// The PlexiiDraw editor's contracts: its state, the context every tool,
// command and panel receives, and the services that do the side effects (so
// a tool can be driven headlessly with fakes -- see tests/unit/drawTools).

import type { FC } from 'react'
import type { DrawCompatibility } from '@shared/draw'
import type { DrawNode as PathPointNode, Pt } from '@shared/drawGeometry'
import type { DrawDoc, DrawDocPaint, DrawDocStroke, DrawNode, DrawTextNode } from '@shared/draw/model'
import type { BrushSettings, StrokePoint } from '../brushes'
import type { DocumentOps } from '../../editor/documentOps'

/** A smart guide being drawn while something snaps. */
export interface SnapGuide {
  axis: 'x' | 'y'
  at: number
}

export interface HistoryEntry {
  doc: DrawDoc
  /** What the step did ("Move", "Rectangle"...), for a History panel and "Undo Move". */
  label: string
}

/** The one active pointer gesture: which tool owns it, and that tool's own data. */
export interface Gesture {
  toolId: string
  data: unknown
}

/** A dialog a command asked the shell to show. */
export interface OpenDialog {
  id: string
  props?: Record<string, unknown>
}

export interface EditorState {
  /** The document, always schema v2 in memory (written back as v1 while v2 writes are gated). */
  doc: DrawDoc
  past: HistoryEntry[]
  future: HistoryEntry[]
  tool: string
  /**
   * The tool a double-click on the rail locked (SPEC §3.2): it stays armed
   * after placing, until Esc or another tool. Null when none is locked.
   */
  toolLocked: string | null
  selection: string[]
  zoom: number
  /** Defaults for the next shape (Illustrator's "set the fill, then draw"). */
  fill: DrawDocPaint
  stroke: DrawDocStroke | undefined
  brush: BrushSettings
  gesture: Gesture | null
  /** The pen's in-progress path (0 undo entries until it is finished). */
  pen: PathPointNode[] | null
  cursorPt: Pt | null
  /** The text object being typed into, if any. */
  editingText: string | null
  guides: SnapGuide[]
  status: string | null
  busy: string | null
  showGrid: boolean
  snapOn: boolean
  spaceDown: boolean
  /** The live, uncommitted brush stroke is on screen. */
  scratchVisible: boolean
  /**
   * Shown, never written. Enforced centrally — history.commit, the command
   * runner, tool selection and the key handler all check it — so every write
   * path is covered by this one flag.
   *
   * It has TWO causes, OR'd: the drawing was made by a newer PlexiiDraw
   * (`compat.readOnly`), or the HOST says this person may only read it
   * (`hostReadOnly`) — a viewer of a shared drawing. The two are kept apart
   * because `fold` recomputes compatibility when a peer's body arrives, and
   * recomputing `readOnly` from compatibility alone silently handed a viewer a
   * writable editor the first time anybody else typed.
   */
  readOnly: boolean
  /** The host's own read-only, remembered so `fold` cannot clear it. */
  hostReadOnly: boolean
  compat: DrawCompatibility
  /** The schema the document was loaded as; it is never written back older. */
  storedSchema: number
  dialog: OpenDialog | null
  /** Files loaded into the Place cursor (File › Place), waiting to be clicked or dragged in. */
  placing: import('./place').PlaceQueue | null
  /** Bumped when the co-editing undo stack changes, so Undo/Redo re-enable. */
  liveUndoTick: number
  /**
   * May a v1 drawing become v2 when edited (DRAW_V2_WRITES, unless a live
   * session has a participant who cannot read v2)? See editor/v2gate.ts.
   */
  v2Writes: boolean
  /** Why v2 writes are off, as a clause ("someone in this live session ..."); null when on. */
  v2Blocked: string | null
  /**
   * Direct selection (WP-PATH): path id -> the [subpath, node] pairs selected.
   * A selected path with NO entry is wholly selected (every anchor); an entry
   * with an empty list is a path selected with none of its anchors. Any
   * object-level select (ctx.select) clears it. See editor/anchorSelection.ts.
   */
  anchors: Record<string, Array<[number, number]>>
  /** The pen is continuing this open end (null for a new path). */
  penTarget: { id: string; si: number; end: 'start' | 'end' } | null
  /** The Curvature tool's path in progress (0 undo entries until finished). */
  curvature: { points: Array<{ x: number; y: number; corner?: boolean }> } | null
  /** Path-editing preferences (Properties panel, tool options). */
  pathPrefs: PathPrefs
  /**
   * State a tool, panel or command keeps BETWEEN gestures, keyed by its owner
   * (a transform tool's origin, the Align panel's key object, the last
   * transform for Transform Again). Never part of the document or of undo.
   */
  toolState: Record<string, unknown>
  /** Isolation mode: the isolated groups' ids, outermost first; [] when not isolated (see editor/isolation.ts). */
  isolation: string[]
  /**
   * The overlay panels (Layers, Artboards...) open now, by panel id. Editor UI
   * state, never part of the document or of undo; a command (F7) or the rail
   * toggles them, and the studio shows each as a ShellPanel.
   */
  openPanels: string[]
}

