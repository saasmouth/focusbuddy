// A real mount of the share sheet's list of usable-desk links.
//
// What is checked is what the sender sees: a link that never expires says
// "Never expires" (not a countdown, not a 9999 date); "Update link" asks first,
// says that everyone with the link will see the new version, then reports the
// time it happened or the reason it did not; and "Never" asks the server for a
// link that never expires -- and says so if the server would not give one.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))
vi.mock('../../src/renderer/src/components/LiveDeskSharing', () => ({ default: () => <div /> }))
vi.mock('../../src/renderer/src/components/LiveWebViewPanel', () => ({ default: () => <div /> }))
vi.mock('../../src/renderer/src/lib/signalConfig', () => ({
  signalConfig: { useRemote: true, httpUrl: 'http://signal.test', wsUrl: 'ws://signal.test/ws' },
  cloudAppUrl: () => 'https://plexiidesk.com/share'
}))
vi.mock('../../src/renderer/src/stores/account', () => ({
  useAccountStore: { getState: () => ({ sessionToken: 'tok' }) }
}))
const sharesState = { createFor: vi.fn(), outgoing: [], revoke: vi.fn(), refresh: vi.fn(async () => {}), invite: vi.fn() }
vi.mock('../../src/renderer/src/stores/shares', () => ({
  useSharesStore: (sel: (s: unknown) => unknown) => sel(sharesState)
}))
vi.mock('../../src/renderer/src/stores/nodes', () => ({
  useNodeStore: { getState: () => ({ nodes: [] }) }
}))
vi.mock('../../src/renderer/src/lib/shareTokens', () => ({ viewerUrlFor: (t: string) => `https://view.test/${t}` }))
vi.mock('../../src/renderer/src/lib/shareSnapshot', () => ({
  buildFolderSnapshot: vi.fn(), buildTaskSnapshot: vi.fn(), generateAnonymousHandle: () => 'handle'
}))

const client = vi.hoisted(() => ({
  listEphemeralShares: vi.fn(),
  mintEphemeralShare: vi.fn(),
  updateEphemeralShare: vi.fn(),
  revokeEphemeralShare: vi.fn(async () => true)
}))
vi.mock('../../src/renderer/src/lib/ephemeralShareClient', async (orig) => ({
  ...(await orig<typeof import('../../src/renderer/src/lib/ephemeralShareClient')>()),
  ...client
}))

import DeskShareSheet from '../../src/renderer/src/components/share/DeskShareSheet'
import type { EphemeralShare } from '../../src/renderer/src/lib/ephemeralShareClient'

const now = Date.now()
const share = (over: Partial<EphemeralShare>): EphemeralShare => ({
  token: 'tok_never_12345', rootId: 'desk-1', title: 'Demo', sizeBytes: 100, createdAt: now - 1000,
  updatedAt: now - 1000, expiresAt: null, opens: 4, lastOpenedAt: null, ...over
})

