# Widget files (4.3.32)

A widget can now exist without a desk, the way a document or a slide deck does.
It is created from the side menu's **Widgets** section, opens full-pane, appears
in Files with its own file type, gets a name without the user typing one, can be
read and written by the assistant, and can be placed on any number of desks as a
**linked instance** whose edits flow both ways.

This note is the contract the code follows. Read it before changing
`src/shared/widgetFiles.ts`, `src/main/db/widgetFiles.ts`, the Widgets section in
`components/nav/AreaAccordion.tsx`, or the canvas drop handler.

## Data model: a widget file is a document

A widget file is a row in `documents` with `doc_type = 'widget'`.

```ts
// documents.body for doc_type 'widget'
interface WidgetFileBody {
  v: 1
  kind: WidgetKind        // the widget kind it renders as
  content: string         // exactly what Widget.content holds for that kind
  color: string | null
  titleSource: 'placeholder' | 'derived' | 'model' | 'user'
}
```

Why a document and not a new table, or a nullable `widgets.task_id`:

| Needed | `documents` row gives it for free |
| --- | --- |
| Exists without a desk | documents have no desk |
| Cross-device sync | `document` is already a workspace-sync item type |
| Trash / restore / purge | `trashDocument` / `restoreDocument` / Documents trash |
| Files | doc pointers in `fb_files` already render in Files |
| Search, Brain, chunk index, mentions, MCP read | all read documents through `extractDocText` / `docBodyToText` |
| Naming pass | `titleBackfill` already walks `documents` |

`widgets.task_id` is `NOT NULL REFERENCES nodes(id) ON DELETE CASCADE`, widget
sync joins through the desk, and the orphan sweep deletes desk-less rows, so a
desk-less widget row would have needed a table rebuild plus three new sync and
cleanup branches. `doc_type` has no CHECK constraint (dropped by
`migrateDocumentsDocTypeCheck`), so the new type needs **no migration**.

Kinds that only make sense on a desk (section, portal, task link, desk agent,
webhooks, living doc, contacts, attention, minimap, meeting record) are
**desk-only**: they describe or arrange the desk they sit on, so they never
become files. In the side menu, clicking one adds it to the open desk. `isStandaloneWidgetKind()` in `src/shared/widgetFiles.ts` is the
one list.

## File types

Every standalone kind has a stable type id and an extension-like label, in
`WIDGET_FILE_TYPES` (`src/shared/widgetFiles.ts`):

| kind | type id | extension | Files label |
| --- | --- | --- | --- |
| table | `plexii.widget.table` | `.plexii-table` | Table |
| task-list | `plexii.widget.task-list` | `.plexii-tasks` | Task list |
| mindmap | `plexii.widget.mindmap` | `.plexii-mindmap` | Mind map |
| sticky | `plexii.widget.sticky` | `.plexii-sticky` | Sticky |
| … | one entry per standalone kind; a unit test fails if a kind is missing | | |

The type id never changes once shipped. Export writes a JSON envelope
`{ type, version: 1, title, kind, content, color }` to `<title><ext>`, plus the
table's columns and rows for a table (its content is only a table id). Import
reads the same envelope back into a new widget file. Files "Add files" sends a
`.plexii-*` file through the importer instead of storing it as an opaque file.

## Linked instances (desk placement)

A widget file placed on a desk is an ordinary `widgets` row:

```
kind         = file.kind
content      = file.content        (a mirror)
title, color = file.title, file.color
syncGroupId  = 'wf:' + file.id
```

`syncGroupId` is the linked-duplicate mechanism that already exists. The `wf:`
prefix marks the group as owned by a file. No widget column is added and
existing desk widgets are unchanged. That is the migration-free design.

Edits propagate in the main process, as direct DB writes so neither direction
re-enters the other:

- **Instance to file and other instances.** `updateWidget` already fans
  content, title and colour out to every widget in the group. When the group id
  starts with `wf:` it also writes the file's body and title
  (`syncWidgetFileFromInstance`).
