// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (path: string): string => readFileSync(path, 'utf8')

describe('launch interruption coordination', () => {
  it('defers low-priority prompts until modal activity has cleared', () => {
    const hook = read('src/renderer/src/lib/useInterruptionClear.ts')
    const missed = read('src/renderer/src/components/MissedTriagePrompt.tsx')
    const feature = read('src/renderer/src/components/onboarding/FeatureSpotlightPopup.tsx')
    expect(hook).toContain("'[aria-modal=\"true\"]'")
    expect(hook).toContain('dataset.interruptionOwner')
    expect(missed).toContain("useInterruptionClear('missed-triage', 750)")
    expect(feature).toContain("useInterruptionClear('feature-spotlight', 750)")
  })

  it('keeps automatic sign-in behind every onboarding module', () => {
    const signIn = read('src/renderer/src/components/LaunchSignInModal.tsx')
    expect(signIn).toContain('onboardingStatus === \'active\' || activeOnboardingModule')
  })
})
