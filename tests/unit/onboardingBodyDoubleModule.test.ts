import { beforeEach, describe, expect, it } from 'vitest'
import { ONBOARDING_MODULES, featureModules, moduleById } from '../../src/renderer/src/lib/onboarding/registry'
import { useCapabilityStore } from '../../src/renderer/src/stores/capabilities'

describe('body-double onboarding module', () => {
  beforeEach(() => {
    useCapabilityStore.setState({ capabilities: {} })
  })

  it('is registered as a replayable feature tour', () => {
    const mod = moduleById('body-double')
    expect(mod).toBeDefined()
    expect(mod!.trigger).toBe('feature')
    expect(mod!.kind).toBe('steps')
    expect(mod!.capability).toBe('body_double')
    expect(mod!.steps.length).toBeGreaterThanOrEqual(3)
  })

  it('names all four modes so the tour explains the choice, not just the feature', () => {
    const text = moduleById('body-double')!
      .steps.map((s) => `${s.title} ${s.body}`)
      .join(' ')
      .toLowerCase()
    for (const phrase of ['silent', 'intros only', 'a little chat', 'happy to talk']) {
      expect(text, `tour should mention "${phrase}"`).toContain(phrase)
    }
  })

  it('lands the user on the real preference and the real start button', () => {
    const spots = moduleById('body-double')!.steps.map((s) => s.spotlight).filter(Boolean)
    expect(spots).toContain('settings-body-double')
    expect(spots).toContain('header-body-double')
  })

  it('is hidden when the edition lacks the capability', () => {
    expect(featureModules().map((m) => m.id)).not.toContain('body-double')
  })

  it('is offered when the capability is on', () => {
    useCapabilityStore.setState({ capabilities: { body_double: true } })
    expect(featureModules().map((m) => m.id)).toContain('body-double')
  })

  it('leaves ungated tours alone either way', () => {
    const ungated = ONBOARDING_MODULES.filter(
      (m) => m.trigger === 'feature' && m.capability === undefined
    ).map((m) => m.id)
    expect(ungated.length).toBeGreaterThan(0)
    const offered = featureModules().map((m) => m.id)
    for (const id of ungated) expect(offered).toContain(id)
  })
})