export interface PathPrefs {
  /** Show handles when several anchors are selected (one selected anchor always shows its handles). */
  showHandles: boolean
  /** Smooth tool fidelity, 0 (accurate) .. 100 (smooth). */
  smoothFidelity: number
  /** Path Eraser and Smooth tool reach, in screen px. */
  brushSize: number
}

/** A pointer event in ARTBOARD coordinates, with what tools read off it. */
export interface ToolPointer {
  p: Pt
  clientX: number
  clientY: number
  button: number
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  /** 0..1; 0.5 is substituted when the device reports none. */
  pressure: number
  /** Click count (2 = double click). */
  detail: number
}

/** The key fields the editor reads, so a test can pass a plain object. */
export interface KeyInput {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  /** True when the event came from a text field (it is then left to the field). */
  inField: boolean
  /**
   * The field is one of PlexiiDraw's own (a panel, the options bar). Its
   * command chords that are not text editing (⇧⌘P, ⌘O, ⌘0...) still run, as
   * in Illustrator; see fieldKeepsKey in commands/keys.ts.
   */
  inStudioField?: boolean
  preventDefault(): void
}

// ── Undo ─────────────────────────────────────────────────────────────────────

/**
 * One undoable step that streams previews: begin on pointer-down, preview on
 * every move (no entries, coalesced into one), commit on pointer-up -- or
 * cancel when nothing changed, which takes the step off the stack again.
 */
export interface Txn {
  preview(next: DrawDoc): void
  commit(): void
  cancel(): void
}

export interface History {
  /** Apply a change as one labelled undo step. A change that is no change records nothing. */
  commit(next: DrawDoc, label?: string): void
  /** Apply a change with NO undo step of its own (it belongs to a step already open). */
  replace(next: DrawDoc): void
  /** Open a streamed step; see Txn. */
  begin(label?: string): Txn
  undo(): void
  redo(): void
  canUndo(): boolean
  canRedo(): boolean
}

// ── Services: side effects tools need, faked in headless tests ───────────────

/**
 * Paint-layer pixels. The real implementation draws on the layers' canvases;
 * the tool harness keeps plain RGBA buffers.
 */
