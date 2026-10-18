# Work widget files (4.3.32)

A work widget is a file, the way a document or a slide deck is. A desk is only
the place it lives: it can be made on its own from the side menu's **Work
widgets** section, opens full-pane, appears in Files with its own file type,
gets a name without the user typing one, can be read and written by the
assistant, and can be placed on any number of desks as a **linked instance**
whose edits flow both ways. A work widget added straight to a desk (the canvas
menu, the palette, an AI build, a template, a duplicate) is a file too: a file
with one instance, on that desk. See "Every work widget is a file" below.

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
| Desk widget menu, then "Save as file" | creates the file from the widget and links the widget (and any synced copies) to it (only still offered where a widget is not a file: a desk outside your own workspace) |
| Any other way a work widget reaches a desk | a new file + its first instance, made by `createWidget` itself (below) |

## Every work widget is a file

The owner's rule (4.3.32): "Treat work widgets independent of a desk as a
standard file. The desk is simply the place it lives, and may be added to
multiple desks, but the file is still the file."

### One enforcement point

`db/widgets.createWidget` ends by calling `adoptWidgetAsFile(id, { fresh: true })`
(`db/widgetFiles.ts`) for every create **without a client-provided id**. That is
every locally born widget, whatever started it, because every path ends in
`createWidget`:

| Path | How it reaches `createWidget` |
| --- | --- |
| Canvas right-click "Add object", quick-add keys, command palette, drag from a catalogue | `useWidgetStore.create` → `widgets:create` |
| Build with AI, assistant `create-widget` actions, desk agents | `actionExecutor` → `useWidgetStore.create` |
| Templates (saved and starter), first-run onboarding | `applyTemplate` / `NewNodeDialog` / `FirstRunOnboarding` → `widgets:create` |
| Duplicate (independent), canvas duplicate-selection, context-menu Duplicate | `useWidgetStore.create`, no group → a NEW file (a copy) |
| Duplicate (keep synced), Make a desk, Assemble desk, Bring a synced work widget | `useWidgetStore.create` with the source's `wf:` group → another instance of the SAME file |
| Office/mail/digest widgets, document drag, live-canvas conversion | `window.api.widgets.create` → `widgets:create` |
| MCP `plexii_create_widget`, `plexii_create_table`, desk builders | `deps.createWidget` → `widgets.createWidget` |
| Web runtime | `src/web/worker/handlers.ts` → the same `createWidget` |
| Side menu (drag, "Add to this desk"), placing a file | `placeWidgetFile` → `createWidget` with a `wf:` group → left alone |

Paths that write widget rows **without** `createWidget`, and what they do:

| Path | Rule |
| --- | --- |
| Inbound workspace sync (row apply) and the CRDT replay (`widgets:create` with the widget's own id) | never create a file. A widget born on another device already is whatever it is there; its file arrives as a `document` item of its own. |
| Desk snapshot restore (`restoreSnapshot`) | keeps each widget's current `wf:` link even when the snapshot predates it; a restored widget that is not a file yet becomes one |
| Desk snapshot branch (`branchSnapshot`) | a copy: each standalone widget on the new desk becomes a NEW file |
| `restoreWidget` (undo, desk trash) | a widget that never became a file (the backfill skips the trashed) becomes one when it comes back |

`adoptWidgetAsFile` leaves a widget alone when it is a desk-only kind
(`isStandaloneWidgetKind` false), already in a `wf:` group, or on a desk outside
the user's own workspace (below). Otherwise:

- a lone widget becomes a file whose id is `widgetFileIdForWidget(widgetId)`;
- a member of an ordinary linked-duplicate group (a non-`wf:` `syncGroupId`)
  turns the **whole group** into one file, id `widgetFileIdForGroup(groupId)`,
  shared by every member;
- the content is kept exactly as the widget holds it. A task list placed on a
  desk stays a lens over the desk's tasks, as a file (see "Task lists" for the
  one rule every entry point follows).

