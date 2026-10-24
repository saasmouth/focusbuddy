# Right-click context menus — system-wide audit (non-office surfaces)

Date: 2026-10-23. Branch `context-menus-41` off `cf547781`. Phase: **audit only**: no app source was changed.

Scope: every right-click menu **outside** the office apps (PlexiiWrite / Cells / Deck / Design / Diagrams / Draw, which session d8 owns along with the MENU CONTRACT, SPEC §9). The office editors are excluded throughout. That covers everything under `components/documents/**`, plus the `doc/sheet/slides/map/design/draw` widget bodies (`OfficeDocWidget.tsx`) and the `diagram` widget body.

Evidence convention: `file:line` is relative to `src/` unless it says otherwise. Every claim was checked by reading the source at `cf547781`. Anything not checked at runtime is marked **[unverified]**. No e2e tests were run in this phase (the brief said not to).

Environment note: `npm run typecheck` **fails on dependencies, not on code**. `node-llama-cpp` (`main/ai/local/engineCore.ts:28`) and `paper` (`shared/draw/geometry/paperEngine.ts:86`) are declared in `package.json` (lines 106, 108) but are missing from the cloned `node_modules`. `typecheck:web` fails only on `paper`. Following the brief, nothing was reinstalled. Whoever owns the migration build must restore those two packages (for example from the main checkout) before typecheck can be used as a gate.

Prior art: `docs/context-menu-system-spec.md` (the "Haptyx" spec) designed the unified resolver that exists today. Its §3, the browser menu drawn by the renderer over `context-menu:action`, was **not** what shipped. Since 4.3.39-local.4 web content gets a **native** Electron menu (`main/webContextMenu.ts:1-14`), and the old channel is now dead code (see F-12).

---

## 1. Inventory

### 1.1 Shared primitives that exist today

| # | Primitive | Where | Kind | Used by (right-click, in scope) |
|---|---|---|---|---|
| P1 | **`CanvasContextMenu`** (renderer) | `renderer/src/components/CanvasContextMenu.tsx` | Draws menus, portalled to `document.body` | Empty canvas, P2 (all widget menus), section handle, Files view and flyout, Files list header, side-menu work widget tiles and rail, app tiles, desk gallery cards, PlexiiAssist selection, ColumnsView move menu (left-click) |
| P2 | **Unified resolver**: `resolveMenu(ctx)` plus providers | `renderer/src/lib/contextMenu/{types,resolve,universal,aiAssist,providers,registry,buildContext,frameContext,actions}.ts`; glue in `components/contextMenu/{UnifiedWidgetMenu,UnifiedConnectedMenu,BrowserContextMenu}.tsx` | Turns data (a `MenuContext`) into `CtxMenuItem[]` and renders through P1 | Widget header (all kinds), widget bodies (sticky, note, markdown, page, field, file, table cell, mind map, browser chrome), multi-selection, focus-dock tiles, "More work widget actions…" from web pages |
| P3 | **`deskLifecycleMenuItems` / `lifecycleIndexActions`** | `renderer/src/lib/deskLifecycleMenu.ts:19-83`, `:96-153` | Item builders (data only) | Desk gallery (P1); Desks and Rooms index (P4) |
| P4 | **`IndexContextMenu`** plus the `IndexAction[]` model | `renderer/src/components/views/RoomsDesksIndex.tsx:38` (type), `:562-648` (renderer) | Its own renderer | All Desks, All Rooms (every view mode) |
| P5 | **`buildWebMenu` / `attachWebContextMenu`** (main) | `main/webContextMenu.ts:140-207` (pure builder), `:289-316` (Electron `Menu.popup`) | **Native** OS menu | Desk browser widget pages, standalone browser, connected apps, pop-ups |
| — | `Menu` in `components/plexi/controls.tsx:337-404` | popover API anchored to a trigger | **No callers found** (grep `<Menu` in files that import `plexi/controls` → 0). Not a context menu. Listed only so §9 does not mistake it for a live primitive. |
| — | `WidgetHeaderOverflow` (`components/widgets/WidgetHeaderOverflow.tsx`) | left-click "…" menu | Not right-click. Included because it has the **best a11y in the tree**: Escape returns focus to "…", per `tests/unit/widgetHeaderOverflow.test.tsx:79`. |

#### P1 `CanvasContextMenu`: exact API

```ts
export interface CtxMenuItem {
  label?: string
  icon?: string            // Material Symbols name
  entity?: EntityRef       // draws a Plexii icon; `icon` is the fallback
  shortcut?: string        // free text, right-aligned, mono 11px; no formatting or platform logic
  separator?: boolean
  disabled?: boolean
  onClick?: () => void
  children?: CtxMenuItem[] // submenu; nesting depth is unlimited
  testid?: string
}
props: { x: number; y: number; items: CtxMenuItem[]; onClose: () => void }
```

Behaviour (CanvasContextMenu.tsx):
- Portalled, `role="menu"`, `data-canvas-ctx-menu`, `data-floating-menu`, `.fb-context-menu`, `z-[260]` (lines 257-270).
- Rows are `<button role="menuitem">` with `aria-haspopup` / `aria-expanded` / `aria-disabled`. Separators are `role="separator"` (272-292).
- Root placement avoids the other floating chrome (`resolvePosition`, `collectMenuRects`; lines 119-132). Submenus flip left at the viewport edge (242-255).
- Registers as a menu overlay so edge-pan pauses (`useMenuOverlay`, line 114).
- Closes on an outside left or middle mousedown, armed 50 ms after opening. A right-button mousedown is ignored on purpose (44-59).
- Keyboard: ↑/↓ wrap, Home/End, → opens a submenu, ← steps out of one, Enter/Space activate, single-key type-ahead (600 ms buffer), Escape (182-239).
- **No** `danger` / destructive styling, **no** checked state, **no** `aria-label`, **no** focus return, **no** `aria-activedescendant` (see §3f).

#### P2 Unified resolver: exact API

- `MenuSection` enum (`types.ts:15-24`): `Context=0, AiAssist=1, Create=2, Convert=3, Organise=4, Share=5, Advanced=6, Destructive=7`.
- `MenuContext` (`types.ts:73-89`) has these fields:
  - `object`: `{type:'empty-canvas'} | {type:'widget', widget} | {type:'multi', widgets}`
  - `sub?: {granularity, payload}`
  - `selection?: {text?, imageUrl?, linkUrl?, sourceWidgetId, sourceKind}`
  - `taskId`, `canvasPoint`, `clientPoint`
  - `frame?: FrameCallbacks`
  - `headerExtras?: CtxMenuItem[]`
- `FrameCallbacks` (`types.ts:46-71`): `onMakeTask`, `onShare`, `onDuplicateSynced`, `onDuplicateIndependent`, `onDuplicateToFolder?`, `onEjectFromSection?`, `onUnlinkSynced?`, `onSaveAsFile?`, `onOpenFile?`, `onSaveAsSnippet?`, `onInsertSnippet?`, `onPaste?`. WidgetFrame supplies them (`components/widgets/WidgetFrame.tsx:678-706`). Widget bodies receive them through React context (`frameContext.tsx`, provided at `WidgetFrame.tsx:1637`).
- `MenuContribution` (`types.ts:97-111`): `{ id, section, group?, priority, label, icon?, shortcut?, danger?, predicate?, enabled?, disabledReason?, onSelect?, children? }`.
- Registration:
  - `registerWidgetContextActions(kind, provider)` or `(kind, granularity, provider)`. The provider returns `{ context: MenuContribution[], suppress?: Partial<Record<'ai-assist'|'create'|'convert'|'organise'|'share'|'advanced'|'destructive', boolean>> }` (`registry.ts:28-38`).
  - Plugins use `registerPluginContextActions(pluginId, provider)`, capped at 3 rows per plugin, and land under Advanced ▸ "Installed tools" (`registry.ts:82-107`, `resolve.ts:199-215`).
- Context builders: `buildContextForWidget(widget, {clientX,clientY}, {granularity?, payload?, selectionText?, frame?, headerExtras?})`, `buildContextForSelection`, `buildContextForMulti` (`buildContext.ts`).
- Rendering: `<UnifiedWidgetMenu menuContext onClose/>`, or the drop-in `<UnifiedConnectedMenu sourceWidgetId x y onClose selectionContext? granularity? payload?/>`. The second is imported as `ConnectedToolMenu` in six widgets.
- Fold rules (`resolve.ts:132-227`), in order:
  1. Attention row ("Add to Focus…") comes first.
  2. `headerExtras` are spliced in **unbounded**.
  3. The Context band inlines up to 2 rows (1 if Attention is present). Any more fold into "More actions ▸".
  4. "Paste" appears when `frame.onPaste` is set.
  5. "AI Assist ▸" appears only when there is workable text.
  6. "Create & link ▸" holds both the create entries and a disabled "Copy into" header followed by the convert targets.
  7. Organise, Share and Advanced each inline when they have one row and become a submenu when they have more.
  8. A separator, then Destructive: one row inline, or "Remove ▸" when there are several.

#### P4 `IndexContextMenu`: exact API

`IndexAction = { key, icon, label, title?, inStrip?, disabled?, onClick }` (`RoomsDesksIndex.tsx:38`). The same list drives the hover icon strip and the right-click menu (`RoomsDesksIndex.tsx:151-191, 538-560`). It renders a full-viewport scrim that closes on mousedown or right-click (594-600), handles Escape (583-589), and clamps to the viewport (575-581). It has no separators, no submenus, no shortcuts, and no ARIA roles.

#### P5 `buildWebMenu`: exact API