- **File to instances.** `updateWidgetFile` writes the document and then
  `UPDATE widgets … WHERE sync_group_id = 'wf:<id>'`.

The renderer mirrors the same patch into any in-store copies, so an open desk
updates without a reload. A table's content is a table id, so two instances
share the same `fb_tables` rows and stay in sync by construction.

Placing works the same way from every entry point:

| Gesture | Result |
| --- | --- |
| Drag a kind from the side menu onto a desk | new file + linked instance at the drop point |
| Right-click a kind, then "Add to this desk", or command palette "Add *X* to desk" | new file + linked instance at the spawn point |
| Drag a widget file from Files or from the full-pane header onto a desk | linked instance of that file |
| Desk widget menu, then "Save as file" | creates the file from the widget and links the widget (and any synced copies) to it |

## Full-pane view

`goDocument(id)` routes through `DocumentOpen`. A `widget` doc renders
`WidgetFileView`: a header (kind icon, editable title, type label, drag handle,
place-on-desk, export, move to Trash) above the **same** component the desk uses
(`renderWidget`) in the `embedded` surface.

The pane's widget is a synthetic `Widget` with `id = 'wf:<docId>'` and
`taskId = ''`. `useWidgetStore.update` and `remove` route any `wf:` id to the
widget-file store, so widget components work unchanged.

## Naming

Naming reuses `src/shared/titles.ts` and `src/main/titleBackfill.ts`. Nothing new
was written for this beyond the per-kind content source.

1. **Create.** A title given by the user, the AI or the source widget is
   kept. Otherwise the name is derived from the content. If there is nothing to
   derive from, the file gets a placeholder of `"<Type> · <Mon D, h:mm AM>"`
   (`titleSource: 'placeholder'`). A file is never saved as "Untitled".
2. **Save.** While `titleSource` is `placeholder`, each content save tries
   `deriveWidgetFileTitle(kind, content, resolvers)`:

   | Kind | Title source |
   | --- | --- |
   | sticky, note, markdown | heading or first line |
   | page | page heading |
   | table | first column header and row count ("Client · 12 rows"), or the table's own name |
   | task list | first task ("Call Sam + 3 more") |
   | mind map | root node |
   | card | card title |
   | chart, stat card, metrics | the user's title |
   | field | the field label |
   | voice note | transcript |
   | image | prompt |
   | others | the shared text serialisation |

   On success the title is written with `titleSource: 'derived'` and fanned out
   to every instance.

   Table files are the exception. Their rows live in `fb_rows`, not in the
   file, so every row or schema write calls `onTableChanged`. That call
   re-indexes the file and re-derives its "Header · N rows" name while the name
   is still ours (placeholder or derived). Chart files over that table are
   re-indexed too. An empty table keeps its placeholder, so a file is never
   named after template columns.
3. **Launch.** `runTitleBackfill` treats a widget file whose `titleSource` is
   `placeholder` as untitled. The free pass uses the same per-kind derivation,
   then the existing single Haiku batch handles what is left, with the same caps
   and the same `title_backfill_log`.
4. **User names win.** A rename from Files, the pane header or the desk header
   sets `titleSource: 'user'`. No automatic path writes a title unless the
   source is `placeholder`.

## Text serialisation and AI

`widgetToText` (`src/shared/widgetText.ts`) is the one serialiser. Its output per
kind:

| Kind | Text |
| --- | --- |
| table | markdown table with headers |
| task list | checklist (`- [ ]` / `- [x]`) with due dates and status, from the new `tasks` resolver |
| mind map | indented outline |
| chart | type, title, series, then the aggregated values from the bound table |
| timer, field, calculator | their values |
| everything else | as before |

`widgetFileBodyToText()` wraps it for a file body. It is reached from:

- `extractDocText` (`workspaceRank.ts`), which covers the chunk index, retrieval,
  embeddings, Brain ingest and `@`-mentions of a document;