export interface RasterService {
  /** The layer's drawing surface is mounted and ready. */
  hasSurface(layerId: string): boolean
  /** Scanline flood fill; false when nothing changed. */
  floodFill(layerId: string, p: Pt, color: string, tolerance: number): boolean
  /**
   * Start a brush stroke on the scratch surface with a dot at `p`, for the
   * paint layer `layerId` (the scratch takes that layer's frame; points are
   * in document space). Without a layer id, the default frame.
   */
  beginStroke(p: StrokePoint, brush: BrushSettings, layerId?: string): void
  /** Extend the scratch stroke. */
  strokeTo(from: StrokePoint, to: StrokePoint, brush: BrushSettings): void
  /** Lay the scratch stroke onto the layer (or punch it out) and clear the scratch. False when there was nothing to lay. */
  endStroke(layerId: string, brush: BrushSettings, erase: boolean): boolean
  /** The colour under `p` on a layer, or null where it is transparent. */
  sample(layerId: string, p: Pt): string | null
  /** The layer's pixels as an embeddable PNG data URL, and remember them as what is on screen. */
  snapshot(layerId: string): string
  /** Forget what is on screen, so every layer is repainted from the document (after undo/redo/fold). */
  invalidate(): void
  /**
   * A paint layer's stored picture (`src`, `from` pixels in size) re-laid,
   * unscaled, onto a canvas of `to`'s size with its top-left at (dx, dy):
   * growing adds transparent margin, shrinking crops. Resolves to `src`
   * itself when the picture cannot be decoded (the caller then leaves that
   * layer alone). Optional: raster.reframeRaster is used without it.
   */
  reframe?(src: string, from: { w: number; h: number }, to: { w: number; h: number }, dx: number, dy: number): Promise<string>
}

/** Real-font line breaking for text objects. */
export interface TextService {
  /** The text node with `lines` re-measured. */
  measure(node: DrawTextNode): DrawTextNode
}

/** The scrolling viewport the canvas sits in. */
export interface ViewportService {
  getScroll(): { left: number; top: number }
  setScroll(left: number, top: number): void
  /** Fit the active artboard to the window. */
  fit(): void
  /**
   * Zoom and scroll so a document rectangle fills the window (Fit All, an
   * artboard, Zoom to Selection), in the part no pinned panel covers.
   * `pad` is the screen margin kept on every side (default 24 px), `maxZoom`
   * the most it may zoom in (default 4, so Fit never blows a small artboard
   * up past 400%). Optional: absent in headless runs.
   */
  fitBox?(box: import('@shared/drawGeometry').Box, opts?: { pad?: number; maxZoom?: number }): void
  /** The part of the document the window shows, in document units (where Paste centres art). Optional: absent in headless runs. */
  visibleRect?(): import('@shared/drawGeometry').Box | null
}

/**
 * What an export covers when a drawing has several artboards: one artboard
 * (the active one unless named), each artboard to its own file, the whole
 * canvas, or -- for PDF -- every artboard as a page.
 */
export interface ExportOptions {
  scope?: 'artboard' | 'each' | 'canvas' | 'pages'
  artboardId?: string
}

/**
 * The studio chrome a command may ask for (the office shell around the
 * canvas). Absent in headless runs, so commands that need it are disabled there.
 */
export interface UiService {
  /** Move keyboard focus to the next part of the window: canvas, then the top bar, then the tool rail. */
  cycleFocus(): void
}

/** Where edits go, and the co-editing undo stack when there is one. */
export interface HostService {
  /** Hand an edited document to the host for saving / co-editing (already in storage form). */
  emit(stored: unknown): void
  /** The own-change undo stack, in a live co-editing session. */
  liveUndo(): import('../../../../lib/yjsKeyedJson').LiveUndo | undefined
  /** Export through the main process. */
  exportAs(format: 'png' | 'svg' | 'pdf', opts?: ExportOptions): Promise<void>
  /**
   * The host's Save, when the host writes only when asked (a saved snippet's
   * edit session: SnippetEditSessionView); absent when every edit is persisted
   * as it is made, which is how a drawing saves. Read at call time, so File ›
   * Save and ⌘S (`file.save`) follow the current prop. The editor never saves.
   */
  saveRequest?(): (() => void) | undefined
  /**
   * Set when the studio is editing something that is not a document -- a
   * saved snippet's edit session (DrawStudio's `session`). Commands that act
   * on a DOCUMENT (Make a copy, Rename, Version history, Move to trash, New,
   * Open, Meeting) are then disabled with its reason (editor/session.ts).
   * Read at call time; absent for a drawing.
   */
  session?(): DrawSession | undefined
  /** The studio's own live `title` prop (what is being edited, by name). Absent in headless runs. */
  title?(): string
  /**
   * The document on screen, bound BY THE HOST to its id (DrawStudio's
   * `documentOps`, built with editor/documentOps.ts createDocumentOps). Every
   * File-menu command that acts on a document -- New, New from preset, Open
   * SVG, Make a copy, Rename, Version history, Move to trash -- and Document ›
   * Meeting goes through it, and through nothing else: the commands never
   * read the documents store, whose `active` document is whatever Documents
   * last had open, not necessarily this one (a desk widget never puts its
   * drawing there). Absent where no host supplies a document (a live drawing,
   * a snippet session, headless): those commands are then disabled with a
   * reason (editor/session.ts). Read at call time.
   */
  docOps?(): DocumentOps | undefined
}

