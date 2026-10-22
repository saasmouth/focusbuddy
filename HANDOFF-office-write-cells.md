# office-write-cells — handoff

Kept current on the branch because session addresses die on restart and this
session has now restarted twice. If you are picking this up cold, this file and
the branch are the state.

**Branch:** `office-write-cells`
**Base:** `0c5b169c` (integration-l8 tip with Write merged)
**Commits ahead of base:** none yet — PlexiiWrite and the Cells scaffolding are
both merged into integration-l8 already.

---

## Where things stand

| Thing | State |
|---|---|
| PlexiiWrite on the office shell | **merged** into integration-l8 |
| Cells ribbon + frame (`cellsRibbon.tsx`, `CellsChrome.tsx`) | **merged**, but **nothing imports them** — Cells still renders SheetToolbar |
| Cells wiring (SheetEditor) | **not started**; baseline in progress |
| Saved snippets | separate branch `snippets`, rebased onto this base |

So the remaining Cells work is the wiring, not the design: the ribbon declares
four tabs (Home, Insert, Data, Tools) and the rail, and `CellsChrome` assembles
`OfficeShellLayout`. Both typecheck. Neither is reachable.

---

## The method, which is not optional here

**Capture BOTH baseline passes before you touch a single spec.** This is the
rule that cost the most to learn, and it is invisible to every other check.
Cells' baseline was taken as two passes, as the method requires — but pass A
ran before the specs were converted and pass B ran after, both against the same
pre-wiring bundle. Pass A had 4 failures, pass B had 15, and those 11 extra were
the converted specs correctly failing against an unconverted app. Both logs said
"Running 87 tests", both had clean summaries, and the intersection looked like
an ordinary noisy-machine result: 3 "stable" reds and 13 "flaky". It had
silently SHRUNK the baseline from 4 to 3, which is the dangerous direction,
because a real regression is then excused as a known red.

Two passes are comparable only if they ran the same spec code against the same
bundle. So take passes through the runner, which records that in the log:

```
node scripts/e2e-pass.mjs --log .baseline/<app>A.log --specs-from .baseline/<app>-specs.txt
```

It writes a `# fingerprint` header (git rev, hash of the spec files, hash of the
built renderer, and a count of uncommitted files under src/ and tests/), and
`e2e-baseline-diff.mjs` refuses to report a verdict when two baseline logs
disagree on it. If you have already edited specs and hold only one clean
baseline pass, you do not have a baseline — re-take the pair from a pinned
checkout.

**A single e2e run is not a comparator.** The machine runs several agent
sessions; load has been seen at 49 on 10 cores. At that load the failure set
differs between two runs of the same commit, so every claim must be the
INTERSECTION of two passes. This is not caution, it is the difference between a
real regression and noise — an earlier report of mine was wrong in both
directions until I did this.

**Wrap heavy runs in the shared queue.** One at a time, across all sessions:

```
/private/tmp/claude-501/heavy-run.sh "write-cells: <what>" -- <command>
```

Heavy means a baseline pass, a full vitest run, or `npm run build`. Single specs
do not need it.

**Key the diff on file + test TITLE, never `file:line`.** Converting a surface
means editing its specs, which shifts every line below the edit, and a
line-keyed diff then reports the same test as both a regression and a fix.
Use the tracked script, which does it correctly and travels with the branch:

```
node scripts/e2e-baseline-diff.mjs <baselineA.log> <baselineB.log> <after.log>
```

It intersects the two baselines for you and **refuses to print a verdict** when
the logs cannot support one, which matters more than the diff itself: Playwright
exits 0 with "No tests found" when a spec dies at collection, and an empty
failure set otherwise reads as a clean sweep. It stops when either baseline
collected 0 tests, when the two baselines disagree on how many they collected,
or when the failures it parsed do not match the count the run reported itself.
A rebase that auto-merges a second copy of a helper into `tests/e2e/_helpers.ts`
is the known way to trigger this, so after any rebase also run
`npx playwright test --list` and check the TOTAL before trusting a green run.

**A clean typecheck is not evidence the renderer builds.** Proven today: I
imported `useWidgetsStore` (the real export is `useWidgetStore`);
`typecheck:web` reported 0 errors and rollup then failed on the missing named
export. Always read the build log before claiming it built.

---

