// The interactive slide editor stage. Renders the 1280x720 logical slide CSS-
// scaled to fit, with every element wrapped in react-rnd for select / move /
// resize. Click selects; Shift/Cmd-click extends the selection; a drag on empty
// canvas rubber-bands a marquee. Dragging any selected element moves the whole
// selection together. Double-clicking a text element edits it. Geometry edits
// flow back through callbacks; SlidesEditor owns the data, selection and undo.

import { useRef, useState } from 'react'
import { Rnd } from 'react-rnd'
import type { DeckTheme, Slide, SlideElement, SlideTextElement } from '@shared/types'
import { SLIDE_W, SLIDE_H } from '@shared/slideThemes'
import SlideElementView from './SlideElementView'
import { fillToCss } from '@shared/fills'
import { elementText } from './slideOps'

// Smart-guide snapping. While dragging, an element's left / centre / right (and
// top / middle / bottom) edges snap to the same edges of every other element and
// to the slide's own edges and centre, exactly like Figma. SNAP is the catch
// distance in slide units; a pink guide line is drawn wherever a snap is active.
const SNAP = 7

interface Guide {
  o: 'v' | 'h'
  pos: number
}

interface Marquee {
  x0: number
  y0: number
  x1: number
  y1: number
}

// Find the single closest snap among a set of moving edge positions and a set of
// candidate target lines. Returns the delta to apply and the line to draw.
function bestSnap(moving: number[], targets: number[]): { delta: number; line: number } | null {
  let best: { delta: number; line: number; dist: number } | null = null
  for (const m of moving) {
    for (const t of targets) {
      const dist = Math.abs(m - t)
      if (dist <= SNAP && (!best || dist < best.dist)) best = { delta: t - m, line: t, dist }
    }
  }
  return best ? { delta: best.delta, line: best.line } : null
}

interface Props {
  slide: Slide
  theme: DeckTheme
  width: number
  selectedIds: string[]
  onSelect: (id: string | null, additive: boolean) => void
  onSelectMany: (ids: string[]) => void
  onUpdateElement: (id: string, patch: Partial<SlideElement>) => void
  onMoveMany: (ids: string[], dx: number, dy: number) => void
  onSetText: (id: string, text: string) => void
  // The logical canvas size. Defaults to the 16:9 slide space so existing decks
  // are unaffected; PlexiDesign passes the design's own width/height so the same
  // interactive canvas (drag, resize, snap guides, marquee) works at any size.
  logicalW?: number
  logicalH?: number
  // ── PlexiDesign page-layout extensions ─────────────────────────────────────
  // All optional, so SlidesEditor passes none of them and behaves exactly as it
  // always has.
  //
  // Elements painted BENEATH the editable ones and not interactive: a page's
  // master furniture. Drawn at reduced contrast is the editor's business, not
  // this component's — it simply renders and ignores clicks.
  underlay?: SlideElement[]
  // Extra snap lines beyond the elements themselves: margins, the column grid
  // and the author's own ruler guides.
  extraSnapX?: number[]
  extraSnapY?: number[]
  // Elements that cannot be selected, moved or resized (a locked layer).
  lockedIds?: string[]
  // Drawn in logical coordinates above the content: guides, the margin box, the
  // column grid, overset markers. Pointer events are the caller's to manage.
  overlay?: React.ReactNode
  // Where a text element's EDITABLE text comes from. PlexiDesign supplies this
  // for threaded frames, whose words live in a story rather than on the element.
  textOf?: (el: SlideTextElement) => string
  // A chance to handle the edit gesture entirely. Returning true means the owner
  // took it (PlexiDesign puts a caret in the text) and no inline box is opened.
  // The point is in logical canvas coordinates, so the caret can land exactly
  // where the pointer did rather than at the start of the frame.
  onEditRequest?: (el: SlideTextElement, point: { x: number; y: number }) => boolean
}

// Visible square handles on the selected element's corners and edge midpoints,
// so resizing is as discoverable for an image as it is for a shape.
const HANDLE: React.CSSProperties = {
  width: 14,
  height: 14,
  background: '#6d5dfc',
  border: '2px solid #fff',
  borderRadius: 3,
  boxShadow: '0 1px 3px rgba(0,0,0,0.3)'
}
const HANDLE_STYLES = {
  topLeft: { ...HANDLE, left: -7, top: -7 },
  top: { ...HANDLE, top: -7 },
  topRight: { ...HANDLE, right: -7, top: -7 },
  right: { ...HANDLE, right: -7 },
  bottomRight: { ...HANDLE, right: -7, bottom: -7 },
  bottom: { ...HANDLE, bottom: -7 },
  bottomLeft: { ...HANDLE, left: -7, bottom: -7 },
  left: { ...HANDLE, left: -7 }
}