/** What the studio is editing, when it is not a document (see HostService.session). */
export interface DrawSession {
  kind: 'snippet'
  /** Why document commands are off; editor/session.ts has the default wording. */
  reason?: string
}

// ── The context ──────────────────────────────────────────────────────────────

export interface EditorCtx {
  /** The store itself, for React components that subscribe to slices of it. */
  store: import('zustand/vanilla').StoreApi<EditorState>
  get(): EditorState
  set(patch: Partial<EditorState> | ((s: EditorState) => Partial<EditorState>)): void
  doc(): DrawDoc
  history: History
  raster: RasterService
  text: TextService
  viewport: ViewportService
  host: HostService
  /** The studio chrome; absent in headless runs. */
  ui?: UiService
  status(msg: string | null): void
  busy(msg: string | null): void
  select(ids: string[]): void
  setTool(id: string): void
  /** Run a registered command by id. */
  run(commandId: string, args?: unknown): void
  /** Commit a paint layer's current pixels as one undo step. */
  commitRaster(layerId: string): void
  /** The topmost selectable node under a point, honouring layer order, lock and visibility (and isolation mode). */
  hitTest(p: Pt): DrawNode | null
  /** The innermost object under a point -- a member of a group, never the group (see editor/isolation.ts). */
  hitTestDeep(p: Pt): DrawNode | null
}

// ── Extension points (see documents/draw/README.md) ──────────────────────────

export interface DrawTool {
  id: string
  label: string
  /** Material Symbols name for the toolbox button. */
  icon: string
  /** Toolbox section; a divider is drawn between sections. */
  group: number
  /** Position within the whole toolbox (sections are ordered by their first tool). */
  order: number
  /**
   * Shortcut as Illustrator writes it: one key ('M', '\\') or Shift with one
   * key ('Shift+E'). Use Illustrator's default for the tool where it has one
   * (commands/illustratorKeys.ts); conflicts fail a unit test.
   */
  key?: string
  cursor?: string
  /** Shows the brush panel while active (the painting tools). */
  paint?: boolean
  /** Usable on a read-only drawing (looks, never edits). */
  readOnlySafe?: boolean
  /** Not shown in the toolbox: a mode a command switches to (the Place cursor). */
  hidden?: boolean
  onPointerDown?(ctx: EditorCtx, e: ToolPointer): void
  onPointerMove?(ctx: EditorCtx, e: ToolPointer): void
  onPointerUp?(ctx: EditorCtx, e: ToolPointer): void
  /** The tool's options dialog: double-clicking its toolbox button, or Enter while it is active. */
  onOptions?(ctx: EditorCtx): void
  /** Optional per-tool overlay (previews, handles), drawn in artboard units; k = 1/zoom. */
  Overlay?: FC<{ state: EditorState; k: number }>
  /** Stacking order of overlays (lower first). */
  overlayOrder?: number
  /** Works on anchors: the selection's bounding box (and its handles) is hidden while it is active. */
  anchorTool?: boolean
  /**
   * The rail flyout this tool belongs to ('pen', 'shapes'...): tools sharing a
   * flyout show as ONE rail button (the last one used) with the others behind
   * it, as Illustrator's toolbar groups them. Option/Alt-click the button, or
   * run "Next tool in group", to step through them.
   */
  flyout?: string
}

