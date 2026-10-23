// Draw's session entry: the WIRING, not the editor.
//
// DrawStudio is mocked, so what this covers is the thing that can silently go
// wrong at the seam — the `kind` envelope on the way out. d1's warning was
// precise: DrawStudio's `content` IS the stored drawing body, and it emits
// whatever it emits, so if the envelope dropped a field (assets, swatches, a v2
// field this file has never heard of) the master would be saved lossily and the
// loss would only show on reload.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The mock captures the props it was given and exposes a way to emit a change.
let seenContent: unknown = null
let seenTitle = ''
let emit: ((body: unknown) => void) | null = null

vi.mock('../../src/renderer/src/components/documents/DrawStudio', () => ({
  default: ({
    content,
    title,
    onChange
  }: {
    content: unknown
    title: string
    onChange: (b: unknown) => void
  }) => {
    seenContent = content
    seenTitle = title
    emit = onChange
    return <div data-testid="draw-stub" />
  }
}))

import SnippetDrawSession from '../../src/renderer/src/components/snippets/SnippetDrawSession'
import type { SnippetBody } from '../../src/shared/snippets'

const body = {
  kind: 'draw',
  objects: [{ id: 'o1', type: 'rect' }],
  assets: { a1: { bytes: 'xx' } },
  swatches: [{ id: 's1', hex: '#123456' }]
} as unknown as SnippetBody

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
let got: SnippetBody[] = []

beforeEach(() => {
  seenContent = null
  seenTitle = ''
  emit = null
  got = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const mount = (b: SnippetBody = body): void => {
  act(() => {
    root.render(<SnippetDrawSession body={b} title="Logo mark" onChange={(n) => got.push(n)} />)
  })
}

describe('the draw body goes straight in', () => {
  it('passes the snippet body as content, with no wrapping', () => {
    mount()
    expect(seenContent).toBe(body)
    expect(seenTitle).toBe('Logo mark')
  })

  it('refuses a body of another kind rather than handing it to DrawStudio', () => {
    mount({ kind: 'doc', content: [], text: '' } as unknown as SnippetBody)
    expect(host.querySelector('[data-testid="draw-stub"]')).toBeNull()
  })
})

describe('the envelope on the way out loses nothing', () => {
  it('keeps every field the editor emitted, including ones this file knows nothing about', () => {
    mount()
    act(() =>
      emit!({
        objects: [{ id: 'o2' }],
        assets: { a2: { bytes: 'yy' } },
        swatches: [{ id: 's2' }],
        // A field added by a future Draw version. It must still reach the master:
        // a lossy save would only be noticed on reload, long after the edit.
        pageBleed: 12,
        v2: { grid: 'on' }
      })
    )
    expect(got).toHaveLength(1)
    expect(got[0]).toEqual({
      kind: 'draw',
      objects: [{ id: 'o2' }],
      assets: { a2: { bytes: 'yy' } },
      swatches: [{ id: 's2' }],
      pageBleed: 12,
      v2: { grid: 'on' }
    })
  })

  it('stamps the kind so the host always holds a snippet-shaped body', () => {
    mount()
    act(() => emit!({ objects: [] }))
    expect((got[0] as { kind: string }).kind).toBe('draw')
  })

  it('writes nothing by itself — only the host does, on Save', () => {
    mount()
    // Mounting alone must not emit. A session that reported a change on mount
    // would arrive dirty and tempt the user to save a body nobody edited.
    expect(got).toHaveLength(0)
  })
})
