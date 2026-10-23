# Office shell: ToolRail + ContextBar (v2.1 contract, owner decisions applied, "keep panes on the right")

Owner request: *"For consistency, can all tools be a left strip of icons, same as Draw, for all office apps. That will save real estate and keep things consistent for the user regardless of which app they are using. Settings, such as font size, colour and area shading, should remain in a top banner, based on the tab selected, similar to Canva or Microsoft Office."*

Owner rulings (§7):
- **D1:** "Everything should be in the top bar or the left tool bar." There are no right inspectors.
  - **Amended (v2.1): "Keep panes on the right."** CONTENT panes (comments, outline, the AI assistant, conversations, lists you read and type in) stay on the right, in ONE shared, collapsible `ShellSidePane` (§2.5a). Property controls still go to tabs; tool panels (Layers, Library, Swatches, Preflight…) stay `ShellPanel` overlays (§2.4).
- **D2:** menu bar and tabs share one row.
- **D3:** contextual tabs don't auto-switch.
- **D4:** real armed modes in Deck and Design.
- **D5:** Row 2 collapses on double-click of the active tab, persisted per user.

Apps: PlexiiWrite, PlexiiCells, PlexiiDeck, PlexiiDesign, PlexiiDiagrams, PlexiiDraw.
Base: `integration-l8` @ 4611fe69. Lead: d8 (Diagrams). Converters: d1 (Draw), d2 (Design, Deck), 3e (Write, Cells).
This spec was written from a read-only inventory of every toolbar, menu bar, inspector and panel at 4ff812ad. The review log is §10.

---

## 1. Layout (every app, top to bottom)

```
┌ header row (existing, unchanged: back · title · share · saved) ──────────────────┐
├ Row 1: [File][Edit][View][Insert][…] │ [Home][Insert][Arrange][App…][Shape*] [▴] │  MenuBar + tab strip
├ Row 2: [↶][↷] │ …controls of the active tab (selection-aware)… │   [right slot]  │  ContextBar body
├────┬───────────┬────────────────────────────────────────────────────────────────┤
│Rail│ (navigator│                      canvas / page                             │
│40px│  optional)│        ┌─────────────┐  ← overlay panel (Layers, Library, AI…)  │
│    │           │        │  floats over │    opened from the rail bottom or a     │
│    │           │        │  the canvas  │    bar button, never a fixed column    │
└────┴───────────┴────────┴─────────────┴──────────────────────────────────────────┘
                 └ bottom strip (optional: Diagrams pages, Design page rail) ┘
```

- **Row 1** holds the existing menu bar (File, Edit, …), kept as in Office and Canva. Then, on the same row after a divider, the ContextBar's tab strip, then a collapse chevron (D5).
- **Row 2** shows the controls of the active tab:
  - Undo and Redo pinned at the left, on every tab, in every app;
  - a **right slot** at the right: zoom in canvas apps, word count or status in Write and Cells.
- **ToolRail:** 40px, on the left of the content row.
- **No right inspector (D1).** Every inspector setting lives in a ContextBar tab. Tool panels that aren't selection settings (layers, libraries, swatches, styles, data binding forms) open as **overlay panels** (§2.4) from a bottom-pinned rail item or a bar button. They float over the canvas and close or pin on request.
- **One right side pane (D1 as amended, §2.5a):** content panes (comments, outline, AI assistant) live in a single collapsible column on the right, one pane at a time, collapsing to a 28px edge tab. It is the only thing that reserves width on the right.
- **Navigator column** (optional, `leftAside`): Deck's slide thumbnails only. It's navigation, not tools or settings, like PowerPoint. Everything else that used to be a column becomes an overlay.
- **Bottom strip** (optional): page and slide strips that exist today (Diagrams pages, Design page rail).

## 2. Shared components (new, `src/renderer/src/components/office/shell/`)

The lead edits no app file except Diagrams, the first conversion. Draw's `render/Toolbox.tsx` belongs to d1.

### 2.1 `ToolRail<C>`

```ts
type RailKind = 'tool' | 'action' | 'panel'
interface RailItem<C> {
  id: string; label: string; icon: string
  kind: RailKind            // tool = an armed mode (sticky until done) · action = one-shot · panel = toggles an overlay panel
  group: number; order: number
  shortcut?: string         // ALREADY FORMATTED by the host from its live keymap. Absent = no key shown.
  hidden?: boolean | ((c: C) => boolean)
  disabled?: boolean | ((c: C) => boolean)
  disabledReason?: string | ((c: C) => string)
  readOnlySafe?: boolean
  flyout?: string           // items sharing a key render as ONE button with a flyout (§2.2)
  badge?: 'dot' | string    // indicator: has options, a modal state ("continuing path"), a count
  pinned?: 'bottom'         // panels and AI
  onSelect: (c: C) => void
  onOptions?: (c: C) => void          // double-click; the tooltip adds " — double-click for options"
  optionsHint?: string                // replaces that hint, e.g. armed shapes: "double-click to keep it selected"
  testid?: string                     // default `${railTestid}-${id}`
}
interface ToolRailProps<C> {
  items: RailItem<C>[]; ctx: C
  activeId?: string                   // HOST-DRIVEN, including temporary tools; it can also name an open panel
  openPanels?: string[]               // panel items show pressed while open
  lastUsed?: Record<string, string>; onFlyoutPick?: (flyout: string, id: string) => void
  readOnly?: boolean; footer?: ReactNode; testid: string; ariaLabel?: string
}
```

- **Registry-friendly.** Items are sorted by group, then order, with separators between groups. `hidden` is respected, and a keyless item shows no key.
- **No keyboard capture.** No document or window listener. Every key handled (↑/↓/Home/End roving, Shift+F10 for a flyout, Esc) is an `onKeyDown` on the rail's own buttons.
- **Active state:** `aria-pressed` with `bg-accent/15 text-accent`.
- **Look:** 32px buttons, 17px icons. Separators are `bg-[var(--edge-soft)]`.
- **Tooltips:** `components/Tooltip.tsx`, placed to the right: "Label (Key)" plus the options or disabled suffix. The tooltip is also the aria-label.
- **Read-only:** items without `readOnlySafe` are disabled with "not available: this document is read-only".
- **Armed modes (D4):** a `tool` item arms a mode in the HOST (Draw, Diagrams, and now Deck and Design). The rail only shows `activeId`.

### 2.2 Flyouts (v1 renders them)

- Items with the same `flyout` show as one button: the host's `lastUsed[flyout]`, or the lowest order when there's none. A corner triangle marks it.
- **Open:** press and hold (350 ms), click the triangle, or Shift+F10. The popover is a list of `menuitemradio` items with shortcuts, and the active item is checked.
- Picking an item calls `onFlyoutPick` and then `onSelect`.
- Cycling with Shift plus the group key is the host keymap's job.

### 2.3 `ContextBar<C>`

```ts
interface BarTab<C> {
  id: string; label: string
  when?: (c: C) => boolean        // contextual tab
  contextual?: boolean            // contextual styling (accent marker)
  render: (c: C) => ReactNode
}
interface ContextBarProps<C> {
  tabs: BarTab<C>[]; ctx: C
  activeTab: string; onTabChange: (id: string) => void          // host-owned, persisted per app
  collapsed?: boolean; onCollapsedChange?: (v: boolean) => void // D5: double-click the active tab; the host persists it per user
  pinnedStart?: ReactNode         // Undo / Redo (required)
  rightSlot?: ReactNode
  menuBar: ReactNode              // the existing menu bar, rendered on Row 1 before the tabs
  readOnly?: boolean              // greys out controls that aren't readOnlySafe, with a reason
  focusCycleKey?: string | null   // default 'F6', host-overridable; the HOST binds it and calls the exposed focusBar()
  testid: string                  // existing toolbar ids survive (doc-toolbar, sheet-toolbar, …)
}
```

- **Contextual tabs** appear while `when(ctx)` is true and don't steal focus (D3). If the active tab's `when` turns false, the bar falls back to **Home**.
- **Home is selection-aware.**
- **Keyboard scope (binding):**
  - The tabs are a tablist with ←/→ and Home/End.
  - Row 2 is a toolbar with a roving tabindex.
  - Everything is handled by `onKeyDown` on the bar's own elements, with **no document or window listeners**. With the canvas focused, arrows, Enter and letters belong to the app.
- **Collapse (D5):** double-clicking the active tab, or the chevron, hides Row 2. The tabs stay. The host persists the choice per user.

### 2.4 `ShellPanel` (overlay panels, replacing every right column; D1)

```ts
interface ShellPanelProps {
  id: string; title: string; icon?: string
  open: boolean; onClose: () => void
  width?: number                  // default 280; clamped to the canvas width (§2.6)
  pinnable?: boolean              // pinned panels stay open while you work on the canvas (Layers, Library); unpinned ones close on an outside click or Esc
  pinned?: boolean; onPinnedChange?: (v: boolean) => void   // host-owned, persisted per app
  onRectChange?: (rect: DOMRect | null) => void   // reported while open AND pinned (ResizeObserver), so the host can inset the viewport: Fit and zoom-to-selection centre art in the visible area (d1 review)
  returnFocus?: () => void        // where focus goes when the panel closes (e.g. the canvas); default is the opener
  children: ReactNode; testid: string
}
```