`buildWebMenu(params: Pick<ContextMenuParams, 'x'|'y'|'linkURL'|'srcURL'|'mediaType'|'selectionText'|'isEditable'|'editFlags'|'misspelledWord'|'dictionarySuggestions'>, ctx: {surface: 'desk'|'browser'|'connected-app'|'popup', canGoBack, canGoForward, dev, desks?}) → WebMenuEntry[]`, where `WebMenuEntry = {type:'separator'} | {id, label, enabled} | {label, submenu}`.

- It is pure and unit-tested (`tests/unit/webContextMenu.test.ts`). Groups are joined with single separators (`joinGroups`, 85-93).
- Actions run in main (`run`, 344-435). Commands for the renderer go over `webMenu:command` (`shared/webMenu.ts`) and are handled in `components/browser/WebMenuCommandHost.tsx`.
- No accelerators are set on the native `MenuItem`s, so **no shortcut hints** appear.
- e2e test hook: with `NODE_ENV=test` and `PLEXI_WEB_MENU_HOOK=1`, the menu is recorded instead of popped (`__plexiiLastWebMenu`, `__plexiiRunWebMenuItem`; lines 229-311).

### 1.2 Every right-click handler in scope

R = renderer, M = main / native. "Own" means the file draws its own menu DOM, not P1.

| Surface | Trigger (file:line) | Menu built at | Primitive | R/M |
|---|---|---|---|---|
| Bare canvas (no widget under the cursor; empty desk or empty area) | `components/Canvas.tsx:2938` → `handleCanvasContextMenu` 1854-1868 (only when the target has `data-bare-canvas`, set at 2932 and 3159) | `buildCtxMenu` 2010-2122 | P1, hand-built items | R |
| Widget header (every kind except section; frameless kinds are framed by `renderWidget.tsx:37-59`) | `WidgetFrame.tsx:1328-1332` | `WidgetFrame.tsx:1641-1663` | P2 (multi when the widget is part of a 2+ selection, 1652-1655) | R |
| Sticky body (textarea) | `widgets/StickyWidget.tsx:281-286` | UnifiedConnectedMenu | P2 | R |
| Note body (**edit mode only**) | `widgets/NoteWidget.tsx:175-181`; the read-mode `rendered` block at 114 has no handler | UnifiedConnectedMenu | P2 | R |
| Markdown body | `widgets/MarkdownWidget.tsx:409-414` | UnifiedConnectedMenu | P2 | R |
| Page body (incl. living page) | `widgets/PageWidget.tsx:397-402` | UnifiedConnectedMenu | P2 | R |
| Field body | `widgets/FieldWidget.tsx:140-147` | UnifiedConnectedMenu (no selection) | P2 | R |
| File body: link card / file preview | `widgets/FileWidget.tsx:226-235`, `:279-285` | UnifiedConnectedMenu with **title/URL passed as "selection"** | P2 | R |
| Table cell | `widgets/TableWidget.tsx:920-937` | `:1474-1491` (granularity `cell`) | P2 | R |
| Table column header | `TableWidget.tsx:1141-1144` | `HeaderContextMenu` 1842-1938 | **Own** | R |
| Mind map body | `widgets/MindMapWidget.tsx:1042-1058` | UnifiedConnectedMenu | P2 | R |
| Browser-family widget chrome (webview, pdf, gdoc, gsheet, gslide, email) | `widgets/WebViewWidget.tsx:538-554` (skips clicks inside `<webview>`) | `:599-605`, seeded with the URL as "selection" | P2 | R |
| Browser-family widget **page content** | `main/index.ts:775` → `attachWebContextMenu` | `main/webContextMenu.ts:140-207`; "More work widget actions…" → `webview:context-menu` → `contextMenu/BrowserContextMenu.tsx` (granularity `browser-target`) | P5, then P2 | M → R |
| Standalone browser / connected apps / pop-ups | `main/index.ts:775`, `:688` | P5 | P5 | M |
| Section handle | `widgets/SectionWidget.tsx:266-270` | `:477-556` | P1, hand-built (does **not** use P2) | R |
| Speed-deck tile (**edit mode only**) | `widgets/StreamDeckWidget.tsx:793-797` | `SlotContextMenu` 1077-1170 | **Own** | R |
| Speed-deck background | `StreamDeckWidget.tsx:594-601` | `DeckContextMenu` 949-1030 | **Own** | R |
| Focus-dock tile (widget focus mode strip) | `components/WidgetFocusDock.tsx:177` → `openTileMenu` 71-84 | `:327` | P2 (no frame) | R |
| Multi-selection | header of any selected widget, `WidgetFrame.tsx:1652-1655` | `buildContextForMulti` | P2 | R |
| Side menu, Work widgets tile and rail icon | `nav/WidgetsSection.tsx:146-149`, `:349-352` | `widgetKindMenuItems` 79-112 | P1 | R |
| Side menu, app tiles (PlexiiApps, comms apps) | `nav/AreaAccordion.tsx:315-319` (`AppTileMenu` 288-325) | same | P1 (only when it has items) | R |
| Files full view: file / folder row or tile | `views/FilesView.tsx:687`, `:786` → `:379-382` / `:403-406` | `entryContextItems` 234-312 | P1 | R |
| Files full view: list column header | `views/FilesView.tsx:613-616` | `:641-648` | P1 | R |
| Files flyout (panel / float) entry | `files/FilesPanel.tsx:819` → `:613` | `entryMenu` 230-262 | P1 | R |
| All Desks / All Rooms (gallery, list, board, table, timeline) | `views/RoomsDesksIndex.tsx:494, 517, 681, 744, 811, 901, 990` → `openCtxMenu` 185-192 | `DesksView.tsx:275-331`, `RoomsView.tsx:221-305` (+ P3) | P4 | R |
| Desk gallery card ("Your desks") | `components/DeskGallery.tsx:108-113` | `deskLifecycleMenuItems` | P1 + P3 | R |
| Open tray tab | `components/OpenTray.tsx:348-362` | `:421-488` | **Own** | R |
| PlexiiAssist message list (needs a selection) | `components/ChatPanel.tsx:1002` → `:485-490` | `ctxMenuItems` 492-545 | P1 | R |
| Desk jump list row | `components/DeskJumpList.tsx:196-201` | none: right-click **starts an inline rename** | — | R |
| Office-doc widget body | `widgets/OfficeDocWidget.tsx:290` (`stopPropagation` only) | office editors | out of scope (d8) | R |

Menus that are **not right-click** but share the vocabulary (lexicon only):
- `desk/DeskContextMenu.tsx` (header trail popover, own renderer, "Rename", "Share…", "Move to a room…").
- `ColumnsView.tsx:456-461, 521-536` (move button → P1).
- FloatingToolbar "more" menu, `Canvas.tsx:3291-3322` ("Clean up", "Home ⌘H", "Reset view ⌘0").
- `WidgetHeaderOverflow`.

### 1.3 Surfaces where right-click does nothing (desktop) or shows the browser's menu (web build)

