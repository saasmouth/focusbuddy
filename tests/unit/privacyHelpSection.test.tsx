// Settings > Data > Privacy: both reporting switches render OFF for a person
// who never chose, say so in words, and actually set the stored preference the
// transports read. Update checks render ON (said so), Background AI tasks and
// "Keep this device local" OFF, and each reaches the place that enforces it.
// The copy must not reintroduce a claim the inventory
// (docs/network-inventory.md) contradicts.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))

import PrivacyHelpSection from '../../src/renderer/src/components/settings/PrivacyHelpSection'
import { localOnlyMode } from '../../src/renderer/src/lib/localOnlyMode'
import {
  crashReportsEnabled,
  setTelemetryEnabled,
  telemetryEnabled
} from '../../src/renderer/src/lib/telemetryPrefs'

let host: HTMLDivElement
let root: Root

function mount(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<PrivacyHelpSection />))
}
const box = (id: string): HTMLInputElement => host.querySelector(`[data-testid="${id}"]`) as HTMLInputElement

let mainPrefs = { autoUpdateChecks: true, backgroundAi: false }
let api: {
  files: { openExternal: ReturnType<typeof vi.fn> }
  privacy: { getPrefs: ReturnType<typeof vi.fn>; setPrefs: ReturnType<typeof vi.fn> }
  update: { check: ReturnType<typeof vi.fn>; onState: ReturnType<typeof vi.fn> }
  backup: { snapshotBeforeSyncResume: ReturnType<typeof vi.fn> }
}

beforeEach(() => {
  localStorage.clear()
  mainPrefs = { autoUpdateChecks: true, backgroundAi: false }
  api = {
    files: { openExternal: vi.fn() },
    privacy: {
      getPrefs: vi.fn(async () => ({ ...mainPrefs })),
      setPrefs: vi.fn(async (patch: Partial<typeof mainPrefs>) => (mainPrefs = { ...mainPrefs, ...patch }))
    },
    update: { check: vi.fn(async () => ({ ok: true })), onState: vi.fn(() => () => {}) },
    backup: { snapshotBeforeSyncResume: vi.fn(async () => ({ ok: true, path: '/u/backups/before-sync-resume-x.fbbackup' })) }
  }
  ;(window as unknown as { api: unknown }).api = api
})

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('Privacy settings', () => {
  it('shows both switches off for a person who never chose, and says reporting is off by default', () => {
    mount()
    expect(box('privacy-usage-toggle').checked).toBe(false)
    expect(box('privacy-crash-toggle').checked).toBe(false)
    expect(host.querySelector('[data-testid="privacy-reporting-default"]')?.textContent).toMatch(
      /off unless you turn them on/
    )
  })

  it('ticking a box is the consent the transports read', () => {
    mount()
    act(() => box('privacy-usage-toggle').click())
    expect(telemetryEnabled()).toBe(true)
    expect(crashReportsEnabled()).toBe(false)
    act(() => box('privacy-crash-toggle').click())
    expect(crashReportsEnabled()).toBe(true)
    act(() => box('privacy-usage-toggle').click())
    expect(telemetryEnabled()).toBe(false)
  })

  it('reflects an explicit earlier choice', () => {
    setTelemetryEnabled(true)
    mount()
    expect(box('privacy-usage-toggle').checked).toBe(true)
  })

  it('names what leaves the computer and makes none of the retired claims', () => {
    mount()
    const text = host.textContent ?? ''
    for (const host of ['OpenStreetMap', 'DuckDuckGo', 'dl.plexiidesk.com', 'Anthropic', 'OpenAI']) {
      expect(text).toContain(host)
    }
    // Icons no longer go through Google's favicon service (4.3.34).
    expect(text).not.toMatch(/Google/)
    expect(text).toMatch(/fetched from the linked site itself/)
    expect(text).toMatch(/not end to end/)
    // Each of these was in the app before 4.3.34 and was not true.
    expect(text).not.toMatch(/Only items you explicitly share, and your email address/)
    expect(text).not.toMatch(/nothing leaves/i)
    expect(text).not.toMatch(/anonymous/i)
  })

  it('update checks: on by default and said so; the switch and Check now reach main', async () => {
    mount()
    await flush()
    expect(box('privacy-updates-toggle').checked).toBe(true)
    expect(host.textContent).toMatch(/no account or device identifier/)
    act(() => box('privacy-updates-toggle').click())
    await flush()
    expect(api.privacy.setPrefs).toHaveBeenCalledWith({ autoUpdateChecks: false })
    act(() => (host.querySelector('[data-testid="privacy-updates-check-now"]') as HTMLButtonElement).click())
    expect(api.update.check).toHaveBeenCalledTimes(1)
  })

  it('background AI tasks: off by default, names exactly what it would send, and reaches main', async () => {
    mount()
    await flush()
    const b = box('privacy-background-ai-toggle')
    expect(b.checked).toBe(false)
    const label = b.closest('label')?.textContent ?? ''
    expect(label).toMatch(/up to 40/)
    expect(label).toMatch(/400 characters/)
    expect(label).toMatch(/Anthropic/)
    expect(label).toMatch(/OpenAI/)
    expect(label).toMatch(/search questions/)
    act(() => b.click())
    await flush()
    expect(api.privacy.setPrefs).toHaveBeenCalledWith({ backgroundAi: true })
  })

  it('keep this device local: off by default; on warns about other devices; off saves a backup first', async () => {
    mount()
    await flush()
    expect(box('privacy-keep-local-toggle').checked).toBe(false)
    act(() => box('privacy-keep-local-toggle').click())
    await flush()
    expect(localOnlyMode()).toBe(true)
    expect(host.querySelector('[data-testid="privacy-keep-local-warning"]')?.textContent).toMatch(
      /that device.s version wins/
    )
    act(() => box('privacy-keep-local-toggle').click())
    await flush()
    expect(api.backup.snapshotBeforeSyncResume).toHaveBeenCalledTimes(1)
    expect(localOnlyMode()).toBe(false)
    expect(host.querySelector('[data-testid="privacy-keep-local-note"]')?.textContent).toMatch(/backup/)
  })

  it('keep this device local stays on when the backup before resuming fails', async () => {
    api.backup.snapshotBeforeSyncResume = vi.fn(async () => ({ ok: false, error: 'disk full' }))
    localStorage.setItem('plexii.sync.localOnly', 'on')
    mount()
    await flush()
    act(() => box('privacy-keep-local-toggle').click())
    await flush()
    expect(localOnlyMode()).toBe(true)
    expect(box('privacy-keep-local-toggle').checked).toBe(true)
    expect(host.querySelector('[data-testid="privacy-keep-local-note"]')?.textContent).toMatch(/not turned back on/)
  })
})
