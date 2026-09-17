// The wizard exists because a custom widget is generated in ONE shot from a
// sentence, and a sentence leaves out exactly the things that decide whether the
// result is right — whether it remembers what you type, what it should work out,
// how much room it has. Those omissions do not surface as questions; they
// surface as a widget that looks plausible and is not what you asked for.
import { describe, it, expect } from 'vitest'
import {
  WIDGET_WIZARD_QUESTIONS,
  EMPTY_WIDGET_ANSWERS,
  composeSpec,
  composeEditSpec,
  describeAnswers,
  answersSaySomething,
  type WidgetWizardAnswers
} from '../../src/shared/customWidgetWizard'

const a = (
  choices: Record<string, string[]>,
  other: Record<string, string> = {}
): WidgetWizardAnswers => ({ choices, other })

describe('the questions', () => {
  it('can each be answered by clicking', () => {
    for (const q of WIDGET_WIZARD_QUESTIONS) expect(q.options.length).toBeGreaterThanOrEqual(2)
  })

  it('always leaves a way out of the list', () => {
    for (const q of WIDGET_WIZARD_QUESTIONS) expect(q.otherPlaceholder.trim()).not.toBe('')
  })

  it('uses unique ids, per question and within each question', () => {
    const ids = WIDGET_WIZARD_QUESTIONS.map((q) => q.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const q of WIDGET_WIZARD_QUESTIONS) {
      const o = q.options.map((x) => x.id)
      expect(new Set(o).size).toBe(o.length)
    }
  })

  it('asks about memory, which is the usual reason one disappoints', () => {
    expect(WIDGET_WIZARD_QUESTIONS.map((q) => q.id)).toContain('memory')
  })
})

describe('composeSpec', () => {
  it('states what was chosen as instructions, not as description', () => {
    const spec = composeSpec(
      a({ kind: ['tracker'], holds: ['items', 'numbers'], does: ['total'], look: ['list'] })
    )
    expect(spec).toContain('WHAT IT IS: a tracker.')
    expect(spec).toContain('IT KEEPS:')
    expect(spec).toContain('a list of items')
    expect(spec).toContain('IT WORKS OUT:')
    expect(spec).toContain('AT A GLANCE IT READS AS: a compact list.')
  })

  it('turns "remember" into the actual sandbox calls', () => {
    // "It should remember" means nothing to a generator unless it is told HOW.
    const spec = composeSpec(a({ memory: ['remember'] }))
    expect(spec).toContain('plexi.setState()')
    expect(spec).toContain('plexi.getState()')
  })

  it('says plainly when it must NOT persist', () => {
    const spec = composeSpec(a({ memory: ['fresh'] }))
    expect(spec).toContain('starts fresh')
    expect(spec).not.toContain('plexi.setState()')
  })

  it('always forbids inventing sample data', () => {
    // A generated widget that ships with invented rows looks finished and is
    // lying about having data. This clause is not optional on any path.
    for (const answers of [EMPTY_WIDGET_ANSWERS, a({ kind: ['log'] }), a({}, { kind: 'anything' })]) {
      const spec = composeSpec(answers)
      expect(spec).toContain('START EMPTY')
      expect(spec).toContain('HONESTY')
    }
  })

  it('tells the generator the real size it has to fit', () => {
    const spec = composeSpec(a({ kind: ['tracker'] }), { width: 400, height: 440 })
    expect(spec).toContain('400×440')
    expect(spec).toContain('Scroll inside the widget')
  })

  it('states the network boundary either way', () => {
    expect(composeSpec(EMPTY_WIDGET_ANSWERS, { net: false })).toContain('NOT available')
    expect(composeSpec(EMPTY_WIDGET_ANSWERS, { net: true })).toContain('NETWORK: allowed')
  })

  it('carries free text through when the person wrote instead of clicking', () => {
    const spec = composeSpec(a({}, { kind: 'a burndown for a two-week sprint' }))
    expect(spec).toContain('a burndown for a two-week sprint')
  })

  it('does not repeat free text that is already the answer', () => {
    const spec = composeSpec(a({}, { kind: 'a burndown chart' }))
    const hits = spec.split('a burndown chart').length - 1
    expect(hits).toBe(1)
  })

  it('keeps free text alongside a clicked option', () => {
    const spec = composeSpec(a({ kind: ['tracker'] }, { kind: 'per client, not per project' }))
    expect(spec).toContain('WHAT IT IS: a tracker.')
    expect(spec).toContain('per client, not per project')
  })

  it('reads "nothing" as a real answer, not an absent one', () => {
    const held = composeSpec(a({ holds: ['nothing'] }))
    expect(held).toContain('IT KEEPS: nothing')
    const does = composeSpec(a({ does: ['nothing'] }))
    expect(does).toContain('IT WORKS OUT: nothing')
  })

  it('is deterministic', () => {
    const ans = a({ kind: ['calculator'], does: ['total'] }, { look: 'big numbers' })
    expect(composeSpec(ans)).toBe(composeSpec(ans))
  })

  it('still produces a usable brief when nothing was answered', () => {
    const spec = composeSpec(EMPTY_WIDGET_ANSWERS)
    expect(spec.length).toBeGreaterThan(0)
    expect(spec).toContain('START EMPTY')
  })
})

