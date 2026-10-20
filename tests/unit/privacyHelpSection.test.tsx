// Settings > Data > Privacy: both reporting switches render OFF for a person
// who never chose, say so in words, and actually set the stored preference the
// transports read. The copy must not reintroduce a claim the inventory
// (docs/network-inventory.md) contradicts.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))

import PrivacyHelpSection from '../../src/renderer/src/components/settings/PrivacyHelpSection'
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

beforeEach(() => {
  localStorage.clear()
  ;(window as unknown as { api: unknown }).api = { files: { openExternal: vi.fn() } }
})
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
    for (const host of ['Google', 'OpenStreetMap', 'DuckDuckGo', 'dl.plexiidesk.com', 'Anthropic']) {
      expect(text).toContain(host)
    }
    expect(text).toMatch(/not end to end/)
    // Each of these was in the app before 4.3.34 and was not true.
    expect(text).not.toMatch(/Only items you explicitly share, and your email address/)
    expect(text).not.toMatch(/nothing leaves/i)
    expect(text).not.toMatch(/anonymous/i)
  })
})
