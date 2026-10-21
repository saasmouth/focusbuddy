import { useState } from 'react'
import { openDocHistory } from '../DocHistoryPanel'
import { confirmDialog, promptText } from '../../plexi/PromptDialog'
import { useDocumentsStore } from '../../../stores/documents'
import { useViewStore } from '../../../stores/view'
import { launchMeeting } from '../../../lib/startMeeting'
import { MenuBarShell, MenuModal, type MenuDef } from './menuBarKit'
import { DRAW_SIZES, blankDrawBody, solid, type DrawPaint } from '@shared/draw'
import type { BooleanOp } from '@shared/drawGeometry'
import { ARTBOARD_ANCHORS, type AlignEdge, type ArrangeDir, type ArtboardAnchor } from '@shared/drawOps'

// The PlexiDraw menu bar. Unlike the diagram bar, this editor really does have
// undo history, layers, pathfinder operations and file export, so every menu
// here is wired to a command that exists — nothing is listed that the studio
// cannot actually do.

export interface DrawStudioActions {
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
  exportAs: (format: 'png' | 'svg' | 'pdf') => void
  selectAll: () => void
  deleteSelection: () => void
  duplicateSelection: () => void
  boolean: (op: BooleanOp) => void
  arrange: (dir: ArrangeDir) => void
  align: (edge: AlignEdge) => void
  addLayer: (kind: 'vector' | 'raster') => void
  fitToWindow: () => void
  setZoom: (z: number) => void
  zoom: number
  showGrid: boolean
  setShowGrid: (v: boolean) => void
  snapOn: boolean
  setSnapOn: (v: boolean) => void
  /** Resize the artboard, keeping the artwork pinned at `anchor` (default top-left). */
  resize: (w: number, h: number, anchor?: ArtboardAnchor) => void
  setBackground: (p: DrawPaint) => void
  background: DrawPaint
  width: number
  height: number
  hasSelection: boolean
  /** A drawing made by a newer PlexiiDraw: every command that would change it is off. */
  readOnly?: boolean
}

