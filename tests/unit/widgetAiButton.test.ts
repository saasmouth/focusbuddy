// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// "There's still no AI button in a lot of the widgets, like table. It should be
// consistent in the header for all widgets."
//
// It was on two widgets out of forty-odd, and on the table it was in the BODY —
// beside the add-column plus and Add row — which is not where anyone looks for
// it. The fix is that the SHARED frame draws it, so "all widgets" is a
// structural fact rather than a list someone has to keep up to date.
//
// This test exists because the obvious alternative — adding the button to each
// widget — passes a spot check and then rots on the next widget somebody adds.
// Asserting it on the frame is asserting it on every widget at once.
//
// Where it GOES is lib/widgetAi's business, and widgetAiSeparation.test.ts
// covers that: widget AI and the conversational assistant are different things.

const ROOT = join(__dirname, '..', '..', 'src', 'renderer', 'src')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const frame = read('components/widgets/WidgetFrame.tsx')

describe('the AI button lives on the shared widget frame', () => {
  it('is rendered by the frame, so every widget with a header has one', () => {
    expect(frame).toContain('data-testid="widget-ai"')
  })

  it('sits in the header actions row, not the body', () => {
    const actions = frame.slice(
      frame.indexOf('fb-widget-actions'),
      frame.indexOf('fb-widget-actions') + 3200
    )
    expect(actions).toContain('data-testid="widget-ai"')
  })

  it('is FIRST in that row, so its position never shifts between widgets', () => {
    const actions = frame.slice(frame.indexOf('fb-widget-actions'))
    // Rename is the control that used to lead the row.
    expect(actions.indexOf('data-testid="widget-ai"')).toBeLessThan(
      actions.indexOf('aria-label="Rename widget"')
    )
  })

  it('carries an accessible name, since it is an icon-only control', () => {
    // Built from the plan, so it states what this widget's AI actually does
    // rather than a generic label — and names the fallback case explicitly.
    const btn = frame.slice(
      frame.indexOf('data-testid="widget-ai"') - 1400,
      frame.indexOf('data-testid="widget-ai"')
    )
    expect(btn).toContain('aria-label=')
    expect(btn).toContain('ask the assistant instead')
    expect(btn).toContain('aiPlan.purpose')
  })

  it('does not drag the widget when clicked', () => {
    // Every control in this row stops mousedown: react-rnd treats a press
    // inside .widget-handle as the start of a drag otherwise.
    const btn = frame.slice(
      frame.indexOf('data-testid="widget-ai"') - 1400,
      frame.indexOf('data-testid="widget-ai"')
    )
    expect(btn).toContain('onMouseDown={(e) => e.stopPropagation()}')
    expect(btn).toContain('widget-nodrag')
  })
})

describe('what it does, and that it is never a dead control', () => {
  it('asks lib/widgetAi which surface answers', () => {
    expect(frame).toContain('planWidgetAi(widget, Boolean(onAi))')
  })

  it('prefers the widget’s own AI surface when it has one', () => {
    expect(frame).toContain("aiPlan.surface === 'own'")
    expect(frame).toContain('onAi?.()')
  })

  it('otherwise routes to the shared widget SETUP assistant', () => {
    // NOT the conversational assistant — those serve different purposes and
    // this button belongs to widget AI.
    expect(frame).toContain("aiPlan.surface === 'setup'")
    expect(frame).toContain('useWidgetSetup.getState().start(widget.id)')
  })

  it('reaches the assistant only as an explicit fallback, never silently', () => {
    const fn = frame.slice(
      frame.indexOf('const askAssistantAbout'),
      frame.indexOf('const askAssistantAbout') + 700
    )
    // A mention needs a main-process resolver or the chip would claim context
    // that never rode the request, so the ref is conditional...
    expect(fn).toContain('if (ref) chat.addMentionRef(ref)')
    // ...and the open is not: a button that does nothing would be no better
    // than the absent buttons that were reported.
    expect(fn).toContain('useAssistantChrome.getState().openPanel()')
  })

  it('exposes which surface answered, so the two are distinguishable', () => {
    expect(frame).toContain('data-ai-surface={aiPlan.surface}')
  })

  it('the table routes the header button to its own column/row assistant', () => {
    const table = read('components/widgets/TableWidget.tsx')
    // ...but only when a table is BOUND. An unbound table widget has nothing to
    // add columns to, and needs the "which table?" expert instead — so it
    // passes no handler and planWidgetAi falls through to setup.
    expect(table).toContain('onAi={table ? () => setAiOpen((v) => !v) : undefined}')
    // And keeps the in-body buttons: those are where you already are when you
    // want another column or another row.
    expect(table).toContain('data-testid="table-ai-columns"')
    expect(table).toContain('data-testid="table-ai-rows"')
  })
})

describe('coverage is structural, not a maintained list', () => {
  it('a representative widget passes no onAi and still gets the button', () => {
    // The default path is what makes "all widgets" true. Pick a widget with no
    // AI surface of its own and confirm it does not need to opt in.
    const calc = read('components/widgets/CalculatorWidget.tsx')
    expect(calc).toContain('<WidgetFrame')
    expect(calc).not.toContain('onAi')
  })

  it('every widget that renders the frame inherits it', () => {
    const dir = join(ROOT, 'components', 'widgets')
    const callers = readdirSync(dir)
      .filter((f) => f.endsWith('.tsx'))
      .filter((f) => readFileSync(join(dir, f), 'utf8').includes('<WidgetFrame'))
    // A floor, not an exact count: new widgets should not fail this test, and
    // the number only going up is the point.
    expect(callers.length).toBeGreaterThanOrEqual(30)
    // None of them draws its own header AI button — one button, one place.
    for (const f of callers) {
      const src = readFileSync(join(dir, f), 'utf8')
      expect(src, `${f} must not draw its own header AI button`).not.toContain(
        'data-testid="widget-ai"'
      )
    }
  })
})