The desktop main window has **no** `context-menu` handler. `attachWebContextMenu` is attached only to pop-ups and `<webview>` guests (`main/index.ts:686-692, 775`; the comment at 691 says "not the main window's React renderer"). `package.json` has no `electron-context-menu`. Electron shows no default menu, so on desktop any right-click the renderer does not handle shows **nothing** [Electron's documented behaviour; not reproduced at runtime in this phase]. In the web build (`src/web`) the same right-click shows the **browser's native menu**.

Right-click does nothing (desktop):
- **Widget bodies with no handler**: task-list, metrics, contacts, inbox, location-map, calendar, stat-card, **gallery**, image-gen (prompt textarea included), image, video, timer, calculator, color, task-link, local-app-launcher, **drive** (its file rows too), chart, voice-recorder, meeting-record, attention, scratchpad, shape, card, custom-block, custom, agent, webhook, inbound-hook, portal, living-doc (only its Page body is covered), chat-thread (composer included), mail-thread. Bodies are in `renderWidget.tsx:125-243`. None of those files contains `onContextMenu` (exhaustive grep).
- **Note in read mode** (`NoteWidget.tsx:114-125`).
- **Speed-deck tiles outside edit mode**: the handler returns early (`StreamDeckWidget.tsx:794`), and the root handler skips slots (598).
- **Section body / container area**: only the handle has a handler.
- **PlexiiAssist**: message bubbles (user and assistant) **without** a text selection (`ChatPanel.tsx:487` returns without `preventDefault`); the **composer**; the assistant overlay.
- **PlexiChat** (MessagesView) messages and composer. Capture uses the bell button (`MessagesView.tsx:797-815`).
- **Home dashboard cards**: every `HomeWidgetId` in `views/homeWidgetDefs.ts:5-61` (standup, navigator, continue, agenda, pulse, quick, activity, pinned-desk, office-document, app-*, people-home, room-portal, quick-links, shortcuts, app-launcher, create, overdue, focus-timer, one-thing, where-was-i, stalled, new-meeting, pinned-conversation, transcribe, new-desk, discover, attention, att-*). `HomeDashboard.tsx`, `homeWidgets.tsx` and `dashboardEmbeds.tsx` contain no `contextmenu`.
  - Exception: the `desk-widget` and `work-widget` cards render the real widget through `renderWidget` (`dashboardEmbeds.tsx:95-97, 579-581`), so the WidgetFrame header menu and body menus work inside the card. WidgetFrame only changes position and size when embedded (`WidgetFrame.tsx:161, 965-994`) [header visibility in cards unverified at runtime].
- **Focus rows** (`views/AttentionView.tsx`): no handler. Actions are hover buttons such as "Copy the full text", Snooze, Archive and Assign (1161-1265).
- **Side menu** rows: Home, Desks, Rooms, Plans, Trash and the other desk-area rows (`Sidebar.tsx:399-470` `NavRow`, `AreaAccordion.tsx:493-520`), Connected apps rows, People rows, section headers. Only app tiles that offer "Add … to this desk" or are Files get a menu (`AreaAccordion.tsx:305-319`).
- **Files** (full view and flyout): the **empty area**, the breadcrumb, the toolbar.
- **Columns view** cards and **Trash / Recent / Shared** views (none of them contain `contextmenu`).
- **Every app-native text input** (rename fields, search boxes, prompt dialogs, chat composers): no Cut / Copy / Paste anywhere.

Stale code that claims a fallback which does not exist on desktop:
- "Shift-right-click for the browser's native menu (cut/copy/paste)" appears at `NoteWidget.tsx:176`, `FieldWidget.tsx:142-144`, `TableWidget.tsx:921` and `MindMapWidget.tsx:1045`. Sticky, markdown, page, file and webview have the same `shiftKey` early return.
- On desktop that fallback is **nothing** (see above). It only works in the web build.

---

## 2. Matrix

Notation: `#n` is the 1-based top-level position as rendered, `gN` is the separator group, `▸X` means it sits inside submenu X, `⌘V` is the shortcut hint exactly as drawn, `—` means absent.

### 2.1 Full rendered order per surface (authoritative; the matrix below summarises it)

**U1. Work widget, unified menu, single widget, header right-click.** Example: a sticky with text, not in a section, not synced, not a file instance, and snippets wired.

| # | g | Row | Children (in order) |
|---|---|---|---|
| 1 | 1 | Add to Focus… | — |
| 2 | 1 | More actions ▸ | Build with AI · Make a checklist (or "Remove checkboxes") |
| 3 | 1 | Paste `⌘V` | — |
| 4 | 1 | AI Assist ▸ | Expand · Simplify · Summarise · Rewrite · Fix Grammar · Improve Clarity · Continue Writing · Explain · Change Tone ▸ (Professional, Casual, Friendly, Direct, Concise, Formal, Custom tone...) · Translate ▸ (English, Spanish, French, German, Japanese, Chinese, Custom language...) · Custom Prompt... |
| 5 | 1 | Create & link ▸ | Automate with an agent · Send to a URL · Sticky · Note · Markdown · Page · File · Field · Table · Color · ─ · *Copy into* (disabled header) · Note · Markdown · Page |
| 6 | 1 | Organise ▸ | Bring to front · [Move out of section] · Pin to corner ▸ (Top left, Top right, Bottom left, Bottom right, [Unpin]; current zone marked `✓` in the shortcut slot) · Recolor ▸ (Yellow, Pink, Blue, Green, Orange, Clear color; current colour marked `✓`) · Flag as a decision |
| 7 | 1 | Share ▸ | Copy text `⌘C` · Share... |
| 8 | 1 | Advanced ▸ | Make this a Desk... · Duplicate (keep synced) · Duplicate (independent copy) · [Duplicate into another Room / Desk...] · [Save as file \| Open file] · Save as snippet · [Insert snippet…] · [Unlink from synced copies] |
| ─ | | separator | |
| 9 | 2 | Remove ▸ | Archive · Delete (Delete opens the "Remove from this desk / Delete work widget" chooser, `lib/widgetRemoval.ts:1-15`) |

Sources: `resolve.ts:132-227`, `universal.ts:56-472`, `aiAssist.ts:32-107`, `providers.ts:33-50`, `lib/createConnectedTool.ts` (`CREATE_AND_CONNECT_MENU`). That is **9 top-level rows**: the "eight-item ceiling" is broken (F-9).

**Body right-clicks**: the same resolver with the same frame (through `FrameCallbacksProvider`), so a body menu equals the header menu, plus the selection text as the AI / Copy / Focus seed.

**U2. Multi-selection** (header of a selected widget): #1 g1 Add N to Focus… · #2 g1 Organise ▸ (Automate N with an agent, Bring all to front) · #3 g1 Copy all text `⌘C` (only when some text exists) · ─ · #4 g2 Delete N work widgets.

**U3. Focus-dock tile** (no frame): Add to Focus… · Show in full view · [context rows] · AI Assist ▸ · Create & link ▸ · Organise ▸ · Copy text `⌘C` (inline) · Duplicate (inline, generic, `universal.ts:424-432`) · ─ · Remove ▸ (Archive, Delete). There is no Share..., Make this a Desk, Save as snippet or Paste, because there is no frame (`WidgetFocusDock.tsx:71-84`).

**C1. Bare canvas** (`Canvas.tsx:2095-2121`): #1 g1 Add object ▸ (category groups ▸ kinds, Advanced ▸, From a saved snippet…) · #2 g1 Paste `⌘V` · ─ · #3 g2 Auto-arrange ▸ (Group by type, Stack by type) · ─ · #4 g3 Home — fit all to view `⌘H` · #5 g3 Reset view `⌘0` · ─ · #6 g4 Customise this device's layout / Stop customising this device's layout.

**S1. Section handle** (`SectionWidget.tsx:481-552`): #1 g1 Share section… · #2 g1 Make this a task… · ─ · #3 g2 Duplicate (empty) · #4 g2 Section layout ▸ (Free, Grid, Stacks, List; current marked by a " ✓" **label suffix**) · #5 g2 Bring to front · ─ · #6 g3 Archive (keep children on desk).

**T1. Table column header** (`TableWidget.tsx:1886-1937`): Insert column left ▸* · Insert column right ▸* · ─ · Delete column (rose). *These switch the panel to a type picker in place, not a true submenu.

**T2. Table cell**: U1 plus a Context band of Add row, Duplicate row and Delete row, folded into More actions ▸, plus header extras when right-clicked on the header: Import CSV, JSON or Excel… · Generate columns and rows with AI… / Hide the AI assistant · ─ (`TableWidget.tsx:1533-1546`).

**SD1. Speed-deck tile, edit mode** (`StreamDeckWidget.tsx:1115-1167`): #1 g1 Configure… / Add button… · ─ · #2 g2 Copy `⌘C` · #3 g2 Cut `⌘X` · #4 g2 Paste `⌘V` · #5 g2 Duplicate `⌘D` · ─ · #6 g3 New folder here / Remove (rose).

**SD2. Speed-deck background** (`:990-1023`): Copy deck JSON · Export deck to file… · Import deck from file… · ─ · Accessibility permission… · ─ · Reset deck… (rose).

**B1. Browser widget chrome**: U1 with header extras [Pin to Apps] · Reload · [Open full screen] · Change URL… (`WebViewWidget.tsx:616-655`), plus context rows Open in browser / Open and Copy URL / Copy path (`providers.ts:141-171`).

**B2. Web page, native** (`main/webContextMenu.ts:140-207`):
- Editable field: [spelling suggestions, Add to dictionary] · ─ · Undo · Redo · ─ · Cut · Copy · Paste · Select all.
- Read-only content, groups in this order:
  1. Selection: Copy · ─ · Ask PlexiiAssist about this · AI Assist ▸ (Summarise, Explain, Simplify, Rewrite · ─ · Change Tone ▸, Translate ▸ · ─ · Custom Prompt…).
  2. Link: Open link as a new browser work widget (desk) / Open link (browser) · Open link in default browser · Copy link address.
  3. Image: Save image as… · Copy image · Copy image address.
  4. Video: Copy video address.
  5. Page background: Back · Forward · Reload · ─ · Select all.
  6. Add … to desk ▸ (New desk…, recent desks, Choose a desk…).
  7. More work widget actions… (desk surface only).
  8. Inspect element (dev only).

**B3. "More work widget actions…" from a page**: U1 without a frame. Context rows: Open link in new browser · Save image to desk / Save video to desk · Copy link (`providers.ts:236-285`). The selection seeds AI Assist and Create.

**F1. Files full view entry** (`FilesView.tsx:234-312`):
- Open · Rename · then by kind: [widget file: Export… · ─ · Move to Trash] **or** [folder: Collaborate live] [file: Reveal in Finder]
- [Share with team or group] · [Create public link] · ─ · Delete / Delete folder and contents / Remove from folder.

**F2. Files flyout entry** (`FilesPanel.tsx:230-262`): Open · [Add to this desk / Add N items to this desk] · Show in full Files · Rename · ─ · Move to Trash (widget file) / Delete / Delete folder and contents / Remove from folder.

**F3. Files list header**: Sort by Name · Sort by Type · Sort by Size · Sort by Date added · Sort by Date modified.

**N1. Side-menu work widget tile** (`WidgetsSection.tsx:79-112`): [Add to this desk] · [New ‹kind› work widget] or [Only works on a desk] (disabled) · ─ · Move to Other work widgets / Move to Work widgets.

**N2. App tile** (`AreaAccordion.tsx:296-311`): Files only: Open beside · Open floating · Open full screen · ─ · then [Add ‹Kind› to this desk] (when a desk is open and the tile maps to a widget).

**I1. All Desks** (`DesksView.tsx:275-331`, P4): [Share with team or group] · Create public link · Rename desk · Open desk · Archive desk / Unarchive desk · Move to Trash. Shared desks get: Archive for me · [Leave share] · *Shared by @x — leave or archive instead* (disabled). No separators.

**I2. All Rooms** (`RoomsView.tsx:221-305`): [Share with team or group] · Create public link · Chat about this room · Rename room · Make this a plan / Remove from Plans · Open room / Open plan · Archive room · Move to Trash (shared: as I1).

**G1. Desk gallery card** (`DeskGallery.tsx:146-153` → `deskLifecycleMenu.ts:19-83`): Open desk / Open room · ─ · Archive desk · Move to Trash (shared: Archive for me · Leave share · disabled reason).

**TR1. Tray tab** (`OpenTray.tsx:421-488`): Pin — keep it here / Unpin · Close the others · Close all · [─ · *Send to desk* heading · desk list] (documents only).

**CH1. PlexiiAssist selection** (`ChatPanel.tsx:492-545`): Add to Focus… · ─ · Save selection as sticky · Save selection as note (disabled when no desk) · ─ · Copy.

### 2.2 Matrix A: clipboard, open, edit

Cells use the form `label #pos gN [⌘]`. "U1" means "as in U1 above".

| Surface | Cut | Copy | Paste | Paste plain | Select all | Open | Open in new tab/window | Rename | Duplicate |
|---|---|---|---|---|---|---|---|---|---|
| Bare canvas C1 | — | — | Paste #2 g1 ⌘V | — | — | — | — | — | — |
| Widget header U1 (all kinds) | — | Copy text ▸Share #7 g1 ⌘C (text kinds or selection only) | Paste #3 g1 ⌘V (sticky, note, markdown, page non-living, table, image) | — | — | Open / Open in browser ▸More actions (link kinds); Open file ▸Advanced (file instances) | — | — (rename is a header double-click) | Duplicate (keep synced) / (independent copy) / into another Room / Desk... ▸Advanced |
| Widget body (sticky, note-edit, markdown, page, field, file, mindmap, browser chrome) | — | as U1 | as U1 | — | — | as U1 | — | — | as U1 |
| Table cell T2 | — | Copy text ▸Share (cell text) | Paste | — | — | — | — | — | Duplicate row ▸More actions |
| Table column header T1 | — | — | — | — | — | — | — | — | — |
| Multi U2 | — | Copy all text #3 g1 ⌘C | — | — | — | — | — | — | — |
| Focus dock U3 | — | Copy text (inline) ⌘C | — | — | — | Show in full view #2 | — | — | Duplicate (inline) |
| Section S1 | — | — | — | — | — | — | — | — (inline title edit) | Duplicate (empty) #3 g2 |
| Speed-deck tile SD1 | Cut #3 g2 ⌘X | Copy #2 g2 ⌘C | Paste #4 g2 ⌘V | — | — | — | — | — | Duplicate #5 g2 ⌘D |
| Speed-deck bg SD2 | — | Copy deck JSON #1 g1 | — | — | — | — | — | — | — |
| Web editable B2 | Cut g3 | Copy g3 | Paste g3 | — | Select all g3 | — | — | — | — |
| Web read-only B2 | — | Copy g1 (selection), Copy link address, Copy image, Copy image address, Copy video address | — | — | Select all (page bg) | Open link | Open link as a new browser work widget; Open link in default browser | — | — |
| Files view F1 | — | — | — | — | — | Open #1 g1 | — | Rename #2 g1 | — |
| Files flyout F2 | — | — | — | — | — | Open #1 g1 | Show in full Files #2–3 g1 | Rename #3–4 g1 | — |
| Side tile N1 | — | — | — | — | — | — | — | — | — |
| App tile N2 | — | — | — | — | — | Open beside #1 · Open floating #2 · Open full screen #3 (Files) | — | — | — |
| All Desks I1 | — | — | — | — | — | Open desk #3–4 | — | Rename desk #2–3 | — |
| All Rooms I2 | — | — | — | — | — | Open room / Open plan #5–6 | — | Rename room #3–4 | — |
| Gallery G1 | — | — | — | — | — | Open desk / Open room #1 g1 | — | — | — |
| Tray TR1 | — | — | — | — | — | — | — | — | — |
| Assist selection CH1 | — | Copy #4 g3 | — | — | — | — | — | — | — |
| Desk jump row | right-click = inline rename (no menu) | | | | | | | | |

### 2.3 Matrix B: share, organise, AI, destructive

| Surface | Copy link | Share | Pin | Add to Focus | Ask PlexiiAssist | AI Assist | Save as snippet | Move to… | Add to desk / create | Remove / Delete / Trash / Archive |
|---|---|---|---|---|---|---|---|---|---|---|
| C1 | — | — | — | — | — | — | — | — | Add object ▸ #1 g1 (+ From a saved snippet…) | — |
| U1 | Copy URL / Copy path ▸More actions (link kinds) | Share... ▸Share #7 | Pin to corner ▸Organise #6 | Add to Focus… #1 g1 | — | AI Assist ▸ #4 (text only) | Save as snippet ▸Advanced #8 | Move out of section ▸Organise; Duplicate into another Room / Desk... ▸Advanced | Create & link ▸ #5 | **Remove ▸** #9 g2 → Archive, Delete |
| U2 | — | — | — | Add N to Focus… #1 | — | — | — | — | — | **Delete N work widgets** #4 g2 |
| U3 | — | — | Pin to corner ▸Organise | Add to Focus… #1 | — | yes | — | — | Create & link ▸ | Remove ▸ (Archive, Delete) |
| T1 | — | — | — | — | — | — | — | — | Insert column left / right | **Delete column** #3 g2 (rose) |
| T2 | — | Share... | Pin to corner | Add to Focus… | — | on the cell text | Save as snippet | — | Create & link | Delete row ▸More actions (**Context band, not Destructive**); Remove ▸ |
| S1 | — | **Share section…** #1 g1 | — | — | — | — | — | — | Make this a task… #2 | **Archive (keep children on desk)** #6 g3 |
| B1 | Copy URL | Share... | **Pin to Apps** (header extra) | Add to Focus… | — | on the URL (seeded as "selection") | Save as snippet | — | Create & link | Remove ▸ |
| B2 | Copy link address | — | — | — (deferred to "More work widget actions…", desk only) | **Ask PlexiiAssist about this** g2 | AI Assist ▸ g2 (4 direct actions) | — | — | Add selection / link / image / video / page to desk ▸ | — |
| B3 | Copy link | — (no frame) | Pin to corner | Add to Focus… | — | yes | — | — | Open link in new browser; Save image / video to desk | Remove ▸ |
| SD1 / SD2 | — | — | — | — | — | — | — | — | New folder here | **Remove** (rose) / **Reset deck…** (rose) |
| F1 | — | Share with team or group; Create public link | — | — | — | — | — | — | — | **Move to Trash** (widget files) / **Delete** / **Delete folder and contents** / **Remove from folder** |
| F2 | — | — | — | — | — | — | — | — | Add to this desk | same four variants as F1 |
| N1 | — | — | — | — | — | — | — | Move to Other work widgets / Work widgets | Add to this desk; New ‹kind› work widget | — |
| N2 | — | — | — | — | — | — | — | — | Add ‹Kind› to this desk | — |
| I1 | — | Share with team or group #1; Create public link #2 | — | — | — | — | — | — | — | **Archive desk** · **Move to Trash** (no separator) / Archive for me · Leave share |
| I2 | — | as I1 + Chat about this room | Make this a plan / Remove from Plans | — | — | — | — | — | — | **Archive room** · **Move to Trash** |
| G1 | — | — | — | — | — | — | — | — | — | **Archive desk / room** · **Move to Trash** (after ─) |
| TR1 | — | — | **Pin — keep it here / Unpin** #1 | — | — | — | — | Send to desk (list) | — | **Close the others**, **Close all** |
| CH1 | — | — | — | Add to Focus… #1 g1 | — | — | — | — | Save selection as sticky / note | — |

### 2.4 Per widget kind (header menu is U1 for every kind; differences only)

Columns:
- **Ctx band**: the provider rows (`providers.ts`).
- **Extras**: `headerMenuExtras`.
- **Paste**: whether `snippets.onPaste` is wired.
- **AI / Copy text**: present when `isTextKind` and the content is non-empty (`actions.ts:23`: sticky, note, markdown, page, card, living-doc) or when there is a selection.
- **Save as file**: `isStandaloneWidgetKind` (`shared/widgetFiles.ts:93`).

| Kind | Body right-click | Ctx band | Extras | Paste | AI / Copy text | Save as file |
|---|---|---|---|---|---|---|
| sticky | U1 (textarea) | Build with AI; Make a checklist / Remove checkboxes | — | yes | yes | yes |
| note | U1 **in edit mode only**; read mode does nothing | Build with AI | — | yes | yes | yes |
| markdown | U1 | Build with AI | — | yes | yes | yes |
| page | U1 | — | — | yes (not living) | yes | yes |
| living-doc | nothing (body) | Regenerate now; **AI Assist suppressed** | — | — | Copy text only | — |
| card | nothing | Build with AI | — | — | yes | yes |
| table | cell → T2; column header → T1 | Add row (+ cell: Duplicate row, Delete row) | Import CSV, JSON or Excel…; Generate columns and rows with AI… / Hide the AI assistant; ─ | yes | cell text only | yes |
| field | U1 (no selection) | — | — | — | — | yes |
| mindmap | U1 | Build with AI | — | — | — | yes |
| file | U1 with **title / URL as selection** | Open / Open in browser; Copy path / Copy URL (when content is set) | — | — | on the title (pseudo-selection) | — |
| image | nothing | Open; Copy path | — | yes | — | — |
| video, pdf, gdoc, gsheet, gslide, email | video: nothing; browser family: B1 / B2 | Open in browser / Open; Copy URL / Copy path | browser family: Pin to Apps, Reload, Open full screen, Change URL… | — | — | — |
| webview | chrome: B1; page: B2 → B3 | as above + browser-target rows (B3) | as above | — | on the URL | — |
| color | nothing | Copy #hex | — | — | — | yes |
| section | **S1 (own, not U1)**; the registered `section` provider (`providers.ts:194-231`) is not reached from the handle | (Section layout lives in S1) | — | — | — | — |
| streamdeck | SD1 (tile, edit mode only) / SD2 (background) | — | — | — | — | yes |
| custom | nothing | — | Change what it does…; Change this work widget…; Save to my work widgets…; Revert to previous version; View / Hide source; Internet access: on / off; Can make changes: on / off; Start over; My work widgets… (**up to 9 extras**, `CustomWidget.tsx:511-561`) | — | — | yes |
| gallery, drive, image-gen, task-list, metrics, contacts, inbox, location-map, calendar, stat-card, chart, timer, calculator, task-link, local-app-launcher, voice-recorder, meeting-record, attention, scratchpad, shape, custom-block, agent, webhook, inbound-hook, portal, chat-thread, mail-thread | **nothing** | — | — | — | — | per `WIDGET_FILE_TYPES` (gallery, image-gen, task-list, metrics, location-map, stat-card, chart, timer, calculator, voice-recorder, scratchpad, shape, custom-block: yes) |
| doc, sheet, slides, map, design, draw, diagram | out of scope (office, d8) | — | — | — | — | — |

---

## 3. Findings

### (a) Missing Cut / Copy / Paste where content is selectable or editable

- **F-1 No app-native text field has a clipboard menu on desktop.**
  - The main window has no `context-menu` handler (`main/index.ts:686-692`, comment at 691). Inputs with no handler of their own (rename fields, search, prompt dialogs, both chat composers, the image-gen prompt, the chat-thread composer) show nothing.
  - **Paste as plain text exists nowhere** in scope.
  - Select all exists only in the native web menu (`webContextMenu.ts:161, 196`).
- **F-2 Text widgets replace the clipboard with the unified menu, and the "Shift-right-click for native" escape hatch is dead on desktop.**
  - Sticky, note (edit mode), markdown, page, field, table cell and mind map all `preventDefault` and draw U1. U1 has no Cut, no Select all, and no caret Paste.
  - "Paste ⌘V" (`resolve.ts:157-172`) inserts the clipboard **into the widget through snippet conversion** (`useWidgetSnippets.ts:116, 223, 276, 302`). It is not a caret paste.
  - "Copy text" copies the selection, or the **whole widget** when nothing is selected (`actions.ts:159-176`). It is buried at Share ▸ (`universal.ts:309-318`).
  - The Shift bypass (`NoteWidget.tsx:176` et al.) yields nothing on desktop (see §1.3). In the web build it yields the browser's own menu.
- **F-3 Assistant replies and messages.**
  - PlexiiAssist bubbles only get a menu **when text is selected** (`ChatPanel.tsx:485-490`). Without a selection there is nothing, even though "Copy this reply" exists as a hover button (`ChatPanel.tsx:1222`, `data-testid="turn-copy"`).
  - User bubbles have no Copy at all [no button found by grep for Copy in ChatPanel; unverified for other components].
- **F-4 Speed-deck lists Copy before Cut** (`StreamDeckWidget.tsx:1123-1134`). The OS and web order is Cut, Copy, Paste (`webContextMenu.ts:157-162`).

### (b) Same action, different labels

Counts are per **rendered surface** (§2.1 IDs). "Same semantics?" was checked in code.

| Action (semantics) | Labels and counts | Same thing? |
|---|---|---|
| Soft-delete to Trash with undo | **"Move to Trash" ×5** (G1 `deskLifecycleMenu.ts:76`; I1 and I2 `deskLifecycleMenu.ts:146`; F1 `FilesView.tsx:248`; F2 `FilesPanel.tsx:252`, both widget-file entries) · **"Delete" ×2** (F1 `FilesView.tsx:306`, F2 `FilesPanel.tsx:255`, plain files) · **"Delete folder and contents" ×2** (same lines, folders) | **Yes.** Files "Delete" calls `fileManager:delete` → `deleteEntry`, which is a **soft delete** that sets `trashed_at` with undo (`main/db/files.ts:482-500`, `stores/fileManager.ts:445-461`). That is the same contract as "Move to Trash". The only differences: F1/F2 Delete has **no confirm**, while widget-file "Move to Trash" confirms when the file is placed (`confirmTrashWidgetFile`). |
| Remove a reference / placement (the object survives) | **"Remove from folder" ×2** (F1 and F2, doc pointer: trashes the pointer, the document is untouched) · widget **"Delete"** inside **"Remove ▸"** (U1, `universal.ts:466`; `resolve.ts:122`), which opens a chooser: "Remove from this desk" vs "Delete work widget" (`widgetRemoval.ts:1-15`) · **"Delete N work widgets"** ×1 (U2, same chooser, `actions.ts:204-216`) · speed-deck **"Remove"** ×1 (removes a button) | **No.** These mix "remove from container" with "delete the object". The widget parent is labelled "Remove" while its child is labelled "Delete", and that child asks Remove-or-Delete again. |
| Hide but keep (archive) | **"Archive"** ×2 surfaces (U1 and U3, `universal.ts:457`) · **"Archive desk" / "Archive room"** ×3 (G1, I1, I2) · **"Archive (keep children on desk)"** ×1 (S1) · **"Archive for me"** ×3 (shared desks in G1, I1, I2) | Mostly the same (an archived flag). "Archive for me" is scoped to this account (DEC-021). The section variant ejects its children first (`SectionWidget.tsx:537-551`). |
| Close a tab | "Close the others", "Close all" (TR1) | Unique to the tray. |
| Open the object | **"Open"** ×3 (F1, F2, U1 link kinds when the target is not http) · **"Open desk" / "Open room" / "Open plan"** ×3 (G1, I1, I2) · **"Open in browser"** ×1 (U1 http link kinds) · **"Open file"** ×1 (U1 file instance) · **"Show in full view"** ×1 (U3) · **"Show in full Files"** ×1 (F2) · **"Open full screen"** ×2 (B1 extra, N2 Files) · **"Open beside" / "Open floating"** ×1 (N2) | All are "open", with different targets. |
| Open a link elsewhere | "Open link in new browser" (B3, `providers.ts:249`) · "Open link as a new browser work widget" (B2 desk) · "Open link" (B2 browser) · "Open link in default browser" (B2) | B3 and B2-desk are the **same action** under 2 labels (both spawn a browser widget). |
| Copy a link | "Copy URL" (U1 link kinds) · "Copy path" (U1 local) · "Copy link" (B3) · "Copy link address" (B2) | "Copy link" and "Copy link address" are the same action on the same page, reached through the native menu and through "More work widget actions…" respectively. |
| Copy | "Copy" ×3 (B2, SD1, CH1) · "Copy text" ×2 (U1, U3) · "Copy all text" ×1 (U2) · "Copy #hex" ×1 (color) · "Copy deck JSON" ×1 | Different scopes. "Copy text" without a selection copies the whole widget. |
| Share dialog | **"Share..."** (U1; ASCII dots, `universal.ts:324`) · **"Share…"** (DeskContextMenu, left-click) · **"Share section…"** (S1) | Same `ShareDialog`. |
| Move to an org or group | "Share with team or group" ×3 (I1, I2, F1) | Different action from the Share dialog (`shareToOrgOrGroup` moves the object). |
| Public link | "Create public link" ×3 (I1, I2, F1) | Only on these three. Widgets get it through the Share dialog [unverified]. |
| Promote to a desk | **"Make this a Desk..."** (U1) · **"Make this a task…"** (S1) · **"Duplicate into another Room / Desk..."** (U1) | **All three open the same `MakeTaskDialog`**: `WidgetFrame.tsx:679` and `:683` both call `setMakeTaskOpen(true)`, and so does S1 at `SectionWidget.tsx:491`. That is three labels for one dialog, and "task" is retired vocabulary. |
| Rename | "Rename" ×2 (F1, F2; plus DeskContextMenu) · "Rename desk" / "Rename room" ×2 (I1, I2) · right-click = rename with no menu (DeskJumpList) | Same action. |
| Pin | "Pin to corner ▸" (U1) · "Pin to Apps" (B1) · "Pin — keep it here" / "Unpin" (TR1) | **Different** semantics under the same verb. |
| Add to desk | "Add to this desk" ×2 (N1, F2) · "Add ‹Kind› to this desk" ×1 (N2) · "Add N items to this desk" (F2 multi) · "Add selection / link / image / video / page to desk ▸" (B2) · "Save image to desk" / "Save video to desk" (B3) · "Save selection as sticky / note" (CH1) | Same intent. B2 and B3 use **"Add … to desk"** and **"Save … to desk"** for the same image on the same page. |
| AI Assist submenu | 8 direct actions in U1 (`aiAssist.ts:35-41`, `shared/aiTextActions.ts`) vs **4** in B2 (`WEB_SELECTION_AI_ACTIONS`, `aiTextActions.ts:48`). Tone / Translate custom rows read "Custom tone..." (ASCII) in U1 and "Custom tone…" in B2. | The `aiAssist.ts:1-3` header says "identical wherever it appears". **It is not.** |
| Make a widget reusable | "Save as snippet" (U1) vs "Save to my work widgets…" (custom extras) vs "Save as file" (U1) | Three different things (template, custom-widget library, linked file), all in **one** custom-widget menu. |

Ellipsis: **ASCII "..." ×6**: `universal.ts:324, 342, 367` and `aiAssist.ts:61, 85, 95`. All of them are in P2, the menu people see most. **Unicode "…" ×29** in menu labels everywhere else: 27 grep hits from the scratch extractor, excluding 4 non-menu hits in the DesksView bulk bar and the WidgetsSection footer, plus SD1's ternary "Configure…" / "Add button…". That includes B2's copies of the same AI rows.

Case: Title Case appears in "Make this a **D**esk...", "Duplicate into another **R**oom / **D**esk...", "Change **T**one", "Custom **P**rompt...", "Fix **G**rammar", "Improve **C**larity" and "Continue **W**riting". Every other in-scope label (≈95%) is sentence case.

### (c) Inconsistent order and separators

- **F-5 The destructive group is last in 12 of 12 surfaces** that have one: U1, U2, U3, T2, S1, T1, SD1, SD2, G1, F1, F2, I1/I2 counted as one renderer. The one exception is the table's "Delete row", which sits in the Context band (F-11). A separator precedes it in 10 (P2 always adds one, `resolve.ts:221`; S1, T1, SD1, SD2, G1, F1 `FilesView.tsx:304`, F2 `FilesPanel.tsx:249`). It has **no separator in I1 and I2** (P4 cannot draw one).
- **F-6 Open is first in 5 of 9 surfaces** that offer it (F1, F2, G1, N2, B2 link group). It is 3rd–4th in I1 (after Share and Rename), 5th–6th in I2, and 2nd in U3 (after Add to Focus). The same object (a desk) shows Open **first** in the gallery (G1) and **fourth** in the index (I1).
- **F-7 Share placement**: first in S1, I1 and I2; near the end in U1 (Share ▸ #7) and F1 (after Reveal). DeskContextMenu puts it after Rename.
- **F-8 Rename placement**: 2nd in F1, 3rd–4th in F2, 2nd–3rd in I1, 3rd–4th in I2.
- **F-9 The "eight-item ceiling" is broken in practice.**
  - `resolve.ts:157-172` adds Paste **outside** the slot arithmetic. That gives 9 top-level rows on sticky, note, markdown, page, table and image (U1).
  - `headerExtras` are spliced in **uncapped** (`resolve.ts:147-149`), so a table header has 10 (§2.1 T2) and a custom widget can exceed 15.
  - The unit test only checks a context with no frame (`tests/unit/contextMenuResolve.test.ts:78-97`; it never sets `frame.onPaste`).
- **F-10 Separators inside a band.** The table's `headerMenuExtras` end in `{ separator: true }` (`TableWidget.tsx:1545`), so a separator lands between the extras and Add row in the middle of the Context band. Apart from that, P2 draws a **single** separator per menu (before Destructive), so the 7–8 top-level rows read as one undivided list. C1 draws 4 groups and B2 up to 8.
- **F-11 `danger` is decorative-only metadata.** `types.ts:105` says `danger` "forces the Destructive band". `resolve.ts` never reads `danger` (grep: 0 hits), and P1 has no destructive styling.
  - So "Delete row" (`providers.ts:126-133`, `danger: true`) sits in the **Context** band under "More actions", undistinguished.
  - Own renderers do style destructive rows rose (`TableWidget.tsx:1907`, `StreamDeckWidget.tsx:1194-1196`). The visual treatment therefore differs by primitive.
- **F-12 Dead path.**
  - `Canvas.tsx:887-970` listens on `contextMenu.onAction` (`context-menu:action`; preload `index.ts:1251-1255`; types `shared/types.ts:211-226`).
  - Nothing in `src/main` sends `context-menu:action` (grep: 0 senders). That covers 84 lines of create-from-selection handlers plus a channel and a type.
- **F-13 Checked state is drawn three ways**: a `✓` in the **shortcut** slot (`universal.ts:257, 288`), a `" ✓"` **label suffix** (`SectionWidget.tsx:520`), and an icon plus `aria-current` (DeskContextMenu). Screen readers get no checked state from any of them (no `menuitemradio` / `aria-checked`).
- **F-14 Duplicate surfaces with drifted copies.**
  - The section handle (S1) is a hand-built menu that duplicates parts of U1: Share, make-desk, Bring to front, layout, archive. It lacks Add to Focus, AI, Create & link, Save as snippet, Recolor, Pin, and Copy.
  - The `section` provider in P2 (`providers.ts:194-231`) is never reached from the handle.
  - FloatingToolbar "Home ⌘H" (`Canvas.tsx:3313-3317`) vs C1 "Home — fit all to view ⌘H" (2102-2105): the same action under two labels.
  - F1 vs F2 for the **same entry**: the flyout lacks Share with team or group, Create public link, Reveal in Finder, Export… and Collaborate live, while the full view lacks Add to this desk.

### (d) Missing Add to Focus / Ask PlexiiAssist / Save as snippet where the feature is reachable

How each feature is reached, checked by finding its callers:
- **Add to Focus**: the generic `fb:command-new-work-item` event. Its dispatchers are `universal.ts:69`, `WidgetFrame.tsx:293`, `ChatPanel.tsx:509`, `MessagesView.tsx:809`, `CommandCenter.tsx:594`, `StartOrAskPlexi.tsx:367, 384` and `stores/chat.ts:720`. `sourceType` is a free string (`shared/types.ts:264`), so the path accepts any object.
- **Ask PlexiiAssist**: two live paths. One is `askAboutPrompt` + `stageInComposer` for text (`browser/WebMenuCommandHost.tsx:14-52`). The other is `mentionFromWidget` + `openPanel` for widgets (`WidgetFrame.tsx:203-208`, today reached only from the header AI button's "ask the assistant instead" path). `mentionFromNode` (desks and rooms, `lib/assistantMentions.ts:148`) is live, but only through @-mention suggestions (`MentionSuggestion.ts:92`). There is **no** file mention helper. Documents only come through search hits (`assistantMentions.ts:165+`).
- **Save as snippet**: `SaveSnippetDialog` / `widgetBodyFromWidget` (`WidgetFrame.tsx:702, 1669`). The non-office callers are WidgetFrame only.

| Surface | Add to Focus | Ask PlexiiAssist | Save as snippet |
|---|---|---|---|
| U1 / U3 widget | present | **missing** (path exists: `askAssistantAbout`, `WidgetFrame.tsx:203`) | U1 present; **U3 missing** (no frame) |
| U2 multi | present | missing (no multi-mention path found) | missing (feature is single-widget) |
| S1 section | **missing** | **missing** | **missing** (WidgetFrame path not wired to sections) |
| B2 web page | **missing on the standalone browser**; on the desk only via "More work widget actions…" | present ("Ask PlexiiAssist about this") | n/a |
| CH1 assist selection | present | n/a (already in the assistant) | n/a |
| PlexiChat message | no menu at all (feature on the bell button) | — | — |
| G1 / I1 / I2 desks, rooms | **missing**. `presetForDesk` exists for exactly this ("Marking a whole desk from its own menu (CR-09 Q3)", `attentionPresets.ts:92-96`) but has **zero callers**: an engine-only preset. | **missing** (`mentionFromNode` is live) | n/a |
| F1 / F2 files | missing (generic path only; no file preset) | missing (no file mention helper: would need new plumbing; **do not** propose without it) | missing for widget-file entries [whether a Files entry can produce a `WidgetSnippetBody` is unverified] |
| TR1 tray | missing | missing | n/a |

### (e) Shortcut hints

- Every hint in scope uses the **⌘ glyph**: `⌘V` (`Canvas.tsx:2089`, `resolve.ts:166`), `⌘C` (`universal.ts:315`), `⌘H` / `⌘0` (`Canvas.tsx:2104, 2110`), and `⌘C ⌘X ⌘V ⌘D` (`StreamDeckWidget.tsx:1126-1148`). No "Cmd+" / "Ctrl+" variants were found in right-click menus.
- **Platform handling: none.** There is no formatter in the renderer outside the office code (`documents/draw/commands/keys.ts:301` is office-only). The bindings accept `metaKey || ctrlKey` (`Canvas.tsx:1225`), but Windows users see ⌘.
- **Hints whose binding could not be found**: SD1's ⌘C, ⌘X, ⌘V and ⌘D. StreamDeckWidget's only `keydown` listeners are the two menus' Escape handlers (962, 1090). Nothing in `widgets/streamdeck/` binds them. U1's "Copy text ⌘C" and "Paste ⌘V" bindings for a selected widget were not verified (`desk/deskSnippets.ts` handles desk paste) **[unverified]**.
- The native web menu (P5) sets **no accelerators**, so Cut, Copy, Paste and the rest show no hints at all.
- The `shortcut` slot is also used for `✓` (F-13).

### (f) Accessibility per primitive

| Primitive | role menu / menuitem | Arrow keys | Escape | Focus on open | Focus return on close | Other |
|---|---|---|---|---|---|---|
| P1 CanvasContextMenu | yes / yes (+separator, haspopup, expanded, aria-disabled) | ↑↓ wrap, Home/End, →/←, type-ahead | yes, but **Escape in a submenu closes the whole menu** (`:220-224`; submenus receive the root `onClose` at `:330`). The comment at `:31-34` says Escape "steps back out". | the panel `div` is focused (`:108-110`) | **no** | Rows are never focused and there is no `aria-activedescendant`, so screen readers are not told which row is active. No menu `aria-label`. Disabled section headers ("Copy into") are announced as disabled items. |
| P4 IndexContextMenu | **no** | **no** | yes (`:583-589`) | **no** | **no** | Its scrim swallows the next click. |
| TR1 tray (own) | **no** | **no** | **no** | **no** | **no** | Closes on mouse-leave (`OpenTray.tsx:427`), so it is unusable from the keyboard. No outside-click close (no listener found). |
| T1 table header (own) | **no** | **no** | yes (`TableWidget.tsx:1863-1865`) | **no** | **no** | `position: fixed` rendered **inside** the canvas's transformed layer (`Canvas.tsx:3164`: `translate(...) scale(zoom)`) and the widget, with no portal. A transformed ancestor becomes the containing block, so the menu is likely mispositioned or scaled at zoom ≠ 1 **[unverified at runtime]**. |
| SD1 / SD2 speed-deck (own) | **no** | **no** | yes (`:952`, `:1080`) | **no** | **no** | Same `fixed`-inside-transform risk **[unverified]**. Dark-only hard-coded colours (`rgba(20,28,48,.96)`) ignore the theme tokens. |
| P5 native web | OS-native | OS | OS | OS | OS | Fully accessible by construction. |
| DeskContextMenu (left-click, reference) | yes / yes | no | yes | no | **yes** (`desk/DeskContextMenu.tsx:121`) | — |
| WidgetHeaderOverflow (left-click, reference) | yes | yes, wrap | yes | first item | **yes** | The model to copy. |

---

## 4. Proposed canonical group order and lexicon (derived from the majority)

### 4.1 Group order

Counts are surfaces where the group's relative position is observable.

| Order | Group | Majority evidence |
|---|---|---|
| 1 | **Open / navigate** (Open, Open in…, Show in…) | First in 5 of 9 surfaces that have Open (F1, F2, G1, N2, B2; not first in I1, I2, U1 link kinds, U3). **Conflicts with CR-09 D-A** ("Add to Focus" first on objects, operator ruling, `resolve.ts:138-143`): escalate E-1. |
| 2 | **Mark** (Add to Focus…) | First in 2 of 2 surfaces that have it (U1, CH1), by ruling. Proposed: directly after Open, or first when there is no Open (E-1). |
| 3 | **Object-specific** (kind rows, Build with AI, layout, Configure…) | P2 Context band (always early); SD1 Configure is first. |
| 4 | **Clipboard**: Cut · Copy · Paste · Paste as plain text · Select all | Order taken from the only complete clipboard group (B2) plus OS convention. SD1 has Copy before Cut (F-4) and U1 buries Copy in Share. Position escalated (E-5). |
| 5 | **AI**: Ask PlexiiAssist · AI Assist ▸ | B2: right after Copy. U1: after Context / Paste. Both are early-middle. |
| 6 | **Create / send**: Create & link ▸, Add to this desk, Save selection as…, Send to desk | — |
| 7 | **Organise / move**: Bring to front, Pin ▸, Recolor ▸, Move to… | U1, U2, S1 |
| 8 | **Share / link**: Share…, Copy link, Create public link, Share with team or group | Mixed (F-7); placed before Advanced per P2. Escalated (E-4). |
| 9 | **Rename / duplicate / save as / advanced** | Rename position is mixed (F-8). Escalated with E-3. |
| — | separator | Precedes Destructive in 10 of 12 (F-5) |
| 10 | **Destructive**: Archive · Move to Trash · Remove from ‹container› · Delete permanently | Last in 12 of 12 (F-5) |

Rules:
- One separator between non-empty groups (B2's `joinGroups`, P1 already supports it).
- Destructive rows styled as danger and always behind a separator.
- Checked state as `menuitemcheckbox` / `menuitemradio` (a new P1 field), not text in the shortcut slot.

### 4.2 Lexicon (majority label → proposed canonical)

| Concept | Majority (count) | Canonical |
|---|---|---|
| Soft delete to Trash | "Move to Trash" ×5 vs "Delete" / "Delete folder and contents" ×4 | **Move to Trash** (also truthful: it is recoverable) |
| Remove a placement or reference | "Remove from folder" ×2; widget chooser "Remove from this desk" | **Remove from ‹container›** (Remove from this desk / folder / section) |
| Archive | "Archive" ×2, "Archive ‹noun›" ×3 | **Archive** (noun dropped; see E-3) |
| Ellipsis | "…" ×29 vs "..." ×6 | **…** (U+2026) whenever the item opens a dialog or picker |
| Case | sentence case ≈95% | **Sentence case** ("Change tone", "Custom prompt…", "Fix grammar", "Make this a desk…") |
| Copy | "Copy" ×3 vs "Copy text" ×2, "Copy all text" ×1 | **Copy** (selection), with a scoped label only when it copies the whole object ("Copy all text") |
| Rename | "Rename" ×2 (+DeskContextMenu) vs "Rename desk" / "Rename room" ×2 | **Rename** |
| Add to desk | "Add to this desk" ×2 (+N2 variant) | **Add to this desk** (in-app); **Add ‹thing› to desk ▸** (web, picking a desk). "Save image / video to desk" → **Add image / video to desk** |
| Focus | "Add to Focus…" ×2 (+multi) | **Add to Focus…** |
| Assistant | "Ask PlexiiAssist about this" ×1 | **Ask PlexiiAssist** (+ "about this" only for a selection) |
| Share dialog | "Share..." / "Share…" / "Share section…" | **Share…** |
| Duplicate | "Duplicate" ×2 vs qualified ×4 | **Duplicate** (plain = independent copy); synced copy as **Duplicate, keep synced** |
| Promote to a desk | "Make this a Desk..." / "Make this a task…" | **Make this a desk…** (one label, one row; drop "Duplicate into another Room / Desk..." since it is the same dialog; E-7) |
| Open | split 3 / 3 | escalate (E-3) |
| Copy link | "Copy URL" / "Copy link" / "Copy link address", 1 each | **Copy link** (proposed; tie, E-10) |

### 4.3 Calls the majority cannot settle (escalate to the owner and d8)

- **E-1** Add to Focus **first** (CR-09 D-A ruling) vs **Open first** (5 / 8 majority) on objects that have both.
- **E-2** Widget destructive band: keep "Remove ▸ (Archive, Delete → chooser)", or flatten to **Archive · Remove from this desk · Move to Trash** (three explicit rows, no second question). The latter matches 4.2, but `docs/widget-files.md` "Remove or delete" chose the chooser.
- **E-3** Noun-suffixed labels ("Open desk", "Rename room", "Archive desk") vs bare verbs. 3 / 3 surfaces, a tie.
- **E-4** Share family: keep **Share…**, **Share with team or group** and **Create public link** as three rows, or fold them under **Share ▸**. Also decide whether Share comes early (S1, I1, I2) or late (U1, F1).
- **E-5** Clipboard position in widget menus (top, per OS convention, vs inside Share). Also: should right-click in a text editor keep the native-style clipboard menu (B2's editable path) and offer the widget menu only off-text? The Shift-bypass decision depends on this.
- **E-6** Keep or drop the **eight-item ceiling** (spec §1) now that Paste and header extras exceed it (F-9). If kept, extras must count against Context's slots.
- **E-7** Should "Duplicate into another Room / Desk..." stay as a separate row for the same dialog as "Make this a desk…"?
- **E-8** Web content stays **native** (P5, current, a11y-perfect, cannot match P1 visually) vs a renderer menu (spec §3, which was never shipped). This is d8's §9 call for the cross-surface look.
- **E-9** Tray wording: "Close the others" / "Close all" vs the browser convention "Close other tabs" / "Close all tabs". And "Pin — keep it here" vs "Pin tab".
- **E-10** "Copy link" vs "Copy link address" vs "Copy URL" (tie, 1 / 1 / 1).
- **E-11** DeskJumpList: right-click = rename (no menu), or a standard menu with Rename first.
- **E-12** The AI Assist set should be identical on web (4 actions) and in-app (8). Decide which.

---

## 5. Migration plan

### 5.1 Bespoke menus and sizes (lines of menu-building or rendering code)

| ID | Where | Lines | Work |
|---|---|---|---|
| M-a | P1 `CanvasContextMenu.tsx` | 341 | Add danger styling, checkable items, focus return, `aria-activedescendant` (or roving focus), submenu-scoped Escape, `aria-label`, and a platform shortcut formatter |
| M-b | P2 `lib/contextMenu/*` (types 131, resolve 227, universal 472, aiAssist 108, providers 287, registry 107, buildContext 54, actions 282) + `components/contextMenu/*` | ~1,700 | Lexicon constants; honour `danger`; count Paste and extras in the ceiling (or drop it, E-6); a clipboard group; an Ask PlexiiAssist row; one AI set |
| M-c | Empty canvas `Canvas.tsx:2010-2122` + dead `Canvas.tsx:887-970` | 113 + 84 | Group / lexicon; delete the dead listener (F-12) |
| M-d | Section `SectionWidget.tsx:477-556` | 80 | Replace with P2 (frame callbacks for sections) |
| M-e | Table header `TableWidget.tsx:1842-1938` (+ extras 1533-1546) | 97 + 14 | Move to P1 (portal) |
| M-f | Speed deck `StreamDeckWidget.tsx:937-1210` | ~270 | Move to P1 (portal, a11y, real bindings or drop the hints) |
| M-g | Browser widget extras `WebViewWidget.tsx:616-655`; Custom `CustomWidget.tsx:511-561`; File / Field / Sticky / Note / Markdown / Page / MindMap body handlers | ~40 + 50 + ~10 each | Lexicon; stop passing URL / title as "selection" (`FileWidget.tsx:233`, `WebViewWidget.tsx:552`) |
| M-h | Focus dock `WidgetFocusDock.tsx:71-84` | 14 | Pass frame-equivalent callbacks |
| M-i | Index `RoomsDesksIndex.tsx:562-648` + `DesksView.tsx:275-331` + `RoomsView.tsx:221-305` + `deskLifecycleMenu.ts` (153) | 87 + 57 + 85 + 153 | Render P4 through P1 (separators, roles, keyboard); unify order with G1 |
| M-j | Gallery `DeskGallery.tsx:108-153` | 15 | Order and lexicon only (via P3) |
| M-k | Side menu `WidgetsSection.tsx:79-112`, `AreaAccordion.tsx:288-325` | 34 + 38 | Lexicon only |
| M-l | Tray `OpenTray.tsx:421-488` | 68 | Move to P1 (keyboard, Escape, roles) |
| M-m | DeskJumpList right-click `DeskJumpList.tsx:196-201` | 6 | Per E-11 |
| M-n | Files `FilesView.tsx:234-312, 605-650`; `FilesPanel.tsx:230-262` | 79 + 46 + 33 | One shared `fileEntryMenu(entry, surface)` builder (F-14) |
| M-o | PlexiiAssist `ChatPanel.tsx:485-545` + composers | 61 | Menu without a selection (Copy reply etc.); clipboard on the composer |
| M-p | Native web `main/webContextMenu.ts:95-207` | 113 | Lexicon, accelerators, AI set (E-12) |
| M-q | **New**: main-window editable-field menu (Cut / Copy / Paste / Paste as plain text / Select all / spelling) for app-native inputs | new, ~60 | F-1. Natural home: `main/webContextMenu.ts` (`isEditable` branch reused) attached to the main `BrowserWindow`'s webContents in `main/index.ts` |

### 5.2 Work packages (disjoint file ownership)

**WP0: primitive and resolver. Single owner, lands first.** The others rebase on it.

Owns:
- `components/CanvasContextMenu.tsx`
- `lib/contextMenu/**`
- `components/contextMenu/**`
- a **new** `lib/menuLexicon.ts` (label constants) and `lib/shortcutLabel.ts` (platform formatter)
- `tests/unit/contextMenuResolve.test.ts`, `widgetContextActions.test.ts`, `browserMenuProvider.test.ts`

Scope: M-a, M-b. Publishes the P1 additions (`danger`, `checked`, `role` variants) and the lexicon.

Code ≈ 2–3 h of agent time. Validate with the unit suite plus the e2e list for P1 and P2 in §6 (about 25 specs). Test wall-clock dominates. Run them as **one** baseline-diffed batch (the 53/172 red baseline rule).

**WP1: desk and widgets.** Owns:
- `components/Canvas.tsx` (shared hot file; **only** WP1 edits it)
- `widgets/WidgetFrame.tsx`, `SectionWidget.tsx`, `TableWidget.tsx`, `StreamDeckWidget.tsx`, `WebViewWidget.tsx`, `CustomWidget.tsx`, `FileWidget.tsx`, `FieldWidget.tsx`, `StickyWidget.tsx`, `NoteWidget.tsx`, `MarkdownWidget.tsx`, `PageWidget.tsx`, `MindMapWidget.tsx`
- `components/WidgetFocusDock.tsx`, `ColumnsView.tsx`, `DeskJumpList.tsx`

Scope: M-c through M-h, M-m. This is the largest package. If it must be split, split **by file** with WidgetFrame, Canvas and Section staying together: WP1a = Canvas + WidgetFrame + Section + Dock + Columns + JumpList; WP1b = the widget body files.

**WP2: navigation, lists, tray.** Owns `views/RoomsDesksIndex.tsx`, `views/DesksView.tsx`, `views/RoomsView.tsx`, `components/DeskGallery.tsx`, `lib/deskLifecycleMenu.ts`, `nav/WidgetsSection.tsx`, `nav/AreaAccordion.tsx`, `components/OpenTray.tsx`, `desk/DeskContextMenu.tsx` (lexicon only). Scope: M-i through M-l, plus the Add to Focus and Ask PlexiiAssist rows for desks and rooms (`presetForDesk`, `mentionFromNode`).

**WP3: Files, PlexiiAssist, web, main.** Owns:
- `views/FilesView.tsx`, `files/FilesPanel.tsx`
- `components/ChatPanel.tsx`, `views/chat/ChatComposer.tsx`
- `main/webContextMenu.ts`, `shared/webMenu.ts`, `shared/aiTextActions.ts` (**shared with WP0's `aiAssist.ts` import; WP0 must not edit it**)
- `components/browser/WebMenuCommandHost.tsx`
- `main/index.ts` (attach point for M-q)
- `preload/index.ts` and the generated channel maps (to remove `contextMenu.onAction` / `context-menu:action`, F-12). Follow the new-IPC-channel checklist in reverse: both generators, the web-worker map and `src/web/api/channelMap.generated.ts:641`. Coordinate with WP1, which deletes the Canvas listener in the same merge.

Scope: M-n through M-q.

Shared files that need a single owner:
- `components/CanvasContextMenu.tsx`, `lib/contextMenu/**`, the lexicon and shortcut libs: **WP0**
- `components/Canvas.tsx`: **WP1**
- `main/index.ts`, `preload/index.ts`, `src/web/api/channelMap.generated.ts`, `shared/aiTextActions.ts`: **WP3**
- `tests/e2e/_helpers.ts` (right-click helper at 632): whoever changes the "to this desk" label owns the helper edit. Propose WP2.

Order: WP0 → (WP1 ∥ WP2 ∥ WP3) → the aggregator merges all three and runs the e2e set once.

---

## 6. Tests that touch each menu

R = real right-click (Playwright `click({button:'right'})` / `mouse.click(..., {button:'right'})`). S = synthetic `dispatchEvent('contextmenu')`. H = main-process test hook (the native menu never pops). L = asserts labels only.

| Surface | e2e | unit | Reach |
|---|---|---|---|
| P1 behaviour (keyboard, dismiss, submenu, overlay) | `menuKeyboard.spec.ts:71`, `ctxMenuDismiss.spec.ts:48` (R) and `:66` (S), `contextMenuSubmenu.spec.ts:36`, `edgePanMenuOverlay.spec.ts:225`, `a11yReducedMotion.spec.ts` (L) | — | R |
| C1 bare canvas | `contextMenuSubmenu`, `densityExtension:131`, `deskLayoutObjectOverlayUI:54`, `newWidgetTyping:125`, `officeDocCanvas:64`, `tidyModesWiring:337, 355`, `widgetMenuNativeOffice:61, 112, 182`, `widgetRemoveOrDelete:81`, `snippetsWidgets:209`, `edgePanMenuOverlay:225` | `tidyOneHome.test.ts`, `widgetCatalogFiles.test.ts`, `widgetFilesEveryWidget.test.ts` (L "Add object") | R |
| U1 header | `contextMenuRegression:100, 156, 277`, `headerMenuUnified:70`, `widgetContextActions:48`, `decisionRisk:123, 291`, `modalA11y:116`, `snippetsWidgets:84`, `syncedWidgetChoice:75`, `linkIntentOverhaul:284`, `tableImport:147`, `sectionDragEject:108, 468` (child widget header), `_reconciliationCheck:248` | `contextMenuResolve.test.ts` (14), `widgetContextActions.test.ts` (7), `workWidgetDeleteAndMenu.test.ts`, `embeddedWidgetNoRemove.test.tsx`, `widgetRemovalChoice.test.ts` | R |
| U1 body | `contextMenuUnified:76, 107`, `createConnectedTool:87`, `contextMenuRegression:228`, `webhookOutbound:323`, `widgetSetupAi:90`, `mindmapAiSetup:84`, `widgetDelete:71` | — | R |
| U2 multi | `linkIntentOverhaul:341` | `contextMenuResolve.test.ts` | R |
| T2 cell / T1 column header | `tableCellMenu:85` (R); `tableColumnManipulation:92` (**S**) | — | R / S |
| S1 section | `contextMenuRegression` (L "Share section"), `widgetContextActions` (L "Section layout") | `widgetContextActions.test.ts` (provider, not S1) | R |
| B2 / B3 web | `webContextMenu.spec.ts:96-97` (`sendInputEvent` + H), `widgetEmbedEditable`, `widgetResize`, `widgetHeaderNarrow` (L "More work widget actions") | `webContextMenu.test.ts` (13), `browserMenuProvider.test.ts` (5), `webAddToDesk.test.ts` | H |
| N1 side tile | `deskWidgets:78`, `widgetFiles:218, 230`, `_deskFullBleedScreenshots:406`, `widgetMenuNativeOffice:158`, `widgetRemoveOrDelete:492`, `_helpers.ts:632` (shared add-via-side-menu helper; used widely) | `workWidgetDeleteAndMenu.test.ts`, `appNotifications.test.ts` (L) | R |
| N2 app tile | `fileManager:46`, `filesPanel:107-134`, `liveFolder:75`, `plexichatFeatures:115` | — | R |
| F1 Files view | `fileManager:241`, `liveFolder:104`, `phaseBTeamShare:189` | — | R |
| F2 flyout | none found | — | **untested** |
| I1 / I2 index | `restyleFunctional:142` (rooms rename), `roomDeskWidgetRename.spec.ts` (L) | — | R |
| G1 gallery | none found | — | **untested** |
| TR1 tray | `traySendToDesk:18` (**S**) | — | S only |
| CH1 assist selection | none found | `attentionItemEditor.test.ts` (L "Save selection as sticky", likely a string collision) | **untested** |
| SD1 / SD2 speed deck | none found | — | **untested** |
| U3 focus dock | none found | — | **untested** |
| DeskJumpList | `deskJumpRename:88` | — | R |

Suspect specs (a target surface not found in source; read the call log against the red baseline before calling them stale):
- `liveCanvas.spec.ts:199` right-clicks a sidebar task row and expects "Collaborate live". No sidebar row has a menu, and "Collaborate live" exists only on Files folders (`FilesView.tsx:262`).
- `shareInvite.spec.ts:167` right-clicks `[role="treeitem"]`. No renderer element has `role="treeitem"` (grep: 0).

Label strings that migrations will break (each is asserted in the specs above):
- **P2**: "Add to Focus…", "Create & link", "AI Assist", "More actions", "Make this a Desk", "Duplicate (keep synced)", "Duplicate (independent copy)", "Unlink from synced copies", "Bring to front", "Flag as a decision", "Pin to corner", "Recolor", "Copy text", "Share...", "Archive", "Delete", "Remove", "Paste", "Add row", "Duplicate row", "Delete row", "Build with AI", "Make a checklist", "Section layout", "Pin to Apps", "Insert snippet", "Import CSV, JSON or Excel".
- **C1**: "Add object", "Auto-arrange", "Reset view", "Customise this device", "From a saved snippet".
- **Others**: "Move to Trash", "Reveal in Finder", "Collaborate live", "Add to this desk", "Move to Other work widgets", "Only works on a desk", "Open beside", "Open floating", "Open full screen", "Send to desk", "Share section", "Make this a task", "Rename room", "Insert column left", "Delete column".
- **Web**: "Ask PlexiiAssist about this", "More work widget actions", "Open link as a new browser work widget".

Recommended practice: target `data-testid` / `testid` (P1 already supports `CtxMenuItem.testid`) instead of label text before renaming, so each lexicon change is a one-line data edit.
