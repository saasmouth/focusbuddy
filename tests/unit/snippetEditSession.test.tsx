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

import { act, useState } from 'react'
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

/**
 * A stand-in for an app's editor, and it SEEDS ITS STATE ONCE on purpose.
 *
 * Every real office editor does: DrawStudio, DesignEditor, DiagramEditor,
 * SheetEditor and SlidesEditor all build their store, undo stack and loaded
 * rasters from `content` on mount, and none re-seeds on a prop change. An
 * earlier version of this stub was stateless, which made it USELESS for the one
 * bug in this area — the host replacing the body without remounting, so a
 * Reload left the old content on screen. The stub passed; the real thing would
 * not have.
 */
function StubEditor({
  body,
  onChange,
  requestSave
}: {
  body: SnippetBody
  onChange: (next: SnippetBody) => void
  requestSave?: () => void
}): JSX.Element {
  const [seeded] = useState(() => (body as { text?: string }).text ?? '')
  return (
    <>
      <span data-testid="stub-seeded">{seeded}</span>
      <button data-testid="stub-request-save" onClick={() => requestSave?.()}>
        the editor's own Save
      </button>
      <button
        data-testid="stub-change"
        onClick={() =>
          onChange({ kind: 'doc', content: [{ type: 'paragraph' }], text: 'edited' } as SnippetBody)
        }
      >
        type
      </button>
      <button
        data-testid="stub-change-lossy"
        onClick={() =>
          onChange({ kind: 'doc', content: [{ type: 'paragraph' }], text: 'edited' } as SnippetBody, [
            'a paint layer',
            '2 extra artboards'
          ])
        }
      >
        type something the snippet cannot hold
      </button>
    </>
  )
}