- **One place for every panel:** a column beside the rail, over the canvas's left edge, whether it was opened from the rail or a bar button. A panel opened from the bar never drops from that button, so people always find panels in the same spot, and pinned panels stack top to bottom in that column.
- The panel floats over the canvas with `fb-glass-panel`, within the editor's bounds.
- It never covers the rail or the bar, and is never under the floating menu.
- Several pinned panels stack vertically.
- **A pinned panel never covers the page (rule, every app).** A pinned panel stays while you work, so the content beside it must be reachable: a page-based app (Deck's slide, Design's page, Write's sheet) lays its page out past every pinned panel, using `onRectChange` (reported while open and pinned; measured from the panel, which is absolute, so the inset never moves it and cannot oscillate). An infinite canvas (Diagrams, Draw) insets Fit and zoom-to-selection instead. Unpinned panels are transient and may cover the canvas. `ShellPanel` reads `onRectChange` through a ref, so a host may pass an inline callback and keep the inset in state without a render loop. Guarded by `officeShellLayout.spec` (the AppCase `page` field: with the panel pinned, the page's left edge clears the panel's right edge) at the default and 480px sizes. Found in Design: a pinned Layout panel covered 113px of the A4 page, and a marquee started on it selected nothing while Playwright called the target visible.
- Esc (while focus is in the panel) closes an unpinned panel and calls `returnFocus` (canvas), or else focuses the opener. Panel toggle chords (e.g. Illustrator's F7 for Layers) are the HOST's keymap's job. The panel registers no global key listener.

### 2.5a `ShellSidePane` (the ONE right content pane; owner: "keep panes on the right")

```ts
interface SidePane {
  id: string; title: string; icon: string
  render: () => ReactNode
  badge?: string                  // e.g. an open-comment count; shown on the tab and the edge tab
  testid?: string                 // the pane CONTENT keeps its existing id (doc-comments-tab, sheet-ai-panel…)
  tabTestid?: string              // its switcher tab keeps an existing id (doc-tab-comments); default `${testid}-tab-${id}`
}
interface ShellSidePaneProps {
  panes: SidePane[]
  activeId: string | null         // null = collapsed to the edge tab. HOST-owned, persisted per app (e.g. plexii.<app>.sidePane)
  onChange: (id: string | null) => void
  width?: number                  // default 320 (SIDE_PANE_WIDTH)
  testid: string                  // the pane root (doc-side-panel, slides-side-panel); prefixes -expand, -collapse, -edge, -open-<id>, -tab-<id>
  collapseTestid?: string         // keep an existing collapse id (sheet-ai-collapse)
}
```

- Rendered by `OfficeShellLayout`'s `rightPane` slot, right of the canvas column, never inside it (it never covers the canvas, rail, bar or overlay panels at normal widths).
- **What goes here:** panes you read and type in — comments, outline, the AI assistant (PlexiiAssist, the slides AI, the sheet AI, the Diagrams AI), conversations, lists. **Not** property controls (tabs) and **not** tool panels (ShellPanel overlays).
- **One pane at a time.** With two or more panes the header is a switcher (`role="tablist"`); with one it shows the title. The header's collapse button (`${testid}-collapse`) collapses it.
- **Collapsed:** a 28px edge tab (`${testid}-edge`, DOM id `shell-sidepane`) with an expand chevron (`${testid}-expand`, reopens the pane you last had open) and one opener per pane (`${testid}-open-<id>`, badges kept). `doc-side-panel-expand` falls out of the naming.
- **Only apps that HAVE content panes render one** (Draw has none: no ShellSidePane, no toggle, no edge tab; an app never fakes a pane to satisfy the shell). **Toggled from the top bar:** every app with panes puts a `BarToggle` in the ContextBar right slot (`<app>-sidepane-toggle`, `controls={SIDE_PANE_DOM_ID}`). A rail item may also open a pane: `kind: 'panel', sidePane: true` sets `aria-controls="shell-sidepane"`; the host lists that item id in `openPanels` while its pane shows, so it renders pressed. Bar buttons that open a pane (Insert › AI diagram) only open, never close.
- **Narrow (§2.6):** below 520px of shell width it opens as a sheet over the canvas (`data-sheet="true"`, full height of the content row, leaving the 40px rail visible). Esc inside the sheet collapses it. Docked, Esc is left to the app.
- **Sheets stack by recency (shell-owned):** an overlay panel and the side pane can both be sheets at once; whichever opened LAST is on top, so its close is reachable. `ShellPanel` and `ShellSidePane` report opening to `OfficeShellLayout` (`raise`), which lifts the panels column above the pane when a panel opened last. Apps do nothing. (Found in Design: the pane, z-40, covered a panel's close in a 480px widget.)
- **Collapse id ruling:** the collapse button's test id is `${testid}-collapse` unless `collapseTestid` keeps a legacy id (`sheet-ai-collapse`). App-agnostic code (the §8 guard, helpers) finds it by the shell's structural hook `[data-shell-role="sidepane-collapse"]` inside the pane, never by deriving the id, so no per-app configuration is needed and none can drift.
- **No focus grab and no global key listener.** A pane that reopens on load must not steal the keyboard or scroll its container (no `autoFocus` inside panes); focusing on an explicit open is the pane content's job.
- **Remembered per app:** the host persists `activeId` (Diagrams: `plexii.diagram.sidePane`).

### 2.5 Bar primitives (one look everywhere)

| Primitive | Use |
|---|---|
| `BarToggle` | on/off (Bold, Merge, Guides, **Filter**) |
| `BarButton` | one-shot (Sort A→Z, Tidy) |
| `BarDialogButton` | **opens a dialog or overlay panel**: Conditional formatting…, Validation…, Pivot…, Data source…, Styles…. Shown as an icon plus label with "…" (`aria-haspopup="dialog"`), and grouped at the END of a tab |
| `BarSelect`, `BarNumber` | font size, number format, stroke width, X/Y/W/H |
| `BarColor` | text colour, fill, highlight, stroke (palette popover, plus "none" where allowed) |
| `BarMenu` | dropdown (Align ▾, Layout ▾, Export ▾) |
| `BarGroup`, `BarSep` | labelled clusters and dividers |
| `BarCustom` | app widgets (FontPicker, the arrow picker, the 9-point reference). Row 2 is 36px with 24px fields, so a compact Transform cluster fits; a "Transform…" dialog is the fallback |

Every primitive takes `disabled`, `disabledReason`, `readOnlySafe`, `shortcut` (host-formatted, for the tooltip) and `testid`.

### 2.6 `OfficeShellLayout`, plus narrow and embedded behaviour (3e's (a): ONE behaviour for all six apps)

```ts
interface OfficeShellLayoutProps {
  bar: ReactNode; rail: ReactNode; children: ReactNode
  leftAside?: ReactNode           // navigator only (Deck thumbnails)
  bottom?: ReactNode              // page or slide strip
  panels?: ReactNode              // the open <ShellPanel>s
  rightPane?: ReactNode           // the one <ShellSidePane> (§2.5a)
  testid: string
}
```

Editors also run inside desk widgets (OfficeDocWidget: doc 860×760, sheet 880×580, resizable smaller). The shell measures itself with a `ResizeObserver` on its own root, never the window:
1. **Row 1 overflow:**
   - First, the menu bar folds into a single **"≡" menu button**. Its menus become submenus, and the menu testids stay on the items.
   - If the tabs still don't fit, trailing tabs fold into a **"More ▾"** tab. The active tab and any visible contextual tab are never folded.
2. **Row 2 overflow:** horizontal scroll with edge fades and chevrons. No control is ever hidden.
3. **Rail:** always 40px. When the editor is shorter than the rail, the rail scrolls vertically (`overflow-y-auto`). Flyouts and tooltips are portalled and clamped to the window, so they're never clipped by the widget.
4. **Panels:** below 520px editor width, a `ShellPanel` opens as a sheet covering the canvas (full width), still never covering the rail or the bar.
5. **leftAside** (Deck thumbnails) collapses to a toggle below 640px editor width.

These thresholds are constants in `office/shell/layout.ts`, so every app shares them.

## 3. Consistency rules

1. **Common rail order** (if an app has the tool, it is in this place):

| Group | Items, in order |
|---|---|
| 0 Navigate | **Select** (V) · Direct/Group select (Draw) · **Hand** (H, where pan exists) |
| 1 Create | **Text** (T) · **Shapes** flyout (Rect M · Rounded · Ellipse L · Triangle · Polygon · Star · Line \\) · Pen and path tools (Draw) |
| 2 Insert | **Image** · Icon/Stock/Logo · **Table** · **Chart** · Sticky note · Link · Divider |
| 3 App | app-specific tools |
| bottom | **overlay panels** (Layers, Library, Swatches…) · **AI** (always last, `auto_awesome`) |

   Write and Cells start at group 2. Deck, Design, Diagrams and Draw start with **Select**.
2. **Armed modes (D4)** apply in every canvas app: Deck, Design, Diagrams and Draw.
   - Pressing a `tool` arms it, and the cursor changes.
   - Click places the default size; drag sizes it.
   - After placing, the app returns to **Select**, as PowerPoint and Canva do. Double-clicking a tool keeps it armed until Esc or V, as Illustrator's "tool lock" does.
   - Esc always returns to Select.
   - Each app has **one** key handler (its existing one: Draw's keymap, Diagrams' `handleKey`, and a new handler in Deck and Design built the same way). The rail and the bar never handle keys.
   - **Cost of D4, made explicit.** Turning one-shot adds into armed modes changes every e2e spec that clicked a tool and then asserted on the new element: about 29 call sites in 11 specs for Design and Deck, plus the Diagrams shape specs. Each converter updates them in the same PR, through ONE shared helper in `tests/e2e/_helpers.ts`: `placeElement(window, app, tool, at?)` arms `${app}-tool-${tool}`, then clicks the canvas at a default point (or `at`) and returns the new element's id. That's a one-line edit per call site. d2 adds the helper with the first conversion that needs it; the lead's Diagrams conversion uses it too.
3. **Icons, one per concept:**
   - select `arrow_selector_tool`, hand `pan_tool`, text `title`
   - rect `crop_square`, rounded `rounded_corner`, ellipse `circle`, triangle `change_history`, line `horizontal_rule`
   - image `image`, table `grid_on`, chart `bar_chart`, sticky `sticky_note_2`, link `link`
   - layers `layers`, AI `auto_awesome`, find `search`, undo `undo`, redo `redo`
4. **Shortcuts:**
   - Bare letters apply in canvas apps only, for modes: V, H, T, M, L, \\. Draw keeps its full Illustrator map and remapping; the other apps don't take Draw's R, O or S.
   - Write and Cells get no bare letters.
   - Labels are always host-formatted from the live keymap.
5. **Tabs:** **Home** · **Insert** · **Arrange** (canvas apps) or **Layout** · app tabs · **View** · **Review** · contextual tabs last.
   - Every rail insert also appears on Insert, together with the menu-only inserts.
6. **The menu bar stays the complete command index.**
   - Nothing is removed from a menu.
   - A command that lived only in a toolbar or inspector gets a menu entry too (e.g. File → Import Word (.docx)).
7. **One state per control (3e's (b)).** When a control appears in two places (the rail and a tab, or a tab and a menu), both read the SAME host state and call the SAME command. For example, Cells' Filter is pressed in the rail exactly when the Data tab's Filter toggle is on. A unit test per app asserts it.
8. **House style:** tokens only, the subtle treatment, no new radius values.

## 4. Testid policy

- Container ids survive through the `testid` props. ContextBar keeps `doc-toolbar`, `sheet-toolbar`, `slides-toolbar`, `diagram-toolbar`, and `design-toolbar` (new). Rails are `doc-rail`, `sheet-rail`, `slides-rail`, `design-rail`, `diagram-rail` and `draw-toolbox` (kept).
- Tabs are `${barTestid}-tab-${id}`. Panels are `${app}-panel-${id}`.
- A control keeps its testid wherever it moves, **including inspector controls moving into tabs** (`diagram-fill`, `element-opacity`, `design-font-size`…). Controls without an id get `${app}-${id}`.
- **4.1 Ids whose MEANING changes get NEW ids (d2 review).** A control that was a one-shot "add" and becomes an armed tool must not keep its `*-add-*` id. That would let an old spec click it, place nothing, and pass vacuously. Armed rail tools use `${app}-tool-${id}` (`design-tool-rect`, `slides-tool-ellipse`, `diagram-tool-process`); `diagram-tool-select/-pan/-text` already follow this. One-shot inserts that remain (the Insert tab, the Diagrams Library panel) keep their `*-add-*` ids and old meaning. Specs written against a changed control must fail loudly at conversion, and are rewritten there.
- Retired container ids (`diagram-inspector`, `element-inspector`, `design-inspector`, `design-canvas-inspector`, `draw-inspector`, `slides-side-panel`) are removed. The specs that waited on them are updated in the same PR to wait on the new tab or control.

## 5. Rules for every conversion

1. **No feature disappears.** Each PR includes a mapping table, from current control to new home, plus a unit test that renders every tab and panel and checks each mapped testid is present.
2. **Drops proposed:** none.
3. **Keys:** one app handler; the shell adds none.
4. **Hit tests** at default size and narrow size (§8).

### 5a. Converting an app: the checklist (learned converting Diagrams, Draw, Write, Design, Cells and Deck)

Before handing a conversion back, every item, with evidence:

1. **Baseline first, by test id not file name.** Sweep `tests/` for every testid the retired surfaces carried (half the affected specs are not named for the app), run them on the base in a worktree with its own fixed `out/`, and key results by test title.
2. **Action parity.** Every callback the retired toolbar, inspector and panels had maps to a ribbon or rail action that calls the SAME editor function, not a rewritten lambda. Read each ported body against the original, line by line: nested shapes (gradients, crops, wrap modes, chart sources) are where ports go wrong while the testid survives (Design's wrap, Cells' Named ranges skipping the selection prefill).
3. **A mapping unit test** renders every tab for the selection that makes it apply and finds every mapped control (Diagrams, Deck).
4. **Armed tools are fully wired:** arm, place on click, size on drag, back to Select, lock on double-click, Esc, the suite keys, and the rail's last-used flyout member (host-owned `lastUsed` + `onFlyoutPick`). Placement must work over existing elements (capture phase).
5. **Selection-driven panels open pinned** (an unpinned panel closes on the canvas click that is the job), and **a pinned panel never covers the page** (§2.4).
6. **The host keeps `flex-1 min-w-0` and `min-h-0`** (§6), and nothing makes the desk widget's scroll container scroll.
7. **One copy of every control:** no bespoke control left beside its ribbon twin (the duplicate-testid scan, §8).
8. **No host outside-click or Escape handler** on anything inside a `BarPopover` or `ShellPanel`; they own both. Focus the popover's first control on open.
9. **Specs follow controls to their tabs** with `selectBarTab` (contextual tabs never switch on their own, D3; folded tabs need More ▾), and scope menu clicks to the menu's own testid (side menus carry tiles named like insert items).
10. **Specs that reach controls by TEXT are swept too:** a bar-scoped text locator (`slides-toolbar` › "Text") for a control that moved to the rail, or onto another tab, just times out. Check every text lookup against the tab and rail labels, as well as every testid (ec).
11. **Baselines are comparable only on the same spec code and the same bundle.** Take the base pass from a pinned checkout at the base SHA before editing specs; a base pass on edited specs silently shrinks the baseline while every count gate passes. Between tips, read any "fixed" entry on a spec you edited with suspicion (ec; the baseline diff tool records rev, spec hash and bundle hash and refuses mismatches).
12. **The tab sweep:** for every ribbon testid, every spec touching it selects its tab, even when it is green, because a new document can happen to open on that tab (f0).
13. **Gates:** `npm run typecheck`, `npm run lint:hooks`, the app's unit tests, `npm run build` with its log read (tsc passing is not proof rollup does), `npx playwright test --list` count after any rebase (a duplicate helper makes every spec silently collect 0), then the app's specs and its `officeShellLayout` rows. Heavy runs go through the shared queue. Four scripts do the mechanical parts: `scripts/pre-handover.mjs` (every typecheck config, lint:hooks, collection — run it last, before quoting a SHA), `scripts/check-converted-app.mjs` (items 7, 10 and 12), `scripts/e2e-pass.mjs` (records rev, spec hash and bundle hash into the log) and `scripts/e2e-baseline-diff.mjs` (item 11, and it refuses a verdict rather than printing a misleading one). Run EVERY typecheck config, not the one covering the code you touched: snippets shipped a TS4076 in `tsconfig.node` because only the web config was run (ec).
14. **A declared panel has an opener AND a body.** Cells' `CellsPanel` listed six ids and `PANEL_META` described six, while `togglePanel` had exactly ONE caller and `panelBody` returned null for five — six declared panels, one real, and an `officeShellLayout` row naming one of the dead ones waits forever for a panel that cannot appear. Declare an id only in the change that gives it both; leave a tool as its existing modal until it genuinely becomes a panel, and say so where the type is declared (ec).

## 6. Per-app mapping (every toolbar AND inspector control)

**Host rule (every app): the element that hosts `OfficeShellLayout` must be `flex-1 min-w-0` (and `min-h-0` in a column), as must every flex item between the app's root and the shell.** A flex item's default `min-width: auto` is its content's width, so one wrapper without `min-w-0` lets the editor grow to its widest toolbar instead of the space it was given. Full-window that can hide behind a wide screen; in a narrow desk widget it overflows the widget, the right slot and side pane fall off the edge, and Row 1 never folds because the bar thinks it has room. Write hit this, and so did Draw. The narrow-embed row of `officeShellLayout.spec` checks it and names each offending element with its classes and whether it is a flex item still at `min-width: auto` (§8). The same holds vertically: anything that makes the widget's scroll container scroll (a `shrink-0` notice, a column without `min-h-0`) lets focus slide the bar under the widget's header; the row names the elements past the bottom.

**Workcentre tiles are a second embedded host (4.3.41).** The Workcentre desk view (`WorkcentreView`) renders each object's full inline content in a grid tile, so a Write, Cells, Deck, Diagrams, Design or Draw tile mounts the same live editor a canvas widget does, under the same host rule. A tile can be made as small as the editor's minimum in `lib/widgetSizing.ts` (320×240 for every office editor; the free canvas uses the same table), and at that size Row 1 must fold and nothing may overflow the tile. `workcentre.spec` WC-4 checks this for a Write tile; WC-6 checks that tile handles sit on top and tiles stay clear of the floating menu in light and dark. The spatial canvas does not render while Workcentre is open, so an editor never mounts twice.

(R) = rail · Tab · Ctx = contextual tab · Pin = pinned in Row 2 · Panel = overlay panel · Menu = menu bar.

### 6.1 PlexiiDiagrams (lead)
- **Side pane (§2.5a, `diagram-sidepane`):** the AI (`diagram-ai-pane`, prompt `diagram-ai-prompt`, run `map-ai-run`), formerly a modal. Opened by the rail's `map-ai` (`sidePane` item), Insert › `diagram-insert-ai`, Edit-menu "AI diagram…" and the right-slot `diagram-sidepane-toggle`.
- **Rail:**
  - Select V `diagram-tool-select` · Hand H `diagram-tool-pan`
  - | Text T `diagram-tool-text` · Shapes flyout (Process `diagram-tool-process`, Decision, Terminator, Data, Database, Circle, as armed tools with new `-tool-` ids) · Sticky · Table · Image
  - The Library panel keeps its one-shot `map-add-*` buttons with their old meaning (click adds at the centre).
  - | bottom: **Library** panel (Shapes/Icons/Images, 430 shapes, pinnable; replaces the left library column) · **Layers** panel · AI `map-ai`
- **Pin:** `diagram-undo`, `diagram-redo`.
- **Right slot:** zoom `diagram-zoom`, fit `diagram-fit`.
- **Home** (selection-aware):
  - shapes: Bold `diagram-bold`, Italic, Underline, Font `diagram-font`, Size `diagram-font-size`, Text colour `diagram-text-color`, text align, Fill `diagram-fill`, Line colour `diagram-stroke`
  - lines: routing ×3, colour `diagram-line-color`, width `diagram-line-width`
  - always: Tidy `diagram-tidy`
- **Insert:** shape items · Text · Table · Sticky · Swimlane · Image… · Template… `diagram-templates` · From a Plexii table… · Work widget… (`diagram-data`, a dialog) · Mermaid… · AI diagram… · New page.
- **Arrange:**
  - Position & size cluster X/Y/W/H/Rotation (`diagram-x`, `diagram-y`, `diagram-w`, `diagram-h`, `diagram-rotation`)
  - order ×4 (`diagram-front`, `diagram-back`) · Group `diagram-group` / Ungroup / Lock `diagram-lock` / Hide / Show all hidden
  - Align ×6 `map-align-*` / Distribute `map-distribute-h`/`-v` · Rotate/Flip ×4 · Layout ▾ `map-arrange`
- **Ctx Shape** (nodes selected):
  - Change shape `diagram-change-shape` · Fill `diagram-fill`, Line `diagram-stroke`, Line width `diagram-stroke-width`, Line style `diagram-stroke-dash`
  - Opacity · Corners · Drop shadow `diagram-shadow` · Icon `diagram-icon-input` · Image (one image node) · Table rows/columns (table node)
- **Ctx Text** (nodes selected): Font, Size, B/I/U, Colour, Align, Vertical align, Label `diagram-label-field`.
- **Ctx Line** (edges selected): routing · Start `diagram-start-arrow` / End `diagram-end-arrow` arrowheads · Pattern `diagram-line-dash` · Colour · Width · Animated flow · Label `diagram-edge-label-field` · Reset route `diagram-reset-line`.
- **Ctx Data** (one node selected): Link & notes…, Custom data…, Data source… (BarDialogButtons opening panels, which keep `diagram-link`, `diagram-data-add/-key/-value`, `diagram-bind-table/-row/-template`, `diagram-add-rule`).
- **Design** (page):
  - Theme ▾ with 7 themes (`diagram-theme-*`) and Apply theme to every shape
  - Background `diagram-bg` · Grid `diagram-grid` · Grid size · Snap `diagram-snap` · Guides `diagram-guides` · Minimap
  - New lines `diagram-default-routing` · Default arrow · Line jumps `diagram-line-jumps` · This page
- **View:** Find `diagram-find` · Fit/zoom · panels.
- **Retired:** the right Inspector, the left library column (now a Library panel), and the separate layers popover (now a Layers panel).

### 6.2 PlexiiDraw (d1)
- **Rail:** the registry, unchanged. Fill and stroke chips in `footer`. Bottom: **Layers** panel (pinnable); later Swatches, Appearance, Symbols and History panels. Flyouts follow when d1 adopts them.
- **Right slot:** zoom `draw-zoom`, fit, grid, snap `draw-snap-toggle`, artboard size, `draw-status`. **The OptionsBar row is removed.**
- **Home:** Fill `draw-fill`, Stroke `draw-stroke`, width `draw-stroke-width`, dash `draw-stroke-dash`, opacity `draw-object-opacity`, blend `-blend`.
- **Object:** Transform cluster (or the "Transform…" fallback) · Align · Arrange · Transform Again.
- **Contextual tabs:**
  - **Ctx Type** (`draw-text-family`, `-size`, `draw-text-align-*`)
  - **Ctx Shape** (`draw-shape-sides`, `-inner`, `-radius`)
  - **Ctx Brush** (`draw-brush-*`, when the tool has `paint`)
  - **Ctx Anchors** (`anchorTool`)
  - **Ctx Artboard** (draw-fixes-41)
  - **Ctx Path** (Simplify…, Join, Average…, Pathfinder)
  - **Ctx Group/Isolation** (Isolate, Ungroup, clipping masks; the breadcrumb stays on the canvas)
  - **Ctx Image** (Replace…, info, Image Trace later)
- **Retired:** the right dock (DrawInspector moves to the tabs; Layers becomes a panel).

### 6.3 PlexiiDesign (d2)
- **Rail:**
  - Select V `design-tool-select` | Text T `design-tool-text` · Shapes flyout (Rect M `design-tool-rect`, Round `design-tool-roundrect`, Ellipse L `design-tool-ellipse`, Triangle `design-tool-triangle`, Line \\ `design-tool-line`; **armed modes**, D4; new `-tool-` ids per §4.1)
  - | Image `design-add-image` · Stock panel `design-stock-btn` · Logo `design-add-logo`
  - | bottom: Layers panel · AI design `design-ai-btn`
- **Side pane (§2.5a):** PlexiiAssist (`design-ai-panel` content). Opened by `design-ai-toggle` (keep the id on the right-slot side-pane toggle or a rail `sidePane` item); NOT a rail-bottom overlay.
- **Pin:** `design-undo`, `design-redo`.
- **Home** (selection-aware):
  - text: Font `design-font-family`, Size `design-font-size`, Colour `design-text-color`, B `design-bold`/I/U, Align `design-align-text-*`
  - shape: Fill `design-fill-color`
  - all: Opacity `design-opacity`, Rotation `design-rotation`
  - nothing selected: Background `design-bg-color`
- **Insert:** Text, Shapes, Image, Stock, Logo, Page `design-page-add`, Page-number frame, Work widget, Saved snippet… `design-insert-snippet` (the snippet library, design snippets, aimed at this design; also Insert › Insert snippet…). These are one-shot inserts at a default position, keeping the `design-add-*` ids with their old meaning.
- **Arrange:**
  - Align `design-align-*` · Distribute · Group `design-group` / Ungroup · Forward/Back · Save as snippet… `design-save-snippet` (also Edit › Save selection as snippet…; see docs/saved-snippets.md) · Duplicate `design-duplicate` / Delete `design-delete-element`
  - Layer `design-element-layer` · Wrap (`design-wrap-none`/`-square`, `design-wrap-offset`)
- **Layout:**
  - **Start from ▾** (`BarCustom` wrapping d2's self-contained `design-start-btn` / `design-start-menu`: every template and size by category, plus Custom size W × H in px/mm/in and orientation. It replaced `design-templates-btn` and `design-size-btn` in 26960d67) · Margins, columns &amp; layers… (the `design-layout-panel` controls, as a panel) · Guides `design-aids-toggle` · Facing pages · Master pages ▾
- **Brand:** Brandify `design-brandify` · Brand kit… · Swatches… (the `design-swatches-panel` controls) · Paragraph styles… (`design-styles-panel`) · Redesign… `design-redesign-btn`.
- **Review:** Preflight… (`design-preflight-panel`) · Accessibility `design-a11y-check` · Export ▾ `design-export-btn` (PNG, PDF, Bleed `design-bleed-input`, Print PDF).
- **Ctx Text** (threading): `design-open-story`, `design-story-columns`, `design-story-style`, `design-unlink`, `design-link-frames`.
- **Ctx Image:** Alt `design-alt`, Remove background `design-remove-bg`.
- **Retired:**
  - the right inspector (`design-inspector`, `design-canvas-inspector`);
  - the full-width toolbar Panel row (each panel becomes a ShellPanel);
  - the AI right column becomes the PlexiiAssist pane in `ShellSidePane` (owner amendment).
- **Kept:** the page rail (bottom); StoryEditor opens as a panel.

### 6.4 PlexiiDeck (d8, from d2's handoff)
- **Bar:** `slides-toolbar` (the ContextBar keeps the old toolbar's id, so every spec's "editor is open" wait still holds); menu bar `slides-menubar` on Row 1.
- **Rail** (`slides-rail`):
  - Select V `slides-tool-select` | Text T `slides-tool-text` · Shapes flyout (Rectangle M `slides-tool-rect`, Rounded `slides-tool-roundrect`, Ellipse L `slides-tool-ellipse`, Triangle `slides-tool-triangle`, Line \\ `slides-tool-line`; **armed**, D4: click places the default size centred on the press, drag sizes, back to Select; double-click locks; Esc disarms; new `-tool-` ids per §4.1)
  - | Image `slides-rail-image` · Table `slides-rail-table` · Chart `slides-rail-chart` · Work widget `slides-rail-widget`
  - | bottom: Layouts and themes (panel `slides-rail-layouts`) · PlexiiAssist (`slides-rail-ai`, a `sidePane` item).
- **Side pane (§2.5a, `slides-side-panel`):** PlexiiAssist (`slides-ai-assistant`; the per-slide actions keep `slides-ai-*`) · Generate deck (`slides-ai-generate`, holding the deck generator `slides-ai-panel`). Opens on first run when the editor is wide enough, never as a sheet over a narrow widget; remembered in `plexii.slides.sidePane`. Toggle `slides-sidepane-toggle` in the right slot.
- **leftAside:** slide thumbnails `slides-thumbnails`, with `slides-add`, `slides-duplicate-<i>`, `slides-delete-<i>`.
- **Pin:** `slides-undo`, `slides-redo`. **Right slot:** Present `slides-present` · side-pane toggle.
- **Home** (selection-aware):
  - nothing selected: New slide `slides-home-new-slide` · Duplicate slide · Layout ▾
  - text: Font `slides-font` · Size `slides-font-size` (+ presets ▾) · B/I/U `slides-bold`/`-italic`/`-underline` · Colour `slides-text-color` · Align ×3 `slides-align-text-*` · Lists `slides-list-bullet`/`-number`
  - shape: Fill `slides-fill`, Border colour `slides-border`
  - every single element: Opacity `element-opacity`, Rotation `element-rotation`
- **Insert:** one-shot Text box `slides-insert-text` · Image · Shape ▾ (incl. Line / arrow) `slides-insert-shape` · Table · Chart · Work widget · Saved snippet… `slides-insert-snippet` (the snippet library, slide snippets, aimed at this deck) · AI slides `slides-insert-ai` (the old toolbar's one-click deck generation: opens the side pane's Generate deck) · New slide · Templates… `slides-templates-btn`. These keep the old toolbar buttons' meaning (insert now, default position); the rail's tools are the armed versions.
- **Design** (slide):
  - Slide layout ▾ `slides-prop-layout` (items `slides-layout-*`) · Theme ▾ `slides-prop-theme` (items `slides-theme-*`, current one checked) · Background `slides-prop-background` · Transition `slides-prop-transition` · Slide font `slides-prop-font` (read from the theme) · Layouts and themes… `slides-prop-master` (the old "Master slides" button, which only ever showed the layouts; it opens the visual grids as a panel, `slides-panel-layout-*` / `slides-panel-theme-*`).
- **Arrange:** X/Y/W/H `slides-x`/`-y`/`-w`/`-h` · Align ▾ `slides-align-menu` (×6, plus centre on slide ×2) · Distribute `slides-distribute-h`/`-v` · Group `slides-group` / Ungroup `slides-ungroup` · Front/Forward/Backward/Back · Duplicate `slides-el-duplicate` / Delete `slides-el-delete` · Save as snippet… `slides-save-snippet` (also Edit › Save selection as snippet…; see docs/saved-snippets.md) · Frame: Radius `slides-radius`, Shadow `inspector-shadow` (every element but a line, as the inspector's Frame was). Disabled controls say why. The floating multi-select align bar (`slides-align-bar`) retired into this tab.
- **Ctx Shape:** Fill · Border colour and width · Gradient `shape-gradient` (start, end, angle, back to solid) / `shape-gradient-toggle`.
- **Ctx Line:** Colour `slides-line-stroke` · Width · Arrowhead `slides-line-arrow`.
- **Ctx Image:** Alt `element-alt` · Fit `slides-image-fit` · Lock aspect · Crop `inspector-crop` / Remove crop / Reset proportions · Border colour.
- **Ctx Table:** +Row `table-add-row` / +Col `table-add-col` / −Row / −Col · Header row · Edit cells… `table-edit-cells` (the "Table cells" panel holding `table-cells`, pinned by default because it is used with the selection).
- **Ctx Chart:** Title · Type `chart-type` · Stacked (bar/area) · Link a sheet range… `chart-link` · Refresh `chart-refresh`.
- **Animations:** Entrance `element-anim` · Order `slides-anim-order` · Slide transition (also on Design).
- **Review:** Accessibility check `slides-a11y-btn` · Speaker notes `slides-notes-focus` · PlexiiAssist. **Speaker notes stay under the canvas** (`slides-notes-editor`, the one notes editor; owner clarification).
- **File menu:** Import (.pptx) / Download ▸ PowerPoint, PDF (the toolbar's folder menu retired).
- **Keys:** the editor's one handler arms V/T/M/L/\\ and Esc disarms; the shell adds none.
- **Retired:** SlidesToolbar, ElementInspector (`element-inspector` and its section ids `inspector-table`/`-chart`/`-frame`/`-anim`), the side panel's Slide/Layout tabs (`slides-tab-slide`/`-layout`) and its second notes editor. `tests/unit/deckShellMapping.test.tsx` maps every old control to its new home.

### 6.5 PlexiiWrite (3e)
- **Rail** (actions): Image · Table · Link · Divider · Table of contents · Footnote · Work widget · bottom: Find · Ask AI.
- **Pin:** Undo, Redo.
- **Right slot:** "N words".
- **Home:** Styles `doc-styles-btn` · Font · Size · B/I/U/S · Code · Sub/Sup · Text colour · Highlight · Align ×4 · Line spacing · Lists ×3 · Clear formatting.
- **Insert:** the rail items plus Meeting.
- **Layout:** Page/Continuous · Page setup · Outline (opens the Outline pane) · Focus mode (collapses the side pane while on).
- **Side pane (§2.5a, `testid="doc-side-panel"`):** PlexiiAssist (`doc-ai-tab`, tab `doc-tab-ai`) · Comments (`doc-comments-tab`, tab `doc-tab-comments`, badge = open count) · Outline (`doc-outline-tab`, tab `doc-tab-outline`). `doc-side-panel-collapse` and `doc-side-panel-expand` are kept by the default naming.
- **Review:** Find &amp; replace · Word count · Accessibility · Comments (opens the Comments pane).
- **Ctx Table:** Add row below · Add column right · Delete row · Delete table.
- **Kept:** the bubble menu.
- **File menu:** File → Import Word (.docx), new and deliberate.

### 6.6 PlexiiCells (3e)
- **Rail** (actions):
  - Chart flyout (Bar, Line, Area, Pie, Scatter) · Pivot `sheet-pivot-btn` · Sparkline `sheet-insert-sparkline` · Lookup `sheet-lookup-btn` · **Filter** `sheet-filter-btn`
  - bottom: Macros panel `sheet-macros-btn` · Query panel `sheet-query-btn` · AI fill
- **Pin:** Undo, Redo.
- **Home:** Font · B/I/U · Text colour · Fill colour · Align ×3 · Merge `sheet-merge-btn` · Number format `sheet-number-format` · Clear formatting.
- **Insert:** Rows and columns (insert and delete) · Chart · Pivot · Sparkline · Lookup · Saved snippet… `sheet-insert-snippet` (the snippet library, sheet snippets, aimed at this spreadsheet; also Insert › Insert snippet…) · Sheet · Named range · Meeting.
- **Data:** Sort ↑/↓ · **Filter** (BarToggle, the SAME state as the rail item; §3.7) · Conditional formatting… `sheet-condformat-btn` · Validation… `sheet-validation-btn` · Named ranges… · Save as snippet… `sheet-save-snippet` (the selected range; also Edit › Save selection as snippet…; see docs/saved-snippets.md) · Macros… · Query….
- **Side pane (§2.5a):** SheetAiPanel (`sheet-ai-panel` content, `collapseTestid="sheet-ai-collapse"`); `sheet-ai-toggle` becomes the right-slot side-pane toggle (rail "AI fill" may be a `sidePane` item).
- **File menu:** Import/export.

## 7. Owner decisions (final)

| # | Decision |
|---|---|
| D1 | **No right inspectors.** Settings go in tabs; tool panels are overlays from the rail bottom or a bar button. **Amended: "Keep panes on the right"** — content panes (comments, outline, AI) live in ONE shared, collapsible `ShellSidePane` (§2.5a). |
| D2 | Menu bar and tabs on **one row**. |
| D3 | Contextual tabs **don't** auto-switch. |
| D4 | **Real armed modes** in Deck and Design (V/M/L/T/\\), each with its app's single key handler. |
| D5 | Row 2 **collapses** on double-click of the active tab, **persisted per user**. |

## 8. Hit-test and layout guard (`officeShellLayout.spec.ts`)

For each app, at the **default size**, then the **floating menu at 480px**, then a **narrow desk widget (480×360)**:
1. The rail's left edge is at or right of the `sidebar-dock` right edge minus 1px, and below the header row.
2. `elementFromPoint` (12px in, mid-height) hits the element itself for: the first and last rail item, every visible tab (or the "≡" and "More" buttons at narrow size), the pinned Undo, the first Row 2 control, and an open ShellPanel's close button.
3. An open panel never overlaps the rail or Row 1 or Row 2.
4. At narrow size: the menus are folded into "≡", no tab is clipped, and the rail scrolls rather than overflowing (never sideways).
5. The side pane (apps with content panes; the AppCase `sidePane` row is omitted otherwise, and `corner` is omitted for apps without a bottom strip): collapsed, its edge tab and the top-bar toggle are on top; opened, it sits right of the canvas (or as a sheet when narrow), never over the rail or the bar, its collapse is on top, and the rail is still on top.
7. **Every size runs in light and dark** (fb.theme.mode, asserted on `html.dark`). Each run also checks (`checkConsistency`): no shell control under a window drag region (Electron's last-region-wins rule on the visible part of each control); Undo/Redo on top on every visible tab and Row 2 36px on all; nothing right of the canvas but the side pane, no side pane in apps without content panes, the side-pane toggle in the bar; rail 40px; rail icon contrast ≥ 3:1 and tab label contrast ≥ 4.5:1. A style fingerprint per app/theme/size goes to `test-results/office-shell-fp`; `node scripts/office-shell-crossapp.mjs report` names any app that differs from the majority on shell-owned properties.
8. **Baselines are keyed by test title, never file:line** (`office-shell-crossapp.mjs diff base.json head.json` over Playwright JSON reports).
6. All rects for one assertion are read in ONE `evaluate` (a desk widget can still be settling), and the narrow widget sits outside the desk's 80px hover edge-pan zone.

## 9. Menu contract (4.3.41-local.2): menu bars and right-click, system wide

Owner: "fill any gaps or inconsistencies between menus in office apps, right-click context menus system wide. They should share functionality and layout for familiarity across the system." This section is the contract every menu is held to. It was written FROM THE MAJORITY: the office half from a runtime inventory of all six office apps (`tests/e2e/_menuInventory.spec.ts`: every menu-bar item and right-click menu as a person sees it, on a fresh build of cf547781), the rest from 2e's audit of every other right-click surface (`docs/context-menus/AUDIT.md`, 76a7a0f9). Where the majority is clear it rules; true ties are listed in §9.7 for 9d.

### 9.1 One primitive per kind of menu. No bespoke menus.

| Menu | The primitive (the only one allowed) | Owner |
|---|---|---|
| A menu bar (File, Edit, …) | `documents/editor/menuBarKit.tsx` (`MenuBarShell`, `MenuItem`) | d8 |
| Any right-click menu in the renderer | `components/CanvasContextMenu.tsx` (`CtxMenuItem`), "the context-menu kit" | d8 |
| Right-click on web content (webviews, browser, pop-ups) | native, `main/webContextMenu.ts` `buildWebMenu()` (stays native: it works over a webview and is fully accessible; E-8 below) | 2e |
| Labels, shortcuts, canonical groups | `lib/menus/` (new): `lexicon.ts` (every shared label), `shortcuts.ts` (one platform-aware hint formatter), `officeContextMenu.ts` (the office right-click builder), `editableFieldMenu.ts` (text fields) | d8 |

The kit gains, before anyone migrates: `danger` (destructive styling; the field exists and is ignored today), a checked state (`menuitemcheckbox` / `menuitemradio`, never text in the shortcut slot), focus return to the invoker on close, a portal (so a menu opened inside the zoomed canvas is not scaled or clipped), and `hint` (why an item is off, as menuBarKit already shows). Bespoke menus (Diagrams' `diagram/ContextMenu.tsx`, Draw's `draw/render/CanvasContextMenu.tsx`, Cells' column-header menu, and 2e's list: IndexContextMenu, table header, speed-deck, tray tab) move onto the kit; a guard (§9.8) fails on a new one.

### 9.2 Menu bars: order, contents, names (all six office apps)

**Order:** File · Edit · View · Insert · Format · ‹app menus› (Slide, Data, Arrange, Layout, Object, Layer, Document) · Tools · Window · Help. A menu an app genuinely has no items for is absent (Cells and Design have no View today: see §9.6).

**File** (same names, order and separators in every app; items an app cannot do are absent):
`New ‹document type›` · `Make a copy` | `Rename` · `Version history` | `Import…` (if the app imports; `Import ▸` when it imports more than one format) · `Download ▸` · `Print…` (if the app prints) | `Move to Trash`
- `Download ▸` is the export submenu everywhere (4 of 6 call it Download; Diagrams' `Export ▸` and Draw's three `Export … …` rows are renamed/grouped).
- The meeting item lives in **Insert** as `Meeting` (4 of 6), not File (Diagrams' "Start a meeting").
- Document items come from the host's `DocumentOps` and are ABSENT without one (§9.5).
- Draw keeps Illustrator's file conventions as app items between `Make a copy` and `Rename` (Open SVG…, Save, Place…, New from preset ▸); its `Export …` rows become `Download ▸`.

**Edit:**
`Undo` ⌘Z · `Redo` ⇧⌘Z | `Cut` ⌘X · `Copy` ⌘C · `Paste` ⌘V · `Paste in place` (where position means something) · `Duplicate` ⌘D · `Delete` ⌫ | `Select all` ⌘A | `Find…` ⌘F · `Find and replace…` ⇧⌘H (E-14) | `Save selection as snippet…`
- `Duplicate` (3 of 4) not "Duplicate selection"; `Delete` (right-click majority, and shorter) not "Delete selection".
- `Save selection as snippet…` belongs to Edit (5 of 6), with the ellipsis (it opens a dialog).
- Every app that can select has `Select all` (Cells, Deck, Design lack it today).
- App extras go after the shared block, behind a separator (Diagrams' Copy style / Paste style; Draw's Paste in Front / Back / on All Artboards, Copy As ▸, Deselect).

**Insert:** ‹app objects› | `Insert snippet…` · `Work widget from a desk…` | `Meeting`
- `Insert snippet…` (4 of 6), not Write's "Saved snippet".

**Format, app menus, Tools, Window:** app-specific, but a shared action keeps the shared name and shortcut (Group ⌘G, Ungroup ⇧⌘G, Bring to front ⇧⌘], Send to back ⇧⌘[, Align ▸, Clear formatting ⌘\, Check accessibility).

**Help:** `Keyboard shortcuts` ⌘/ (4 of 6), then app help (Diagrams' "How to diagram", Draw's "How PlexiiDraw works"). Draw's second shortcuts entry in Edit (⌥⇧⌘K) goes; Diagrams' `?` becomes ⌘/ (with `?` still bound).

### 9.3 Right-click: one structure everywhere

Groups in this order, one separator between non-empty groups, the destructive group always last behind its own separator (last on 12 of 12 surfaces in 2e's audit):

1. **Object actions** for what was clicked (Edit text, Open, Configure…, kind rows). **`Open` first, `Add to Focus…` second** on objects that have them (owner ruling E-1, 4.3.41; supersedes operator ruling CR-09 D-A, which put Add to Focus first).
2. **Clipboard:** `Cut` · `Copy` · `Paste` · `Paste as plain text` (text only) · `Duplicate`
3. **Arrange** (layered objects only): `Bring to front` ⇧⌘] · `Send to back` ⇧⌘[ (plus Group / Ungroup where the app groups)
4. **Plexii:** `Save selection as snippet…` · `Ask PlexiiAssist` (`… about this` on a selection) · `Add to Focus…` (when not already in group 1)
5. **More actions ▸** for anything beyond the first four groups (this is how the eight-item ceiling is kept, E-6)
6. **Destructive** (danger): `Delete` ⌫ in an editor's content; for a placed item, three explicit rows in this order: `Remove from ‹container›` · `Archive` · `Move to Trash` (owner ruling E-2; no chooser)

Three standard shapes:
- **On an object** (a shape, an element, a node, a cell, a widget): all six groups as they apply.
- **On empty canvas / page:** `Paste` · `Insert snippet…` | ‹create here› (Add text here, Add a box here, New artboard) | `Select all` ⌘A | view items (Fit, Zoom to selection).
- **On text** (Write's page, a Cells cell being edited, a text box being edited, any text field in the app): `Cut` · `Copy` · `Paste` · `Paste as plain text` | `Select all` | `Ask PlexiiAssist about this` · `Save selection as snippet…` (built by `editableFieldMenu.ts`; today the main window shows nothing at all on text, 2e §IMPACT-1).

Same labels, icons and shortcut hints as the menu bar for the same action; the icon set is the kit's (content_cut, content_copy, content_paste, control_point_duplicate, flip_to_front, flip_to_back, bookmark_add, bookmarks, delete).

### 9.4 Lexicon and format

- **Sentence case** (≈95% today). **"…"** (U+2026, never "...") when the item opens a dialog or picker (29 vs 6).
- **Move to Trash** (a named place in the app; 5 surfaces) for soft deletes of files and documents, everywhere, including all six File menus; **Delete** only for removing content inside an editor (a shape, a row, a slide); **Remove from ‹container›** for a placement; **Archive** bare.
- **Copy** (not "Copy text"); **Rename** (bare verb); **Duplicate** (independent copy) / **Duplicate, keep synced**; **Add to this desk**; **Add to Focus…**; **Share…**; **Ask PlexiiAssist**; **Make this a desk…**; **Copy link** (E-10).
- **Shortcut hints** come from `lib/menus/shortcuts.ts` only: Apple modifier order ⌃⌥⇧⌘ with glyphs on macOS (`⇧⌘Z`, never `⌘⇧Z`), `Ctrl+Shift+Z` elsewhere. A hint is shown only for a key that is actually bound (2e found ⌘C/X/V/D hints on the speed-deck with no binding).

### 9.5 Absent or disabled-with-reason

- **Absent** when the action cannot apply in this context at all: no document (no `DocumentOps`: a snippet session, a live document; already the rule since office-docops-41), a read-only viewer (no editing items; Copy stays), an app that lacks the capability (§9.6 lists each, with why).
- **Disabled, with a reason in `hint`** when the action applies here but not right now: nothing selected (Cut / Copy / Delete: "Select something first"), empty clipboard (Paste), at the first undo step (Undo), a locked object.
- Never a silently dead item: an enabled item always does something; a disabled one always says why.

### 9.6 The audit matrix (office apps, runtime inventory, cf547781)

Menus as they render (`·` = separator). Generated from `tests/e2e/_menuInventory.spec.ts` output, not typed by hand.

| Menu | Write | Cells | Deck | Diagrams | Design | Draw |
|---|---|---|---|---|---|---|
| File | New document, Make a copy, ·, Rename, Version history, Download ▸, Print (PDF) ⌘P, ·, Move to trash | New spreadsheet, Make a copy, ·, Rename, Version history, Import (.xlsx / .csv), Download ▸, ·, Move to trash | New presentation, Make a copy, ·, Rename, Version history, Import (.pptx), Download ▸, ·, Move to trash | New diagram, Make a copy, ·, Rename, Version history, ·, Import ▸, Export ▸, ·, Start a meeting, Move to trash | New design, Make a copy, ·, Rename, Version history, Download ▸, ·, Move to trash | New artwork ⌘N, Open SVG… ⌘O, Save ⌘S, Make a copy ⌥⌘S, ·, New from preset ▸, Place… ⇧⌘P, Place as template…, Import SVG…, Replace image…, ·, Export PNG…, Export SVG…, Export PDF…, ·, Rename, Version history, Move to trash |
| Edit | Undo ⌘Z, Redo ⌘Y, ·, Cut ⌘X, Copy ⌘C, Paste ⌘V, ·, Select all ⌘A, Find and replace ⌘⇧H | Undo ⌘Z, Redo ⌘Y, ·, Cut ⌘X, Copy ⌘C, Paste ⌘V, ·, Save selection as snippet… | Undo ⌘Z, Redo ⌘Y, ·, Cut ⌘X, Copy ⌘C, Paste ⌘V, Duplicate selection ⌘D, Delete selection ⌫, ·, Save selection as snippet… | Undo ⌘Z, Redo ⇧⌘Z, ·, Cut ⌘X, Copy ⌘C, Paste ⌘V, Duplicate ⌘D, Save selection as snippet…, Delete ⌫, ·, Select all ⌘A, Find and replace ⌘F, ·, Copy style ⌥⌘C, Paste style ⌥⌘V | Undo ⌘Z, Redo ⌘⇧Z, ·, Cut ⌘X, Copy ⌘C, Paste ⌘V, Duplicate ⌘D, ·, Delete selection ⌫, ·, Save selection as snippet… | Undo ⌘Z, Redo ⇧⌘Z, ·, Cut ⌘X, Copy ⌘C, Paste ⌘V, Paste in Front ⌘F, Paste in Back ⌘B, Paste in Place ⇧⌘V, Paste on All Artboards ⌥⇧⌘V, Copy As ▸, Duplicate, Delete ⌫, ·, Select all ⌘A, Deselect ⇧⌘A, Select all on active artboard ⌥⌘A, ·, Save selection as snippet…, Insert snippet…, ·, Keyboard shortcuts… ⌥⇧⌘K |
| View | Page view, Continuous view, ·, Show outline, Show comments, ·, Focus mode | **absent** | Present ▶, Check accessibility | Fit to view ⇧1, Zoom to selection ⇧2, Zoom in ⌘+, Zoom out ⌘−, Actual size ⌘0, ·, Shape library, Layers, Ribbon, ·, Grid, Snap to grid, Smart guides, Line jumps, Minimap | **absent** | Fit Artboard in Window ⌘0, Fit All in Window ⌥⌘0, Zoom to Selection, Zoom to 100% ⌘1, Next Artboard, Previous Artboard, Hide Artboards ⇧⌘H, ·, Grid ⌘', Snap to edges ⌘U |
| Insert | Image, Table, Table of contents, Footnote, Work widget from a desk, Saved snippet, Link ⌘K, Horizontal line, ·, Meeting | Row above, Row below, Column left, Column right, ·, Chart ▸, Pivot table, Sparkline, ·, Sheet, Named range, ·, Insert snippet…, ·, Meeting | Text box, Image, Shape ▸, Line, Chart, Table, Work widget from a desk, Insert snippet…, ·, Meeting | Process, Decision, Start / End, Data (I/O), Database, Circle, ·, Basic shapes ▸, Flowchart shapes ▸, Arrows shapes ▸, Containers shapes ▸, Callouts shapes ▸, Sticky notes shapes ▸, Tables shapes ▸, UML shapes ▸, ERD shapes ▸, BPMN shapes ▸, Network shapes ▸, Cloud shapes ▸, Org chart shapes ▸, Mind map shapes ▸, Wireframe shapes ▸, Plexii shapes ▸, ·, Text T, Table, Sticky note, Swimlane, Image…, ·, From a Plexii table…, Work widget from a desk…, Template…, Mermaid…, Insert snippet…, AI diagram…, ·, New page | Text, Image, Shape ▸, Line, Work widget from a desk, Insert snippet…, ·, Add page, Page-number frame, ·, Meeting | **absent** |
| Format | Text ▸, Paragraph styles ▸, Align ▸, Bullets & numbering ▸, ·, Clear formatting ⌘\ | Text ▸, Number ▸, Alignment ▸, ·, Conditional formatting, Clear formatting ⌘\ | Align ▸, ·, Group ⌘G, Ungroup ⌘⇧G | **absent** | **absent** | **absent** |
| Tools | Word count ⌘⇧C, Check accessibility, ·, Save selection as snippet | AI fill | **absent** | **absent** | Remove image background, ·, Preflight for print…, Print PDF (bleed + crop marks) | **absent** |
| Help | Keyboard shortcuts ⌘/ | Keyboard shortcuts ⌘/ | Keyboard shortcuts ⌘/ | Keyboard shortcuts ?, How to diagram | Keyboard shortcuts ⌘/ | How PlexiiDraw works F1 |
| Data | **absent** | Sort sheet A → Z, Sort sheet Z → A, ·, Create a filter, Data validation, Named ranges | **absent** | **absent** | **absent** | **absent** |
| Slide | **absent** | **absent** | New slide, Duplicate slide, Delete slide, ·, Move slide up, Move slide down | **absent** | **absent** | **absent** |
| Arrange | **absent** | **absent** | **absent** | Bring to front ⇧⌘], Bring forward ⌘], Send backward ⌘[, Send to back ⇧⌘[, ·, Group ⌘G, Ungroup ⇧⌘G, Lock / unlock ⇧⌘L, Hide, Show all hidden, ·, Align ▸, Distribute ▸, Rotate & flip ▸, ·, Tidy connections, Auto layout ▸ | **absent** | **absent** |
| Layout | **absent** | **absent** | **absent** | **absent** | Margins, columns & layers…, Paragraph styles…, Swatches & spot inks…, Show layout guides, Facing pages, ·, Master pages ▸, ·, ·, Add page, Duplicate this page, ·, Link text frames into one story, Unlink frame from its story | **absent** |
| Object | **absent** | **absent** | **absent** | **absent** | **absent** | Transform ▸, ·, Pathfinder ▸, Arrange ▸, Align ▸, Path ▸, ·, Group ⌘G, Ungroup ⇧⌘G, ·, Lock ▸, Unlock all ⌥⌘2, Hide ▸, Show all ⌥⌘3, ·, Clipping Mask ▸, Compound Path ▸, ·, Isolate selected group, Exit isolation mode, ·, Artboards ▸ |
| Layer | **absent** | **absent** | **absent** | **absent** | **absent** | New vector layer ⌘L, New paint layer |
| Document | **absent** | **absent** | **absent** | **absent** | **absent** | Artboard size… ⌥⌘P, Background ▸, ·, Meeting |
| Window | **absent** | **absent** | **absent** | **absent** | **absent** | Layers F7, Artboards, ·, Move focus: canvas, top bar, tools ⌥F6, Next tool in group |
| Right-click: surface / cell | **no menu** | **no menu** | **no menu** | Paste ⌘V, Insert snippet…, Add text here, Add a box here, Select all ⌘A, Tidy connections, Fit page ⇧1 | **no menu** | Undo ⌘Z, Redo ⇧⌘Z, ·, Cut ⌘X, Copy ⌘C, Paste ⌘V, Paste in Place ⇧⌘V, Copy As SVG Code, ·, Save selection as snippet…, Insert snippet…, ·, Group ⌘G, Ungroup ⇧⌘G, Bring to front ⇧⌘], Send to back ⇧⌘[, ·, New Artboard, Fit to Artwork Bounds, ·, Duplicate, Delete ⌫, ·, Select all ⌘A, Deselect ⇧⌘A |
| Right-click: object / header | **no menu** | Insert column left, Insert column right, ·, Freeze up to this column, ·, Group selected columns, ·, Delete column | **no menu** | Edit text Enter, Cut ⌘X, Copy ⌘C, Duplicate ⌘D, Save selection as snippet…, Delete ⌫, Copy style ⌥⌘C, Paste style ⌥⌘V, Bring to front ⇧⌘], Send to back ⇧⌘[, Zoom to shape ⇧2, Lock ⇧⌘L, Hide shape, Tidy these connections | (not probed) | (not probed) |

**Gaps and inconsistencies found (the office half; 2e's AUDIT.md has the rest):**

| # | Finding | Apps | Contract |
|---|---|---|---|
| G1 | **No right-click menu at all** on content | Write (text), Cells (cells), Deck (slide and elements), Design | §9.3 shapes, on the kit |
| G2 | Right-click menus are bespoke, without the kit's roles and keyboard | Diagrams (`diagram-context-menu`), Cells' column/row header menus (`sheet-col-menu`, `sheet-row-menu`: no clipboard group), Draw (its own menu) | move to the kit |
| G3 | Redo shortcut differs | ⌘Y: Write, Cells, Deck · ⇧⌘Z: Diagrams, Draw, Design (as ⌘⇧Z) | E-13 |
| G4 | Modifier order differs (⌘⇧ vs ⇧⌘) | Write (⌘⇧H, ⌘⇧C), Deck (⌘⇧G), Design (⌘⇧Z) | ⇧⌘ via `shortcuts.ts` |
| G5 | `Duplicate selection` / `Delete selection` vs `Duplicate` / `Delete` | Deck, Design | `Duplicate`, `Delete` |
| G6 | No `Duplicate` / `Delete` / `Select all` in Edit | Write (no Duplicate/Delete: text uses keys), Cells (none), Deck (no Select all), Design (no Select all) | add where the app selects objects; Write's text keeps its key behaviour (absent with reason, §9.6 exceptions) |
| G7 | Snippet items placed and named differently | Write: Tools › "Save selection as snippet" (no …), Insert › "Saved snippet" | Edit › `Save selection as snippet…`, Insert › `Insert snippet…` |
| G8 | Export named three ways | Download ▸ (4), Export ▸ (Diagrams), Export PNG/SVG/PDF… (Draw) | `Download ▸` |
| G9 | Meeting in File in one app | Diagrams (File › Start a meeting) | Insert › `Meeting` |
| G10 | Find shortcut | Write ⌘⇧H, Diagrams ⌘F | E-14 |
| G11 | Two Keyboard shortcuts entries / non-⌘/ | Draw (Edit ⌥⇧⌘K + Help F1), Diagrams (`?`) | Help › `Keyboard shortcuts` ⌘/ |
| G12 | "Move to trash" (6 menu bars) vs "Move to Trash" (5 right-click surfaces) | all | `Move to Trash` (E-15 if 9d prefers otherwise) |
| G13 | No View menu | Cells, Design | add View with the shared zoom items where the app zooms; otherwise absent with reason |

**Genuine exceptions (absent, with the reason):** these are the `EXCEPTIONS` in `tests/unit/officeMenuBarContract.test.tsx`, and the guard fails on any other missing row.

| App | Absent | Why |
|---|---|---|
| Write | Edit › `Delete`, `Duplicate` | running text: Backspace deletes characters, and there is no selected object to duplicate (the native text menu still has Cut/Copy/Paste) |
| Cells | Edit › `Duplicate` | a range has nothing "beside itself" to duplicate into; it is copied and pasted to a chosen cell |
| Cells | Insert › `Work widget from a desk…` | a cell holds a value; Cells has no surface a live widget can sit on |
| Cells | Arrange | cells do not layer |
| Design | Edit › `Find…`, `Find and replace…` | Design text lives in threaded rich-text stories; searching them needs the story editor (owner f0) |
| Draw | the shared File/Edit/Help layout, and the kit for right-click | Illustrator's layout and keys (⌘F/⌘B Paste in Front/Back, ⌥⇧⌘K shortcuts) for its users' muscle memory; the menu bar and right-click menu are built from Draw's command registry (owner d1). E-16 |

**Delivered (4.3.41-local.2, branch `menu-contract-41`):**

| # | Now |
|---|---|
| G1 | Cells cells (`sheet-cell-menu`), Deck elements and empty slide (`slides-context-menu`), Design frames and empty page (`design-context-menu`) open the kit's menu in the §9.3 shapes. Write's text, and any cell or text box being typed in, get the native text menu (2e's wp3) |
| G2 | Diagrams' menu and Cells' header menus are on the kit (roles, keyboard, focus return); every row they had is kept, the rows past the first four groups under `More actions ▸`; testids kept. Draw: E-16 |
| G3 | Redo shows `⇧⌘Z` everywhere and `⌘Y` stays bound (E-13); ⌘Y added to Cells and Deck, which lacked it |
| G10 | `Find…` ⌘F and `Find and replace…` ⇧⌘H in Write, Cells, Deck, Diagrams (E-14); ⇧⌘H opens the panel with its Replace row. In Write ⇧⌘H was TipTap Highlight's unadvertised default; Highlight stays on the toolbar and palette |
| — | Draw (E-16): `Download ▸` (PNG, SVG, PDF), `Move to Trash` last behind a separator, `Keyboard shortcuts` in Help. Its key stays Illustrator's ⌥⇧⌘K, because ⌘/ is Add new fill in Draw; so the bar claims a key only when its item shows that key |
| G4, G5, G7, G12 | every shared row takes its label and hint from the lexicon (`menuAction`) |
| G6 | `Select all` added to Deck, Design (with ⌘A), Cells; `Delete` to Cells (the ⌫ it already bound); `Find and replace…` built for Cells (the sheet's cells) and Deck (text boxes, table cells, notes) on one shared panel (`RecordFindReplace`, `recordFind`); Deck keeps each run's formatting |
| G8 | `Download ▸` in Diagrams |
| G9 | `Meeting` at the end of Insert in Diagrams |
| G11 | `⌘/` is bound by the menu bar itself (`MenuBarShell`), so it opens the app's sheet in every app; it used to open App's global sheet in five of them. `⌘F` likewise, where the editor has not taken it. Diagrams keeps `?` too |
| — | Hints that named unbound keys are bound now: ⇧⌘] / ⇧⌘[ in Deck and Design, ⌘G / ⇧⌘G in Design |
| G13 | open: a View menu for Cells and Design needs the zoom those apps do not have yet |

### 9.7 Calls for 9d (true ties, each with a recommendation)

**Decided 2026-10-23** (owner: E-1, E-2; 9d: the rest; relayed by 9d):

- **E-1 (owner): `Open` first, `Add to Focus…` second.** Overrides my recommendation and supersedes CR-09 D-A (§9.3 group 1).
- **E-2 (owner): three explicit rows**, `Remove from ‹container›` · `Archive` · `Move to Trash`, all danger, last (§9.3 group 6).
- **E-13:** Redo shows ⇧⌘Z; ⌘Y stays bound.
- **E-14:** ⌘F is Find, ⇧⌘H is Find and replace, wherever both exist; Draw excepted (⌘F is Paste in Front).
- **E-15:** `Move to Trash`.
- **E-6:** the eight-item ceiling via `More actions ▸`.
- Every other E-n: the recommendation below stands.

The calls as they were put:

- **E-13 Redo:** ⌘Y (3) vs ⇧⌘Z (3). Recommended ⇧⌘Z shown, ⌘Y also bound everywhere.
- **E-14 Find and replace:** ⌘F (Diagrams) vs ⇧⌘H (Write). Recommended ⌘F = Find and ⇧⌘H = Find and replace wherever both exist; Draw excepted.
- **E-16 PlexiiDraw (owner d1):** its menu bar and right-click menu come from its command registry, Illustrator's layout. Recommend d1 takes the lexicon labels (`Move to Trash`, `Download ▸` for the three exports, `Keyboard shortcuts` ⌘/ in Help) and renders its right-click entries through the kit, keeping its Illustrator-only rows and keys.
- **E-15 "Move to Trash" capital T** (recommended: Trash is a named place, like Focus) vs sentence-case "Move to trash".
- From 2e's audit (E-1 … E-12), with my recommendation: E-1 Add to Focus first (the ruling stands; **overruled**, see above); E-2 three explicit rows over the chooser (**decided** in the owner's order: Remove from ‹container› · Archive · Move to Trash); E-3 bare verbs (Open, Rename, Archive); E-4 `Share…` plus `Copy link` as rows, the rest under `Share ▸`; E-5 clipboard as group 2 everywhere, the Shift-bypass dropped once text fields have the §9.3 text menu; E-6 keep the eight-item ceiling via `More actions ▸`; E-7 drop the duplicate "Duplicate into another Room / Desk…"; E-8 web stays native; E-9 browser wording ("Close other tabs", "Close all tabs", "Pin tab"); E-10 `Copy link`; E-11 a standard menu with Rename first; E-12 one AI set of 8 everywhere.

### 9.8 Guards

- `tests/unit/officeMenuBarContract.test.tsx`: renders Write, Cells, Deck and Design's real menu bars and reads the menus they hand `MenuBarShell`: every shared row has the lexicon's label and hint wherever it appears; File, Edit first and Help last; Edit offers every shared action the app supports, in contract order (absences only via `EXCEPTIONS`, with reasons, as in §9.6); File ends with Move to Trash; Insert ends with the shared tail; Help has Keyboard shortcuts ⌘/; no stray or doubled separators. Mutation-checked.
- `tests/unit/officeContextMenus.test.ts`: the kit's object and empty-canvas shapes (`officeContextMenu.ts`) against `expectMenuContract` (2e's shared helper), plus a source guard: an office file that handles `contextmenu` and keeps menu state must use the kit (allowlist: Draw, E-16). Mutation-checked.
- `tests/unit/menuBarKeys.test.tsx`: the bar's ⌘/ beats App's global sheet, ⌘F yields to an editor that took it and to form fields, and a hidden bar answers neither.
- `tests/unit/recordFind.test.ts`: the shared find core, including run-preserving replace.
- `tests/unit/officeCommand.test.ts`: the adapters render one label, hint and reason on every surface; `ctxRow` refuses a silent disabled row; `documentCommands` reaches only its host's document (two hosts, two documents; seen red with a factory that kept the current ops); Print only where the host prints.
- `tests/unit/officeCommandRegistry.test.ts`: ids unique within and across apps; every command that can be off says why; centre/colour; no Mac glyph on Windows; a source rule that the converted surfaces carry no hard-coded glyph hint.
- `tests/unit/reorderZ.test.ts`: the undo snapshot survives a reorder; a multi-selection keeps its order.
- `tests/e2e/writeRibbonActions.spec.ts`, `deckOneAction.spec.ts`, `canvasOneAction.spec.ts`: one real-click proof per merged duplicate and per newly bound key.
- `tests/e2e/officeMenus.spec.ts`: by real clicks in the built app, per app: Edit and Help as rendered (order, labels, hints), ⌘/ opens the app's sheet and not the global one, ⌘F opens Find and replace, and a right-click on an object opens the kit menu (role=menu) in the shared order with Delete last in the danger colour and the menu bar's hints.

### 9.9 One definition per action (registry, 4.3.41-local.2)

Owner addition: "office app top menus aren't repeated, rather, combined and consistent so they all act the same." Rule (9d): every office action has ONE definition, an `OfficeCommand` (`lib/menus/officeCommand.ts`: id, label, keys, icon, enabled with its reason, checked, run). The menu bar (`menuItemOf`), the ribbon (`barProps`, `barMenuItem`), the right-click menu (`ctxRow`, through `objectMenu`/`canvasMenu`) and the palette (`paletteEntries`) render from it, so an action that appears on several surfaces is the same object on each: same name, same hint, same behaviour, by construction.

- Ids are the existing code ids (palette ids `sl-*`, `doc-*`; Draw's registry ids); new ones take the app's prefix (`dg-`, `ds-`, `ce-`). Never renamed.
- Hints come from `keys` only, through one formatter (`⌘` on macOS, `Ctrl` elsewhere). No surface writes a glyph string.
- File's document actions are built from the host-bound DocumentOps (`documentCommands`): no document id or store `active` lives in a registry; no ops, no rows (absent, §9.5).
- Diagrams' `cmd` and Draw's command registry adapt into it; nothing is rewritten.
- Right-click consumes the same commands through the kit (seam agreed with 2e): `ctxRow` throws on a disabled command without a reason. Editable text keeps the native menu.

Per app: Deck `slides/deckCommands.ts`, Diagrams `diagram/diagramCommands.ts`, Design `design/designCommands.ts` (d8); Write and Cells `buildWriteCommands`/`buildCellsCommands` (ec). Rails and ContextBar tabs: 82's rule and guards.

**True duplicates found and merged** (each with a proof seen red before the fix):

| App | Action | Was | Now |
|---|---|---|---|
| Write | Link, Word count, Check accessibility (ribbon) | wired to `setFindOpen(false)`: did nothing | the menu's command (`insertLink`; DocEditor owns the dialogs) |
| Write | Paste (menu) | inserted plain text, dropping formatting | ProseMirror's own paste (`view.pasteHTML`), the pipeline ⌘V runs |
| Deck | New slide | menu added a blank slide; ribbon and palette opened the gallery | one command: the gallery |
| Design | Bring forward / Send backward (ribbon) | moved only the first selected frame | `reorderSelected`, every selected frame |
| Diagrams | Bold / Italic / Underline | ribbon read the theme-resolved style of all selected shapes, ⌘B the raw style of the first | one `toggleTextStyle`; off writes false |
| Diagrams | Paste | menu pasted no outside data; right-click text only | one `pasteFromClipboard` feeding paste() what ⌘V carries |
| Deck, Design | stacking | `reorderZ` wrote through to the undo snapshot (Undo after a reorder did nothing); a multi-selection lost its order | copies; `reorderMany` keeps the selection's order |
| Write, Cells | Find, Highlight, Heading, Select all, Clear formatting, save-snippet body | two or three code paths each | ec's slice |

Labels taken to the majority: Fit page, Zoom to selection, Lock/Unlock (icon shows the action), Hide, Deck's align names, Download (not Export), Remove background, centre/colour (9d), Present (no fake ▶ hint). Keys that menus showed and nothing bound are bound: Deck and Design ⌘B/⌘I/⌘U on the selected text box or frame (through commit, so read-only cannot write).

## 10. Delivery and estimate (re-estimated for D1 and D4)

**Lead (d8):**
- **Shell** (ToolRail, flyouts, ContextBar with tabs/contextual/collapse/readOnly, ShellPanel, OfficeShellLayout with Row 1 folding, the narrow rules, primitives), plus unit tests (including "no document listener" and "one state per control"): **about 1 day**. The branch is announced when it lands, and converters start then.
- **Diagrams conversion** (the whole Inspector into tabs and panels, the library and layers as panels, armed shape modes, spec updates, `officeShellLayout.spec` for Diagrams at three sizes): **about 1.5 days** after the shell.

**Converter guidance.** These figures are the lead's guidance, not the converters' measurements; each owner confirms their own estimate. The side-pane amendment adds roughly half a day for Write, Deck and Design, which already have right panes to move:
- d1 (Draw): about 1.5–2 days (inspector to tabs, Layers panel; the rail maps directly).
- d2 (Design plus Deck): about 3–4 days. These have the largest inspectors and both gain armed modes and a key handler.
- 3e (Write plus Cells): about 1.5 days (no inspectors; mostly toolbar mapping and Row 1 folding).

## 11. Review log

- **d1 (Draw), round 1:** §2.1, §2.2 and §2.4 fit. Added: bar `readOnly` and per-primitive disabled/reason/readOnlySafe; host-overridable `focusCycleKey`; no document listeners; the Draw contexts (Artboard, Path, Group/Isolation, Image, Object with Arrange and Transform Again); BarCustom density; bar shortcut tooltips. The right-dock request was superseded by owner D1, and those panels are now overlay ShellPanels.
- **d1, round 2:** ShellPanel `onRectChange` (pinned inset for Fit and zoom) and `returnFocus` on Esc; toggle chords stay the host's.
- **d2 (Design, Deck):** §6.3 updated for `design-start-btn` (Start from ▾, which replaced the templates and size buttons in 26960d67); D4 spec churn costed with the shared `placeElement` helper (§3.2); ids that change meaning get new `-tool-` ids (§4.1); the Start-from first-run self-open stays as d2 built it.
- **3e (Write, Cells):** menu bar kept; BarDialogButton; app-typed C; testid policy; menu-item testids. Round 2: one narrow/embedded behaviour (§2.6, §8); one state per duplicated control (§3.7); Import Word confirmed.
- **Owner:** D1 and D4 changed from the defaults; D2, D3 and D5 confirmed.
- **d1, conversion:** bar fields get `py-0` (text clipped at 24px); BarNumber reports only real changes on blur/Enter (no empty undo step); Draw has no content pane or bottom strip, so its AppCase omits `sidePane` and `corner`; Draw's focus-cycle key is ⌥F6 (F6/⌘F6 are Illustrator's).
- **Owner, v2.1:** "Keep panes on the right." D1 amended: `ShellSidePane` (§2.5a) for content panes; PlexiiAssist (Design) and every AI panel go there, not the rail bottom; Deck speaker notes stay under the canvas. Estimates in §9 are guidance. Lead built ShellSidePane plus the Diagrams AI pane, with unit tests and §8 checks 5–6.