export default function SlideCanvas({
  slide,
  theme,
  width,
  selectedIds,
  onSelect,
  onSelectMany,
  onUpdateElement,
  onMoveMany,
  onSetText,
  logicalW = SLIDE_W,
  logicalH = SLIDE_H,
  underlay,
  extraSnapX,
  extraSnapY,
  lockedIds,
  overlay,
  textOf,
  onEditRequest
}: Props): JSX.Element {
  const lw = logicalW
  const lh = logicalH
  const scale = width / lw
  const height = width * (lh / lw)
  const bg = fillToCss(slide.background) ?? theme.background
  const elements = (slide.elements ?? []).slice().sort((a, b) => a.z - b.z)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // Live drag state: which elements are moving, the lead element, and the delta.
  const [drag, setDrag] = useState<{ ids: string[]; primaryId: string; dx: number; dy: number } | null>(null)
  const [guides, setGuides] = useState<Guide[]>([])
  const [marquee, setMarquee] = useState<Marquee | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)

  // Snapped position + guides for `el` dragged to (x, y). Elements in `exclude`
  // (the ones moving with it) are not snap targets, so a group never snaps to
  // its own members.
  function computeSnap(
    el: SlideElement,
    x: number,
    y: number,
    exclude: Set<string>
  ): { x: number; y: number; guides: Guide[] } {
    const others = elements.filter((o) => !exclude.has(o.id))
    const xs: number[] = [0, lw / 2, lw, ...(extraSnapX ?? [])]
    const ys: number[] = [0, lh / 2, lh, ...(extraSnapY ?? [])]
    for (const o of others) {
      xs.push(o.x, o.x + o.w / 2, o.x + o.w)
      ys.push(o.y, o.y + o.h / 2, o.y + o.h)
    }
    const sx = bestSnap([x, x + el.w / 2, x + el.w], xs)
    const sy = bestSnap([y, y + el.h / 2, y + el.h], ys)
    const g: Guide[] = []
    if (sx) g.push({ o: 'v', pos: sx.line })
    if (sy) g.push({ o: 'h', pos: sy.line })
    return { x: sx ? x + sx.delta : x, y: sy ? y + sy.delta : y, guides: g }
  }

  // The set of elements a drag on `id` should move: the whole selection when the
  // element is part of a multi-selection, otherwise just itself.
  function movingSet(id: string): string[] {
    return selectedIds.includes(id) && selectedIds.length > 1 ? selectedIds : [id]
  }

  function startEdit(el: SlideElement, point?: { x: number; y: number }): void {
    if (el.type !== 'text') return
    if (onEditRequest?.(el, point ?? { x: el.x, y: el.y })) return
    setEditingId(el.id)
    setDraft(textOf ? textOf(el) : elementText(el))
  }
  function commitEdit(): void {
    if (editingId) onSetText(editingId, draft)
    setEditingId(null)
  }

  // Convert a viewport point to slide coordinates using the scaled stage's box.
  function toSlide(clientX: number, clientY: number): { x: number; y: number } {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale }
  }

  // Marquee select: begins only on the empty stage (not on an element). A tiny
  // drag is treated as a plain click and clears the selection.
  function beginMarquee(e: React.MouseEvent): void {
    if (e.target !== e.currentTarget) return
    const start = toSlide(e.clientX, e.clientY)
    setMarquee({ x0: start.x, y0: start.y, x1: start.x, y1: start.y })
    const onMove = (ev: MouseEvent): void => {
      const p = toSlide(ev.clientX, ev.clientY)
      setMarquee((m) => (m ? { ...m, x1: p.x, y1: p.y } : m))
    }
    const onUp = (ev: MouseEvent): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const p = toSlide(ev.clientX, ev.clientY)
      setMarquee(null)
      const rx0 = Math.min(start.x, p.x)
      const ry0 = Math.min(start.y, p.y)
      const rx1 = Math.max(start.x, p.x)
      const ry1 = Math.max(start.y, p.y)
      if (rx1 - rx0 < 4 && ry1 - ry0 < 4) {
        onSelect(null, false) // a click on empty canvas deselects
        return
      }
      const hit = elements
        .filter((el) => el.x < rx1 && el.x + el.w > rx0 && el.y < ry1 && el.y + el.h > ry0)
        .filter((el) => !lockedIds || !lockedIds.includes(el.id))
        .map((el) => el.id)
      onSelectMany(hit)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      data-testid="slide-canvas"
      style={{ width, height, position: 'relative', overflow: 'hidden', background: bg, boxShadow: '0 1px 8px rgba(0,0,0,0.12)' }}
    >
      <div
        ref={stageRef}
        onMouseDown={beginMarquee}
        style={{ width: lw, height: lh, position: "absolute", top: 0, left: 0, transform: `scale(${scale})`, transformOrigin: 'top left', color: theme.textColor }}
      >
        {/* Master furniture: painted first so it sits under the page's own
            content, and inert so a running head cannot be nudged by accident. */}
        {underlay && underlay.length > 0 && (
          <div data-testid="slide-underlay" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            {underlay.slice().sort((a, b) => a.z - b.z).map((el) => (
              <SlideElementView key={`u-${el.id}`} el={el} />
            ))}
          </div>
        )}
        {elements.map((el) => {
          const selected = selectedIds.includes(el.id)
          const isEditing = el.id === editingId
          const locked = !!lockedIds && lockedIds.includes(el.id)
          const showHandles = selected && selectedIds.length === 1 && !isEditing && !locked
          const pos = drag && drag.ids.includes(el.id) ? { x: el.x + drag.dx, y: el.y + drag.dy } : { x: el.x, y: el.y }
          return (
            <Rnd
              key={el.id}
              scale={scale}
              bounds="parent"
              size={{ width: el.w, height: el.h }}
              position={pos}
              disableDragging={isEditing || locked}
              enableResizing={showHandles}
              lockAspectRatio={el.type === 'image' && !!el.lockAspect}
              resizeHandleStyles={showHandles ? HANDLE_STYLES : undefined}
              onMouseDown={(e) => {
                if (locked) return
                const additive = e.shiftKey || e.metaKey || e.ctrlKey
                if (additive) onSelect(el.id, true)
                // Keep a multi-selection intact when grabbing a member to drag it;
                // only a plain click on an unselected element replaces.
                else if (!selectedIds.includes(el.id)) onSelect(el.id, false)
              }}
              onDrag={(_e, d) => {
                const ids = movingSet(el.id)
                const snapped = computeSnap(el, d.x, d.y, new Set(ids))
                setDrag({ ids, primaryId: el.id, dx: snapped.x - el.x, dy: snapped.y - el.y })
                setGuides(snapped.guides)
              }}
              onDragStop={(_e, d) => {
                let ids: string[]
                let dx: number
                let dy: number
                if (drag && drag.primaryId === el.id) {
                  ids = drag.ids
                  dx = drag.dx
                  dy = drag.dy
                } else {
                  ids = movingSet(el.id)
                  const snapped = computeSnap(el, d.x, d.y, new Set(ids))
                  dx = snapped.x - el.x
                  dy = snapped.y - el.y
                }
                if (ids.length > 1) onMoveMany(ids, dx, dy)
                else onUpdateElement(el.id, { x: Math.round(el.x + dx), y: Math.round(el.y + dy) })
                setDrag(null)
                setGuides([])
              }}
              onResizeStop={(_e, _dir, ref, _delta, p) =>
                onUpdateElement(el.id, {
                  w: Math.round(parseFloat(ref.style.width)),
                  h: Math.round(parseFloat(ref.style.height)),
                  x: Math.round(p.x),
                  y: Math.round(p.y)
                })
              }
              style={{
                outline: selected ? '2px solid #6d5dfc' : '1px dashed rgba(120,120,120,0.35)',
                outlineOffset: 0
              }}
              onDoubleClick={(ev) => startEdit(el, toSlide(ev.clientX, ev.clientY))}
            >
              {isEditing && el.type === 'text' ? (
                <textarea
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setEditingId(null)
                    }
                  }}
                  style={{
                    width: '100%',
                    height: '100%',
                    resize: 'none',
                    border: 'none',
                    outline: 'none',
                    background: 'rgba(255,255,255,0.85)',
                    color: '#111',
                    fontSize: el.paragraphs[0]?.runs[0]?.fontSize ?? 24,
                    fontFamily: el.fontFamily,
                    padding: 4
                  }}
                />
              ) : (
                <div data-testid="slide-element" data-eltype={el.type} style={{ width: '100%', height: '100%', pointerEvents: 'none' }}>
                  <SlideElementView el={{ ...el, x: 0, y: 0 }} />
                </div>
              )}
            </Rnd>
          )
        })}

        {/* Smart-guide lines, drawn in slide coordinates so they scale with the
            stage. Pink to read as alignment aids, not content. */}
        {guides.map((g, i) => (
          <div
            key={i}
            data-testid="slide-guide"
            style={{
              position: 'absolute',
              background: '#ec4899',
              pointerEvents: 'none',
              zIndex: 9999,
              ...(g.o === 'v'
                ? { left: g.pos - 1, top: 0, width: 2, height: lh }
                : { top: g.pos - 1, left: 0, height: 2, width: lw })
            }}
          />
        ))}

        {overlay}

        {marquee && (
          <div
            data-testid="slide-marquee"
            style={{
              position: 'absolute',
              border: '1px solid #6d5dfc',
              background: 'rgba(109,93,252,0.12)',
              pointerEvents: 'none',
              zIndex: 9998,
              left: Math.min(marquee.x0, marquee.x1),
              top: Math.min(marquee.y0, marquee.y1),
              width: Math.abs(marquee.x1 - marquee.x0),
              height: Math.abs(marquee.y1 - marquee.y0)
            }}
          />
        )}
      </div>
    </div>
  )
}
