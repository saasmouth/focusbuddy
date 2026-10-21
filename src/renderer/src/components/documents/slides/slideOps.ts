// Pure element operations on a slide. Every function returns a new Slide so the
// editor can snapshot for undo and React diffs cheaply.

import type {
  Slide,
  SlideElement,
  SlideTextElement,
  SlideTextParagraph
} from '@shared/types'

let seq = 0
export function elementId(): string {
  seq += 1
  return `el-${Date.now().toString(36)}-${seq}`
}

export function addElement(slide: Slide, el: SlideElement): Slide {
  return { ...slide, elements: [...(slide.elements ?? []), el] }
}

export function updateElement(slide: Slide, id: string, patch: Partial<SlideElement>): Slide {
  return {
    ...slide,
    elements: (slide.elements ?? []).map((e) => (e.id === id ? ({ ...e, ...patch } as SlideElement) : e))
  }
}

export function deleteElement(slide: Slide, id: string): Slide {
  return { ...slide, elements: (slide.elements ?? []).filter((e) => e.id !== id) }
}

export function duplicateElement(slide: Slide, id: string): { slide: Slide; newId: string } {
  const el = (slide.elements ?? []).find((e) => e.id === id)
  if (!el) return { slide, newId: id }
  const newId = elementId()
  // A DEEP copy, not a spread.
  //
  // A spread gives the duplicate its own top-level object and leaves every
  // nested one shared: original.fill === copy.fill, and the same for border,
  // paragraphs and the runs inside them. Two consequences, both bad and
  // neither obvious.
  //
  // Editing the copy's fill edited the original's too, because they were one
  // object. And the saved body then contained the same object reachable by
  // two paths, which is exactly what the IPC payload check rejected as
  // "cyclic data" — the bug that broke saves after Draw's Duplicate and
  // needed the 4.3.39-local.7 hotfix. Design's Duplicate had the same defect.
  //
  // structuredClone rather than JSON round-tripping: elements are plain
  // persisted data, so it is safe, and it keeps undefined-valued keys instead
  // of silently dropping them.
  const copy = { ...structuredClone(el), id: newId, x: el.x + 20, y: el.y + 20 } as SlideElement
  return { slide: { ...slide, elements: [...(slide.elements ?? []), copy] }, newId }
}

// Bring an element forward or back by swapping z with its neighbour.
export function reorderZ(slide: Slide, id: string, dir: 'forward' | 'back' | 'front' | 'backmost'): Slide {
  const els = [...(slide.elements ?? [])].sort((a, b) => a.z - b.z)
  const i = els.findIndex((e) => e.id === id)
  if (i === -1) return slide
  if (dir === 'front') els[i].z = Math.max(...els.map((e) => e.z)) + 1
  else if (dir === 'backmost') els[i].z = Math.min(...els.map((e) => e.z)) - 1
  else {
    const j = dir === 'forward' ? i + 1 : i - 1
    if (j < 0 || j >= els.length) return slide
    const tmp = els[i].z
    els[i].z = els[j].z
    els[j].z = tmp
  }
  return { ...slide, elements: els }
}

// The plaintext of a text element, one paragraph per line.
export function elementText(el: SlideTextElement): string {
  return el.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n')
}

// Replace a text element's text from plain lines, preserving the first run's
// styling and each paragraph's list/align settings where possible.
export function setElementText(el: SlideTextElement, text: string): SlideTextElement {
  const lines = text.split('\n')
  const sample = el.paragraphs[0]?.runs[0] ?? {}
  const paragraphs: SlideTextParagraph[] = lines.map((line, i) => ({
    runs: [{ ...sample, text: line }],
    align: el.paragraphs[i]?.align ?? el.paragraphs[0]?.align,
    bulletLevel: el.paragraphs[i]?.bulletLevel ?? el.paragraphs[0]?.bulletLevel,
    listStyle: el.paragraphs[i]?.listStyle ?? el.paragraphs[0]?.listStyle
  }))
  return { ...el, paragraphs: paragraphs.length ? paragraphs : [{ runs: [{ ...sample, text: '' }] }] }
}

// Apply a run-style patch (bold/italic/size/color) to every run of a text
// element. Element-level styling — mixed per-run styling is a later iteration.
export function styleTextElement(
  el: SlideTextElement,
  patch: Partial<{ bold: boolean; italic: boolean; underline: boolean; color: string; fontSize: number }>
): SlideTextElement {
  return {
    ...el,
    paragraphs: el.paragraphs.map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r, ...patch })) }))
  }
}

export function setParagraphAlign(el: SlideTextElement, align: 'left' | 'center' | 'right'): SlideTextElement {
  return { ...el, paragraphs: el.paragraphs.map((p) => ({ ...p, align })) }
}

export function setListStyle(el: SlideTextElement, listStyle: 'bullet' | 'number' | 'none'): SlideTextElement {
  return { ...el, paragraphs: el.paragraphs.map((p) => ({ ...p, listStyle })) }
}

// CSS background size + position that shows just the cropped window of an image,
// scaled to fill the element frame. Crop is inset fractions (0..1) from each
// edge; the visible window is (1-l-r) wide and (1-t-b) tall.
export function cropStyle(crop: { l: number; t: number; r: number; b: number }): {
  size: string
  position: string
} {
  const round = (n: number): number => Math.round(n * 100) / 100
  const vw = Math.max(0.01, 1 - crop.l - crop.r)
  const vh = Math.max(0.01, 1 - crop.t - crop.b)
  const px = crop.l + crop.r > 0 ? (crop.l / (crop.l + crop.r)) * 100 : 0
  const py = crop.t + crop.b > 0 ? (crop.t / (crop.t + crop.b)) * 100 : 0
  return { size: `${round(100 / vw)}% ${round(100 / vh)}%`, position: `${round(px)}% ${round(py)}%` }
}