The file is named as any file is (a real widget title is kept as the user's,
not the kind's own label; else derived from content; else the dated
placeholder), filed in Files, and lives in the **desk's** workspace (org).

### Shared desks

Only a desk in the user's own workspace makes files: `deskFileScope(taskId)`
returns null for a desk with `shared_root_id` (live-shared with named people, in
either direction) or `shared_from_handle` (accepted from someone else). A
shared desk syncs on the per-desk path, which never carries documents, so a file
made there would exist for one member only, and every member converting the
same widget would mint their own. Widgets there stay plain desk rows. An
instance whose file this device does not have (a shared desk, a file still
syncing) behaves as a plain widget: its × asks the single confirm.

### Copies

- **Duplicate (independent copy)**, duplicate-selection, context-menu
  Duplicate: a new, independent file. A table copy gets its own `fb_tables`
  row and rows (`lib/copyWidgetContent.ts`), so the copy is not a second file
  over the same data.
- **Duplicate (keep synced)**: another instance of the same file.
- **Unlink from synced copies** on an instance: leaves the shared file and
  becomes a new file of its own (with its own table rows).
- **Template saved from a desk**: a template stores content, not groups, so
  each use makes new files. **Branch a desk snapshot**: new files.
  (A template's or branch's table still points at the original table id, as
  before this change; only the explicit duplicates above clone a table.)

### Launch backfill

`runWidgetFileBackfill()` (main/index.ts, 8 s after launch, detached, after the
safety backup and before the naming pass) converts what predates the rule:

- **Once per workspace per device**, recorded in the device-local `sync_meta`
  as `widgetFiles.backfill.v1:<orgId>`.
