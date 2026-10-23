// The session's mount point: where "open and edit the original from where it's
// placed" actually lands.
//
// The host owns four things and this file is about those four only — the view's
// own behaviour (buffering, conflicts, loss warnings) is covered in
// snippetEditSession.test.tsx, and the view is stubbed here so this file does
// not drag TipTap and PlexiiCells in behind it.

import { act, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rendered: { snippetId: string; onClose: () => void }[] = []
let mounts = 0

/**
 * The stubbed session, and it SEEDS FROM ITS PROP ON MOUNT ONLY, on purpose.
 *
 * That is what the real thing does — every office editor builds its store and
 * undo stack from `content` on mount and never re-seeds — and it is the only
 * way this file can tell a remount from a re-render. A first version counted
 * `mounts` in the render body, which a re-render satisfies just as well: the
 * test passed with the host's `key` deleted, proving nothing.
 */
vi.mock('../../src/renderer/src/components/snippets/SnippetEditSessionView', () => ({
  default: ({ snippetId, onClose }: { snippetId: string; onClose: () => void }) => {
    rendered.push({ snippetId, onClose })
    const [mountedWith] = useState(snippetId)
    useEffect(() => {
      mounts += 1
    }, [])
    return (
      <div data-testid="session-stub" data-snippet={snippetId} data-mounted-with={mountedWith}>
        <button data-testid="stub-close" onClick={onClose}>
          close
        </button>
      </div>
    )
  }
}))

import { SnippetSessionHost } from '../../src/renderer/src/components/snippets/SnippetSessionHost'
import {
  openSnippetSession,
  useSnippetSession
} from '../../src/renderer/src/components/snippets/snippetSessionStore'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  rendered.length = 0
  mounts = 0
  useSnippetSession.setState({ snippetId: null })
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
    root.render(<SnippetSessionHost />)
  })
}
const open = async (id: string): Promise<void> => {
  await act(async () => openSnippetSession(id))
}
const el = (testid: string): HTMLElement | null =>
  host.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null

describe('the host is inert until a snippet is opened', () => {
  it('renders nothing at all, so it costs a mounted-but-empty overlay nothing', async () => {
    await mount()
    expect(el('snippet-session-host')).toBeNull()
    expect(mounts).toBe(0)
  })

  it('opens the snippet the opener was given', async () => {
    await mount()
    await open('s1')
    expect(el('snippet-session-host')).not.toBeNull()
    expect(el('session-stub')!.getAttribute('data-snippet')).toBe('s1')
  })

  it('closes back to nothing through the view, not around it', async () => {
    await mount()
    await open('s1')
    await act(async () => el('stub-close')!.click())
    expect(el('snippet-session-host')).toBeNull()
    expect(useSnippetSession.getState().snippetId).toBeNull()
  })
})

describe('the scrim does not close the session', () => {
  it('survives a click on the backdrop', async () => {
    // Every other modal in the app closes here, and this one must not. The
    // session's edits exist nowhere but its own buffer — no document row is
    // created — and the only thing standing between them and a stray click is
    // the confirm inside the view's close. A scrim wired to the store's close
    // would bypass that confirm entirely and the edit would be gone with no
    // prompt and nothing to restore from.
    await mount()
    await open('s1')
    const scrim = el('snippet-session-host')!
    await act(async () => {
      scrim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      scrim.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(el('snippet-session-host')).not.toBeNull()
    expect(useSnippetSession.getState().snippetId).toBe('s1')
  })
})

describe('opening a second snippet remounts', () => {
  it('does not re-point a live session at a different master', async () => {
    // The failure this prevents is the worst one available to this feature: the
    // view refetches on a snippetId change, but its buffered body and dirty
    // flag are component state and would survive it — so an unsaved body from
    // the first snippet could be saved onto the second one's master, which
    // then propagates to every live instance of the WRONG snippet.
    await mount()
    await open('s1')
    expect(mounts).toBe(1)
    await open('s2')
    // The assertion that bites: what the editor SEEDED from, not what it was
    // last rendered with. A re-render would leave this at 's1' while the prop
    // said 's2' — an editor showing one snippet and saving to another.
    expect(el('session-stub')!.getAttribute('data-mounted-with')).toBe('s2')
    expect(el('session-stub')!.getAttribute('data-snippet')).toBe('s2')
    expect(mounts).toBe(2)
  })
})
