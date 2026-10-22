# office-write-cells — handoff

Written for the aggregator session that merges this branch. Session addresses change
on restart, so this lives on the branch instead of in a chat message.

**Branch:** `office-write-cells`
**Rebased onto:** `d12ac046` (integration-l8 tip at the time of writing)
**Scope delivered:** PlexiiWrite converted onto the shared office shell. PlexiiCells
is NOT converted — its ribbon and frame are written and typecheck, but nothing
imports them.

---

## Ready to merge?

Write: yes, subject to the three load-flaky tests below being read as flaky.
Cells: no — scaffolding only, and deliberately labelled as such in its commit.

Verified on this branch:

- `npm run typecheck` (node + web + webruntime): 0 errors
- `npm run build`: clean, no stray artefacts in `src/`
- `tests/unit/workItemsRefusalMessage.test.ts`: 9/9
- `tests/e2e/documents.spec.ts`: 6/6
- `tests/e2e/docComments.spec.ts`: 2/2
- `tests/e2e/docAssistantConsolidation.spec.ts`: 3/3

## The e2e numbers, and how they were taken

A single run is NOT a valid comparator in this suite — the failure set differs
between two runs of the same commit. Every claim below is the INTERSECTION of two
runs, which is the only stable signal.

**Baseline** at `982f2335`, 28 specs / 89 tests, one worker, clean tree:
76 passed / **13 stable failures** / 1 flaky.

**After Write's conversion**, same specs, two passes, identical both times:
85 passed / 7 failed. **Zero regressions. Six of the 13 pre-existing failures fixed:**
docComments "add a comment…", docEditor DE-2, docEditor DE-10,
docHeadingStyles DHS-1, docHeadingStyles DHS-5, docPageSetup DPS-5.

