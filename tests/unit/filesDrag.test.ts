import { describe, it, expect, afterEach } from 'vitest'
import {
  FILES_DRAG_MIME,
  FILES_DRAG_MARKER_PREFIX,
  NEWER_VERSION_REASON,
  markerTypesFor,
  markersIn,
  parseFilesDrag,
  serializeFilesDrag,
  sourceKindOf,
  dragLabel,
  type FileDragRef
} from '../../src/shared/filesDragPayload'
import {
  activeFilesDrag,
  clearFilesDrag,
  dragCarriesFiles,
  readFilesDrag,
  refFromEntry,
  refsForDragStart,
  writeFilesDrag
} from '../../src/renderer/src/lib/filesDrag'

// A DataTransfer that behaves like Chromium's for what we use.
class FakeDT {
  private data = new Map<string, string>()
  effectAllowed = 'uninitialized'
  dropEffect = 'none'
  get types(): string[] {
    return [...this.data.keys()]
  }
  setData(t: string, v: string): void {
    this.data.set(t.toLowerCase(), v)
  }
  getData(t: string): string {
    return this.data.get(t.toLowerCase()) ?? ''
  }
}
const dt = (): DataTransfer => new FakeDT() as unknown as DataTransfer

const img: FileDragRef = { entryId: 'f-img', kind: 'file', name: 'Q3 chart.png', mimeType: 'image/png', ext: 'png', sizeBytes: 1200, orgId: 'personal' }
const folder: FileDragRef = { entryId: 'd-1', kind: 'folder', name: 'Plans' }
const doc: FileDragRef = { entryId: 'e-doc', kind: 'doc', name: 'Plan', docId: 'doc-1', docType: 'doc' }
const wf: FileDragRef = { entryId: 'e-wf', kind: 'doc', name: 'Budget', docId: 'wf-1', docType: 'widget', widgetKind: 'table' }

afterEach(() => clearFilesDrag())

describe('Files drag payload', () => {
  it('round-trips through a DataTransfer, metadata only', () => {
    const d = dt()
    writeFilesDrag(d, [img, folder], 'files-panel')
    const r = readFilesDrag(d)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload).toEqual({ v: 1, source: 'files-panel', refs: [img, folder] })
    expect(d.getData(FILES_DRAG_MIME)).not.toMatch(/base64|data:/)
    expect(d.getData('text/plain')).toBe('Q3 chart.png\nPlans')
    expect(dragCarriesFiles(d)).toBe(true)
    expect(d.effectAllowed).toBe('copyMove')
  })

  it('refuses an unknown NEWER version with a reason, never guessing', () => {
    const raw = JSON.stringify({ v: 2, source: 'files-panel', refs: [img] })
    expect(parseFilesDrag(raw)).toEqual({ ok: false, reason: NEWER_VERSION_REASON })
    expect(parseFilesDrag(JSON.stringify({ v: 0, refs: [img] }))).toEqual({ ok: false, reason: null })
    expect(parseFilesDrag('nonsense')).toEqual({ ok: false, reason: null })
    expect(parseFilesDrag(JSON.stringify({ v: 1, refs: [{ kind: 'file' }] }))).toEqual({ ok: false, reason: null })
    expect(parseFilesDrag('')).toEqual({ ok: false, reason: null })
  })

  it('marks what is in the drag, readable during dragover', () => {
    const d = dt()
    writeFilesDrag(d, [img, folder, doc, wf], 'files-view')
    const markers = markersIn(d.types).sort()
    expect(markers).toEqual(['doc', 'folder', 'image', 'widget'])
    for (const t of markerTypesFor([img])) expect(t.startsWith(FILES_DRAG_MARKER_PREFIX)).toBe(true)
    expect(t(d.types)).toBe(true)
    function t(types: string[]): boolean {
      return types.every((x) => x === x.toLowerCase())
    }
  })

  it('one item also carries the compatibility payloads every existing target reads', () => {
    const a = dt()
    writeFilesDrag(a, [doc], 'files-view')
    expect(a.getData('application/fb-entry-id')).toBe('e-doc')
    expect(JSON.parse(a.getData('application/x-fb-document'))).toMatchObject({ id: 'doc-1', docType: 'doc' })
    const b = dt()
    writeFilesDrag(b, [wf], 'files-view')
    expect(b.getData('application/x-plexii-widget-file')).toBe('wf-1')
    // Several items: only ours (a single-item target must not take the first of many).
    const c = dt()
    writeFilesDrag(c, [img, doc], 'files-view')
    expect(c.getData('application/fb-entry-id')).toBe('')
  })

  it('keeps the payload in module state for dragover, and the webview shield on <html>, until cleared', () => {
    const d = dt()
    writeFilesDrag(d, [img], 'files-panel')
    expect(activeFilesDrag()?.refs[0]?.entryId).toBe('f-img')
    expect(document.documentElement.hasAttribute('data-fb-files-drag')).toBe(true)
    clearFilesDrag()
    expect(activeFilesDrag()).toBeNull()
    expect(document.documentElement.hasAttribute('data-fb-files-drag')).toBe(false)
  })

  it('classifies by family for placement', () => {
    expect(sourceKindOf(img)).toBe('image')
    expect(sourceKindOf({ ...img, mimeType: 'image/svg+xml', ext: 'svg' })).toBe('svg')
    expect(sourceKindOf({ ...img, mimeType: '', ext: '', name: 'a.PDF' })).toBe('pdf')
    expect(sourceKindOf({ ...img, mimeType: 'video/mp4', ext: 'mp4' })).toBe('video')
    expect(sourceKindOf({ ...img, mimeType: 'audio/mpeg', ext: 'mp3' })).toBe('audio')
    expect(sourceKindOf({ ...img, mimeType: 'text/csv', ext: 'csv' })).toBe('text')
    expect(sourceKindOf({ ...img, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' })).toBe('sheet')
    expect(sourceKindOf({ ...img, mimeType: 'application/zip', ext: 'zip' })).toBe('generic')
    expect(sourceKindOf(folder)).toBe('folder')
    expect(sourceKindOf(doc)).toBe('office-doc')
    expect(sourceKindOf(wf)).toBe('widget')
  })

  it('a drag from a selected row carries the selection; from an unselected row, only that row', () => {
    const entries = [
      { id: 'a', parentId: null, kind: 'file' as const, name: 'a.txt', createdAt: 0, updatedAt: 0 },
      { id: 'b', parentId: null, kind: 'folder' as const, name: 'B', createdAt: 0, updatedAt: 0 },
      { id: 'c', parentId: null, kind: 'file' as const, name: 'c.png', createdAt: 0, updatedAt: 0 }
    ]
    const look = (id: string) => entries.find((e) => e.id === id)
    expect(refsForDragStart(entries[0]!, ['a', 'b'], look, 'personal').map((r) => r.entryId)).toEqual(['a', 'b'])
    expect(refsForDragStart(entries[2]!, ['a', 'b'], look).map((r) => r.entryId)).toEqual(['c'])
    expect(refFromEntry(entries[0]!, 'org-9').orgId).toBe('org-9')
    expect(dragLabel([img])).toBe('Q3 chart.png')
    expect(dragLabel([img, doc, wf])).toBe('3 items')
  })

  it('serializes what it parses', () => {
    const raw = serializeFilesDrag('drive-widget', [folder])
    expect(parseFilesDrag(raw)).toEqual({ ok: true, payload: { v: 1, source: 'drive-widget', refs: [folder] } })
  })
})
