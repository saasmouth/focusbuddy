// The diagram and slide entries in SnippetEditSessionView's registry, mounted
// through the real host with the real editors. What only a mount can show:
//   - a diagram snippet opens PlexiiDiagrams on ONE page (no page tabs, no
//     "New page" anywhere), since a snippet is a single graph;
//   - a slide snippet opens PlexiiDeck on ONE in-memory slide (no navigator,
//     no new/duplicate slide, the Slide menu's items disabled, no speaker notes
//     box, since a fragment has nowhere to keep notes), and its File menu's
//     document items are disabled (they act on the documents store's ACTIVE
//     document, which in a session is some other document);
//   - neither creates or writes a document: the only thing a session persists
//     is the snippet, and only on Save (the host's own tests pin that part).
// The wrap/unwrap mapping is pinned in snippetSessionMapping.test.ts.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 60_000 })
import type { Snippet } from '../../src/shared/snippets'

beforeAll(async () => {
  // Load each kind's (lazy) editor module up front, so React.lazy resolves from
  // the module cache. Importing PlexiiDiagrams or PlexiiDeck cold takes seconds
  // under a full parallel run, and a wait loop racing that tests the machine.
  await import('../../src/renderer/src/components/snippets/SnippetDiagramSession')
  await import('../../src/renderer/src/components/snippets/SnippetSlideSession')
  class RO {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
  if (!(globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly) {
    ;(globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class {
      m22 = 1
      constructor(_t?: string) {}
    }
  }
})

const master = (kind: 'diagram' | 'slide', body: unknown): Snippet =>
  ({
    id: 's1', kind, name: 'Fragment', description: null, body, tags: [], scope: 'personal', orgId: 'personal',
    authorId: null, revision: 1, usageCount: 0, createdAt: 0, updatedAt: 0
  }) as unknown as Snippet

const DIAGRAM = master('diagram', {
  kind: 'diagram',
  nodes: [
    { id: 'a', x: 0, y: 0, label: 'Start', shape: 'rect', color: '#336699', width: 120, height: 60 },
    { id: 'b', x: 220, y: 0, label: 'End', shape: 'rect', color: '#336699', width: 120, height: 60 }
  ],
  edges: [{ id: 'e1', source: 'a', target: 'b' }]
})
const SLIDE = master('slide', {
  kind: 'slide',
  elements: [{ id: 't1', type: 'text', x: 0, y: 0, w: 300, h: 60, z: 0, paragraphs: [{ runs: [{ text: 'Title' }] }] }]
})

let docsCreate: ReturnType<typeof vi.fn>
let docsUpdate: ReturnType<typeof vi.fn>
let snippetUpdate: ReturnType<typeof vi.fn>
let host: HTMLDivElement
let root: Root

function installApi(snippet: Snippet): void {
  docsCreate = vi.fn()
  docsUpdate = vi.fn()
  snippetUpdate = vi.fn()
  const empty = new Proxy(() => Promise.resolve([]), { get: () => () => Promise.resolve([]) })
  ;(window as unknown as { api: unknown }).api = new Proxy(
    {
      snippets: new Proxy({ get: vi.fn().mockResolvedValue(snippet), update: snippetUpdate }, { get: (t, k) => (t as Record<string, unknown>)[k as string] ?? (() => Promise.resolve([])) }),
      documents: new Proxy({ create: docsCreate, update: docsUpdate }, { get: (t, k) => (t as Record<string, unknown>)[k as string] ?? (() => Promise.resolve(null)) })
    } as Record<string, unknown>,
    { get: (t, k) => t[k as string] ?? empty }
  )
}

beforeEach(() => {
  localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function open(snippet: Snippet): Promise<void> {
  installApi(snippet)
  const { default: SnippetEditSessionView } = await import('../../src/renderer/src/components/snippets/SnippetEditSessionView')
  await act(async () => {
    root.render(<SnippetEditSessionView snippetId="s1" onClose={() => {}} />)
  })
  // The kind's editor is lazy: let the import and the Suspense boundary settle.
  for (let i = 0; i < 200 && !host.querySelector('[data-testid="diagram-editor"], [data-testid="slides-present"]'); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25))
    })
  }
}
const text = (): string => host.textContent ?? ''

describe('a diagram snippet opens PlexiiDiagrams on one page', () => {
  it('mounts the real editor with its graph, and no page tabs or new page', async () => {
    await open(DIAGRAM)
    expect(host.querySelector('[data-testid="diagram-editor"]'), 'PlexiiDiagrams mounted').not.toBeNull()
    expect(host.querySelectorAll('.react-flow__node').length).toBe(2)
    expect(host.querySelector('[data-testid="diagram-pages-bar"]'), 'the status bar stays').not.toBeNull()
    expect(host.querySelector('[data-testid^="diagram-page-"]:not([data-testid="diagram-page-stats"])'), 'no page tabs, no add').toBeNull()
    expect(host.querySelector('[data-testid="diagram-insert-page"]')).toBeNull()
  })

  it('File › Import offers no multi-page format (draw.io, JSON), only single-graph ones', async () => {
    await open(DIAGRAM)
    const file = host.querySelector('[data-testid="draw-menubar-file"]') as HTMLElement | null
    expect(file, 'the Diagrams menu bar renders').not.toBeNull()
    act(() => file!.click())
    const list = host.querySelector('[data-testid="draw-menubar-file-list"]') as HTMLElement
    // The Import submenu opens on hover (menuBarKit's SubmenuRow).
    const importRow = Array.from(list.querySelectorAll<HTMLElement>(':scope > div.relative')).find((el) => el.textContent?.includes('Import'))
    expect(importRow, 'File has an Import submenu').toBeDefined()
    act(() => importRow!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    const labels = Array.from(list.querySelectorAll('button')).map((b) => b.textContent ?? '')
    expect(labels.some((l) => l.includes('Mermaid')), 'Mermaid (one graph) is offered').toBe(true)
    expect(labels.some((l) => l.includes('Visio')), 'Visio (into this page) is offered').toBe(true)
    expect(labels.some((l) => l.includes('draw.io')), 'draw.io can carry pages').toBe(false)
    expect(labels.some((l) => l.includes('PlexiiDiagrams JSON')), 'JSON replaces the diagram, pages and all').toBe(false)
  })

  it('the File menu cannot create, copy, rename, meet on or trash a document', async () => {
    await open(DIAGRAM)
    act(() => (host.querySelector('[data-testid="draw-menubar-file"]') as HTMLElement).click())
    const item = (label: string): HTMLButtonElement | undefined =>
      Array.from(host.querySelectorAll<HTMLButtonElement>('[data-testid="draw-menubar-file-list"] > button')).find((b) => b.textContent?.includes(label))
    for (const label of ['New diagram', 'Make a copy', 'Rename', 'Version history', 'Start a meeting', 'Move to trash']) {
      expect(item(label), label).toBeDefined()
      expect(item(label)!.disabled, `${label} is disabled in a session`).toBe(true)
    }
    // Try them anyway: a disabled item must not run.
    for (const label of ['New diagram', 'Make a copy', 'Move to trash']) act(() => item(label)!.click())
    expect(docsCreate).not.toHaveBeenCalled()
  })

  it('creates and writes no document', async () => {
    await open(DIAGRAM)
    expect(docsCreate).not.toHaveBeenCalled()
    expect(docsUpdate).not.toHaveBeenCalled()
    expect(snippetUpdate).not.toHaveBeenCalled()
  })
})

describe('a slide snippet opens PlexiiDeck on one in-memory slide', () => {
  it('mounts the real editor with no navigator and no slide-level commands', async () => {
    await open(SLIDE)
    expect(host.querySelector('[data-testid="slides-present"]'), 'PlexiiDeck mounted').not.toBeNull()
    expect(host.querySelector('[data-testid="slides-thumbnails"]'), 'no navigator').toBeNull()
    expect(host.querySelector('[data-testid="slides-notes-editor"]'), 'no speaker notes box: the snippet could not keep them').toBeNull()
    expect(host.querySelector('[data-testid="slides-add"]')).toBeNull()
    for (const id of ['slides-home-new-slide', 'slides-home-duplicate-slide', 'slides-insert-new-slide', 'slides-templates-btn']) {
      expect(host.querySelector(`[data-testid="${id}"]`), id).toBeNull()
    }
    expect(text()).toContain('Title')
  })

  it('the File menu cannot create, copy, rename or trash a document; Download stays', async () => {
    await open(SLIDE)
    const file = host.querySelector('[data-testid="slides-menubar-file"]') as HTMLElement | null
    expect(file, 'the Slides menu bar renders').not.toBeNull()
    act(() => file!.click())
    const item = (label: string): HTMLButtonElement | undefined =>
      Array.from(host.querySelectorAll<HTMLButtonElement>('[data-testid="slides-menubar-file-list"] button')).find((b) => b.textContent?.includes(label))
    for (const label of ['New presentation', 'Make a copy', 'Rename', 'Version history', 'Import (.pptx)', 'Move to trash']) {
      expect(item(label), label).toBeDefined()
      expect(item(label)!.disabled, `${label} is disabled in a session`).toBe(true)
    }
    expect(item('Download')?.disabled, 'Download (a file, no document row) stays').toBe(false)
  })

  it('creates no document row and writes nothing (the deck is in memory only)', async () => {
    await open(SLIDE)
    // Try the disabled document items anyway: a disabled item must not run.
    act(() => (host.querySelector('[data-testid="slides-menubar-file"]') as HTMLElement).click())
    for (const b of Array.from(host.querySelectorAll<HTMLButtonElement>('[data-testid="slides-menubar-file-list"] button'))) {
      if (/New presentation|Make a copy|Move to trash/.test(b.textContent ?? '')) act(() => b.click())
    }
    expect(docsCreate).not.toHaveBeenCalled()
    expect(docsUpdate).not.toHaveBeenCalled()
    expect(snippetUpdate).not.toHaveBeenCalled()
  })
})