export type MenuId = 'file' | 'edit' | 'object' | 'layer' | 'document' | 'view' | 'help' | (string & {})

export interface CommandMenuPlacement {
  /** Top-level menu id, then an optional submenu label: 'object' or 'object/Pathfinder'. */
  path: string
  /** Position within the menu; items in different hundreds get a separator between them. */
  order: number
}

export interface Command {
  id: string
  label: string
  icon?: string
  /**
   * Shortcut text for a key keymap.ts does not hold. A key bound in keymap.ts
   * is shown from there, written for the platform, so leave this out.
   */
  shortcut?: string
  /**
   * Set on a stand-in for a command another package delivers: it holds the
   * key and the menu place, shows disabled with this reason ("arrives with
   * Transform tools"), and is replaced automatically by the real command.
   */
  pending?: string
  /**
   * Its run() says why it cannot work (and changes nothing) when it is
   * disabled, so its key still runs it then: Group on a v1 drawing says that
   * groups need the newer format instead of doing nothing.
   */
  explainsWhenDisabled?: boolean
  menu?: CommandMenuPlacement
  /** Disabled commands show greyed with this reason; must be pure. */
  enabled?(ctx: EditorCtx): boolean
  /** Why it is disabled now, as a short phrase ("select something to zoom to"), shown under the menu item and in bar tooltips; must be pure. */
  disabledReason?(ctx: EditorCtx): string | null
  /** Shows a check mark. */
  checked?(ctx: EditorCtx): boolean
  /** The menu's wording now, when it changes with state (Hide Artboards / Show Artboards); `label` is the fixed name used elsewhere. Must be pure. */
  menuLabel?(ctx: EditorCtx): string
  /** Whether a KEY binding should fire now; when false the key falls through (e.g. arrows with nothing selected). */
  keyWhen?(ctx: EditorCtx): boolean
  run(ctx: EditorCtx, args?: unknown): void | Promise<void>
}

/** A top-level menu or a submenu heading. */
export interface MenuSpec {
  /** 'object' for a top-level menu, 'object/Pathfinder' for a submenu. */
  path: string
  label: string
  icon?: string
  order: number
}

/**
 * An overlay panel (Layers, Artboards; later Swatches, Appearance, Symbols,
 * History). It floats over the canvas beside the tool rail (the office
 * shell's ShellPanel), opened from its button at the bottom of the rail or by
 * its command, and can be pinned. There is no docked panel column.
 */
export interface DrawPanel {
  id: string
  title: string
  /** Material Symbols name for its rail button and header. */
  icon: string
  /** Position among the panel buttons at the bottom of the rail. */
  order: number
  /** The command that toggles it (its key and menu item come from there): 'window.layers'. */
  command: string
  component: FC<{ ctx: EditorCtx }>
}

/**
 * A tab of the top bar (the office shell's ContextBar). Home and Object are
 * always there; a contextual tab (Type, Shape, Path...) appears while `when`
 * holds and never takes focus on its own. Every control runs a command.
 */
export interface DrawBarTab {
  id: string
  label: string
  order: number
  /** A permanent tab's place in the shared tab order (SPEC §3.9); contextual tabs have `when` instead. */
  role?: import('../../../office/shell').TabRole
  /** A contextual tab: shown only while this returns true, with the contextual marker. */
  when?(state: EditorState): boolean
  component: FC<{ ctx: EditorCtx }>
}

export interface DrawDialog {
  id: string
  title: string
  /** Width in px (the default modal is 340). */
  width?: number
  /**
   * The component brings its own modal (an app-wide dialog such as the
   * saved-snippets library), so the studio shows it as it is rather than
   * inside its own titled modal, which would draw a modal within a modal.
   */
  frameless?: boolean
  component: FC<{ ctx: EditorCtx; props?: Record<string, unknown>; close: () => void }>
}
