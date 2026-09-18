import { describe, expect, it } from 'vitest'
import { QUICK_TASKS, quickTaskById } from '../../src/renderer/src/lib/browserQuickTasks'

// The presets are prompts, and a prompt that reads fine can still produce a
// useless run. These lock the properties that separate a preset that works from
// a label that looks like one.
describe('browser quick tasks', () => {
  it('has unique ids', () => {
    expect(new Set(QUICK_TASKS.map((q) => q.id)).size).toBe(QUICK_TASKS.length)
  })

  it('gives the agent an instruction, not a keyword', () => {
    // "Summarise" alone yields a run that reads one screenful and stops.
    for (const q of QUICK_TASKS) {
      expect(q.task.length, `${q.id} is too terse to steer a run`).toBeGreaterThan(80)
      expect(q.task).not.toBe(q.label)
    }
  })

  it('tells every run what to record', () => {
    // The findings ARE the yield — a run that reads well and records nothing
    // delivers nothing downstream.
    for (const q of QUICK_TASKS) {
      expect(q.task.toLowerCase(), `${q.id} never says what to record`).toContain('record')
    }
  })

  it('names the collect action where collecting is the point', () => {
    // These two exist because the element list cannot show images at all and
    // shows only actionable links; without naming the action they degrade into
    // "read the page and guess".
    expect(quickTaskById('links')?.task).toContain('what="links"')
    expect(quickTaskById('images')?.task).toContain('what="images"')
  })

  it('warns against inventing what the page does not say', () => {
    // The two presets that tabulate are the ones where a plausible-looking
    // fabrication would be hardest to spot afterwards.
    for (const id of ['extract', 'images']) {
      expect(quickTaskById(id)?.task.toLowerCase()).toMatch(/do not invent|inventing/)
    }
  })

  it('returns null for an unknown id rather than a default', () => {
    expect(quickTaskById('nope')).toBeNull()
  })
})
