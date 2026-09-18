// Dragging a document onto a desk.
//
// The two properties that matter: a drop from OUTSIDE the app must never be
// mistaken for one of ours, and nothing here may throw — a drop handler that
// throws leaves the pointer stuck in a dragging state with no way out.
import { describe, it, expect } from 'vitest'
import {
  DOC_DRAG_TYPE,
  canPlaceOnDesk,
  readDocumentDrag,
  writeDocumentDrag,
  dragCarriesDocument,
  widgetDraftFor
} from '../../src/renderer/src/lib/documentDrag'

/** A DataTransfer good enough to carry a drag, without a DOM. */
function fakeDT(seed: Record<string, string> = {}): DataTransfer {
  const store: Record<string, string> = { ...seed }
  return {
    setData: (t: string, v: string) => {
      store[t] = v
    },
    getData: (t: string) => store[t] ?? '',
    get types() {
      return Object.keys(store)
    },
    effectAllowed: 'none',
    dropEffect: 'none'
  } as unknown as DataTransfer
}

describe('what can go on a desk', () => {
  it('accepts every document type that has a widget of its own kind', () => {
    for (const t of ['doc', 'sheet', 'slides', 'map', 'design', 'draw']) {
      expect(canPlaceOnDesk(t), t).toBe(true)
    }
  })

  it('refuses anything else', () => {
    for (const t of ['knowledge', 'web', 'agent', '', 'widget']) {
      expect(canPlaceOnDesk(t), t).toBe(false)
    }
  })
})

describe('round trip', () => {
  it('carries the document through a drag', () => {
    const dt = fakeDT()
    writeDocumentDrag(dt, { documentId: 'd1', docType: 'sheet', title: 'Budget' })
    expect(readDocumentDrag(dt)).toEqual({ documentId: 'd1', docType: 'sheet', title: 'Budget' })
  })

  it('sets a plain-text fallback so dragging elsewhere pastes something', () => {
    const dt = fakeDT()
    writeDocumentDrag(dt, { documentId: 'd1', docType: 'doc', title: 'Brief' })
    expect(dt.getData('text/plain')).toBe('Brief')
  })
})

describe('reading a drag that is not ours', () => {
  it('ignores a plain-text drag from another app', () => {
    expect(readDocumentDrag(fakeDT({ 'text/plain': 'hello' }))).toBeNull()
  })

  it('ignores a file drag', () => {
    expect(readDocumentDrag(fakeDT({ Files: '' }))).toBeNull()
  })

  it('ignores nothing at all', () => {
    expect(readDocumentDrag(null)).toBeNull()
    expect(readDocumentDrag(fakeDT())).toBeNull()
  })

  it('never throws on malformed payloads', () => {
    for (const raw of ['{', 'null', '[]', '"x"', '{"documentId":""}', '{"documentId":"d"}']) {
      expect(() => readDocumentDrag(fakeDT({ [DOC_DRAG_TYPE]: raw }))).not.toThrow()
      expect(readDocumentDrag(fakeDT({ [DOC_DRAG_TYPE]: raw }))).toBeNull()
    }
  })

  it('refuses a payload naming a type that cannot sit on a desk', () => {
    const raw = JSON.stringify({ documentId: 'd1', docType: 'knowledge', title: 'x' })
    expect(readDocumentDrag(fakeDT({ [DOC_DRAG_TYPE]: raw }))).toBeNull()
  })

  it('fills a missing title rather than dropping the document', () => {
    const raw = JSON.stringify({ documentId: 'd1', docType: 'doc' })
    expect(readDocumentDrag(fakeDT({ [DOC_DRAG_TYPE]: raw }))?.title).toBe('Untitled')
  })
})

describe('highlighting during dragover', () => {
  it('decides from the TYPE, because the data is withheld until drop', () => {
    // A page cannot read what is being dragged over it — only the type list. So
    // the highlight is driven by the type and the payload validated at the drop.
    expect(dragCarriesDocument(fakeDT({ [DOC_DRAG_TYPE]: 'anything' }))).toBe(true)
    expect(dragCarriesDocument(fakeDT({ 'text/plain': 'x' }))).toBe(false)
    expect(dragCarriesDocument(null)).toBe(false)
  })
})

describe('the widget a drop becomes', () => {
  it('is the same kind as the document, on the desk it was dropped on', () => {
    const d = widgetDraftFor({ documentId: 'd1', docType: 'slides', title: 'Launch' }, 'desk-9')
    expect(d.taskId).toBe('desk-9')
    expect(d.kind).toBe('slides')
    expect(d.title).toBe('Launch')
  })

  it('points AT the document rather than copying it', () => {
    // Editing it on the desk and editing it in Office must be the same file —
    // that is the entire reason to put it there.
    const d = widgetDraftFor({ documentId: 'd1', docType: 'doc', title: 'x' }, 'desk-1')
    expect(d.content).toBe('d1')
  })

  it('arrives at a usable size', () => {
    const d = widgetDraftFor({ documentId: 'd1', docType: 'doc', title: 'x' }, 'desk-1')
    expect(d.width).toBeGreaterThan(200)
    expect(d.height).toBeGreaterThan(200)
  })
})
