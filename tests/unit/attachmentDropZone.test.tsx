// The attachment editor as a drop target, mounted (components/fields/AttachmentDrop).
//
// What a person sees: drop a picture on an attachment field and it is added to
// what the field holds. What must NOT happen: the desk underneath also taking
// the drop (the canvas and the Workcentre each make a new object from it), the
// same drop being stored twice when a table cell owns the drop around the
// editor, or a failure that leaves the field unchanged in silence.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({ default: () => null }))
vi.mock('../../src/renderer/src/components/PlexiiIcon', () => ({ PlexiiDocIcon: () => null }))
vi.mock('../../src/renderer/src/components/DocPickerModal', () => ({ default: () => null }))

import FieldEditor from '../../src/renderer/src/components/fields/FieldEditor'
import { AttachmentDropZone } from '../../src/renderer/src/components/fields/AttachmentDrop'
import { useNoticeStore } from '../../src/renderer/src/stores/notice'
import type { FieldDefinition } from '../../src/shared/fields'

const DEF = { id: 'c1', type: 'attachment', label: 'Photos', config: {} } as unknown as FieldDefinition
const DATA_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
let ingestUrl: ReturnType<typeof vi.fn>
let ingestBuffer: ReturnType<typeof vi.fn>
let nextId = 0

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  nextId = 0
  ingestUrl = vi.fn(async (url: string) =>
    url.includes('broken') ? { ok: false, error: 'The image could not be fetched (404).' } : { ok: true, file: { id: `new-${++nextId}` } }
  )
  ingestBuffer = vi.fn(async (input: { originalName: string }) => ({ id: `buf-${input.originalName}` }))
  ;(window as unknown as { api: unknown }).api = {
    files: {
      ingestUrl,
      ingestBuffer,
      get: vi.fn(async (id: string) => ({ id, originalName: `${id}.png`, mimeType: 'image/png' })),
      delete: vi.fn(async () => true)
    }
  }
  useNoticeStore.getState().clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** Fire a drag event carrying `data` (+ files) at `el`, the way a browser's drop arrives. */
function fire(el: Element, type: 'dragenter' | 'dragover' | 'dragleave' | 'drop', data: Record<string, string>, files: File[] = []): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  const dt = {
    types: [...(files.length ? ['Files'] : []), ...Object.keys(data)],
    files,
    effectAllowed: 'all',
    dropEffect: 'none',
    getData: (t: string) => data[t] ?? ''
  }
  Object.defineProperty(ev, 'dataTransfer', { value: dt })
  act(() => {
    el.dispatchEvent(ev)
  })
  return ev
}

