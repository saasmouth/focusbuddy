# Editor program: how each surface actually wins

A plan to make every editor better than the incumbent at the work our users do.
Written for the people who will build it, and for whoever has to defend the
scope.

## The frame, because it decides everything below

The brief was "better and more powerful than Office, Google, the independents
and Adobe". Taken literally, at the thing each is best at, that is not a plan:
Excel is forty years and hundreds of engineers, Illustrator shipped in 1987,
and InDesign carries decades of colour science and print workflow. Matching
them feature for feature is five figures of engineer-years and would mean
losing on seven fronts at once.

That is also the wrong target, because nobody buys the seventh-best
spreadsheet. The winnable version is sharper:

> **Be the best place to do the work, not the best clone of the tool.**

Three things make that real, and the incumbents cannot copy any of them without
abandoning their own architecture:

1. **Composition.** The document sits beside the spreadsheet, the thread, the
   tasks and the live web page, on one surface that persists. Office has the
   apps and no surface. Google has the surface and only its own apps.
2. **Wiring.** Widgets feed each other. A chart from a table fed by an inbox
   rule, summarised by an agent, on the same desk. Cross-app automation exists
   elsewhere only as a separate product you configure.
3. **Local and bring-your-own-key.** Structural. A cloud-first competitor
   cannot match it without re-architecting.

So each editor gets two tracks, and they are funded differently:

- **Parity floor.** The things whose absence is embarrassing and ends
  evaluations. Not a differentiator. Finish them, then stop.
- **The leap.** The thing only possible because the editor lives on a desk.
  This is where the "more powerful" claim is actually earned, and it is
  defensible because it is not portable to their architecture.

Chasing parity past the floor is the failure mode to watch for. Mesh gradients
do not win anyone from Illustrator.

---

## Phase 0 — settle and unblock (days)

| Item | Why first |
|---|---|
| Wire co-editing into regular Documents | `YjsDocSync` runs in production today for Live Docs. `DocEditor` already takes a `collab` prop. The relay, CRDT, live cursors and update-log replay all exist. This is wiring, not building, and it converts the category's most common objection into a headline |
| Rewrite the claim gate afterwards | §14 bans "real-time" and "simultaneous editing". Once the wiring lands that is false modesty, and the limitations table needs the same edit |
| Pin or replace `xlsx@0.18.5` | Last npm build before SheetJS left npm, carries known advisories. A security decision with a deadline, not a feature |
| Pick one diagramming surface | `map`, `diagram` and `mindmap` cover one job three times. Consolidation is cheaper than maintaining three and clearer in the picker |

## Phase 1 — parity floors (the embarrassing gaps)

| Editor | Floor | Note |
|---|---|---|
| Slides | Real `.pptx` import: shapes, images, positions, layouts, theme | Today it extracts text only. Widest gap between what the picker implies and what happens |
| Documents | OOXML in and out against our own model, replacing docx → HTML → docx | `mammoth` discards by design. No editor work fixes fidelity while it is in the path |
| Draw | SVG import and export | Without it artwork cannot leave. Cheapest credibility win on this list |
| Design | Decide print or screen, then CMYK, bleed, PDF/X if print | "Print-ready" is currently implied and not true |
| Browser | Find in page, zoom, downloads, per-widget session isolation | The first three are noticed in the first minute |
| Sheets | Named ranges, cell comments, structured tables | The function set is already near mainstream-competitive |
| Diagrams | Connector routing that survives a move, shape libraries | Most of what a specialist actually sells |

## Phase 2 — the leaps, per editor

This is the part that is better rather than equal.

**Documents.** A document that cites the desk. Pull a figure from the table
widget and it stays bound: the number updates, the sentence updates, and the
provenance is visible on hover. Word has fields; they point at other Word
documents. Ours point at live work.

**Sheets.** A cell whose source is a widget, not a value. `=INBOX("from:legal")`
or a column fed by the table next to it. The function set is already strong
enough that this is the differentiator, not more functions.

**Slides.** Generate the deck from the desk. The brief, the chart and the
decisions are already there; building the deck by hand from them is the chore.
Round-trip so the generated deck survives export.

**Diagrams.** Nodes that are live widgets, not pictures of them. A box that is
the task, so the diagram is the plan rather than a drawing of it. This is the
one place where Lucidchart cannot follow, because their nodes have nowhere to
point.

**Draw and Design.** Assets bound to the desk, so artwork placed in a layout
updates when the source changes, with no relink step. Adobe solves this with
Creative Cloud Libraries, which is a sync product. Ours is just the desk.

**Browser.** The page becomes desk content: reader-mode text indexed by Cmd-K,
selections clipped to a note with the source URL kept. A browser tab that
contributes to search instead of being a hole in it.

## Phase 3 — the cross-cutting blockers

These outrank most feature work, because they end evaluations before features
are compared.

| Item | Effect |
|---|---|
| No web or mobile client | Disqualifies most team evaluations outright |
| Mail: single-account, password-only IMAP, no OAuth | The Gmail and Outlook majority cannot connect |
| Not notarized, no certifications | Blocks managed and security-conscious buyers regardless of quality |
| Cmd-K does not index mail or chat | A visible hole in the strongest thing we have |

## How to judge this is working

Not by feature counts against a competitor matrix. By whether a user can finish
a real piece of work without leaving the desk, and whether the thing they made
survives being sent to someone who does not use Plexii. The second is what the
parity floors are for; the first is what the leaps are for.

## Honest limits

Phase 1 is months of work for a team, not a sprint. The Documents OOXML item
alone is the largest single piece on this list and should probably be scoped as
its own project with its own test corpus of real documents. Anyone promising
all of Phase 1 in a quarter has not read the `mammoth` call path.
