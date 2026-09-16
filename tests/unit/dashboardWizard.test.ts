import { describe, expect, it } from 'vitest'
import {
  WIZARD_QUESTIONS,
  EMPTY_ANSWERS,
  placeableFor,
  planDashboard,
  planToInstances,
  hasEnoughToRecommend,
  refineWithPlan,
  describeAnswers,
  catalogueFor,
  type WizardAnswers
} from '../../src/renderer/src/components/views/dashboardWizard'
import {
  DASHBOARD_SURFACES,
  HOME_WIDGET_DEFS,
  widgetDef,
  type DashboardSurface
} from '../../src/renderer/src/components/views/homeWidgetDefs'

const a = (choices: Record<string, string[]>, other: Record<string, string> = {}): WizardAnswers => ({
  choices,
  other
})

const everything: WizardAnswers = a(
  Object.fromEntries(WIZARD_QUESTIONS.map((q) => [q.id, q.options.map((o) => o.id)])),
  { role: 'deadlines focus writing metrics team meetings ideas recording' }
)

describe('the questions', () => {
  it('can each be answered by clicking', () => {
    for (const q of WIZARD_QUESTIONS) expect(q.options.length).toBeGreaterThanOrEqual(4)
  })

  it('always leaves a way out of the list', () => {
    // The person whose work is not on the list is the one whose dashboard is
    // most likely to be wrong, so free text is never optional.
    for (const q of WIZARD_QUESTIONS) expect(q.otherPlaceholder.trim()).not.toBe('')
  })

  it('uses unique ids, per question and within each question', () => {
    const qIds = WIZARD_QUESTIONS.map((q) => q.id)
    expect(new Set(qIds).size).toBe(qIds.length)
    for (const q of WIZARD_QUESTIONS) {
      const ids = q.options.map((o) => o.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })
})

describe('what the wizard is allowed to place', () => {
  it('offers nothing retired', () => {
    for (const s of DASHBOARD_SURFACES) {
      for (const d of placeableFor(s)) expect(d.retired).toBeFalsy()
    }
  })

  it('offers nothing that needs a picker first', () => {
    // A pinned desk with no desk chosen is a broken tile on a brand-new
    // dashboard, which is the exact opposite of what the wizard is for.
    for (const s of DASHBOARD_SURFACES) {
      for (const d of placeableFor(s)) expect(d.config).toBeUndefined()
    }
  })

  it('respects which dashboard a widget belongs to', () => {
    // Team status is a People widget; it must not turn up on Office.
    expect(placeableFor('people').map((d) => d.id)).toContain('people-home')
    for (const s of ['home', 'office', 'brain'] as DashboardSurface[]) {
      expect(placeableFor(s).map((d) => d.id)).not.toContain('people-home')
    }
  })

  it('draws from the live registry rather than a copied list', () => {
    // If someone adds a widget to HOME_WIDGET_DEFS, the wizard should already
    // know about it — that is the whole reason this is derived, not listed.
    const offered = new Set(placeableFor('home').map((d) => d.id))
    const expected = HOME_WIDGET_DEFS.filter(
      (d) => !d.retired && !d.config && (!d.surfaces || d.surfaces.includes('home'))
    )
    expect(offered.size).toBe(expected.length)
  })
})

describe('planDashboard', () => {
  it('gives an untouched wizard a real dashboard rather than an empty one', () => {
    const plan = planDashboard(EMPTY_ANSWERS)
    expect(plan.widgets.length).toBeGreaterThan(0)
    expect(plan.widgets.map((w) => w.widget)).toContain('standup')
  })

  it('never plans a widget that is not placeable on that surface', () => {
    for (const s of DASHBOARD_SURFACES) {
      const allowed = new Set(placeableFor(s).map((d) => d.id))
      for (const w of planDashboard(everything, s).widgets) expect(allowed).toContain(w.widget)
    }
  })

  it('never plans a widget twice', () => {
    for (const s of DASHBOARD_SURFACES) {
      const ids = planDashboard(everything, s).widgets.map((w) => w.widget)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('only ever plans a size the widget actually supports', () => {
    // Sizes are geometry: a widget rendered at a span its content cannot fill
    // leaves a hole in the grid.
    for (const s of DASHBOARD_SURFACES) {
      for (const w of planDashboard(everything, s).widgets) {
        expect(widgetDef(w.widget).sizes).toContain(w.size)
      }
    }
  })

  it('leads with the story of the day for someone who starts with one', () => {
    expect(planDashboard(a({ rhythm: ['brief'] })).widgets[0].widget).toBe('standup')
  })

  it('leads with the one thing for someone who starts on one thing', () => {
    const plan = planDashboard(a({ rhythm: ['focus'], pressure: ['interrupted'] }))
    expect(plan.widgets[0].widget).toBe('one-thing')
    expect(plan.widgets.map((w) => w.widget)).toContain('focus-timer')
  })

  it('compounds agreeing answers instead of letting them compete', () => {
    // Two answers pointing at Attention should make it more certain, not fight
    // over one slot.
    const one = planDashboard(a({ rhythm: ['list'] }))
    const both = planDashboard(a({ rhythm: ['list'], pressure: ['dropped'], role: ['ops'] }))
    expect(one.widgets[0].widget).toBe('attention')
    expect(both.widgets[0].widget).toBe('attention')
    // And the agreement pulls the adjacent widget in too.
    expect(both.widgets.map((w) => w.widget)).toContain('overdue')
  })

  it('gives the headline the biggest size it supports', () => {
    const plan = planDashboard(a({ rhythm: ['brief'], role: ['delivery'] }))
    const head = plan.widgets[0]
    expect(head.size).toBe(widgetDef(head.widget).sizes[widgetDef(head.widget).sizes.length - 1])
  })

  it('reads free text when nothing was clicked', () => {
    const plan = planDashboard(a({}, { role: 'I chase overdue deadlines for clients all week' }))
    expect(plan.widgets.map((w) => w.widget)).toContain('overdue')
  })

  it('does not let free text outweigh a click', () => {
    // Free text nudges; a click decides.
    const plan = planDashboard(a({ rhythm: ['brief'] }, { watch: 'numbers metrics kpi revenue' }))
    expect(plan.widgets[0].widget).toBe('standup')
  })

  it('changes nothing for a sentence it does not recognise', () => {
    const plain = planDashboard(a({ rhythm: ['list'] }))
    const noisy = planDashboard(a({ rhythm: ['list'] }, { role: 'zxqv wobble frim' }))
    expect(noisy.widgets).toEqual(plain.widgets)
  })

  it('treats "keep it clean" as an answer, not an absence of one', () => {
    // Someone who asked for no shortcut buttons should not get them because
    // another answer argued for one.
    const plan = planDashboard(a({ role: ['client'], shortcuts: ['none'] }))
    expect(plan.widgets.map((w) => w.widget)).not.toContain('new-meeting')
    expect(plan.widgets.map((w) => w.widget)).not.toContain('new-desk')
  })

  it('places the shortcut buttons that were asked for', () => {
    const plan = planDashboard(a({ shortcuts: ['newdesk', 'meet', 'record'] }))
    const ids = plan.widgets.map((w) => w.widget)
    expect(ids).toContain('new-desk')
    expect(ids).toContain('new-meeting')
    expect(ids).toContain('transcribe')
  })

  it('keeps a dashboard readable at a glance', () => {
    for (const s of DASHBOARD_SURFACES) {
      const plan = planDashboard(everything, s)
      const main = plan.widgets.filter((w) => widgetDef(w.widget).defaultCol === 'main')
      const rail = plan.widgets.filter((w) => widgetDef(w.widget).defaultCol === 'rail')
      expect(main.length).toBeLessThanOrEqual(3)
      expect(rail.length).toBeLessThanOrEqual(5)
    }
  })

  it('never lets a strong rail answer starve the headline', () => {
    // Four shortcut buttons are all rail widgets; the main column must still
    // get filled.
    const plan = planDashboard(a({ shortcuts: ['newdesk', 'meet', 'record', 'apps'] }))
    expect(plan.widgets.some((w) => widgetDef(w.widget).defaultCol === 'main')).toBe(true)
  })

  it('puts the main column before the rail', () => {
    const plan = planDashboard(everything)
    const cols = plan.widgets.map((w) => widgetDef(w.widget).defaultCol)
    expect(cols.indexOf('rail') === -1 || cols.lastIndexOf('main') < cols.indexOf('rail')).toBe(true)
  })

  it('gives every planned widget a reason', () => {
    for (const s of DASHBOARD_SURFACES) {
      for (const w of planDashboard(a({ role: ['leading'], pressure: ['unclear'] }), s).widgets) {
        expect(w.reason).not.toBe('')
      }
    }
  })

  it('tilts towards each dashboard without asking different questions', () => {
    const ans = a({ rhythm: ['list'] })
    expect(planDashboard(ans, 'people').widgets.map((w) => w.widget)).toContain('people-home')
    expect(planDashboard(ans, 'office').widgets.map((w) => w.widget)).toContain('continue')
    expect(planDashboard(ans, 'brain').widgets.map((w) => w.widget)).toContain('discover')
    // Their own answer still leads, whichever dashboard they are on.
    for (const s of DASHBOARD_SURFACES) {
      expect(planDashboard(ans, s).widgets[0].widget).toBe('attention')
    }
  })

  it('is deterministic', () => {
    const ans = a({ role: ['client', 'making'], pressure: ['scattered'] }, { watch: 'revenue' })
    expect(planDashboard(ans)).toEqual(planDashboard(ans))
  })
})

describe('planToInstances', () => {
  it('produces rows the dashboard will load back', () => {
    // loadFlat drops anything whose widget id it does not know, whose size is
    // not a real size, or whose key repeats — so a plan that survives none of
    // that would silently fall back to stock.
    const known = new Set(HOME_WIDGET_DEFS.map((d) => d.id))
    const rows = planToInstances(planDashboard(everything))
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(known).toContain(r.widget)
      expect(['icon', 'sm', 'md', 'lg', 'stack']).toContain(r.size)
      expect(typeof r.key).toBe('string')
    }
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
  })
})

describe('refineWithPlan', () => {
  const base = planDashboard(a({ rhythm: ['list'], role: ['delivery'] }))

  it('lets the model reorder', () => {
    const out = refineWithPlan(base, [
      { widget: 'pulse' },
      { widget: 'attention' },
      { widget: 'overdue' }
    ])
    // Main-column widgets still lead, but within the rail the model's order holds.
    expect(out.widgets.map((w) => w.widget)).toEqual(['attention', 'pulse', 'overdue'])
  })

  it('drops a widget it invented', () => {
    const out = refineWithPlan(base, [{ widget: 'attention' }, { widget: 'sales-pipeline' }])
    expect(out.widgets.map((w) => w.widget)).toEqual(['attention'])
  })

  it('drops a widget that is real but not offered on this surface', () => {
    const office = planDashboard(a({ rhythm: ['brief'] }), 'office')
    const out = refineWithPlan(office, [{ widget: 'standup' }, { widget: 'people-home' }])
    expect(out.widgets.map((w) => w.widget)).not.toContain('people-home')
  })

  it('drops a widget that needs a picker', () => {
    const out = refineWithPlan(base, [{ widget: 'attention' }, { widget: 'pinned-desk' }])
    expect(out.widgets.map((w) => w.widget)).not.toContain('pinned-desk')
  })

  it('clamps a size the widget does not support', () => {
    const out = refineWithPlan(base, [{ widget: 'pulse', size: 'stack' }])
    expect(widgetDef('pulse').sizes).toContain(out.widgets[0].size)
  })

  it('ignores a size that is not a size at all', () => {
    const out = refineWithPlan(base, [{ widget: 'attention', size: 'enormous' }])
    expect(widgetDef('attention').sizes).toContain(out.widgets[0].size)
  })

  it('drops a repeat instead of placing it twice', () => {
    const out = refineWithPlan(base, [{ widget: 'attention' }, { widget: 'attention' }])
    expect(out.widgets.map((w) => w.widget)).toEqual(['attention'])
  })

  it('keeps the working plan when the model says nothing usable', () => {
    // The worst a bad model call can do is nothing.
    for (const bad of [null, undefined, [], [{ widget: 'nope' }], [{ widget: '' }]]) {
      expect(refineWithPlan(base, bad as never)).toEqual(base)
    }
  })

  it('keeps the honest reason when the model offers none', () => {
    const out = refineWithPlan(base, [{ widget: 'attention' }])
    expect(out.widgets[0].reason).toBe(base.widgets.find((w) => w.widget === 'attention')?.reason)
    expect(out.widgets[0].reason).not.toBe('')
  })

  it('still respects the column limits when the model over-fills', () => {
    const greedy = HOME_WIDGET_DEFS.filter((d) => !d.retired && !d.config).map((d) => ({ widget: d.id }))
    const out = refineWithPlan(base, greedy)
    const main = out.widgets.filter((w) => widgetDef(w.widget).defaultCol === 'main')
    const rail = out.widgets.filter((w) => widgetDef(w.widget).defaultCol === 'rail')
    expect(main.length).toBeLessThanOrEqual(3)
    expect(rail.length).toBeLessThanOrEqual(5)
  })
})

describe('hasEnoughToRecommend', () => {
  it('is false before anything is said', () => {
    expect(hasEnoughToRecommend(EMPTY_ANSWERS)).toBe(false)
    expect(hasEnoughToRecommend(a({ role: [] }, { role: '   ' }))).toBe(false)
  })

  it('is true after a click, or after free text alone', () => {
    expect(hasEnoughToRecommend(a({ role: ['ops'] }))).toBe(true)
    expect(hasEnoughToRecommend(a({}, { role: 'support engineer' }))).toBe(true)
  })
})

describe('describeAnswers', () => {
  it('quotes free text rather than paraphrasing it away', () => {
    // The sentence someone bothered to type is the most specific thing known
    // about them; summarising it is how a wizard ends up generic.
    const out = describeAnswers(a({}, { role: 'I run a two-person legal practice' }))
    expect(out).toContain('"I run a two-person legal practice"')
  })

  it('names the labels a person clicked, not the ids', () => {
    const out = describeAnswers(a({ role: ['leading'] }))
    expect(out).toContain('Leading a team')
    expect(out).not.toContain('leading')
  })

  it('says plainly when nothing was answered', () => {
    expect(describeAnswers(EMPTY_ANSWERS)).toContain('skipped')
  })

  it('leaves out questions that were not answered', () => {
    const out = describeAnswers(a({ rhythm: ['brief'] }))
    expect(out.split('\n')).toHaveLength(1)
  })

  it('ignores an option id that is not on the question', () => {
    expect(describeAnswers(a({ role: ['not-an-option'] }))).toContain('skipped')
  })
})

describe('catalogueFor', () => {
  it('describes exactly the widgets the wizard may place', () => {
    for (const s of DASHBOARD_SURFACES) {
      const cat = catalogueFor(s)
      expect(cat.map((c) => c.id).sort()).toEqual(placeableFor(s).map((d) => d.id).sort())
      for (const c of cat) {
        expect(c.sizes.length).toBeGreaterThan(0)
        expect(['main', 'rail']).toContain(c.column)
        expect(c.name).not.toBe('')
      }
    }
  })

  it('never offers the model a widget it would then have to reject', () => {
    // The catalogue sent to the model and the set refineWithPlan accepts are the
    // same set, so a well-behaved model can never have its answer thrown away.
    for (const s of DASHBOARD_SURFACES) {
      const asked = catalogueFor(s).map((c) => ({ widget: c.id }))
      const out = refineWithPlan(planDashboard(everything, s), asked)
      expect(out.widgets.length).toBeGreaterThan(0)
      for (const w of out.widgets) expect(asked.map((x) => x.widget)).toContain(w.widget)
    }
  })
})