// ── Multi-element operations: selection, alignment, distribution, grouping ────

export type AlignEdge = 'left' | 'centerX' | 'right' | 'top' | 'middleY' | 'bottom'

function pick(slide: Slide, ids: string[]): SlideElement[] {
  const set = new Set(ids)
  return (slide.elements ?? []).filter((e) => set.has(e.id))
}

// Expand a selection to include every element sharing a groupId with any member,
// so clicking one element of a group acts on the whole group.
export function withGroupMembers(slide: Slide, ids: string[]): string[] {
  const els = slide.elements ?? []
  const idSet = new Set(ids)
  const groups = new Set<string>()
  for (const e of els) if (idSet.has(e.id) && e.groupId) groups.add(e.groupId)
  if (!groups.size) return ids
  const out = new Set(ids)
  for (const e of els) if (e.groupId && groups.has(e.groupId)) out.add(e.id)
  return [...out]
}

// Shift every listed element by (dx, dy) — the commit of a group drag or nudge.
export function moveElementsBy(slide: Slide, ids: string[], dx: number, dy: number): Slide {
  const set = new Set(ids)
  return {
    ...slide,
    elements: (slide.elements ?? []).map((e) =>
      set.has(e.id) ? ({ ...e, x: Math.round(e.x + dx), y: Math.round(e.y + dy) } as SlideElement) : e
    )
  }
}

// Align the selected elements to a shared edge of their combined bounding box.
export function alignElements(slide: Slide, ids: string[], edge: AlignEdge): Slide {
  const els = pick(slide, ids)
  if (els.length < 2) return slide
  const minX = Math.min(...els.map((e) => e.x))
  const maxR = Math.max(...els.map((e) => e.x + e.w))
  const minY = Math.min(...els.map((e) => e.y))
  const maxB = Math.max(...els.map((e) => e.y + e.h))
  const cx = (minX + maxR) / 2
  const cy = (minY + maxB) / 2
  const set = new Set(ids)
  return {
    ...slide,
    elements: (slide.elements ?? []).map((e) => {
      if (!set.has(e.id)) return e
      switch (edge) {
        case 'left': return { ...e, x: Math.round(minX) }
        case 'right': return { ...e, x: Math.round(maxR - e.w) }
        case 'centerX': return { ...e, x: Math.round(cx - e.w / 2) }
        case 'top': return { ...e, y: Math.round(minY) }
        case 'bottom': return { ...e, y: Math.round(maxB - e.h) }
        case 'middleY': return { ...e, y: Math.round(cy - e.h / 2) }
        default: return e
      }
    })
  }
}

// Distribute the selected elements so the gaps between them are equal along the
// chosen axis. Needs 3+; the outermost two hold and the rest space between them.
export function distributeElements(slide: Slide, ids: string[], axis: 'h' | 'v'): Slide {
  const els = pick(slide, ids)
  if (els.length < 3) return slide
  const horiz = axis === 'h'
  const sizeOf = (e: SlideElement): number => (horiz ? e.w : e.h)
  const posOf = (e: SlideElement): number => (horiz ? e.x : e.y)
  const sorted = [...els].sort((a, b) => posOf(a) - posOf(b))
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const extent = posOf(last) + sizeOf(last) - posOf(first)
  const totalSize = sorted.reduce((s, e) => s + sizeOf(e), 0)
  const gap = (extent - totalSize) / (sorted.length - 1)
  const newPos = new Map<string, number>()
  let cursor = posOf(first)
  for (const e of sorted) {
    newPos.set(e.id, cursor)
    cursor += sizeOf(e) + gap
  }
  return {
    ...slide,
    elements: (slide.elements ?? []).map((e) => {
      if (!newPos.has(e.id)) return e
      const p = Math.round(newPos.get(e.id) as number)
      return horiz ? ({ ...e, x: p } as SlideElement) : ({ ...e, y: p } as SlideElement)
    })
  }
}

let groupSeq = 0
// Tie the selected elements together under a fresh groupId.
export function groupElements(slide: Slide, ids: string[]): Slide {
  if (ids.length < 2) return slide
  groupSeq += 1
  const gid = `grp-${Date.now().toString(36)}-${groupSeq}`
  const set = new Set(ids)
  return { ...slide, elements: (slide.elements ?? []).map((e) => (set.has(e.id) ? { ...e, groupId: gid } : e)) }
}

// Dissolve the group of every element sharing a group with any selected one.
export function ungroupElements(slide: Slide, ids: string[]): Slide {
  const els = slide.elements ?? []
  const idSet = new Set(ids)
  const groups = new Set<string>()
  for (const e of els) if (idSet.has(e.id) && e.groupId) groups.add(e.groupId)
  if (!groups.size) return slide
  return {
    ...slide,
    elements: els.map((e) => {
      if (e.groupId && groups.has(e.groupId)) {
        const next = { ...e }
        delete (next as { groupId?: string }).groupId
        return next as SlideElement
      }
      return e
    })
  }
}
