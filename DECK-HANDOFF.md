# PlexiiDeck → office shell: handoff from d2 (Design)

Written for the agent taking Deck chunks 3 and 4. Design is converted (chunk 1 committed, chunk 2 in this commit), so everything here is "what I already hit, so you don't".

Branch to read from: `design-shell-l11`. Take the shared pieces from it rather than reinventing them.

---

## 1. The files, and what is in them today

| File | Lines | What it holds |
|---|---|---|
| `src/renderer/src/components/documents/SlidesEditor.tsx` | ~1000 | The editor: state, commands, key handler, the render. |
| `slides/SlidesToolbar.tsx` | 97 | The toolbar to retire. `slides-undo`, `slides-redo`, `slides-templates-btn` and the insert buttons. |
| `slides/ElementInspector.tsx` | 486 | The right inspector to retire (19 testids). Position/size, fill, border, gradient, radius, shadow, crop, alt, fit, animation. |
| `slides/SlidesSidePanel.tsx` | 480 | The right side panel to retire (23 testids): Slide/Layout/Theme/Background/Transition/Master/Font tabs. |
| `slides/SlideCanvas.tsx` | — | **Shared with Design. Do not fork it.** It already has armed-tool placement (see §3). |
| `editor/SlidesMenuBar.tsx` | — | Stays, and moves INSIDE the ContextBar as its `menuBar` (SPEC §1, D2). |

Per SPEC §6.4 the thumbnails rail becomes `leftAside` (navigation, not tools), the notes textarea **stays under the canvas** (owner ruling, confirmed by cb), and the AI panel goes into the shared right `ShellSidePane`.

## 2. What chunk 1 already did for you

