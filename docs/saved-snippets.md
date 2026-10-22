# Saved snippets

A snippet is one saved component — a pricing table, a payment-terms clause, a
sign-off block, a KPI widget — that a user keeps and re-inserts wherever it is
relevant. Two things make it more than copy-paste: how an inserted copy relates
to the saved original, and who is allowed to use it.

## The two link modes

Inserting a snippet is either a **duplicate** or a **live instance**, and the
difference is the feature.

| | Duplicate | Live |
|---|---|---|
| What is inserted | the snippet's content, as ordinary editable blocks | a reference holding only the snippet's id |
| Later edits to the master | never reach it | appear everywhere it was inserted |
| In the host's stored body | the content itself | `{ snippetId }` and nothing else |
| When the master is deleted | unaffected — it is just content now | renders an explicit "no longer exists" |

A duplicate deliberately creates **no node**. A copy that has stopped tracking
its origin needs no reference, so it gets none; only a live instance does. This
is why `insertSnippetDuplicate` takes the *content* and `insertSnippetLive`
takes an *id* — the signatures make the difference impossible to blur.

A live instance resolves on every mount, which is the same rule
`WidgetEmbedNode` already states for embedded widgets: *the node stores only the
id, so the host never carries a stale copy*. Editing the snippet in the library
is therefore how you update every document that uses it.

`revision` is bumped on a body change and surfaced on the rendered node as
`data-snippet-revision`, so a host can tell that what it drew is current. A
rename does **not** bump it: a rename changes nothing a live instance renders,
and treating it as new content would look like a change to every host.

## Personal and organisational

There is **no separate permission system**, deliberately.

- Snippets are stored with an `org_id`, like documents and every other
  tenancy-bound row. Switching workspace switches library.
- `PERSONAL_ORG_ID` (`'personal'`) is the reserved private workspace.
- A user only has an org they were invited into and switched to. **Being able to
  see an org's library is the invitation.**

Within a real org, `scope` separates the two things the user asked for:

- `personal` — the user's own reusable assets. `authorId` records who saved it
  (the signed-in email, which is the only stable identifier the main process
  has locally; null in an anonymous workspace, which is the normal local-first
  case).
- `org` — shared with everyone in that workspace, so a team keeps one real
  pricing table instead of nine drifting ones.

An org-scoped save **in the personal workspace is stored as personal**. There is
nobody to share with there, so labelling it "org" would be a claim the workspace
cannot honour. The library's Organisation tab says so outright rather than
showing an empty list, because "this org has nothing shared" and "there is no
org here" are different statements and an empty list would assert the wrong one.

`fork` copies an org snippet into the caller's personal library, so someone can
diverge from the shared version without editing it for everyone.

### Org scope does not reach teammates yet, and says so

**`ORG_SNIPPETS_SYNC` is `false` as of 4.3.41.** An org snippet is marked
organisation-wide and the library filters on it, but it **stays on the computer
that saved it**.

Workspace sync carries a closed set of item types and the gate is server-side:

```ts
// focusbuddy-signal/src/workspaceSync.ts
export type WorkspaceItemType = 'node' | 'widget' | 'timeblock' | 'table' | 'row' | 'file'
if (!WORKSPACE_ITEM_TYPES.includes(input.itemType))
  return { ok: false, conflict: false, error: 'Invalid itemType.' }
```

`snippet` is not in that list, so adding it is a server change and a deploy, not
a client edit. Until then the UI must not imply sharing, so:

- the save dialog's org button reads **"Mark as organisation-wide"**, not
  "Everyone in this organisation";
- selecting it shows `ORG_SNIPPET_REACH_NOTE` — *"Saved on this computer.
  Sharing with your organisation arrives with sync."*;
- the library's Organisation tab shows the same note above its list.

All of that wording derives from the one flag, so flipping
`ORG_SNIPPETS_SYNC` in the same change that adds `snippet` to both whitelists
updates every string at once and no copy goes stale.
`tests/unit/snippets.test.ts` asserts the two stay in step.

The scope was kept rather than hidden because it records the user's intent, it
is what the library filters on, and it is what will travel unchanged once sync
carries snippets — hiding it would mean rebuilding it later and losing the
intent meanwhile. What is not acceptable is telling someone their colleagues
can see something they cannot.

The precedent sits in the server's own comment beside that union: a sync that
accepted only what it recognised "had faithfully carried everything it was
willing to accept" while reporting success throughout, and an image arrived as
a blank widget. Silent partial sync reads as success, which is why this is a
constant and a test rather than a comment.

## Where snippets can go

A snippet is typed by what it holds, and each surface declares what it accepts.

```ts
interface SnippetTarget {
  id: string                    // the MOUNTED SURFACE, not the document
  label: string                 // "This document", "Marketing desk"
  accepts: SnippetKind[]
  supports: SnippetLink[]       // only modes it can really honour
  insert: (s: Snippet, link: SnippetLink) => Promise<boolean> | boolean
}
```

Three properties of this contract matter:

**Targets are mounted surfaces.** A document that is open can take a doc
snippet; the same document closed cannot. Surfaces register on mount and
withdraw on unmount, so the picker offers exactly what is really on screen and
the user is never offered a destination that would quietly do nothing.

