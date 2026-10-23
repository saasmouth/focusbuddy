// The diagram and slide entries in SnippetEditSessionView's registry, mounted
// through the real host with the real editors. What only a mount can show:
//   - a diagram snippet opens PlexiiDiagrams on ONE page (no page tabs, no
//     "New page" anywhere), since a snippet is a single graph;
//   - a slide snippet opens PlexiiDeck on ONE in-memory slide (no navigator,
//     no new/duplicate slide, the Slide menu's items disabled);
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
  for (let i = 0; i < 200 && !host.querySelector('[data-testid="diagram-editor"], [data-testid="slides-notes-editor"]'); i++) {
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
    expect(host.querySelector('[data-testid="slides-notes-editor"]'), 'PlexiiDeck mounted').not.toBeNull()
    expect(host.querySelector('[data-testid="slides-thumbnails"]'), 'no navigator').toBeNull()
    expect(host.querySelector('[data-testid="slides-add"]')).toBeNull()
    for (const id of ['slides-home-new-slide', 'slides-home-duplicate-slide', 'slides-insert-new-slide', 'slides-templates-btn']) {
      expect(host.querySelector(`[data-testid="${id}"]`), id).toBeNull()
    }
    expect(text()).toContain('Title')
  })

  it('creates no document row and writes nothing (the deck is in memory only)', async () => {
    await open(SLIDE)
    // Poke the notes, which edit the in-memory deck but not the fragment.
    const notes = host.querySelector('[data-testid="slides-notes-editor"]') as HTMLTextAreaElement
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      set.call(notes, 'a note')
      notes.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(docsCreate).not.toHaveBeenCalled()
    expect(docsUpdate).not.toHaveBeenCalled()
    expect(snippetUpdate).not.toHaveBeenCalled()
  })
})