/** Let the async store-then-commit chain finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await act(async () => { await Promise.resolve() })
}

describe('the attachment field on its own (a Field work widget, a form)', () => {
  it('takes a dropped browser image and APPENDS it to what the field holds', async () => {
    const commits: unknown[] = []
    const parentDrops: string[] = []
    act(() =>
      root.render(
        // The desk underneath: its drop handler must never see this drop.
        <div onDrop={() => parentDrops.push('desk')} onDragOver={(e) => parentDrops.push(e.defaultPrevented ? 'over:claimed' : 'over:free')}>
          <FieldEditor def={DEF} value={['old-1', 'old-2']} variant="widget" onCommit={(v) => commits.push(v)} />
        </div>
      )
    )
    const field = host.querySelector('[data-testid="attachment-field"]')!
    const over = fire(field, 'dragover', { 'text/html': `<img src="${DATA_PNG}">`, 'text/uri-list': DATA_PNG })
    expect(over.defaultPrevented, 'dragover accepted').toBe(true)
    expect(field.getAttribute('data-drop-over')).toBe('true')
    // The dragover still reaches the desk, marked as claimed (the Workcentre clears its well on that).
    expect(parentDrops).toEqual(['over:claimed'])

    const dropped = fire(field, 'drop', { 'text/html': `<img src="${DATA_PNG}">`, 'text/uri-list': DATA_PNG })
    expect(dropped.defaultPrevented).toBe(true)
    await settle()
    expect(ingestUrl).toHaveBeenCalledTimes(1)
    expect(ingestUrl.mock.calls[0]![0]).toBe(DATA_PNG)
    expect(commits).toEqual([['old-1', 'old-2', 'new-1']])
    expect(parentDrops, 'the desk never saw the drop').toEqual(['over:claimed'])
    expect(field.getAttribute('data-drop-over')).toBeNull()
  })

  it('takes a file dragged from Finder by its bytes', async () => {
    const commits: unknown[] = []
    act(() => root.render(<FieldEditor def={DEF} value={[]} variant="cell" onCommit={(v) => commits.push(v)} />))
    const field = host.querySelector('[data-testid="attachment-field"]')!
    fire(field, 'drop', {}, [new File([new Uint8Array([1, 2, 3])], 'scan.png', { type: 'image/png' })])
    await settle()
    expect(ingestBuffer).toHaveBeenCalledTimes(1)
    expect(ingestUrl).not.toHaveBeenCalled()
    expect(commits).toEqual([['buf-scan.png']])
  })

  it('a link that cannot be fetched says so, and changes nothing', async () => {
    const commits: unknown[] = []
    act(() => root.render(<FieldEditor def={DEF} value={['old-1']} variant="widget" onCommit={(v) => commits.push(v)} />))
    fire(host.querySelector('[data-testid="attachment-field"]')!, 'drop', { 'text/uri-list': 'https://broken.example/a.png' })
    await settle()
    expect(commits).toEqual([])
    expect(useNoticeStore.getState().notice?.text).toBe('Could not attach the image from broken.example. The image could not be fetched (404).')
  })

  it('a drop with nothing usable is still claimed, and says so', async () => {
    const parentDrops: string[] = []
    act(() =>
      root.render(
        <div onDrop={() => parentDrops.push('desk')}>
          <FieldEditor def={DEF} value={[]} variant="widget" onCommit={() => undefined} />
        </div>
      )
    )
    const ev = fire(host.querySelector('[data-testid="attachment-field"]')!, 'drop', { 'text/html': '<p>words</p>' })
    await settle()
    expect(ev.defaultPrevented).toBe(true)
    expect(parentDrops).toEqual([])
    expect(ingestUrl).not.toHaveBeenCalled()
    expect(useNoticeStore.getState().notice?.text).toMatch(/Nothing to attach/)
  })

  it("leaves the app's own drags (a work widget, a Files row) to their own targets", async () => {
    const parentDrops: string[] = []
    act(() =>
      root.render(
        <div onDrop={() => parentDrops.push('desk')}>
          <FieldEditor def={DEF} value={[]} variant="widget" onCommit={() => undefined} />
        </div>
      )
    )
    const field = host.querySelector('[data-testid="attachment-field"]')!
    const over = fire(field, 'dragover', { 'application/x-fb-widget-kind': 'sticky' })
    expect(over.defaultPrevented).toBe(false)
    fire(field, 'drop', { 'application/x-fb-widget-kind': 'sticky' })
    await settle()
    expect(parentDrops).toEqual(['desk'])
  })

  it('appends to the value the field holds when the fetch LANDS, not the one it was dropped on', async () => {
    let release: () => void = () => undefined
    ingestUrl.mockImplementationOnce(() => new Promise((r) => { release = () => r({ ok: true, file: { id: 'slow' } }) }))
    const commits: unknown[] = []
    const render = (value: string[]): void =>
      act(() => root.render(<FieldEditor def={DEF} value={value} variant="widget" onCommit={(v) => commits.push(v)} />))
    render(['a'])
    fire(host.querySelector('[data-testid="attachment-field"]')!, 'drop', { 'text/uri-list': 'https://e.com/slow.png' })
    await settle()
    expect(host.querySelector('[data-testid="attachment-busy"]'), 'shows it is working').not.toBeNull()
    render(['a', 'b']) // something else landed meanwhile
    release()
    await settle()
    expect(commits).toEqual([['a', 'b', 'slow']])
    expect(host.querySelector('[data-testid="attachment-busy"]')).toBeNull()
  })

  it('shows an attached picture as a thumbnail', async () => {
    act(() => root.render(<FieldEditor def={DEF} value={['pic']} variant="cell" onCommit={() => undefined} />))
    await settle()
    const thumb = host.querySelector('[data-testid="attachment-thumb"]') as HTMLImageElement | null
    expect(thumb).not.toBeNull()
    expect(thumb!.getAttribute('src')).toBe('fb-file://pic')
  })
})

describe('inside a zone that owns the drop (a table cell, a List or Cards block)', () => {
  function renderCell(value: string[], commits: unknown[], parentDrops: string[]): void {
    act(() =>
      root.render(
        <div onDrop={() => parentDrops.push('desk')}>
          <table>
            <tbody>
              <tr>
                <AttachmentDropZone current={() => value} commit={(v) => commits.push({ by: 'cell', v })}>
                  {(drop) => (
                    <td data-testid="cell" data-over={drop.over ? 'true' : undefined} {...drop.handlers}>
                      <FieldEditor def={DEF} value={value} variant="cell" onCommit={(v) => commits.push({ by: 'editor', v })} />
                    </td>
                  )}
                </AttachmentDropZone>
              </tr>
            </tbody>
          </table>
        </div>
      )
    )
  }

  it('a drop anywhere in the cell, even on the chips, is stored ONCE and appended', async () => {
    const commits: unknown[] = []
    const parentDrops: string[] = []
    renderCell(['old'], commits, parentDrops)
    // On the editor inside the cell: it binds nothing of its own, so the cell takes it.
    const inner = host.querySelector('[data-testid="attachment-field"]')!
    expect(inner.getAttribute('data-drop-over')).toBeNull()
    fire(inner, 'dragover', { 'text/uri-list': 'https://e.com/a.png' })
    expect(host.querySelector('[data-testid="cell"]')!.getAttribute('data-over')).toBe('true')
    // One highlight, the cell's: the editor inside does not light up a second ring.
    expect(inner.getAttribute('data-drop-over')).toBeNull()
    fire(inner, 'drop', { 'text/uri-list': 'https://e.com/a.png' })
    await settle()
    expect(ingestUrl).toHaveBeenCalledTimes(1)
    // Committed by the CELL (the zone that owns the drop), appended.
    expect(commits).toEqual([{ by: 'cell', v: ['old', 'new-1'] }])
    expect(parentDrops).toEqual([])
  })

  it('a picture let go ON an attachment already in the cell (its thumbnail, its name) is the cell’s drop', async () => {
    // The real drag in attachmentDropNative NAT-1 (a7, 2026-11-05, uiScale 0.9)
    // was released over the existing picture's chip, not the cell's empty part.
    // A person aims at the picture that is there, so that spot must take it too.
    const commits: unknown[] = []
    const parentDrops: string[] = []
    renderCell(['old'], commits, parentDrops)
    await settle()
    const thumb = host.querySelector('[data-testid="attachment-chip"] [data-testid="attachment-thumb"]')
    const name = host.querySelector('[data-testid="attachment-chip"] a')
    expect(thumb, 'the existing picture shows as a thumbnail').not.toBeNull()
    expect(name, 'and its name').not.toBeNull()
    const over = fire(thumb!, 'dragover', { 'text/uri-list': 'https://e.com/a.png' })
    expect(over.defaultPrevented, 'the drop is accepted over the thumbnail').toBe(true)
    expect(host.querySelector('[data-testid="cell"]')!.getAttribute('data-over')).toBe('true')
    const drop = fire(thumb!, 'drop', { 'text/uri-list': 'https://e.com/a.png' })
    expect(drop.defaultPrevented).toBe(true)
    fire(name!, 'drop', { 'text/uri-list': 'https://e.com/b.png' })
    await settle()
    expect(ingestUrl).toHaveBeenCalledTimes(2)
    expect(commits).toEqual([
      { by: 'cell', v: ['old', 'new-1'] },
      { by: 'cell', v: ['old', 'new-2'] }
    ])
    expect(parentDrops, 'the desk underneath takes nothing').toEqual([])
  })

  it('the editor inside shows the cell’s progress', async () => {
    let release: () => void = () => undefined
    ingestUrl.mockImplementationOnce(() => new Promise((r) => { release = () => r({ ok: true, file: { id: 'x' } }) }))
    renderCell([], [], [])
    // Dropped on the chips row inside the cell: still the cell's drop, and its progress shows.
    fire(host.querySelector('[data-testid="attachment-field"]')!, 'drop', { 'text/uri-list': 'https://e.com/a.png' })
    await settle()
    expect(host.querySelector('[data-testid="attachment-busy"]')).not.toBeNull()
    release()
    await settle()
    expect(host.querySelector('[data-testid="attachment-busy"]')).toBeNull()
  })
})
