import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  interruptionOwnerOf,
  useInterruptionClear
} from '../../src/renderer/src/lib/useInterruptionClear'

const read = (path: string): string => readFileSync(path, 'utf8')

describe('launch interruption coordination', () => {
  it('defers low-priority prompts until modal activity has cleared', () => {
    const hook = read('src/renderer/src/lib/useInterruptionClear.ts')
    const missed = read('src/renderer/src/components/MissedTriagePrompt.tsx')
    const feature = read('src/renderer/src/components/onboarding/FeatureSpotlightPopup.tsx')
    expect(hook).toContain("'[aria-modal=\"true\"]'")
    expect(hook).toContain('interruptionOwnerOf(element)')
    expect(missed).toContain("useInterruptionClear('missed-triage', 750)")
    expect(missed).toMatch(/aria-modal="true"[\s\S]{0,160}data-interruption-owner="missed-triage"/)
    expect(feature).toContain("useInterruptionClear('feature-spotlight', 750)")
  })

  it('keeps automatic sign-in behind every onboarding module', () => {
    const signIn = read('src/renderer/src/components/LaunchSignInModal.tsx')
    expect(signIn).toContain('onboardingStatus === \'active\' || activeOnboardingModule')
  })
})

describe('a prompt does not detect its own nested modal', () => {
  let host: HTMLDivElement
  let root: Root

  function SelfOwningPrompt(): ReturnType<typeof createElement> {
    const clear = useInterruptionClear('missed-triage', 25)
    return clear
      ? createElement(
          'div',
          { 'data-interruption-owner': 'missed-triage' },
          createElement('div', { 'aria-modal': 'true', role: 'dialog' }, 'Missed blocks')
        )
      : createElement('span', { 'data-testid': 'waiting' })
  }

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
  })

  it('resolves ownership through the modal wrapper', () => {
    const wrapper = document.createElement('div')
    wrapper.dataset.interruptionOwner = 'missed-triage'
    const modal = document.createElement('div')
    modal.setAttribute('aria-modal', 'true')
    wrapper.appendChild(modal)
    expect(interruptionOwnerOf(modal)).toBe('missed-triage')
  })

  it('stays open after the quiet window instead of oscillating', async () => {
    await act(async () => root.render(createElement(SelfOwningPrompt)))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(25)
    })
    expect(host.querySelector('[role="dialog"]')?.textContent).toBe('Missed blocks')

    // The old coordinator saw the inner aria-modal without reading its owner
    // wrapper, hid it here, then re-opened it after another quiet window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(host.querySelector('[role="dialog"]')?.textContent).toBe('Missed blocks')
  })
})