**`supports` is honest.** A surface that cannot resolve a reference at render
time lists `['duplicate']`, and the picker then offers Duplicate alone. Showing
a Live option that silently became a copy would be a lie about what was asked
for.

**`insert` returns false when it declined.** A sheet with no selection, a
read-only document. The store reports that refusal rather than counting a use
that did not happen, which is why `usageCount` means something.

### Surfaces today

| Kind | Body | Wired |
|---|---|---|
| `doc` | TipTap nodes + plain text | **yes** — duplicate and live |
| `widget` | kind, title, content, size, colour | **yes** — duplicate only, see below |
| `sheet` | row-major values + per-cell formats | modelled, not wired |
| `slide` | slide elements | modelled, not wired |
| `design` | canvas elements | modelled, not wired |
| `diagram` | nodes + edges | modelled, not wired |

The document surface is first because it is the one that needs both link modes
and because the live-embed mechanism already existed there to build on. The
remaining four are typed end to end but **no surface registers them yet** — a
kind with no target simply offers no destination, which is why the picker says
"nothing open can take this" instead of failing.

### Why a desk offers Duplicate only

Not a limitation — a deliberate refusal to build a second mechanism for
something that already has one.

A work widget is already a file, and a file "can be placed on any number of
desks as a **linked instance** whose edits flow both ways"
(`docs/widget-files.md`). That IS live. A "live widget snippet" would be a
second way to do the same thing, competing with the first, so the desk target
declares `supports: ['duplicate']` and the library offers Duplicate alone.

So the division is:

- a widget **snippet** is a template for making new widgets of a shape you use
  often — each one independent from the moment it lands;
- a widget **file** is one widget that appears in several places at once.

Both are real wants, they are not the same want, and the same widget can do
both: `Save as snippet` and `Save as file` sit beside each other in the widget
menu for exactly that reason.

A widget snippet carries its SIZE but not its POSITION: shape is part of what
makes a widget reusable, while where it sat on one desk is not. The destination
desk decides where the new widget lands.

Adding a surface is a registration, not a change to the core:

```ts
useEffect(() => registerSnippetTarget({
  id: `sheet:${instanceId}`,
  label: 'This spreadsheet',
  accepts: ['sheet'],
  supports: ['duplicate'],      // a sheet cannot resolve a reference per-cell
  insert: (s, link) => pasteBlockAtSelection(s.body)
}), [instanceId])
```

## Honest failure states

Each of these is a case where the plausible-looking behaviour is the wrong one.

- **A deleted master** renders "this live snippet no longer exists", naming what
  to do about it. A live instance is a reference, so a dangling reference should
  look dangling and be fixable — not blank, and not a cached copy of what it
  used to say.
- **A corrupt body** reads back as an empty body *of the declared kind*, and the
  row stays listed. One bad row must not take out the library, and a snippet the
  user can see and delete beats one that silently vanished.
- **A body whose kind disagrees with its row** is treated as unreadable rather
  than handed over, so a slide surface can never be given an object a document
  wrote.
- **An empty selection** is refused on save, in the dialog and again in the
  store. An empty library entry cannot be told apart from any other one.
- **An unreadable library** is reported as empty *and errored*, never as an
  empty library that looks fine.

## Where the code is

| Path | What |
|---|---|
| `src/shared/snippets.ts` | the model, the target contract, and the pure rules both sides run |
| `src/main/db/snippets.ts` | the store and its DDL (`ensureSnippetSchema`, registered in `migrations.ts`) |
| `src/main/ipc/index.ts` | seven `snippets:*` handlers |
| `src/preload/index.ts` | `window.api.snippets` |
| `src/renderer/src/stores/snippets.ts` | the library state and the target registry |
| `src/renderer/src/components/snippets/` | `SnippetLibrary`, `SaveSnippetDialog` |
| `.../documents/embed/SnippetEmbedNode.tsx` | the live node, in the shared schema |
| `.../documents/embed/SnippetEmbed.tsx` | resolves a live instance; owns the missing state |
| `.../documents/editor/docSnippets.ts` | the document as a snippet surface |
| `.../desk/deskSnippets.ts` | the desk as a snippet surface (duplicate only) |
| `lib/contextMenu/` | `FrameCallbacks.onSaveAsSnippet`, beside `onSaveAsFile` |

The DDL lives in its own module rather than in `schema.ts` for the reason
`migrations.ts` documents: the cloud runtime builds its database from `SCHEMA`
alone, and a table added only there would drop every snippet row arriving in a
sync body.

## Tests

- `tests/unit/snippets.test.ts` — the shared rules: what a target accepts, link
  modes, search (including inside body text), emptiness per kind, kind/body
  agreement, summaries.
- `tests/unit/snippetsDb.test.ts` — the store: scope coercion in the personal
  workspace, org isolation on list, revision bumped on a body change but not on
  a rename, refusing to empty a snippet, corrupt and wrong-kind bodies, usage
  counting, forking.
- `tests/e2e/snippets.spec.ts` — the round trip in the real app: save a
  selection, insert a duplicate, insert a live instance, edit the master and
  prove the live instance changed while the duplicate did not, delete the master
  and prove the live instance shows as missing, and the personal-workspace
  Organisation tab.

SN-3 and SN-4 are the ones worth keeping: the duplicate/live difference and the
dangling-reference state are both invisible unless something checks them.