## Cells: the baseline set is 15 specs, not 10

Derived from the testids the conversion will move, not from spec names. The five
nobody listed are the reason to derive rather than inherit:

```
sheetEditor  sheetEditorV2  sheetMerge  sheetNav  sheetRework
sheetAiPanel  sheetQueryMacros  sheetSparkline  officeMenuBars  docWidgetDrop
documents  heavyWidgetRestyle  officeDocCanvas  sheetFormulaAssist  sheetRework2
```

The list is on disk at `.baseline/cells-specs.txt`. `sheetRework2` matters
because SR2-5 lives there (see the row-height decision below).

Known reds from the cross-app baseline, to confirm against your own two passes
rather than inherit: `sheetAiPanel` AP-1 (copy change in
`sheet-ai-connections-empty`), `sheetEditorV2` SE-V2-4 and `sheetQueryMacros`
SQM-1 (both timeouts — SE-V2-4 passes alone in 25.3s against a 30s limit, so it
is the first thing to fail on a busy machine and the last to suspect), and
`sheetRework2` SR2-5.

---

## Cells: what the wiring involves

`SheetEditor.tsx` is 2688 lines. The shape that worked for `DocEditor`:

1. Keep the document/grid body where it is; replace the bespoke chrome block
   with `CellsChrome` wrapping it.
2. **`flex-1 min-w-0` on every flex item down to the shell** (SPEC §6). Without
   `min-w-0` a flex item will not shrink below its content's min-content width,
   and the shell rendered at ~1162px inside a 480px desk widget. This is what
   broke Write's and Draw's narrow-embedded rows.
3. The shell's canvas slot has **no `overflow-auto`** — the host supplies its
   own scroller, or the content does not scroll.
4. The AI panel moves onto `ShellSidePane`, keeping `sheet-ai-collapse` via
   `collapseTestid`.
5. Add the Cells row to `officeShellLayout.spec.ts` APPS. Omit `corner` unless
   Cells really has a bottom-RIGHT control — that assertion exists to prove one
   is clear of the Plexii pill, and naming a bottom-left control passes without
   testing anything.
6. Update the specs: a tab's controls are only in the DOM while that tab is
   active, so use `selectBarTab(window, 'sheet-toolbar', '<tab>')` from
   `_helpers.ts`. It is **idempotent on purpose** — a second click on the
   already-active tab is a double-click, which collapses row 2 (owner ruling D5)
   and hides the controls you were reaching for.

### Three passes to run before you claim a conversion is done

Each of these caught something the other two missed, and none of them is a test
run — they are all cheap and they all found real bugs on Cells.

Passes 1 and 2 are scripted, so run them rather than reconstructing them:

```
node scripts/check-converted-app.mjs \
  --surface src/renderer/src/components/documents/SheetEditor.tsx \
  --surface src/renderer/src/components/documents/CellsChrome.tsx \
  --surface src/renderer/src/components/documents/sheet \
  --ribbon  src/renderer/src/components/documents/sheet/cellsRibbon.tsx \
  --removed <wiring-commit>^:<path/to/DeletedBar.tsx>
```

It exits 1 on a duplicate testid and prints pass 2 as advisory. Verified
against the real Cells bug: run over the pre-fix commit it names
`sheet-ai-toggle` at both sites and exits 1. Pass 3 is a human read; no script
does it.

**1. Scan the WHOLE surface for duplicate testids.** Not a hand-picked list of
the ids you expect to move; that found nothing on Cells. Extract every static
testid from the editor, the chrome, the ribbon and the app's `sheet/`-style
subdirectory and look for any appearing twice. Converting leaves bespoke
controls alive next to their ribbon equivalents, and a spec using a strict
locator then fails as a confusing timeout rather than an obvious duplicate.
On Cells this was `sheet-ai-toggle`, live in both the ribbon's pinned slot and
the formula bar, which would have broken a test that was GREEN at baseline.

**2. Diff the deleted bar's callbacks against the actions the ribbon invokes.**
Every `props.on*` the old component took, against every action the ribbon
calls. Expect false alarms and check each one rather than acting on it: on
Cells, three of four gaps were fine (Undo/Redo moved to the chrome's
`pinnedStart`; the ribbon offers insertRowAbove/Below where the bar had one
control). The fourth was real.