describe('composeEditSpec', () => {
  const before = a({ kind: ['tracker'], look: ['list'], memory: ['fresh'] })

  it('states the change as a diff rather than a re-guess', () => {
    // Refining used to be free text with no reference to what the widget already
    // is, so the model had to infer the "before" from its own code.
    const after = a({ kind: ['tracker'], look: ['chart'], memory: ['remember'] })
    const spec = composeEditSpec(before, after)
    expect(spec).toContain('CHANGE THE EXISTING WIDGET')
    expect(spec).toContain('A compact list')
    expect(spec).toContain('A chart')
    expect(spec).toContain('No — start fresh each time')
    expect(spec).toContain('Yes — keep it between sessions')
  })

  it('names only what actually changed', () => {
    const after = a({ kind: ['tracker'], look: ['chart'], memory: ['fresh'] })
    const spec = composeEditSpec(before, after)
    const changeBlock = spec.slice(0, spec.indexOf('WHAT IT IS'))
    expect(changeBlock).toContain('read at a glance')
    expect(changeBlock).not.toContain('What kind of tool')
  })

  it('protects what the user already entered', () => {
    const after = a({ kind: ['log'], look: ['list'], memory: ['fresh'] })
    expect(composeEditSpec(before, after)).toContain('already entered')
  })

  it('falls back to a rebuild when nothing changed', () => {
    const spec = composeEditSpec(before, before)
    expect(spec).toContain('REBUILD THE EXISTING WIDGET')
    expect(spec).toContain('already entered')
  })

  it('carries the full brief, not only the diff', () => {
    const after = a({ kind: ['tracker'], look: ['chart'], memory: ['remember'] })
    const spec = composeEditSpec(after, after, { width: 400, height: 300 })
    expect(spec).toContain('START EMPTY')
    expect(spec).toContain('400×300')
  })
})

describe('describeAnswers', () => {
  it('summarises what was chosen in the person’s own labels', () => {
    const out = describeAnswers(a({ kind: ['tracker'], look: ['list'] }))
    expect(out).toContain('A tracker')
    expect(out).toContain('A compact list')
  })

  it('quotes free text', () => {
    expect(describeAnswers(a({}, { kind: 'a sprint burndown' }))).toContain('“a sprint burndown”')
  })

  it('is empty when nothing was said', () => {
    expect(describeAnswers(EMPTY_WIDGET_ANSWERS)).toBe('')
  })
})

describe('answersSaySomething', () => {
  it('is false before anything is chosen', () => {
    expect(answersSaySomething(EMPTY_WIDGET_ANSWERS)).toBe(false)
    expect(answersSaySomething(a({ kind: [] }, { kind: '   ' }))).toBe(false)
  })

  it('is true after a click, or after free text alone', () => {
    expect(answersSaySomething(a({ kind: ['tracker'] }))).toBe(true)
    expect(answersSaySomething(a({}, { kind: 'something' }))).toBe(true)
  })
})

describe('reading wired and mentioned sources', () => {
  it('turns "read a table" into the actual API, not a wish', () => {
    // "It should read the table" tells a generator nothing it can write code
    // against. The column-id detail is the one that decides whether the widget
    // computes or scrapes.
    const spec = composeSpec(a({ reads: ['table'] }))
    expect(spec).toContain('plexi.getInputs()')
    expect(spec).toContain('plexi.onInput')
    expect(spec).toContain('COLUMN ID')
  })

  it('always says the list starts empty', () => {
    // A widget that invents rows before a wire is drawn looks finished and is
    // lying about having data.
    expect(composeSpec(a({ reads: ['table'] }))).toContain('EMPTY until they do one')
  })

  it('states the negative too, so the generator does not reach for inputs', () => {
    expect(composeSpec(a({ reads: ['none'] }))).toContain('nothing wired in')
  })

  it('says nothing about reading when the question was skipped', () => {
    expect(composeSpec(a({ kind: ['tracker'] }))).not.toContain('plexi.getInputs()')
  })
})

describe('acting in the app', () => {
  it('names only the verbs that were chosen', () => {
    const spec = composeSpec(a({ acts: ['rows', 'brain'] }))
    expect(spec).toContain('add-table-row')
    expect(spec).toContain('create-knowledge-entry')
    expect(spec).not.toContain('set-cell')
    expect(spec).not.toContain('open-url')
  })

  it('insists the ids come from the inputs, which is the scope rule', () => {
    const spec = composeSpec(a({ acts: ['cells'] }))
    expect(spec).toContain('MUST come from plexi.getInputs()')
  })

  it('warns that an action can be refused', () => {
    // A widget that assumes success shows the user a row that was never added.
    const spec = composeSpec(a({ acts: ['rows'] }))
    expect(spec).toContain('check the result')
    expect(spec).toContain('declined')
  })

  it('states the default plainly when the answer was no', () => {
    expect(composeSpec(a({ acts: ['none'] }))).toContain('Do not call plexi.act()')
  })

  it('treats "no" plus a verb as the verb, not as silence', () => {
    const spec = composeSpec(a({ acts: ['none', 'rows'] }))
    expect(spec).toContain('add-table-row')
    expect(spec).not.toContain('Do not call plexi.act()')
  })

  it('carries a written instruction alongside the chosen verbs', () => {
    const spec = composeSpec(a({ acts: ['rows'] }, { acts: 'only when the total goes over budget' }))
    expect(spec).toContain('only when the total goes over budget')
  })
})

describe('@ mentions are the second way in', () => {
  it('tells the generator both routes exist and look the same', () => {
    // @ means "bring this thing's content" everywhere else in the app; a widget
    // is not the one surface where it should stop meaning that.
    const spec = composeSpec(a({ reads: ['table'] }))
    expect(spec).toContain('@ mentioned')
    expect(spec).toContain('via:"wire"|"mention"')
  })

  it('offers reaching outside the desk as a choice', () => {
    const q = WIDGET_WIZARD_QUESTIONS.find((x) => x.id === 'reads')!
    expect(q.options.map((o) => o.id)).toContain('mention')
  })
})
