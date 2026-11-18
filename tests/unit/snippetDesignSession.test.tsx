// The wiring that joins PlexiiDesign to the snippet session (SnippetDesignSession).
//
// DesignEditor is mocked: this is a test of the WIRING, not of the editor —
// what the host receives when the document changes, and that the document is
// wrapped once rather than on every render. The conversions themselves are
// tested in designSnippetSession.test.ts.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const seen: { content?: unknown; title?: string; onChange?: (b: unknown) => void; mounts: number } = { mounts: 0 }
vi.mock('../../src/renderer/src/components/documents/DesignEditor', () => ({
  default: (p: { content: unknown; title: string; onChange: (b: unknown) => void }) => {
    seen.content = p.content
    seen.title = p.title
    seen.onChange = p.onChange
    return null
  }
}))

import SnippetDesignSession from '../../src/renderer/src/components/snippets/SnippetDesignSession'
import type { DesignBody } from '../../src/shared/design'
import type { SnippetBody } from '../../src/shared/snippets'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  seen.mounts = 0
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const snippet = (): SnippetBody =>
  ({
    kind: 'design',
    elements: [{ id: 's1', type: 'shape', shape: 'rect', x: 0, y: 0, w: 100, h: 80, z: 0, fill: { type: 'solid', color: '#2563eb' } }],
    swatches: [{ id: 'sw-1', name: 'Deep sea', color: '#123456' }]
  }) as unknown as SnippetBody

const render = (body: SnippetBody, onChange: (b: SnippetBody) => void): void => {
  act(() => root.render(<SnippetDesignSession body={body} title="A badge" onChange={onChange} />))
}

describe('SnippetDesignSession', () => {
  it('hands the editor a DOCUMENT built from the snippet, and the snippet’s name', () => {
    render(snippet(), () => {})
    const doc = seen.content as DesignBody
    expect(doc.pages).toHaveLength(1)
    expect(doc.pages![0]!.elements[0]!.id).toBe('s1')
    expect(doc.width).toBeGreaterThan(0)
    expect(seen.title).toBe('A badge')
  })

  it('gives the host a SNIPPET back on every change, not a document', () => {
    const changes: SnippetBody[] = []
    render(snippet(), (b) => changes.push(b))
    const doc = seen.content as DesignBody
    // Both sides, because that is what a real commit does: Design's page is
    // canonical and `elements` mirrors it (syncActivePage), and unwrap reads
    // the PAGE. A fixture that moved only the mirror looked like unwrap
    // losing an element, which is what the first run of this test showed.
    const added = { id: 's2', type: 'shape', shape: 'rect', x: 10, y: 10, w: 20, h: 20, z: 1, fill: { type: 'solid', color: '#111' } }
    const elements = [...doc.elements, added as never]
    act(() => seen.onChange!({ ...doc, elements, pages: [{ ...doc.pages![0]!, elements }] }))
    expect(changes).toHaveLength(1)
    const out = changes[0] as unknown as { kind: string; elements: unknown[]; width?: number }
    expect(out.kind).toBe('design')
    expect(out.elements).toHaveLength(2)
    // Not a document: the wrapper's size never reaches the snippet.
    expect(out.width).toBeUndefined()
  })

  it('wraps ONCE: a re-render does not rebuild the document and throw away the edit', () => {
    const onChange = (): void => {}
    render(snippet(), onChange)
    const first = seen.content
    act(() => seen.onChange!({ ...(first as DesignBody), width: 999 }))
    const edited = seen.content as DesignBody
    expect(edited.width).toBe(999)
    // The parent re-renders with the SAME original body, as a host holding it
    // in a ref would.
    render(snippet(), onChange)
    expect((seen.content as DesignBody).width).toBe(999)
  })

  it('renders nothing for a body of another kind, rather than wrapping it as a design', () => {
    seen.content = undefined
    render({ kind: 'slide', elements: [] } as unknown as SnippetBody, () => {})
    expect(seen.content).toBeUndefined()
  })
})
