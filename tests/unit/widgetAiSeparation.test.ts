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

  it('says "Set up" when the widget is empty and "Change" when it is not', () => {
    // "Set up" is wrong for a widget that already has content; at that point
    // the honest offer is to change it.
    expect(planWidgetAi(w('sticky', ''), false).label).toMatch(/set up/i)
    expect(planWidgetAi(w('sticky', 'already written'), false).label).toMatch(/change/i)
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

  it('says so, instead of promising something it cannot do', () => {
    expect(plan.purpose).toMatch(/no AI of its own yet/i)
  })
})

describe('coverage is stated honestly', () => {
  it('lists exactly the kinds that have a widget AI', () => {
    // Nine today: the table's own, plus the eight the setup assistant reaches.
    expect(KINDS_WITH_WIDGET_AI).toContain('table')
    for (const kind of SETUP_SUPPORTED_KINDS) expect(KINDS_WITH_WIDGET_AI).toContain(kind)
    expect(KINDS_WITH_WIDGET_AI.length).toBe(SETUP_SUPPORTED_KINDS.size + 1)
  })

  it('does not claim a kind it cannot serve', () => {
    for (const kind of ['calculator', 'chart', 'clock']) {
      expect(KINDS_WITH_WIDGET_AI).not.toContain(kind)
    }
  })
})
