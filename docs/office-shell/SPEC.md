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

## 6. Per-app mapping (every toolbar AND inspector control)

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
- **Insert:** Text, Shapes, Image, Stock, Logo, Page `design-page-add`, Page-number frame, Work widget. These are one-shot inserts at a default position, keeping the `design-add-*` ids with their old meaning.
- **Arrange:**
  - Align `design-align-*` · Distribute · Group `design-group` / Ungroup · Forward/Back · Duplicate `design-duplicate` / Delete `design-delete-element`
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

### 6.4 PlexiiDeck (d2)
- **Rail:**
  - Select V `slides-tool-select` | Text T `slides-tool-text` · Shapes flyout (Rectangle M `slides-tool-rect`, Rounded `slides-tool-roundrect`, Ellipse L `slides-tool-ellipse`, Triangle `slides-tool-triangle`, Line \\ `slides-tool-line`; **armed**, D4; new `-tool-` ids per §4.1)
  - | Image · Table · Chart · Work widget
  - | bottom: AI (a rail `sidePane` item opening the AI pane).
- **Side pane (§2.5a, `testid="slides-side-panel"`):** the SlidesSidePanel CONTENT panes — AI assistant (`slides-ai-panel`) and comments — keep their ids. Its old property tabs (Slide/Layout) are still mapped to the Design tab below.
- **leftAside:** slide thumbnails, with `slides-add`.
- **Pin:** `slides-undo`, `slides-redo`.
- **Right slot:** Present.
- **Home** (selection-aware):
  - text: B/I/U, Colour, Align, Size, Font, Lists
  - shape: Fill, Border colour
  - all: Opacity `element-opacity`, Rotation `element-rotation`
- **Insert:** all inserts plus Templates… `slides-templates-btn` · New slide.
- **Design** (slide; the old "nothing selected" inspector and the Slide/Layout side tabs):
  - Layout ▾ (`slides-prop-layout`, `slides-layout-*`) · Theme (`slides-prop-theme`, `slides-theme-*`) · Background `slides-prop-background` · Transition · Master `slides-prop-master` · Slide font `slides-prop-font`
- **Arrange:** Position & size x/y/w/h · Align ×6 / Distribute ×2 · Group `slides-group` / Ungroup `slides-ungroup` · Forward/Back · Duplicate/Delete.
- **Ctx Shape:**
  - Fill, Border · Gradient `shape-gradient`, `shape-gradient-toggle`
  - Frame: Radius, Shadow `inspector-shadow`
- **Ctx Line:** Stroke, Arrow toggle.
- **Ctx Image:**
  - Alt `element-alt` · Fit mode · Lock aspect · Crop `inspector-crop` / Remove crop / Reset proportions
  - Frame: radius, shadow, border colour
- **Ctx Table:** +Row `table-add-row` / +Col `table-add-col` / −Row / −Col · Header row · Edit cells… (a panel holding `table-cells`).
- **Ctx Chart:** Title · Stacked · Type `chart-type` · Link a sheet range… `chart-link` · Refresh `chart-refresh`.
- **Animations** (a tab, enabled when something is selected): Entrance `element-anim` · Order.
- **Review:** Accessibility check · Speaker notes (`slides-notes-editor`). **Speaker notes stay under the canvas** (owner clarification); they are not a side pane.
- **File menu:** Import/Export (the Folder ▾ items).
- **Retired:** ElementInspector (`element-inspector`); its controls are mapped above. SlidesSidePanel's property parts are mapped above; its content panes move into `ShellSidePane` keeping `slides-side-panel`.

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
- **Insert:** Rows and columns (insert and delete) · Chart · Pivot · Sparkline · Lookup · Sheet · Named range · Meeting.
- **Data:** Sort ↑/↓ · **Filter** (BarToggle, the SAME state as the rail item; §3.7) · Conditional formatting… `sheet-condformat-btn` · Validation… `sheet-validation-btn` · Named ranges… · Macros… · Query….
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

## 9. Delivery and estimate (re-estimated for D1 and D4)

**Lead (d8):**
- **Shell** (ToolRail, flyouts, ContextBar with tabs/contextual/collapse/readOnly, ShellPanel, OfficeShellLayout with Row 1 folding, the narrow rules, primitives), plus unit tests (including "no document listener" and "one state per control"): **about 1 day**. The branch is announced when it lands, and converters start then.
- **Diagrams conversion** (the whole Inspector into tabs and panels, the library and layers as panels, armed shape modes, spec updates, `officeShellLayout.spec` for Diagrams at three sizes): **about 1.5 days** after the shell.

**Converter guidance.** These figures are the lead's guidance, not the converters' measurements; each owner confirms their own estimate. The side-pane amendment adds roughly half a day for Write, Deck and Design, which already have right panes to move:
- d1 (Draw): about 1.5–2 days (inspector to tabs, Layers panel; the rail maps directly).
- d2 (Design plus Deck): about 3–4 days. These have the largest inspectors and both gain armed modes and a key handler.
- 3e (Write plus Cells): about 1.5 days (no inspectors; mostly toolbar mapping and Row 1 folding).

## 10. Review log

- **d1 (Draw), round 1:** §2.1, §2.2 and §2.4 fit. Added: bar `readOnly` and per-primitive disabled/reason/readOnlySafe; host-overridable `focusCycleKey`; no document listeners; the Draw contexts (Artboard, Path, Group/Isolation, Image, Object with Arrange and Transform Again); BarCustom density; bar shortcut tooltips. The right-dock request was superseded by owner D1, and those panels are now overlay ShellPanels.
- **d1, round 2:** ShellPanel `onRectChange` (pinned inset for Fit and zoom) and `returnFocus` on Esc; toggle chords stay the host's.
- **d2 (Design, Deck):** §6.3 updated for `design-start-btn` (Start from ▾, which replaced the templates and size buttons in 26960d67); D4 spec churn costed with the shared `placeElement` helper (§3.2); ids that change meaning get new `-tool-` ids (§4.1); the Start-from first-run self-open stays as d2 built it.
- **3e (Write, Cells):** menu bar kept; BarDialogButton; app-typed C; testid policy; menu-item testids. Round 2: one narrow/embedded behaviour (§2.6, §8); one state per duplicated control (§3.7); Import Word confirmed.
- **Owner:** D1 and D4 changed from the defaults; D2, D3 and D5 confirmed.
- **d1, conversion:** bar fields get `py-0` (text clipped at 24px); BarNumber reports only real changes on blur/Enter (no empty undo step); Draw has no content pane or bottom strip, so its AppCase omits `sidePane` and `corner`; Draw's focus-cycle key is ⌥F6 (F6/⌘F6 are Illustrator's).
- **Owner, v2.1:** "Keep panes on the right." D1 amended: `ShellSidePane` (§2.5a) for content panes; PlexiiAssist (Design) and every AI panel go there, not the rail bottom; Deck speaker notes stay under the canvas. Estimates in §9 are guidance. Lead built ShellSidePane plus the Diagrams AI pane, with unit tests and §8 checks 5–6.