export default function DrawStudioMenuBar({ actions: a }: { actions: DrawStudioActions }): JSX.Element {
  const createBlank = useDocumentsStore((s) => s.createBlank)
  const active = useDocumentsStore((s) => s.active)
  const rename = useDocumentsStore((s) => s.rename)
  const remove = useDocumentsStore((s) => s.remove)
  const goDocument = useViewStore((s) => s.goDocument)
  const goDocuments = useViewStore((s) => s.goDocuments)
  const [helpOpen, setHelpOpen] = useState(false)
  const [sizeOpen, setSizeOpen] = useState(false)
  const [w, setW] = useState(a.width)
  const [h, setH] = useState(a.height)
  const [anchor, setAnchor] = useState<ArtboardAnchor>('nw')
  const ro = a.readOnly === true
  const title = active?.title ?? 'Untitled artwork'

  async function newArtwork(): Promise<void> {
    const doc = await createBlank('draw')
    goDocument(doc.id)
  }
  async function makeCopy(): Promise<void> {
    const copy = await window.api.documents.create({ docType: 'draw', title: `Copy of ${title}`, body: active?.body })
    goDocument(copy.id)
  }
  async function doRename(): Promise<void> {
    const next = await promptText({ title: 'Rename artwork', initial: title, confirmLabel: 'Rename' })
    if (next != null && next.trim()) void rename(next.trim())
  }
  async function moveToTrash(): Promise<void> {
    if (!active) return
    const ok = await confirmDialog({
      title: `Move "${title}" to trash?`,
      body: 'You can restore it from the Documents trash.',
      confirmLabel: 'Move to trash'
    })
    if (!ok) return
    await remove(active.id)
    goDocuments()
  }

  const menus: MenuDef[] = [
    {
      id: 'file',
      label: 'File',
      build: () => [
        { kind: 'item', label: 'New artwork', icon: 'note_add', run: () => void newArtwork() },
        { kind: 'item', label: 'Make a copy', icon: 'file_copy', run: () => void makeCopy() },
        { kind: 'sep' },
        {
          kind: 'submenu',
          label: 'New from preset',
          icon: 'aspect_ratio',
          items: DRAW_SIZES.map((s) => ({
            kind: 'item' as const,
            label: `${s.label} — ${s.w}×${s.h}`,
            run: () => {
              void (async () => {
                const doc = await window.api.documents.create({ docType: 'draw', title: s.label, body: blankDrawBody(s) })
                goDocument(doc.id)
              })()
            }
          }))
        },
        { kind: 'sep' },
        // Off when read-only: the file would leave out what a newer app added.
        { kind: 'item', label: 'Export PNG…', icon: 'image', run: () => a.exportAs('png'), disabled: ro },
        { kind: 'item', label: 'Export SVG…', icon: 'polyline', run: () => a.exportAs('svg'), disabled: ro },
        { kind: 'item', label: 'Export PDF…', icon: 'picture_as_pdf', run: () => a.exportAs('pdf'), disabled: ro },
        { kind: 'sep' },
        { kind: 'item', label: 'Rename', icon: 'edit', run: doRename },
        {
          kind: 'item',
          label: 'Version history',
          icon: 'history',
          run: () => {
            if (active) openDocHistory(active.id)
          }
        },
        { kind: 'item', label: 'Move to trash', icon: 'delete', run: () => void moveToTrash() }
      ]
    },
    {
      id: 'edit',
      label: 'Edit',
      build: () => [
        { kind: 'item', label: 'Undo', shortcut: '⌘Z', icon: 'undo', run: a.undo, disabled: ro || !a.canUndo },
        { kind: 'item', label: 'Redo', shortcut: '⇧⌘Z', icon: 'redo', run: a.redo, disabled: ro || !a.canRedo },
        { kind: 'sep' },
        { kind: 'item', label: 'Select all', shortcut: '⌘A', icon: 'select_all', run: a.selectAll },
        { kind: 'item', label: 'Duplicate', shortcut: '⌘D', icon: 'file_copy', run: a.duplicateSelection, disabled: ro || !a.hasSelection },
        { kind: 'item', label: 'Delete', shortcut: '⌫', icon: 'delete', run: a.deleteSelection, disabled: ro || !a.hasSelection }
      ]
    },
    {
      id: 'object',
      label: 'Object',
      build: () => [
        {
          kind: 'submenu',
          label: 'Pathfinder',
          icon: 'join_full',
          items: [
            { kind: 'item', label: 'Unite', run: () => a.boolean('union'), disabled: ro },
            { kind: 'item', label: 'Minus front', run: () => a.boolean('subtract'), disabled: ro },
            { kind: 'item', label: 'Intersect', run: () => a.boolean('intersect'), disabled: ro },
            { kind: 'item', label: 'Exclude', run: () => a.boolean('exclude'), disabled: ro }
          ]
        },
        {
          kind: 'submenu',
          label: 'Arrange',
          icon: 'layers',
          items: [
            { kind: 'item', label: 'Bring to front', run: () => a.arrange('front'), disabled: ro },
            { kind: 'item', label: 'Bring forward', run: () => a.arrange('forward'), disabled: ro },
            { kind: 'item', label: 'Send backward', run: () => a.arrange('backward'), disabled: ro },
            { kind: 'item', label: 'Send to back', run: () => a.arrange('back'), disabled: ro }
          ]
        },
        {
          kind: 'submenu',
          label: 'Align',
          icon: 'align_horizontal_center',
          items: (['left', 'center', 'right', 'top', 'middle', 'bottom'] as AlignEdge[]).map((edge) => ({
            kind: 'item' as const,
            label: edge[0].toUpperCase() + edge.slice(1),
            run: () => a.align(edge),
            disabled: ro
          }))
        }
      ]
    },
    {
      id: 'layer',
      label: 'Layer',
      build: () => [
        { kind: 'item', label: 'New vector layer', icon: 'shapes', run: () => a.addLayer('vector'), disabled: ro },
        { kind: 'item', label: 'New paint layer', icon: 'brush', run: () => a.addLayer('raster'), disabled: ro }
      ]
    },
    {
      id: 'document',
      label: 'Document',
      build: () => [
        {
          kind: 'item',
          label: 'Artboard size…',
          icon: 'aspect_ratio',
          disabled: ro,
          run: () => {
            setW(a.width)
            setH(a.height)
            setAnchor('nw')
            setSizeOpen(true)
          }
        },
        {
          kind: 'submenu',
          label: 'Background',
          icon: 'format_color_fill',
          items: [
            { kind: 'item', label: 'Transparent', run: () => a.setBackground({ type: 'none' }), disabled: ro },
            { kind: 'item', label: 'White', run: () => a.setBackground(solid('#ffffff')), disabled: ro },
            { kind: 'item', label: 'Black', run: () => a.setBackground(solid('#000000')), disabled: ro },
            { kind: 'item', label: 'Paper', run: () => a.setBackground(solid('#faf7f2')), disabled: ro }
          ]
        },
        { kind: 'sep' },
        {
          kind: 'item',
          label: 'Meeting',
          icon: 'videocam',
          run: () => void launchMeeting({ kind: 'draw', id: active?.id ?? '', title: title || 'Artwork review' })
        }
      ]
    },
    {
      id: 'view',
      label: 'View',
      build: () => [
        { kind: 'item', label: 'Fit to window', icon: 'fit_screen', run: a.fitToWindow },
        { kind: 'item', label: 'Zoom to 100%', icon: 'zoom_in', run: () => a.setZoom(1) },
        { kind: 'sep' },
        { kind: 'item', label: 'Grid', icon: 'grid_4x4', run: () => a.setShowGrid(!a.showGrid), active: a.showGrid },
        { kind: 'item', label: 'Snap to edges', icon: 'straighten', run: () => a.setSnapOn(!a.snapOn), active: a.snapOn }
      ]
    },
    {
      id: 'help',
      label: 'Help',
      build: () => [{ kind: 'item', label: 'How PlexiiDraw works', icon: 'help', run: () => setHelpOpen(true) }]
    }
  ]

  return (
    <>
      <MenuBarShell menus={menus} testid="draw-studio-menubar" />
      {sizeOpen && (
        <MenuModal title="Artboard size" onClose={() => setSizeOpen(false)}>
          <div className="space-y-2 text-[13px]">
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5">
                <span className="text-[var(--ink-50)]">Width</span>
                <input
                  type="number"
                  value={w}
                  min={16}
                  max={12000}
                  onChange={(e) => setW(Number(e.target.value) || 0)}
                  data-testid="draw-size-width"
                  className="fb-field w-24 px-2 py-1"
                />
              </label>
              <label className="flex items-center gap-1.5">
                <span className="text-[var(--ink-50)]">Height</span>
                <input
                  type="number"
                  value={h}
                  min={16}
                  max={12000}
                  onChange={(e) => setH(Number(e.target.value) || 0)}
                  data-testid="draw-size-height"
                  className="fb-field w-24 px-2 py-1"
                />
              </label>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[var(--ink-50)]">Anchor</span>
              {/* Where the artwork stays pinned as the page grows or shrinks
                  around it, like a canvas-size dialog. */}
              <div className="grid grid-cols-3 gap-0.5" role="radiogroup" aria-label="Anchor" data-testid="draw-size-anchor">
                {ARTBOARD_ANCHORS.map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={anchor === id}
                    aria-label={`Anchor ${id}`}
                    data-testid={`draw-size-anchor-${id}`}
                    onClick={() => setAnchor(id)}
                    className={`w-5 h-5 rounded-sm border ${anchor === id ? 'bg-accent border-accent' : 'border-[var(--edge-firm)] hover:bg-[var(--surface-sunken)]'}`}
                  />
                ))}
              </div>
            </div>
            <p className="text-[11px] text-[var(--ink-40)]">
              Changing the artboard resizes the canvas only — the artwork stays pinned at the anchor, and painted pixels are kept at their size, never stretched.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setSizeOpen(false)} className="fb-btn-surface px-3 py-1.5">
                Cancel
              </button>
              <button
                onClick={() => {
                  a.resize(Math.max(16, Math.min(12000, Math.round(w))), Math.max(16, Math.min(12000, Math.round(h))), anchor)
                  setSizeOpen(false)
                }}
                data-testid="draw-size-apply"
                className="btn-primary px-3 py-1.5"
              >
                Resize
              </button>
            </div>
          </div>
        </MenuModal>
      )}
      {helpOpen && (
        <MenuModal title="How PlexiiDraw works" onClose={() => setHelpOpen(false)}>
          <div className="space-y-2.5 text-[13px] text-[var(--ink-70)]">
            <p>
              PlexiiDraw holds vector shapes and painted pixels in one stack. A <strong>vector layer</strong> takes the pen, pencil, shape and type tools; a{' '}
              <strong>paint layer</strong> takes the brush, eraser and paint bucket. Add either from the Layer menu or the two buttons above the layers list.
            </p>
            <ul className="space-y-1 list-disc pl-4">
              <li>Draw a bezier with the Pen (P) — click for corners, drag for curves, click the first point to close.</li>
              <li>Edit points with the direct-select tool (A): drag anchors, drag handles, hold Alt to break a handle pair.</li>
              <li>Select two or more shapes and use Pathfinder to unite, subtract, intersect or exclude them.</li>
              <li>Hold Shift while drawing for a perfect square or circle, and while dragging to constrain to one axis.</li>
              <li>Space-drag (or the Hand tool) pans; ⌘/Ctrl with the scroll wheel zooms.</li>
              <li>[ and ] resize the brush. The eyedropper (I) samples a colour from a shape or from painted pixels.</li>
              <li>Rasterize a vector layer to paint over its shapes; merge down to flatten two layers into one.</li>
            </ul>
          </div>
        </MenuModal>
      )}
    </>
  )
}