- **Deterministic ids**: the same `widgetFileIdForWidget` /
  `widgetFileIdForGroup` as above (a v5-shaped UUID from SHA-1 of the seed). Two
  Macs converting the same synced desk mint the same document ids and set the
  same `sync_group_id`s, so sync merges them. If the document already exists
  (the other device's arrived first) it is reused as-is.
- **Idempotent**: a forced re-run changes nothing.
- **Skipped**: trashed widgets (restoreWidget files one if it comes back),
  widgets on a trashed desk, shared desks (above), desk-only kinds, and widgets
  already in a `wf:` group, including one whose file has not arrived yet.
- **Titles**: a real widget title is kept (`titleSource: 'user'`); otherwise
  derived from content; otherwise the placeholder dated by the **widget's**
  `createdAt` (the same string on every device). A derived name is written to
  untitled instances; a placeholder is not, so converting a workspace does not
  stamp a date on every untitled sticky.
- **Placement in Files**: the root, the convention every widget file follows
  (`createWidgetFile`'s `parentId ?? null`, `ensureWidgetFilesFiled`). Doc
  pointers do not sync, and a root-filed file is what the other device's
  self-heal produces too, so both devices agree. Files is filterable by type
  ("All work widgets", one entry per type, and "Documents" leaves work widgets
  out), and every work widget file's row says where it lives (below). A file in
  a workspace other than the active one is filed the first time that
  workspace's root is listed. No folders are made on the user's behalf: a
  folder per desk would be a second home for a file that can sit on several
  desks, and would move or duplicate what the user may already have filed.

### Files: "On <desk>"

Under each work widget file's name, Files says where it is placed:
"On Launch plan", "On Launch plan and Hiring", "On Launch plan, Hiring and 3
more desks", or "Not on a desk" (list view and the large grid views; the
tooltip names every desk, and a desk name opens that desk). It is one call per
listing, `widgetFiles:placements(ids)` → `listWidgetFilePlacements`: live
instances on live desks, each desk once, sorted by name. While it loads, or if
it fails, the row says nothing rather than "Not on a desk". It is a label only;
nothing is moved, so items the user filed stay where they are.
- **Indexing**: one batched pass at the end (`reindexDocumentChunks`, then
  `reindexDocuments(false)`), not one embedding request per file.

## Remove or delete

The × on a work widget (frame header, dock chip) and the context menu's Delete
go through `lib/widgetRemoval.ts`. For an instance of a live file it asks one
question, "Remove or delete “<name>”?", with Cancel and two answers:

| Answer | Effect |
| --- | --- |
| **Remove from this desk** | `useWidgetStore.remove`: this desk's instance only, undoable as before. Hint: "It stays in Files." or "It stays in Files and on N other desks." |
| **Delete work widget** (danger) | `useWidgetFilesStore.trash`: the file, its Files entry and every instance on every desk go to Trash. Hint: "Removes it from every desk and from Files. You can restore it from Trash." Undo toast. |

A desk-only kind, or an instance whose file is not here, gets the single
confirm "Delete this work widget?". A multi-selection asks the same question
once for the lot ("Remove or delete N work widgets?": **Remove from this
desk** / **Delete N work widgets**), deleting each distinct file once
(`removalPlan`); removing several is one undo step, and deleting several is one
"N work widgets moved to Trash" notice with one Undo (`trashMany`).

Every way of removing a selection asks it:

| Gesture | Path |
| --- | --- |
| × on the frame header or a dock chip | `removeWorkWidget` |
| Context menu Delete (one or a multi-selection) | `removeWorkWidget` / `removeWorkWidgets` |
| **Delete** or **Backspace** with work widgets selected (marquee, shift-click, ⌘A) | `removeWorkWidgets` |
| The selection bar's delete button | `removeWorkWidgets` |

The key is gated by `lib/deleteKey.ts`, on the quick-add focus rules: never
while typing, in a control, a dialog or a web view, in focus mode, or when a
work widget that is not part of the selection has been clicked into (that one
keeps its own Backspace). ⌘⌫ and a held key are ignored. Cancel keeps the
selection.

Deleting a file (any path) also records an undo step, so ⌘Z restores it as the
notice's Undo does.

### The assistant

`delete-widget` proposals carry `scope`:

| scope | Card | Effect |
| --- | --- | --- |
| `desk` (default, and anything that is not `everywhere`) | "Remove from this desk" | `useWidgetStore.remove`: this desk's copy; the file stays in Files and on other desks |
| `everywhere` | "Delete everywhere" | `useWidgetFilesStore.trashMany`: the × "Delete work widget" path, file and every instance to Trash |

`delete-widget` stays a gated kind: it always waits for Apply, and "Apply all"
confirms first, saying how many are removed from the desk and how many are
deleted everywhere. The prompt tells the model the difference and to use
`everywhere` only when the user means the thing itself; the desk index marks
a file's instance with `file=<id>`, and `everywhere` also accepts a widget
file's documentId. A widget with no file here (desk-only kind, a shared desk)
is simply removed, and the result says so; an id that matches nothing fails
instead of reporting a removal. (`lib/deleteWidgetAction.ts`.)

MCP has no delete or remove tool, by design (`mcpServer.ts`: nothing
destructive on that surface). `plexii_update_widget` now says that an edit
reaches every copy of a work widget file, and that removing or deleting is done
in the app. Build with AI only creates; it never deletes.

Deleting is done in `db/documents.trashDocument` for any `doc_type 'widget'`
document, whichever surface trashed it (the × "Delete", the full-pane "Move to
Trash", Files, the documents store): every live instance is trashed with the
document's own `trashed_at`. `restoreDocument` restores exactly the instances
carrying that timestamp, so an instance removed from a desk earlier stays
removed. `purgeTrashedWidgets` (the 7-day desk-trash purge) keeps instances a
trashed file still holds; `deleteDocument` (purge) removes them. The full-pane
"Move to Trash" and Files' "Move to Trash" confirm first when the file is on
any desk, and say that it will be removed from them.

## The link mark

The small link icon in a work widget's header used to show for any widget in a
sync group. Since every own-desk work widget is an instance of its file, that
was nearly every header, and it said nothing. It now shows only when there is
something worth knowing (`lib/linkBadge.ts`):

| Widget | Mark |
| --- | --- |
| instance of a file placed on this desk only | none |
| instance of a file also placed on other desks | link icon, tooltip "Also on N other desks — a change here shows there too." |
| plain linked duplicate (a desk shared with you, where widgets are not files) | link icon, the old "Synced copy" tooltip |
| the full-pane view of a file | none (its header already says "On N desks") |

The desks come from `widgetFiles:placements`, batched for every header on
screen, read fresh when a desk opens, and re-read after a place, a
"Duplicate (keep synced)", a remove from a desk or a trash. Until known, there
is no mark rather than a guess.

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
   named after template columns. The backing table's own name wins only when
   someone chose it: a placeholder-shaped name (a new table file used to copy
   its placeholder onto the table it provisioned) or an earlier "X · N rows" is
   ignored, and a patch that re-sends the current title, or a placeholder, is
   not a rename (`updateWidgetFile`).
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
| `widgetFiles:placements(ids)` | `{ [fileId]: [{ deskId, deskTitle }] }` for a whole Files listing |
| `widgetFiles:update(id, patch)` | `{ content?, title?, color? }`; a title in the patch means a user rename |
| `widgetFiles:place(id, draft)` | creates the linked instance on a desk; returns `Widget` |
| `widgetFiles:createAndPlace(input, draft)` | the side-menu drag gesture as one call (`createAndPlaceWidgetFile`; a task list made this way is the desk's tasks) |
| `widgetFiles:promote(widgetId)` | "Save as file" |
| `widgetFiles:export(id)` / `widgetFiles:import(path?)` | `.plexii-*` round trip |
| `widgetFiles:trash(id)` | trashes the document, its Files pointer and every desk instance (restore puts them back) |

Delete and restore otherwise use the existing `documents:*` channels; `trashDocument` and `restoreDocument` carry a work widget file's desk instances with it (see "Remove or delete").

## Side menu

The **Work widgets** section (code: the Widgets section) sits directly under the
office apps (Apps: PlexiiApps and Tools) and directly above **Connected apps**,
which became a section of its own (`id: 'connected'`) so Work widgets could sit
between the two. Only open/closed is persisted per section (`fb.nav.accordion.open`),
never an order, so the move needs no migration; the new Connected apps section
inherits the old Apps open/closed choice the first time. Its kinds are:

```
WIDGET_CATALOG (not hideFromPicker)
  minus kinds represented under Apps (each SEGMENT_APPS.office entry's widgetKinds,
        plus what a connected app becomes on a desk)
  minus kinds that already are a side-menu area (Attention)
  minus retired kinds
```

The split between the main list and **Other work widgets** is stored per user in
`lib/widgetMenuPrefs.ts`:

- `localStorage` first;
- mirrored to the account-state endpoint (`setAccountState('widgetMenu', …)`),
  so it follows the user to another device, on the same pattern as autonomy
  prefs;
- the defaults are eight kinds in the main list and everything else under Other
  widgets, in catalogue order;
- a kind added in a later release is appended to Other work widgets.

A kind moves between the lists by dragging it, or by right-clicking it and
choosing "Move to Other work widgets" / "Move to Work widgets". The collapsed rail shows
the main list as icons with tooltips, plus an Other widgets toggle.

Each tile's tooltip is its name plus `widgetMenuHint`: the catalogue hint and
"Click for a new one in Files, or drag it onto a desk." (desk-only kinds:
"Only works on a desk."). Tasks says which list each gesture makes: "Drag onto
a desk, or right-click and Add to this desk: that desk's tasks. Click: a task
list of its own, saved in Files, with the same items on any desk you place it
on."

### App tiles

An app tile under Apps that has a work widget (`widgetKinds` in
`lib/segmentApps.ts`, the first is what it places) can be dragged onto a desk or
right-clicked for "Add <work widget> to this desk". **Mail places the Inbox
work widget** (Plexii's own mail, narrowed to the desk by a rule). Until 4.3.32
its first kind was `email`, a Gmail/Outlook web page in a browser frame, so
"Add Email to this desk" put a Gmail web view on the desk; `email` stays listed
only so it is never offered in the Work widgets section. The Inbox work widget
is desk-only, so it is placed the canvas way, not as a file.

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

There are two kinds of task list, by content:

- **A desk lens** (`{ scope: 'desk' | 'all', filter, … }`): the tasks filed
  under the desk the instance sits on, subtasks nested under their task, with
  "Add a task to this desk" and the This desk / Everywhere toggle. The tasks are
  nodes, not widget content, so they sync and show up in Attention.
- **Its own list** (`{ scope: 'own', filter, items: [{ id, title, done, dueAt }] }`):
  items kept in the file's content, the same on every desk it is placed on.

### The rule (4.3.32)

**Where a task list is made decides which it is:**

| Made | Entry points | Is |
| --- | --- | --- |
| placed onto a desk as it is made | side-menu drag, side-menu right-click "Add to this desk", palette "Add Tasks work widget to desk", canvas right-click / Add object, quick-add | the desk's tasks |
| with no desk | side-menu click, right-click "New tasks work widget", palette "New Tasks work widget" | its own list |
| an existing file placed onto a desk | drag from Files or the full-pane header | whatever the file already is: an own list stays its own list |
| from content | the assistant's `create-widget-file` items, `.plexii-tasks` import, a copy | that content |

Code: `defaultWidgetFileContent(kind, deskDefault, placement)`
(`shared/widgetFiles.ts`) returns the own-list default only for
`placement: 'none'`; `createAndPlaceWidgetFile` (`db/widgetFiles.ts`, used by
the desktop IPC and the web worker for `widgetFiles:createAndPlace`) passes
`'desk'`, so it gets the catalogue's desk lens, the same content the canvas
right-click has always made.

Why this rule and not "every file is its own list": a task on a desk is a node
under that desk, and a desk's subtasks are nodes under those. A task list on a
desk that kept its own items would be a second, unrelated list beside the
desk's real tasks: tasks added to it would not be subtasks of the desk, would
not appear in Attention, and the desk's existing subtasks would not appear in
it. Converting both to own lists did exactly that and was reverted. The lens is
the only thing a task list on a desk can coherently be, and a task list with no
desk has nothing to be a lens over, so it keeps its own items. Before 4.3.32's
loose ends the side-menu drag made an own list while the canvas right-click
made a lens, for the same gesture ("put a task list on this desk"); now both
make the lens.

A lens file's instances each show the tasks of the desk they are on (the
filter and view settings are shared). Opened full-pane (from Files), a lens has
no desk, so it shows every task and says so ("Every task · shows a desk's tasks
when placed on one") instead of a "This desk" chip that would be untrue there.
The side menu's Tasks tooltip says which one a drag and a click make.

## Web runtime

The cloud runtime's worker (`src/web/worker/handlers.ts`) calls the same store
for every `widgetFiles:*` channel except export and import, which need a native
save or open dialog.

## Lexicon

User-facing text calls a desk/canvas widget a **work widget** ("a work widget",
"Work widgets" at a sentence start): the side-menu section, its accordion,
menus, palette rows, tooltips, toasts, errors, the assistant's prompts and MCP
tool descriptions. Code identifiers, kind ids, data fields, IPC channels,
`.plexii-*` type ids, test ids and settings keys are unchanged. The Home
dashboard's own tiles ("home widgets") keep their name. Enforced by
`tests/unit/workWidgetLexicon.test.ts`.
