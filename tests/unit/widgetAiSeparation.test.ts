import { describe, it, expect } from 'vitest'
import { planWidgetAi, KINDS_WITH_WIDGET_AI } from '../../src/renderer/src/lib/widgetAi'
import { SETUP_SUPPORTED_KINDS } from '../../src/renderer/src/lib/widgetSetup'
import type { Widget } from '../../src/shared/types'

// "I think you should separate the ai assistant from the widget setup and
// control ai. They serve different purposes, and the widget ai context should
// be unique to its requirements and use."
//
// The header AI button shipped falling through to the CONVERSATIONAL assistant
// whenever a widget had no AI of its own. That is the conflation: the assistant
// is a correspondent about the workspace, widget AI sets up and controls one
// widget in that widget's own vocabulary, and a generic `update-widget` action
// (title, content string, geometry) cannot speak a chart's or a mail rule's
// language at all.

const w = (kind: string, content = ''): Widget =>
  ({
    id: 'w1',
    taskId: 't1',
    kind,
    title: '',
    content,
    x: 0,
    y: 0,
    width: 200,
    height: 200
  }) as unknown as Widget

describe('a widget with its own AI uses it', () => {
  it('routes to the widget, not the assistant', () => {
    const plan = planWidgetAi(w('table'), true)
    expect(plan.surface).toBe('own')
  })

  it('describes what that AI does in the widget’s own terms', () => {
    // "Set up this widget" tells someone nothing about what they will get.
    expect(planWidgetAi(w('table'), true).purpose).toMatch(/columns/i)
  })

  it('never claims an AI the widget did not wire up', () => {
    // The registry cannot know whether a handler exists; the caller tells it.
    // A kind listed with its own AI but passing no handler must NOT report 'own'.
    expect(planWidgetAi(w('table'), false).surface).not.toBe('own')
  })
})

describe('the shared setup assistant covers the kinds it covers', () => {
  it('reaches every kind SETUP_SUPPORTED_KINDS lists', () => {
    for (const kind of SETUP_SUPPORTED_KINDS) {
      expect(planWidgetAi(w(kind), false).surface, kind).toBe('setup')
    }
  })

  it('the verb follows the kind\u2019s family, and changes with state', () => {
    // "Set up" is wrong for a widget that already has content, and it is also
    // vague: a sticky gets written, a browser gets found, a rule gets
    // described. The verb comes from the family so the button says which.
    expect(planWidgetAi(w('sticky', ''), false).label).toMatch(/write/i)
    expect(planWidgetAi(w('sticky', 'already written'), false).label).toMatch(/rewrite/i)
    expect(planWidgetAi(w('webview', ''), false).label).toMatch(/find/i)
    expect(planWidgetAi(w('inbox', ''), false).label).toMatch(/describe/i)
  })

  it('still routes to setup once a widget has content', () => {
    // The old affordance only appeared on EMPTY widgets, which is why a
    // non-empty sticky had no AI at all.
    expect(planWidgetAi(w('sticky', 'already written'), false).surface).toBe('setup')
  })

  it('phrases each kind differently, because they produce different things', () => {
    const mindmap = planWidgetAi(w('mindmap'), false).purpose
    const browser = planWidgetAi(w('webview'), false).purpose
    expect(mindmap).not.toBe(browser)
    expect(mindmap).toMatch(/nodes|branches/i)
    expect(browser).toMatch(/site|open/i)
  })
})

describe('a kind with no widget AI admits it', () => {
  const plan = planWidgetAi(w('calculator'), false)

  it('reports none rather than silently becoming the assistant', () => {
    expect(plan.surface).toBe('none')
  })

  it('names what it WOULD do, and that it is not wired yet', () => {
    // Every catalogue kind is registered, so an unwired kind is unfinished work
    // rather than an oversight — and saying which is more use than a generic
    // "no AI here".
    expect(plan.purpose).toMatch(/not wired up yet/i)
    expect(plan.purpose).toMatch(/working out/i)
  })
})

describe('coverage is stated honestly', () => {
  it('lists exactly the kinds that have a widget AI', () => {
    // Nine today: the table's own, plus the eight the setup assistant reaches.
    expect(KINDS_WITH_WIDGET_AI).toContain('table')
    for (const kind of SETUP_SUPPORTED_KINDS) expect(KINDS_WITH_WIDGET_AI).toContain(kind)
    expect(KINDS_WITH_WIDGET_AI.length).toBe(SETUP_SUPPORTED_KINDS.size + 1)
  })

  it('serves chart now that its expert is wired and validated', () => {
    // chart was unserved when this file was written. It has a real expert now:
    // it is handed the workspace's actual tables and columns, and its answer is
    // checked against them before anything is written (validateChartConfig).
    expect(KINDS_WITH_WIDGET_AI).toContain('chart')
  })

  it('still does not claim a kind it cannot serve', () => {
    // A calculator has no configuration, and the config family's remaining
    // kinds have no applier yet. Both must stay out of this list rather than
    // routing the button to an expert that refuses.
    for (const kind of ['calculator', 'color', 'metrics', 'task-list']) {
      expect(KINDS_WITH_WIDGET_AI, kind).not.toContain(kind)
    }
  })
})