- `docBodyToText`, which covers MCP `plexii_read_document` and the office
  `docText` resolver;
- global search, which treats a widget file as a document hit and opens the pane.

Writes go through the existing review-and-apply flow:

- **In-app assistant.** Two new proposals, `create-widget-file` and
  `update-widget-file`. Both are gated like `create-document`: a card with
  Apply, with auto-apply only where autonomy policy already allows it.
- **MCP.** Two new tools, `plexii_create_widget_file` and
  `plexii_update_widget_file`. They are write-scoped, so read-only tokens never
  see them, and are recorded through `recordAgentWrite`.
- **Build with AI.** The prompt carries the user's widget files that match the
  request by keyword, as their serialised text, so a build reuses their real
  columns and names instead of inventing them.

## IPC

| Channel | Purpose |
| --- | --- |
| `widgetFiles:create(input)` | `{ kind, title?, content?, color?, parentId? }` creates and files the widget file and returns `WidgetFile` |
| `widgetFiles:get(id)` | returns `WidgetFile \| null` |
| `widgetFiles:list()` | live widget files in the active org |
| `widgetFiles:instances(id)` | the file's desk instances ("On 2 desks") |
| `widgetFiles:update(id, patch)` | `{ content?, title?, color? }`; a title in the patch means a user rename |
| `widgetFiles:place(id, draft)` | creates the linked instance on a desk; returns `Widget` |
| `widgetFiles:createAndPlace(input, draft)` | the side-menu drag gesture as one call |
| `widgetFiles:promote(widgetId)` | "Save as file" |
| `widgetFiles:export(id)` / `widgetFiles:import(path?)` | `.plexii-*` round trip |
| `widgetFiles:trash(id)` | trashes the document and its Files pointer |

Delete and restore otherwise use the existing `documents:*` channels.

## Side menu

The **Widgets** section sits between Apps and People. Its kinds are:

```
WIDGET_CATALOG (not hideFromPicker)
  minus kinds represented under Apps (each SEGMENT_APPS.office entry's widgetKinds,
        plus what a connected app becomes on a desk)
  minus kinds that already are a side-menu area (Attention)
  minus retired kinds
```

The split between the main list and **Other widgets** is stored per user in
`lib/widgetMenuPrefs.ts`:

- `localStorage` first;
- mirrored to the account-state endpoint (`setAccountState('widgetMenu', …)`),
  so it follows the user to another device, on the same pattern as autonomy
  prefs;
- the defaults are eight kinds in the main list and everything else under Other
  widgets, in catalogue order;
- a kind added in a later release is appended to Other widgets.

A kind moves between the lists by dragging it, or by right-clicking it and
choosing "Move to Other widgets" / "Move to Widgets". The collapsed rail shows
the main list as icons with tooltips, plus an Other widgets toggle.

The header "Add widget" button and the hover palette are gone. The side menu,
quick-add keys, the canvas right-click menu and the command palette are the
ways to add a widget. "Import file…" and "Bring a synced widget…" moved to the
Widgets section footer.

## Instance sizing

A desk instance is created in main, not through the widget store's `create`.
`useWidgetFilesStore.place` / `createAndPlace` therefore apply the same central
view cap, `fitNewWidgetToView`, that every other new widget gets. Drop sites
pass only a position.

## Task lists

A task-list widget on a desk is a lens over that desk's tasks. A task-list file
has no desk, so it is created with `scope: 'own'` and keeps its items in its
content (`{ scope: 'own', filter, items: [{ id, title, done, dueAt }] }`). That
is also why every linked instance shows the same list. `TaskListWidget` renders
own-scope content as a plain checklist with due dates. A desk task list that is
promoted with "Save as file" keeps its lens scope.

## Web runtime

The cloud runtime's worker (`src/web/worker/handlers.ts`) calls the same store
for every `widgetFiles:*` channel except export and import, which need a native
save or open dialog.