- **`SlideCanvas` placement is done.** It takes `placing={{ kind, defaultW, defaultH }}` and `onPlace(kind, rect)`. Click places the default centred on the press; drag sizes it; the rubber band is the marquee's rectangle. Deck only has to own the tool state and call it.
- **It places over existing elements**, via `onMouseDownCapture`. Do not "simplify" that back into the marquee handler: wired there it bails unless the press is on empty stage, so arming a tool and clicking on top of anything already on the slide silently places nothing. That cost me a whole spec file before I found it.
- **`placeElement(window, app, tool, opts)`** is in `tests/e2e/_helpers.ts` (d8's). Mine is a four-line wrapper, `placeDesign`; write `placeSlide` the same way:
  ```ts
  export async function placeSlide(window: Page, tool: string, at?: { fx: number; fy: number }) {
    // CAREFUL: Deck has TWO. `slides-canvas` is the editor's wrapper
    // (SlidesEditor.tsx:751); `slide-canvas` — singular — is the shared
    // SlideCanvas's own stage, and it is the one the placement gesture and
    // the element boxes live in. Use `slide-canvas` for coordinates.
    const canvas = '[data-testid="slide-canvas"]'
    const box = await window.locator(canvas).boundingBox()
    return placeElement(window, 'slides', tool, { canvas, flyout: 'shapes', ...(at ? { at: { x: box.width * at.fx, y: box.height * at.fy } } : {}) })
  }
  ```
  **Pass fractions, not pixels.** The canvas is a scaled page; absolute coordinates land outside it and place nothing, which reads exactly like the tool being broken.
- **`selectBarTab(window, bar, tab)`** is in `_helpers.ts` too. It is idempotent (clicking an active tab is a double-click, which collapses Row 2 and hides what you are reaching for) and it opens the **More ▾** overflow when the tab has folded. Narrow windows fold trailing tabs, and which ones fold changes with the active tab's controls — a spec that assumes every tab is on the strip passes wide and fails narrow.

## 3. Testids: rename the ones whose meaning changes

SPEC §4.1. Armed rail tools are `slides-tool-rect`, `slides-tool-text`, … — NOT the old `slides-insert-*`/`*-add-*` ids. Clicking an armed tool places nothing until the canvas is used, so a spec written against the old id would pass while placing nothing. Let the old ids die with the old toolbar.

## 4. Five gotchas that cost me real time

1. **A portalled menu dies if the host also watches for outside clicks.** My Start-from menu kept its own `mousedown`-outside handler after moving to `BarPopover`. The panel is portalled to `document.body`, i.e. outside the component's wrapper, so pressing any row closed the menu before the click landed — every row looked dead, and the symptom was a *different* entry appearing to run. `BarPopover` and `ShellPanel` own outside-click and Escape; delete the host's.
2. **Escape is focus-scoped.** `BarPopover` handles Escape on its own element and registers no document listener (SPEC §2.4). If focus is still on the canvas, Escape reaches the editor's key handler instead and the popover stays open. Focus the popover's first control when it opens.
3. **Unpinned overlay panels close on an outside click — and the outside click is the job.** Swatches/Styles/Layout/Preflight are used *with* a selection: select a shape, then colour it. Unpinned they shut the moment you touch the canvas. Open those `pinnable` and `pinned`. Deck's equivalents: anything selection-driven (Edit cells…, Link a sheet range…).
4. **Diff every ported handler line by line** (3e's lesson, and it caught three of mine). The testid surviving means nothing:
   - `wrap` is `{ mode, offset }` on the element, not a string plus a sibling field — I ported the wrong shape and text would never have wrapped;
   - story columns live on the **document** (`design.columns`), not the element;
   - a style list I typed by hand instead of reading `LAYOUT_STYLES` would drift on the next preset.
   Deck has more of this than Design did: gradient, crop, fit mode, animation and the chart/table controls all carry nested shapes.
5. **`flex-1 min-w-0` on the host container.** Write and Draw both overflowed a 480px desk widget without `min-w-0`; a flex item will not shrink below its content without it. Check it survives on Deck's canvas container.

## 5. The test set to baseline BEFORE you touch anything

Sweep by testid, not by filename (3e's method) — half of Deck's affected specs are not named for Deck:

```
grep -rl "element-inspector\|slides-side-panel\|slides-prop-\|element-opacity\|element-rotation\|element-alt\|slides-group\|table-add-row\|chart-type\|inspector-crop\|shape-gradient\|slides-notes-editor\|slides-templates-btn\|slides-add" tests/
```

That is six files: `slidesEditor`, `slidesPanel`, `slidesTable`, `slideTemplates`, `docWidgetDrop`, `documents`.

Known state when I handed over:
- **Yours to fix** (cb assigned): `slidesEditor` SL-4, SL-5, SL-6, SL-8, SL-9 — all time out on the old toolbar and inspector, so your conversion rewrites their targets anyway. SL-4 drives `element-inspector`'s x/y/w/h, which become Arrange-tab `BarNumber`s.
- **Not yours**: `documents` Step 4 and Step 5 (Write and Cells, with 3e). I verified these fail at `e20ce2f6`, which predates every line any of us wrote here.
- **Fixed by c2**: `slidesTable` ST-1 and `slidesChart` SC-1/SC-2 — the specs' `text=Table` matched the side menu's work-widget tile before the Insert menu item. **Scope menu clicks to the menu's own testid** (`[data-testid="slides-menubar-insert-list"]`), because the side menu carries tiles named like many insert items.

## 6. Shared files

- `tests/e2e/officeShellLayout.spec.ts`: add **only** your `APPS` row (the loops are below it, so rows merge cleanly). Mine is there as a model; it passes at all three sizes. Note d8's newer version runs light and dark too, so titles carry the theme.
- `src/renderer/src/components/office/shell/*`: d8 (session 84) owns these. If a primitive needs changing, ask — do not patch it on your branch.
- `tests/e2e/_helpers.ts`: additive only. `placeElement`, `placeDesign`, `selectBarTab` and `chooseCloudAiSource` are all there already.
