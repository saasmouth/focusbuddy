// A snippet opened as a document: the session host.
//
// The property that matters most here cannot be seen by looking at the screen:
// TYPING MUST NOT WRITE. None of the office editors saves anything — they are
// controlled components whose only output is onChange, and their hosts persist,
// which is what makes them look like they autosave. So in a session the host is
// the only thing standing between a keystroke and a write to the snippet
// master — and because a master write broadcasts, a host that wrote on change
// would re-render every live instance of that snippet, everywhere, per
// keystroke.
//
// The other half is the conflict rule. Two sessions on one master must not
// last-write-win, so Save carries the revision it loaded and a refusal offers
// both ways out explicitly.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))

import SnippetEditSessionView, {
  type SnippetKindEditor
} from '../../src/renderer/src/components/snippets/SnippetEditSessionView'
import type { Snippet, SnippetBody } from '../../src/shared/snippets'

const master = {
  id: 's1',
  kind: 'doc',
  name: 'Payment terms',
  description: null,
  body: { kind: 'doc', content: [{ type: 'paragraph' }], text: 'v1' },
  tags: [],
  scope: 'personal',
  orgId: 'personal',
  authorId: null,
  revision: 3,
  usageCount: 0,
  createdAt: 0,
  updatedAt: 0
} as unknown as Snippet

let update: ReturnType<typeof vi.fn>
let docsUpdate: ReturnType<typeof vi.fn>
let docsCreate: ReturnType<typeof vi.fn>
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

/** A stand-in for an app's editor: a button that emits one change. */
const stubEditor = (): SnippetKindEditor => ({
  render: ({ onChange }) => (
    <button
      data-testid="stub-change"
      onClick={() =>
        onChange({ kind: 'doc', content: [{ type: 'paragraph' }], text: 'edited' } as SnippetBody)
      }
    >
      type
    </button>
  )
})

beforeEach(() => {
  update = vi.fn().mockResolvedValue({ ok: true, snippet: { ...master, revision: 4 } })
  docsUpdate = vi.fn()
  docsCreate = vi.fn()
  ;(globalThis as unknown as { window: unknown }).window = Object.assign(globalThis.window ?? {}, {
    api: {
      snippets: { get: vi.fn().mockResolvedValue(master), update },
      documents: { update: docsUpdate, create: docsCreate }
    },
    confirm: () => true
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const mount = async (): Promise<void> => {
  await act(async () => {
    root.render(
      <SnippetEditSessionView snippetId="s1" onClose={() => {}} editors={{ doc: stubEditor() }} />
    )
  })
}
const click = async (testid: string): Promise<void> => {
  const el = host.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null
  if (!el) throw new Error(`no [data-testid="${testid}"]`)
  await act(async () => el.click())
}

describe('typing does not write', () => {
  it('buffers every change and writes nothing until Save', async () => {
    await mount()
    await click('stub-change')
    await click('stub-change')
    await click('stub-change')
    // The whole point. A host that persisted onChange would have written three
    // times and re-rendered every live instance of this snippet three times.
    expect(update).not.toHaveBeenCalled()
  })

  it('writes exactly once on Save, with the body from the LAST change', async () => {
    await mount()
    await click('stub-change')
    await click('snippet-session-save')
    expect(update).toHaveBeenCalledTimes(1)
    const [id, patch] = update.mock.calls[0]!
    expect(id).toBe('s1')
    expect((patch.body as { text: string }).text).toBe('edited')
  })

  it('carries the revision it loaded, so a stale save is refused rather than winning', async () => {
    await mount()
    await click('stub-change')
    await click('snippet-session-save')
    expect(update.mock.calls[0]![1].expectedRevision).toBe(3)
  })

  it('creates no document, which is why there is nothing to leak into Files', async () => {
    await mount()
    await click('stub-change')
    await click('snippet-session-save')
    expect(docsCreate).not.toHaveBeenCalled()
    expect(docsUpdate).not.toHaveBeenCalled()
  })

  it('Save is disabled until something has actually changed', async () => {
    await mount()
    const save = host.querySelector('[data-testid="snippet-session-save"]') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await click('stub-change')
    expect((host.querySelector('[data-testid="snippet-session-save"]') as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('the banner says what is true', () => {
  it('names the snippet and warns about reach, with no invented count', async () => {
    await mount()
    const banner = host.querySelector('[data-testid="snippet-session-banner"]')!
    expect(banner.textContent).toContain('Payment terms')
    expect(banner.textContent).toContain('everywhere it is used')
    // usage_count counts inserts over all time and is never decremented, so any
    // "used in N places" taken from it would be a precise-looking wrong number.
    expect(banner.textContent).not.toMatch(/\d+ places/)
  })
})

describe('a conflict offers both ways out, explicitly', () => {
  const theirs = { ...master, revision: 9, body: { kind: 'doc', content: [{ type: 'paragraph' }], text: 'theirs' } } as Snippet

  beforeEach(() => {
    update = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'changed elsewhere', conflictWith: theirs })
      .mockResolvedValue({ ok: true, snippet: { ...theirs, revision: 10 } })
    ;(window as unknown as { api: { snippets: { get: unknown; update: unknown } } }).api.snippets.update = update
  })

  it('shows the conflict rather than silently losing the edit', async () => {
    await mount()
    await click('stub-change')
    await click('snippet-session-save')
    expect(host.querySelector('[data-testid="snippet-session-conflict"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="snippet-session-reload"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="snippet-session-overwrite"]')).not.toBeNull()
  })

  it('Overwrite re-saves against the revision it was just shown', async () => {
    await mount()
    await click('stub-change')
    await click('snippet-session-save')
    await click('snippet-session-overwrite')
    // Not the stale 3 it loaded: the 9 it lost to, so the second write is a
    // deliberate replacement of a known body rather than another blind race.
    expect(update.mock.calls[1]![1].expectedRevision).toBe(9)
  })

  it('Reload takes theirs and clears the conflict without writing', async () => {
    await mount()
    await click('stub-change')
    await click('snippet-session-save')
    const before = update.mock.calls.length
    await click('snippet-session-reload')
    expect(host.querySelector('[data-testid="snippet-session-conflict"]')).toBeNull()
    expect(update.mock.calls.length).toBe(before)
  })
})