**Post-rebase** onto `d12ac046`, 104 tests (d8's theme loops): 92 passed / 11 failed,
interrupted at 103/104 by a session restart. Of those 11: six are from the stable 13
(docPagination, SWEEP-1/2/4/5, plexi3LiveVerify), two are PlexiiDraw (see below), and
three are load-flaky — each passes in isolation:

| Test | Why it fails under load |
|---|---|
| docEditor DE-16 | passes alone in 6.5s and 5.9s |
| docEditor DE-17 | times out waiting on `footer-sync-chip`, which is `waitForReady`'s 10s boot gate — the app had not finished booting, nothing to do with Write |
| docPagePagination:103 | dies with "Target page, context or browser has been closed" mid-test |

All three confirmed: `docEditor` DE-16 + DE-17 pass together in 10.8s, and
`docPagePagination` passes 5/5 in 1.0m, on this exact commit.

`widgetEmbed`, which IS in the stable 13, passed post-rebase.

Write's own rows in `officeShellLayout` passed at all three sizes in both themes,
including the narrow-embedded row that was broken before the fix below.

**Comparator:** use `.baseline/newfails2.py <runA.log> <runB.log> <after.log>`. It keys
on file + test TITLE, never `file:line` — this branch edits eleven specs, so every line
below an edit shifts and a line-keyed diff reports the same test as both a regression
and a fix. An earlier report of mine was wrong in both directions for exactly that
reason.

---

## For the other converters (Cells, Deck, Design, Draw)

### PlexiiDraw has the bug Write had

`officeShellLayout.spec.ts:446` — "PlexiiDraw — narrow, embedded in a desk widget" —
fails in both themes on `d12ac046`. Write failed identically, passing the default and
480px rows while failing only the embedded one. That is the signature.

Cause in Write: `DocEditor`'s outer element is a flex **row**, and the scroll container
the shell replaced carried `flex-1 min-w-0`. Without `min-w-0` a flex item will not
shrink below its content's min-content width, so inside a 480px desk widget the whole
shell rendered at ~1162px and the bar overflowed. Fix: restore both classes on the
shell's wrapper. Check DrawStudio's host element for them before looking anywhere else;
if the measured bar width is near the window width rather than ~480, that is it.

Second app to hit this, so it belongs in SPEC §6 rather than being rediscovered a
third time.

### Diff ported handlers line by line, not just their testids

Write's Suggesting toggle regressed silently: the original handler set the React flag
AND the track author/colour AND called `editor.commands.setSuggesting`. Keeping only
the flag left the control looking armed while nothing was tracked. Typecheck and a
click-through both pass that. Only `docTrackChanges` caught it.

### Most "regressions" are specs encoding the old implementation

Of six regressions my after-pass caught, only two were the conversion being wrong. The
rest were specs that knew too much about what they were testing:

- a popover's scrim classes (`.fixed.inset-0.z-30`) clicked through `evaluate` to close
  it — a `ShellPanel` has no scrim; use `[data-testid="<app>-panel-<id>-close"]`
- `getByTitle(...)` and `select[title=...]` — the shell's primitives name themselves
  with `aria-label` plus a Tooltip and set NO `title` attribute; use role + name
- toggles pressed blind twice, which closes what the spec wanted open
- `text=Untitled document` — `titleBackfill` derives a name from the content now. Note
  a doc with NO content is deliberately left untitled, which is why
  `documents.spec` Steps 7 and 8 still pass untouched

### Three shared helpers, in `tests/e2e/_helpers.ts`

- `selectBarTab(window, bar, tab)` — a tab's controls are only in the DOM while that
  tab is active. **Idempotent on purpose:** a second click on the ALREADY-active tab is
  a double-click, which collapses row 2 (owner ruling D5) and hides the controls you
  were reaching for.
- `showDocPane(window, pane)` — opens Write's side pane and selects a tab deterministically
- `showDocStyles(window)` — opens the Styles panel only when it is closed

`selectBarTab` takes the bar testid, so it is not Write-specific; d8's local `selectTab`
can switch to it.

### The first-run cards still eat clicks

`local-ai-intro` is `fixed bottom-12 left-1/2 z-[225]`, 420px wide. With a content pane
on the right its buttons land in that band and clicks never arrive while Playwright
reports the target visible, enabled and stable for the full 30s. Call
`chooseCloudAiSource(window)` after `waitForReady`. `suppressFeatureSpotlights` covers
the bottom-right card.

---

## Two product decisions recorded here

**Cells default row height is 20px, and SR2-5 is the stale side.** `DEFAULT_ROW_PX = 20`
with the comment "Excel default row height (15pt at 96dpi)" — arithmetically right
(15/72×96 = 20) and Excel's actual default; Google Sheets is 21px. History is decisive:
`416e3d36` introduced 28, then `b63d8053` ("Sheets: Excel cell sizing + arrow-key commit
navigation") deliberately changed it to 20. SR2-5 predates that commit and expects ~28.
The spec should move, not the app. If roomier-than-Excel rows are actually wanted, that
is a product call for the owner, not a test fix.

**`documents.spec` Steps 4 and 5 were stale, not broken.** Step 4 expected "Untitled
document" before auto-titling existed; Step 5 expected `#ERR` from `=1/0` before
`sheetFormula` grew typed errors (`#DIV/0!`, `#N/A`, `#VALUE!`, `#NAME?`, `#NUM!`,
`#REF!`, with `#ERR` kept as the fallback). Both updated to the behaviour the app has.
This clears the known red d2 was converting Deck against.

---

## Cells: what remains

Written and committed (`7fbc3f07`), typechecks, imported by nothing:
`sheet/cellsRibbon.tsx` (four tabs — Home, Insert, Data, Tools — plus the rail) and
`CellsChrome.tsx`.

Remaining: wire `SheetEditor` (2688 lines) the way `DocEditor` was wired, move the AI
panel onto `ShellSidePane` keeping `sheet-ai-collapse` via `collapseTestid`, add the
Cells `AppCase` row, and update the ten Cells specs — sheetEditor, sheetEditorV2,
sheetMerge, sheetNav, sheetRework, sheetAiPanel, sheetQueryMacros, sheetSparkline,
officeMenuBars, docWidgetDrop.

One behaviour change already in the ribbon: `SheetToolbar`'s Bold/Italic/Underline
passed `{ bold: true }` into a merging `applyFormat`, so the bar could set a mark but
never clear one and showed no active state, while the Format menu has always toggled
properly. As `BarToggle`s they read `activeFormat` and toggle, so bar and menu agree.

Known Cells reds from d8's 414-test baseline, to carry rather than chase:
`sheetAiPanel` AP-1 (copy change in `sheet-ai-connections-empty`), `sheetEditorV2`
SE-V2-4 (proven load-flaky — passes alone in 25.3s against a 30s timeout, so it tips
first whenever the machine is busy), `sheetQueryMacros` SQM-1 (timeout, not yet
characterised), `sheetRework2` SR2-5 (see the row-height decision above).

---

## One correction to the shared base-reds file

`/private/tmp/claude-501/office-shell/xapp-base-reds.txt` lists six Write tests that are
GREEN on this branch: docComments "add a comment…", DE-2, DE-10, DHS-1, DHS-5, DPS-5.
Re-take it after this merges, or those will be treated as known reds and a real
regression could hide behind one.

It also lists `docEditor` DE-9 as a base red. DE-9 PASSED in both of my clean-tree
baseline passes and both after-passes. Either it is load-dependent in the 414-test run
and not in the 104, or the two baselines were taken under different conditions. Worth a
second look before anyone treats it as permanently red.