let host: HTMLDivElement
let root: Root
const q = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`)
const all = (id: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)]
const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function mountOnLinks(): Promise<void> {
  act(() => {
    root.render(<DeskShareSheet kind="task" entityId="desk-1" label="Demo" />)
  })
  await flush()
  act(() => q('share-audience-link')!.click())
  await flush()
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  client.listEphemeralShares.mockResolvedValue([
    share({}),
    share({ token: 'tok_expiring_123', expiresAt: now + 2 * 86_400_000 - 60_000, opens: 1 })
  ])
  client.mintEphemeralShare.mockReset()
  client.updateEphemeralShare.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('the list of usable-desk links', () => {
  it('says "Never expires" for a link with no end, and counts down only for one that has one', async () => {
    await mountOnLinks()
    const rows = all('share-ephemeral-summary').map((el) => el.textContent ?? '')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('Never expires')
    expect(rows[0]).not.toMatch(/left|9999/)
    expect(rows[1]).toMatch(/1d 23h left/)
  })

  it('asks before updating, and says everyone with the link will see the new version', async () => {
    await mountOnLinks()
    act(() => all('share-update-ephemeral')[0].click())
    const panel = q('share-update-confirm-panel')
    expect(panel?.textContent).toContain('Everyone with this link will see the desk as it is now.')
    expect(client.updateEphemeralShare).not.toHaveBeenCalled()
  })

  it('updates the same token from the desk it was made from, and shows when', async () => {
    const updatedAt = now + 5000
    client.updateEphemeralShare.mockResolvedValue({ ok: true, share: share({ updatedAt }), filesOmitted: [] })
    await mountOnLinks()
    act(() => all('share-update-ephemeral')[0].click())
    act(() => q('share-update-confirm')!.click())
    await flush()
    expect(client.updateEphemeralShare).toHaveBeenCalledWith('tok_never_12345', 'desk-1')
    const done = q('share-update-done')
    expect(done?.getAttribute('role')).toBe('status')
    expect(done?.textContent).toMatch(/^Updated .+\. Everyone with this link now gets this version\.$/)
    expect(q('share-update-confirm-panel')).toBeNull()
  })

  it('shows the reason when an update is refused', async () => {
    client.updateEphemeralShare.mockResolvedValue({ ok: false, error: 'That link has expired.' })
    await mountOnLinks()
    act(() => all('share-update-ephemeral')[1].click())
    act(() => q('share-update-confirm')!.click())
    await flush()
    const err = q('share-update-error')
    expect(err?.getAttribute('role')).toBe('alert')
    expect(err?.textContent).toBe('That link has expired.')
  })

  it('cancel leaves the link alone', async () => {
    await mountOnLinks()
    act(() => all('share-update-ephemeral')[0].click())
    const cancel = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!
    act(() => cancel.click())
    expect(q('share-update-confirm-panel')).toBeNull()
    expect(client.updateEphemeralShare).not.toHaveBeenCalled()
  })
})

describe('making a link with "Never"', () => {
  it('asks the client for a link that never expires (null), not the 48-hour default', async () => {
    client.mintEphemeralShare.mockResolvedValue({ ok: true, url: 'https://plexiidesk.com/share/s/tok_new_123456', share: share({ token: 'tok_new_123456' }) })
    await mountOnLinks()
    expect((q('share-expiry') as HTMLSelectElement).value).toBe('null')
    act(() => q('share-create-link')!.click())
    await flush()
    expect(client.mintEphemeralShare).toHaveBeenCalledWith('desk-1', null)
    expect(q('share-expiry-note')).toBeNull()
  })

  it('says so when the server gave the link an end date anyway', async () => {
    client.mintEphemeralShare.mockResolvedValue({
      ok: true, url: 'https://plexiidesk.com/share/s/tok_new_123456',
      share: share({ token: 'tok_new_123456', expiresAt: now + 2 * 86_400_000 - 60_000 })
    })
    await mountOnLinks()
    act(() => q('share-create-link')!.click())
    await flush()
    expect(q('share-expiry-note')?.textContent).toContain('does not support links that never expire yet')
  })
})

describe('files a link went out without (round 2)', () => {
  const omitted = [
    { id: 'f1', name: 'demo.mov', sizeBytes: 40 * 1024 * 1024, why: 'a link can carry at most 8 MB' },
    { id: 'f2', name: 'scan.png', sizeBytes: 0, why: 'the bytes are not on this device' }
  ]

  it('are named as soon as a new link is made, not discovered by the recipient', async () => {
    client.mintEphemeralShare.mockResolvedValue({
      ok: true, url: 'https://plexiidesk.com/share/s/tok_new_123456', share: share({ token: 'tok_new_123456' }), filesOmitted: omitted
    })
    await mountOnLinks()
    act(() => q('share-create-link')!.click())
    await flush()
    expect(q('share-omitted-note')?.textContent).toBe(
      'Left out because a link can carry at most 8 MB: demo.mov (40 MB). Left out because the file is not on this computer: scan.png.'
    )
  })

  it('say nothing when nothing was left out', async () => {
    client.mintEphemeralShare.mockResolvedValue({
      ok: true, url: 'https://plexiidesk.com/share/s/tok_new_123456', share: share({ token: 'tok_new_123456' }), filesOmitted: []
    })
    await mountOnLinks()
    act(() => q('share-create-link')!.click())
    await flush()
    expect(q('share-omitted-note')).toBeNull()
  })

  it('are named after an update too, grouped by why', async () => {
    client.updateEphemeralShare.mockResolvedValue({ ok: true, share: share({ updatedAt: now + 5000 }), filesOmitted: omitted })
    await mountOnLinks()
    act(() => all('share-update-ephemeral')[0].click())
    act(() => q('share-update-confirm')!.click())
    await flush()
    expect(q('share-update-done')?.textContent).toMatch(
      /Everyone with this link now gets this version\. Left out because a link can carry at most 8 MB: demo\.mov \(40 MB\)\. Left out because the file is not on this computer: scan\.png\.$/
    )
  })

  it('a desk too large for a link is said in a sentence, not "Payload Too Large"', async () => {
    client.mintEphemeralShare.mockResolvedValue({
      ok: false,
      error: 'This desk is too large to send as a link: a link can carry at most 8 MB. Move its largest files to another desk and try again.'
    })
    await mountOnLinks()
    act(() => q('share-create-link')!.click())
    await flush()
    expect(document.body.textContent).toContain('This desk is too large to send as a link')
    expect(document.body.textContent).not.toContain('Payload Too Large')
  })
})