**3. Read each ported handler's BODY against the original.** Pass 2 only proves
an action is referenced, not that it still does the work. Cells' ribbon had
`namedRanges: () => setNamesOpen((v) => !v)` where the real control calls
`openNames()`, which also prefills the range reference from the selection — so
the command would have opened the panel with an empty field. This is the same
shape as Write's Suggesting toggle setting its React flag while dropping the two
editor commands beside it. Typecheck and a click-through both pass it.

**And run `npm run lint:hooks`.** A restructure moves hooks around, and a
`useMemo` that lands after an early return is a Rules-of-Hooks violation that
typecheck does not see. This is how DocEditor shipped a memo below
`if (!editor) return` on the Write merge. Run it before handing over, and
remember a failure may be inherited rather than yours — check whether the tip
already fixes it.

### What Write's regressions were, because Cells will have the same shapes

Of six regressions the after-pass caught, only two were the conversion being
wrong. The rest were specs encoding the old implementation:

- a popover's scrim classes (`.fixed.inset-0.z-30`) clicked through `evaluate`
  to close it — a `ShellPanel` has no scrim; use
  `[data-testid="<app>-panel-<id>-close"]`;
- `getByTitle(...)` and `select[title=...]` — the shell's primitives name
  themselves with `aria-label` plus a Tooltip and set **no** `title` attribute;
- toggles pressed blind twice, closing what the spec wanted open;
- `text=Untitled document` — `titleBackfill` derives a name from content now. A
  doc with NO content is deliberately left untitled, which is why
  `documents.spec` Steps 7 and 8 still pass untouched.

The two real bugs are the ones to watch for:

- **Diff a ported handler line by line, not just its testid.** Write's
  Suggesting toggle set the React flag but dropped the two editor commands
  beside it, so the control looked armed while nothing was tracked. A typecheck
  and a click-through both pass that.
- **The missing `min-w-0`** above.

---

## Two product decisions, with their evidence

**Cells' default row height is 20px and SR2-5 is the stale side.**
`DEFAULT_ROW_PX = 20 // Excel default row height (15pt at 96dpi)` — arithmetically
right (15/72×96 = 20) and Excel's actual default; Google Sheets is 21px. The
history settles it: `416e3d36` introduced 28, then `b63d8053` ("Sheets: Excel
cell sizing + arrow-key commit navigation") deliberately changed it to 20.
SR2-5 predates that decision and expects ~28. **The spec moves, not the app.**
If roomier-than-Excel rows are wanted, that is a product call for the owner and
should be raised as one, not fixed in a test.

**`documents.spec` Steps 4 and 5 were stale, not broken** — fixed on the Write
merge. Step 4 expected "Untitled document" before auto-titling existed; Step 5
expected `#ERR` from `=1/0` before `sheetFormula` grew typed errors
(`#DIV/0!`, `#N/A`, `#VALUE!`, `#NAME?`, `#NUM!`, `#REF!`, with `#ERR` as the
fallback).

---

## Helpers added for every converter

In `tests/e2e/_helpers.ts`:

- `selectBarTab(window, bar, tab)` — idempotent, see above.
- `showDocPane(window, pane)` — opens Write's side pane and selects a tab
  deterministically, instead of pressing a toggle blind.
- `showDocStyles(window)` — opens the Styles panel only when it is closed.
- (upstream) `suppressFeatureSpotlights`, and `chooseCloudAiSource` — call the
  latter after `waitForReady`. The `local-ai-intro` card is fixed bottom-centre
  at `z-225` and swallows clicks on anything in that band while Playwright
  reports the target visible, enabled and stable for the full timeout.

## The snippets branch

`snippets`, rebased onto this same base. Saved snippets: reusable components
insertable as a duplicate or a live instance, personal or organisation-scoped.
Two surfaces wired (documents, desks), four kinds modelled without a target.
`docs/saved-snippets.md` carries the full contract and an "Adding a snippet
target" section for whoever wires the remaining office apps.

Note `ORG_SNIPPETS_SYNC = false` there: org snippets do **not** reach teammates
yet, because the signal server whitelists sync item types and `snippet` is not
on it. Every user-facing string derives from that one constant, and a unit test
holds the claim and the capability together. Flip it in the same change that
adds `snippet` to both whitelists.
