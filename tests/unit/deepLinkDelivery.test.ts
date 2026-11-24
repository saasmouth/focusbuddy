// @vitest-environment node
// A link handed to the app is kept until a window takes it (4.3.56).
//
// 1a found this in PlexiiLite (1dcc8dc): window messages sent before the page
// subscribes are lost. Main here kept a link (sign-in, refused-link notice,
// share, meeting, external markdown) only when NO window existed; with a window
// open it sent and forgot. A window that is still loading, or between draining
// and subscribing (App.tsx awaited a whole share accept or meeting join before
// it listened), has nobody listening: Electron drops the message, nothing stays
// pending, and the link is gone. Now main keeps every item until a window takes
// it (get-pending / take-notices); the message is only a nudge to take it.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ sent: [] as Array<[string, unknown]>, windows: 1 }))
vi.mock('electron', () => ({
  app: { whenReady: async () => undefined, on: () => undefined, isReady: () => true },
  BrowserWindow: {
    // A window is open, its page still loading: send succeeds, nobody hears it.
    getAllWindows: () =>
      Array.from({ length: h.windows }, () => ({
        isDestroyed: () => false,
        isMinimized: () => false,
        restore: () => undefined,
        focus: () => undefined,
        webContents: { send: (ch: string, payload: unknown) => h.sent.push([ch, payload]) }
      }))
  },
  net: { fetch: async () => new Response('{}', { status: 500 }) }
}))
vi.mock('../../src/main/deskHandoffReceiver', () => ({ receiveDeskHandoff: () => undefined }))
vi.mock('../../src/main/liteRoomReceiver', () => ({ receiveLiteRoom: () => undefined }))

import {
  handleAuthLink,
  handleDeepLinkUrlForTests,
  takeAuthNotices,
  consumePendingAuthHandoff,
  consumePendingShareToken,
  consumePendingMeetRoom,
  consumePendingMdEditPath,
  _resetAuthLinksForTests
} from '../../src/main/authProtocol'
import { parseAuthLink } from '../../src/shared/authLink'

const drain = <T>(take: () => T | null): T[] => {
  const out: T[] = []
  for (let v = take(); v !== null; v = take()) out.push(v)
  return out
}

beforeEach(() => {
  h.sent.length = 0
  h.windows = 1
  _resetAuthLinksForTests()
})

describe('with a window open that is not listening yet', () => {
  it('a share link is kept for the window to take, and nudges it', () => {
    handleDeepLinkUrlForTests('plexii://share?token=tok_1', 'open-url')
    expect(h.sent.map(([ch]) => ch)).toEqual(['share:incoming-token'])
    expect(drain(consumePendingShareToken)).toEqual(['tok_1'])
  })

  it('two in quick succession: both, in order, each once', () => {
    handleDeepLinkUrlForTests('plexii://share?token=tok_1', 'open-url')
    handleDeepLinkUrlForTests('plexii://share?token=tok_2', 'open-url')
    expect(drain(consumePendingShareToken)).toEqual(['tok_1', 'tok_2'])
    expect(consumePendingShareToken()).toBeNull()
  })

  it('a meeting link and an external markdown link likewise', () => {
    handleDeepLinkUrlForTests('plexii://meet?room=room_9', 'open-url')
    handleDeepLinkUrlForTests('plexii://edit-md?path=%2Ftmp%2Fa.md', 'open-url')
    expect(drain(consumePendingMeetRoom)).toEqual(['room_9'])
    expect(drain(consumePendingMdEditPath)).toEqual(['/tmp/a.md'])
  })

  it('a sign-in link likewise', async () => {
    await handleAuthLink(parseAuthLink('haptyx://auth?token=sess_1&email=me%40example.com')!, 'open-url')
    const got = drain(consumePendingAuthHandoff)
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ sessionToken: 'sess_1', origin: 'open-url' })
  })

  it('a notice (a refused link) likewise', async () => {
    await handleAuthLink(parseAuthLink(`haptyx://auth?code=${'C'.repeat(43)}&state=nope`)!, 'open-url')
    expect(h.sent.map(([ch]) => ch)).toEqual(['auth:notice'])
    expect(takeAuthNotices()).toEqual([{ kind: 'link-refused', why: 'not-started' }])
    expect(takeAuthNotices()).toEqual([])
  })
})

describe('with no window yet (a link that launched the app)', () => {
  it('kept as before, with no nudge', () => {
    h.windows = 0
    handleDeepLinkUrlForTests('plexii://share?token=tok_cold', 'argv')
    expect(h.sent).toEqual([])
    expect(drain(consumePendingShareToken)).toEqual(['tok_cold'])
  })
})
