// Wiring only, deliberately.
//
// d1 owns whether the wrapping is CORRECT — 41 body tests through the real
// DrawStudio, plus the artboard and round-trip properties. This file owns the
// three things that live in my entry and nowhere else: that a drawing snippet
// is openable at all, that `lost` reaches the session's warning, and that the
// studio's own Save pulls the host's trigger instead of writing.
//
// The helpers are therefore mocked, so these assertions fail for wiring reasons
// rather than drifting whenever d1 improves the wrapping.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DrawSnippetBody, SnippetBody } from '../../src/shared/snippets'

// vi.hoisted because vi.mock is lifted above everything else in the file: a
// factory that closes over ordinary top-level consts throws "cannot access
// before initialization" at import time.
const H = vi.hoisted(() => {
  const WRAPPED = { version: 2, artboards: [{ id: 'snippet-artboard', x: -8, y: -8, w: 120, h: 90 }] }
  const UNWRAPPED = { kind: 'draw', objects: [{ id: 'o1' }], assets: {}, swatches: [] }
  return {
    WRAPPED,
    UNWRAPPED,
    drawBodyFromSnippet: vi.fn(() => WRAPPED),
    snippetFromDrawBody: vi.fn(() => ({
      body: UNWRAPPED,
      lost: ['a paint layer', '2 extra artboards']
    }))
  }
})
const { drawBodyFromSnippet, snippetFromDrawBody } = H
const WRAPPED = H.WRAPPED
const UNWRAPPED = H.UNWRAPPED as unknown as DrawSnippetBody

vi.mock('../../src/shared/draw/snippetBody', () => ({
  drawBodyFromSnippet: H.drawBodyFromSnippet,
  snippetFromDrawBody: H.snippetFromDrawBody
}))

// The studio itself: records what it was given and lets the test drive its
// onChange and its Save command.
const studio: {
  content?: unknown
  session?: unknown
  onSaveRequest?: () => void
  emit?: (body: unknown) => void
} = {}

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))

vi.mock('../../src/renderer/src/components/documents/DrawStudio', () => ({
  default: (props: {
    content: unknown
    session?: unknown
    onSaveRequest?: () => void
    onChange: (b: unknown) => void
  }) => {
    studio.content = props.content
    studio.session = props.session
    studio.onSaveRequest = props.onSaveRequest
    studio.emit = props.onChange
    return <div data-testid="draw-studio" />
  }
}))

import SnippetDrawSession from '../../src/renderer/src/components/snippets/SnippetDrawSession'
import SnippetEditSessionView from '../../src/renderer/src/components/snippets/SnippetEditSessionView'

const SNIPPET = { kind: 'draw', objects: [], assets: {}, swatches: [] } as unknown as SnippetBody

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
let onChange: ReturnType<typeof vi.fn>
let requestSave: ReturnType<typeof vi.fn>

beforeEach(() => {
  drawBodyFromSnippet.mockClear()
  snippetFromDrawBody.mockClear()
  onChange = vi.fn()
  requestSave = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const mount = async (body: SnippetBody = SNIPPET): Promise<void> => {
  await act(async () => {
    root.render(
      <SnippetDrawSession body={body} title="A drawing" onChange={onChange} requestSave={requestSave} />
    )
  })
}

describe('a drawing snippet opens in the studio', () => {
  it('hands the studio the WRAPPED body, not the snippet', async () => {
    await mount()
    expect(drawBodyFromSnippet).toHaveBeenCalledWith(SNIPPET)
    expect(studio.content).toBe(WRAPPED)
  })

  it('declares the snippet session, which is what turns the document commands off', async () => {
    // Without this the studio's Move to trash would bin the documents store's
    // active document — not this snippet, which has no document at all.
    await mount()
    expect(studio.session).toEqual({ kind: 'snippet' })
  })

  it('renders nothing for a snippet of another kind rather than guessing', async () => {
    await mount({ kind: 'doc', content: [], text: '' } as unknown as SnippetBody)
    expect(host.querySelector('[data-testid="draw-studio"]')).toBeNull()
    expect(drawBodyFromSnippet).not.toHaveBeenCalled()
  })
})

describe('what the snippet cannot hold travels with the change', () => {
  it('passes `lost` through as the second argument, where the host can show it', async () => {
    await mount()
    await act(async () => studio.emit!({ edited: true }))
    expect(onChange).toHaveBeenCalledTimes(1)
    const [body, lost] = onChange.mock.calls[0]!
    expect(body).toBe(UNWRAPPED)
    expect(lost).toEqual(['a paint layer', '2 extra artboards'])
  })

  it('compares each change against the LAST snippet body, not the one it mounted with', async () => {
    // The reason this is a ref and not the `body` prop: the studio can emit
    // several changes before the host re-renders, and `prev` is how a damaged
    // object is detected and left out instead of written as rubble. Reading the
    // prop would compare the newest drawing against a body two edits old.
    await mount()
    await act(async () => studio.emit!({ first: true }))
    await act(async () => studio.emit!({ second: true }))
    expect(snippetFromDrawBody.mock.calls[0]![1]).toBe(SNIPPET)
    expect(snippetFromDrawBody.mock.calls[1]![1]).toBe(UNWRAPPED)
  })
})

describe("the studio's Save asks the host", () => {
  it('is wired to the host trigger, so ⌘S in the studio does not write', async () => {
    // DrawStudio shows Save disabled and leaves ⌘S alone when onSaveRequest is
    // absent, which inside a session reads as broken: the session plainly has a
    // Save. Identity rather than a call, because the studio owns when it fires.
    await mount()
    expect(studio.onSaveRequest).toBe(requestSave)
  })
})

describe('the registry entry is REACHABLE, not merely written', () => {
  // The entry can be deleted, or its kind key misspelled, and every test above
  // still passes: they import the component directly. The session would then
  // fall through to "a drawing cannot be opened for editing yet" — the exact
  // state this entry replaced, and the kind of silent regression that only
  // shows up when someone opens a drawing snippet in the shipped app.
  //
  // So this one goes through the real registry, via the real lazy import.

  const DRAW_SNIPPET = {
    id: 's-draw',
    kind: 'draw',
    name: 'A logo mark',
    description: null,
    body: { kind: 'draw', objects: [], assets: {}, swatches: [] },
    tags: [],
    scope: 'personal',
    orgId: 'personal',
    authorId: null,
    revision: 1,
    usageCount: 0,
    createdAt: 0,
    updatedAt: 0
  }

  beforeEach(() => {
    ;(globalThis as unknown as { window: Window }).window = Object.assign(globalThis.window ?? {}, {
      api: { snippets: { get: vi.fn().mockResolvedValue(DRAW_SNIPPET), update: vi.fn() } },
      confirm: () => true
    }) as never
  })

  it('opens a drawing snippet in the studio instead of refusing it', async () => {
    await act(async () => {
      root.render(<SnippetEditSessionView snippetId="s-draw" onClose={() => {}} />)
    })
    // Two assertions, because either alone can pass for the wrong reason: the
    // refusal must be gone AND the studio must be what replaced it.
    expect(host.querySelector('[data-testid="snippet-session-unsupported"]')).toBeNull()
    expect(host.querySelector('[data-testid="draw-studio"]')).not.toBeNull()
  })
})
