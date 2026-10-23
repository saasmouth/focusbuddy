// The share dialog's "Include my comments" box, at the level where the default
// actually lives.
//
// 9d's requirement, and the one worth testing above all the others: with the box
// UNTICKED, sharing copies nothing. A comment on a document only you can see is
// a private note — "fix this before Sarah reads it" is exactly the kind of thing
// people write to themselves — so publishing them to the people you just shared
// with, as a side effect, must take a deliberate tick.
//
// This drives the real component against a stubbed network, so what is asserted
// is the REQUESTS: no POST to /comments when unticked, and one per comment when
// ticked. A test of the copy function alone could not show that, because the
// default is in the dialog, not in the copier.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const DOC_ID = 'doc_local_1'
const PM = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The contentious clause lives here.' }] }]
}

const comments = [
  {
    id: 'c1',
    parentId: null,
    anchorId: null,
    anchor: JSON.stringify({ kind: 'local', from: 1, to: 23, quote: { text: 'The contentious clause' } }),
    author: 'You',
    body: 'fix this before anyone reads it',
    resolved: false,
    createdAt: Date.now() - 7 * 86_400_000
  },
  {
    id: 'c2',
    parentId: null,
    anchorId: null,
    anchor: null,
    author: 'You',
    body: 'a second thought',
    resolved: false,
    createdAt: Date.now() - 86_400_000
  }
]

/** Every request the dialog made, so the assertions can be about traffic. */
let calls: Array<{ method: string; url: string; body: unknown }> = []

beforeAll(() => {
  class RO {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
})

beforeEach(() => {
  calls = []
  localStorage.clear()
  // The two namespaces this flow really uses, over a permissive fallback: the
  // people picker loads the directory on mount, and an unstubbed call there
  // surfaces as an unhandled rejection that passes the test and poisons the
  // next one.
  const anyApi = new Proxy(
    {},
    { get: () => new Proxy(() => Promise.resolve([]), { get: () => () => Promise.resolve([]) }) }
  )
  ;(window as unknown as { api: unknown }).api = new Proxy(
    {
      documents: {
        get: async () => ({ id: DOC_ID, docType: 'doc', title: 'Minutes', body: { doc: PM, headingStyles: {} } }),
        listComments: async () => comments
      },
      people: { setDirectory: async () => {}, list: async () => [] }
    } as Record<string, unknown>,
    {
      get: (target, key: string) => (key in target ? target[key] : anyApi)
    }
  )
  globalThis.fetch = vi.fn(async (url: unknown, init?: unknown) => {
    const u = String(url)
    const o = (init ?? {}) as { method?: string; body?: string }
    calls.push({ method: o.method ?? 'GET', url: u, body: o.body ? JSON.parse(o.body) : undefined })
    if (u.includes('/livedocs') && (o.method ?? 'GET') === 'POST' && u.endsWith('/comments')) {
      return new Response(JSON.stringify({ ok: true, comment: { id: `live_${calls.length}` } }), { status: 200 })
    }
    if (u.endsWith('/livedocs')) {
      return new Response(JSON.stringify({ ok: true, doc: { id: 'live_doc_1' } }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as unknown as typeof fetch
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

async function mount(): Promise<void> {
  const { useAccountStore } = await import('../../src/renderer/src/stores/account')
  act(() => {
    useAccountStore.setState({ sessionToken: 'tok' } as never)
  })
  const { default: LiveDocSharing } = await import('../../src/renderer/src/components/LiveDocSharing')
  act(() => root.render(<LiveDocSharing documentId={DOC_ID} onClose={() => {}} />))
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const q = (sel: string): HTMLElement | null => host.querySelector(sel)

/** Add a person and press Share. */
async function shareWithSomeone(): Promise<void> {
  const search = q('[data-testid="share-picker-search"]') as HTMLInputElement
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    set.call(search, 'sarah@example.com')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const invite = q('[data-testid="share-picker-invite-email"]')
  expect(invite, 'a typed email offers an invite').not.toBeNull()
  act(() => invite!.click())
  const submit = q('[data-testid="share-picker-submit"]') as HTMLButtonElement
  expect(submit.disabled, 'Share enables once someone is picked').toBe(false)
  act(() => submit.click())
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })
}

const commentPosts = (): Array<{ body: unknown }> =>
  calls.filter((c) => c.method === 'POST' && c.url.endsWith('/comments')).map((c) => ({ body: c.body }))

describe('Include my comments', () => {
  it('offers the box, counting THREADS, and leaves it unticked', async () => {
    await mount()
    const box = q('[data-testid="share-include-comments"]')
    expect(box, 'the box is offered when there are comments').not.toBeNull()
    expect(box!.textContent).toContain('Include my comments (2)')
    expect(box!.textContent, 'and says what ticking it means').toContain('able to read them')
    expect((box!.querySelector('input') as HTMLInputElement).checked, 'UNTICKED by default').toBe(false)
  })

  it('UNTICKED: sharing copies nothing — the requirement', async () => {
    await mount()
    await shareWithSomeone()
    // The document really was shared...
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/livedocs'))).toBe(true)
    // ...and not one comment went with it.
    expect(commentPosts()).toEqual([])
  })

  it('TICKED: each comment is copied, with its real time and its anchor', async () => {
    await mount()
    const input = q('[data-testid="share-include-comments"] input') as HTMLInputElement
    act(() => input.click())
    expect(input.checked).toBe(true)
    await shareWithSomeone()

    const posted = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/comments'))
    expect(posted).toHaveLength(2)
    const bodies = posted.map((p) => (p.body as { body: string }).body)
    expect(bodies).toEqual(['fix this before anyone reads it', 'a second thought'])
    // Oldest first, each with the time it was really written.
    const times = posted.map((p) => (p.body as { createdAt: number }).createdAt)
    expect(times[0]).toBe(comments[0]!.createdAt)
    expect(times[1]).toBe(comments[1]!.createdAt)
    expect(times[0]).toBeLessThan(times[1]!)
    // The one with a verified anchor carries a converted live anchor; the one
    // with no anchor carries none rather than an invented one.
    const first = JSON.parse((posted[0]!.body as { anchor: string }).anchor) as { kind: string }
    expect(first.kind).toBe('yjs')
    expect((posted[1]!.body as { anchor: string | null }).anchor).toBeNull()
  })

  it('the box is not offered at all when the document has no comments', async () => {
    ;(window as unknown as { api: { documents: { listComments: () => Promise<unknown[]> } } }).api.documents.listComments =
      async () => []
    await mount()
    expect(q('[data-testid="share-include-comments"]')).toBeNull()
    await shareWithSomeone()
    expect(commentPosts()).toEqual([])
  })
})
