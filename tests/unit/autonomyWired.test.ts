import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canActAutonomously, resolveAutonomy } from '../../src/renderer/src/lib/autonomyPolicy'

// "Settings › AI › Assistant autonomy: stored and shown, but nothing acts on
// it."
//
// Three correct, fully tested pieces that had never been introduced:
//
//   autonomyPolicy.canActAutonomously(level, risk)  — the gate
//   actionExecutor.isAutoApplyable(p)               — the risk classifier
//   stores/autonomy.resolveFor()                    — the resolved level
//
// The agent loop instead hardcoded `isGated: (p) => !isAutoApplyable(p)` — the
// 'auto' policy written out by hand. An operator who chose "Suggest only" still
// had a loop applying low-risk actions, and one who chose "Ask before acting"
// was never asked. The policy resolved, displayed its source and its org
// ceiling, and governed nothing.

const ROOT = join(__dirname, '..', '..', 'src')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const runner = read('renderer/src/lib/agentRunner.ts')
const cards = read('renderer/src/components/ProposalCards.tsx')
const gate = read('renderer/src/lib/autonomyGate.ts')

describe('the agent loop obeys the resolved policy', () => {
  it('no longer hardcodes the auto policy', () => {
    expect(runner).not.toContain('isGated: (p) => !isAutoApplyable(p)')
  })

  it('asks the gate instead', () => {
    expect(runner).toContain('isGated: (p) => !mayApplyWithoutAsking(autonomy.level, p)')
  })

  it('resolves the level once per run, having loaded it first', () => {
    // Per-proposal resolution would let a setting changed mid-run apply to half
    // of it; and an unloaded store reports the built-in default, which would
    // silently demote someone who had chosen 'auto'.
    expect(runner).toContain('const autonomy = await ensureAutonomy()')
  })
})

describe('the gate derives risk from the existing classifier', () => {
  it('does not keep a second list of consequential kinds', () => {
    // actionExecutor's GATED_KINDS is documented as the source of truth. A
    // parallel list would drift the first time a kind was added.
    expect(gate).toContain('isAutoApplyable(p)')
    expect(gate).not.toContain('delete-widget')
    expect(gate).not.toContain('schedule-event')
  })

  it('treats an unresolved policy as "not yet known", never as permission', () => {
    expect(gate).toContain('await store.load()')
  })
})

describe('the proposal cards respect the level', () => {
  it('offers no one-click apply at manual', () => {
    expect(cards).toContain('offersOneClickApply(autonomy.level)')
    expect(cards).toContain('{pendingCount > 1 && oneClick && (')
  })

  it('explains itself rather than going quiet when it will not act', () => {
    // A control that looks live and does nothing is the class of bug being
    // fixed here, so manual mode says why.
    expect(cards).toContain('manualModeNote(autonomy)')
    expect(cards).toContain('data-testid="proposal-manual-note"')
  })

  it('does not act on a policy that has not loaded', () => {
    expect(cards).toContain('if (!autonomy) return')
  })

  it('applies low-risk work itself at auto, and says that it did', () => {
    expect(cards).toContain("autonomy.level !== 'auto'")
    expect(cards).toContain('mayApplyWithoutAsking(autonomy.level, p)')
    expect(cards).toContain('data-testid="proposal-auto-note"')
  })

  it('never auto-applies the same proposal twice', () => {
    expect(cards).toContain('autoAppliedRef.current.has(p.id)')
    expect(cards).toContain('autoAppliedRef.current.add(next.id)')
  })

  it('leaves a placement question to a person', () => {
    // Being asked WHERE is a decision; picking a desk silently is not low-risk.
    expect(cards).toContain('if (!target && isDeskCapable(p.kind)) return false')
  })
})

describe('what each level now means in practice', () => {
  const low = 'low' as const
  const high = 'high' as const

  it('manual acts on nothing', () => {
    expect(canActAutonomously('manual', low)).toBe(false)
    expect(canActAutonomously('manual', high)).toBe(false)
  })

  it('ask acts on nothing without a confirmation', () => {
    expect(canActAutonomously('ask', low)).toBe(false)
    expect(canActAutonomously('ask', high)).toBe(false)
  })

  it('auto acts on low risk and still asks for the rest', () => {
    expect(canActAutonomously('auto', low)).toBe(true)
    expect(canActAutonomously('auto', high)).toBe(false)
  })

  it('the old hardcoded behaviour is exactly the auto level', () => {
    // Which is why the bug was invisible to anyone who wanted 'auto': the fix
    // must not change what they already had.
    for (const risk of [low, high]) {
      const hardcoded = risk === low
      expect(canActAutonomously('auto', risk)).toBe(hardcoded)
    }
  })

  it('an org ceiling of ask overrides a user who asked for auto', () => {
    const r = resolveAutonomy({ orgCeiling: 'ask', systemChoice: 'auto' })
    expect(r.level).toBe('ask')
    expect(r.cappedByOrg).toBe(true)
    expect(canActAutonomously(r.level, 'low')).toBe(false)
  })

  it('with no policy set at all it defaults to asking', () => {
    const r = resolveAutonomy({})
    expect(r.level).toBe('ask')
    expect(r.source).toBe('system-default')
    expect(canActAutonomously(r.level, 'low')).toBe(false)
  })
})