const stubEditor = (): SnippetKindEditor => ({
  render: ({ body, onChange, requestSave }) => (
    <StubEditor body={body} onChange={onChange} requestSave={requestSave} />
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

describe("an editor's own Save asks the host, under the host's guard", () => {
  // PlexiiDraw has a File > Save and a ⌘S of its own, and inside a session they
  // must pull this trigger rather than write: the studio has nothing to write
  // to. The guard is the same one the Save button carries, and it matters more
  // here because a keypress can arrive at any moment.

  it('saves when there is something to save', async () => {
    await mount()
    await click('stub-change')
    await click('stub-request-save')
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('does nothing when nothing has changed', async () => {
    // Not merely wasteful: a save with no change still bumps the master's
    // revision, and every OTHER open session then fails its compare-and-set
    // over a change that never happened — a conflict prompt out of thin air.
    await mount()
    await click('stub-request-save')
    expect(update).not.toHaveBeenCalled()
  })

  it('does not stack a second write on top of one in flight', async () => {
    // Two writes racing the same base revision: the second carries a revision
    // the first has already superseded, so one of them is refused for no reason
    // the user can see.
    let release: (v: unknown) => void = () => {}
    update.mockImplementation(() => new Promise((r) => (release = r)))
    await mount()
    await click('stub-change')
    await click('stub-request-save')
    await click('stub-request-save')
    await click('stub-request-save')
    expect(update).toHaveBeenCalledTimes(1)
    await act(async () => release({ ok: true, snippet: { ...master, revision: 4 } }))
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

  it('Reload actually REMOUNTS the editor, so their body is what is on screen', async () => {
    // The bug this exists for: the host replaced its buffered body but left the
    // editor mounted, and editors seed from content on mount only — so the user
    // pressed "Reload theirs" and went on looking at the body they had just
    // chosen to discard. Silent, and invisible to a stateless stub.
    await mount()
    expect(host.querySelector('[data-testid="stub-seeded"]')!.textContent).toBe('v1')
    await click('stub-change')
    await click('snippet-session-save')
    await click('snippet-session-reload')
    expect(host.querySelector('[data-testid="stub-seeded"]')!.textContent).toBe('theirs')
  })

  it('after Reload, the next save CAS-es against THEIR revision, not the stale one', async () => {
    // d1's framing of this is sharper than mine was, and it is the reason the
    // remount matters: the risk is not a stale VIEW, it is silent DATA LOSS. If
    // the session kept its old base revision after taking theirs, the next edit
    // would be saved against a revision that no longer exists — and with the
    // guard satisfied by the wrong number, it would overwrite their work without
    // the conflict bar ever appearing again.
    await mount()
    await click('stub-change')
    await click('snippet-session-save')
    await click('snippet-session-reload')
    await click('stub-change')
    await click('snippet-session-save')
    const last = update.mock.calls[update.mock.calls.length - 1]!
    expect(last[1].expectedRevision).toBe(9)
  })

  it('Overwrite does NOT remount, so undo history and scroll survive', async () => {
    // The mirror of the rule above: overwriting keeps MY body, so remounting
    // would throw away the editor's state for nothing.
    await mount()
    await click('stub-change')
    await click('snippet-session-save')
    await click('snippet-session-overwrite')
    expect(host.querySelector('[data-testid="stub-seeded"]')!.textContent).toBe('v1')
  })
})

describe('Escape closes, but only when nothing nearer wanted it', () => {
  const mountWith = async (onClose: () => void): Promise<void> => {
    await act(async () => {
      root.render(
        <SnippetEditSessionView snippetId="s1" onClose={onClose} editors={{ doc: stubEditor() }} />
      )
    })
  }
  const press = async (on: HTMLElement): Promise<void> => {
    await act(async () => {
      on.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
  }
  const shell = (): HTMLElement => host.querySelector('[data-testid="snippet-session"]') as HTMLElement

  it('closes a clean session', async () => {
    // A modal with no Escape is the kind of gap nobody files a bug about; they
    // just hunt for the × every time.
    const onClose = vi.fn()
    await mountWith(onClose)
    await press(shell())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('asks before discarding unsaved work, like the × does', async () => {
    const onClose = vi.fn()
    ;(window as unknown as { confirm: () => boolean }).confirm = () => false
    await mountWith(onClose)
    await click('stub-change')
    await press(shell())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('ignores an Escape that something nearer the user already handled', async () => {
    // The real case, and the reason this guard exists rather than a bare
    // handler: PlexiiCells cancels a cell edit on Escape and calls
    // preventDefault WITHOUT stopping propagation (SheetGrid's cell input), so
    // the keypress reaches the session shell too. Closing on it would abandon a
    // whole sheet snippet because the user backed out of one cell — and if the
    // snippet were dirty they would get a discard prompt for pressing Escape in
    // a cell, which is worse than useless.
    const onClose = vi.fn()
    await mountWith(onClose)
    const inner = host.querySelector('[data-testid="stub-change"]') as HTMLElement
    inner.addEventListener('keydown', (e) => e.preventDefault())
    await press(inner)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('still closes on an Escape that bubbled up unclaimed', async () => {
    // The mirror of the rule above: bubbling from inside an editor is normal —
    // Write does nothing with Escape — so an unclaimed one must still work, or
    // the guard would have broken Escape everywhere except the shell itself.
    const onClose = vi.fn()
    await mountWith(onClose)
    await press(host.querySelector('[data-testid="stub-change"]') as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('what a snippet cannot hold is said, not dropped', () => {
  it('names each loss, beside Save, before the decision is made', async () => {
    await mount()
    expect(host.querySelector('[data-testid="snippet-session-lost"]')).toBeNull()
    await click('stub-change-lossy')
    const warn = host.querySelector('[data-testid="snippet-session-lost"]')!
    expect(warn.textContent).toContain('a paint layer')
    expect(warn.textContent).toContain('2 extra artboards')
  })

  it('still allows the save, because it is the user\'s call', async () => {
    // Refusing would be worse: the alternative to saving a lossy body is losing
    // the whole edit. The warning informs the decision rather than making it.
    await mount()
    await click('stub-change-lossy')
    const save = host.querySelector('[data-testid="snippet-session-save"]') as HTMLButtonElement
    expect(save.disabled).toBe(false)
    await click('snippet-session-save')
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('clears when a later change loses nothing', async () => {
    // Otherwise the warning would outlive the thing it warned about, and a stale
    // warning teaches people to ignore the real one.
    await mount()
    await click('stub-change-lossy')
    expect(host.querySelector('[data-testid="snippet-session-lost"]')).not.toBeNull()
    await click('stub-change')
    expect(host.querySelector('[data-testid="snippet-session-lost"]')).toBeNull()
  })

  it('says nothing when there is nothing to say', async () => {
    await mount()
    await click('stub-change')
    expect(host.querySelector('[data-testid="snippet-session-lost"]')).toBeNull()
  })
})
