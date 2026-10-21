// The PlexiiDraw editor's contracts: its state, the context every tool,
// command and panel receives, and the services that do the side effects (so
// a tool can be driven headlessly with fakes -- see tests/unit/drawTools).

import type { FC } from 'react'
import type { DrawCompatibility } from '@shared/draw'
import type { DrawNode as PathPointNode, Pt } from '@shared/drawGeometry'
import type { DrawDoc, DrawDocPaint, DrawDocStroke, DrawNode, DrawTextNode } from '@shared/draw/model'
import type { BrushSettings, StrokePoint } from '../brushes'

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
  /** Made by a newer PlexiiDraw: shown, never written. */
  readOnly: boolean
  compat: DrawCompatibility
  /** The schema the document was loaded as; it is never written back older. */
  storedSchema: number
  dialog: OpenDialog | null
  /** Bumped when the co-editing undo stack changes, so Undo/Redo re-enable. */
  liveUndoTick: number
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
  /** Start a brush stroke on the scratch surface with a dot at `p`. */
  beginStroke(p: StrokePoint, brush: BrushSettings): void
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
  /** Fit the artboard to the window. */
  fit(): void
}

/** Where edits go, and the co-editing undo stack when there is one. */
export interface HostService {
  /** Hand an edited document to the host for saving / co-editing (already in storage form). */
  emit(stored: unknown): void
  /** The own-change undo stack, in a live co-editing session. */
  liveUndo(): import('../../../../lib/yjsKeyedJson').LiveUndo | undefined
  /** Export through the main process. */
  exportAs(format: 'png' | 'svg' | 'pdf'): Promise<void>
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
  status(msg: string | null): void
  busy(msg: string | null): void
  select(ids: string[]): void
  setTool(id: string): void
  /** Run a registered command by id. */
  run(commandId: string, args?: unknown): void
  /** Commit a paint layer's current pixels as one undo step. */
  commitRaster(layerId: string): void
  /** The topmost selectable node under a point, honouring layer order, lock and visibility. */
  hitTest(p: Pt): DrawNode | null
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
  onPointerDown?(ctx: EditorCtx, e: ToolPointer): void
  onPointerMove?(ctx: EditorCtx, e: ToolPointer): void
  onPointerUp?(ctx: EditorCtx, e: ToolPointer): void
  /** Optional per-tool overlay (previews, handles), drawn in artboard units; k = 1/zoom. */
  Overlay?: FC<{ state: EditorState; k: number }>
  /** Stacking order of overlays (lower first). */
  overlayOrder?: number
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
  menu?: CommandMenuPlacement
  /** Disabled commands show greyed with this reason; must be pure. */
  enabled?(ctx: EditorCtx): boolean
  /** Shows a check mark. */
  checked?(ctx: EditorCtx): boolean
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

export interface DrawPanel {
  id: string
  title: string
  dock: 'right'
  order: number
  /** Fixed height in px; absent = takes the remaining space. */
  height?: number
  /** Hidden when this returns false. */
  when?(state: EditorState): boolean
  component: FC<{ ctx: EditorCtx }>
}

export interface DrawDialog {
  id: string
  title: string
  /** Width in px (the default modal is 340). */
  width?: number
  component: FC<{ ctx: EditorCtx; props?: Record<string, unknown>; close: () => void }>
}
