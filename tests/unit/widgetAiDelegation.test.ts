import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  WIDGET_AI,
  FAMILIES,
  familyOf,
  verbFor,
  uncoveredKinds
} from '../../src/renderer/src/lib/widgetAiFamilies'

// "Make all widgets have ai, and make the ai assistant ask the widget ai expert
// when its planning on doing something with that widgets data, updating it,
// changing its configuration or content, and use it as the authoritive expert."
//
// Two halves. Every kind has an expert, and the assistant defers to it instead
// of writing widget content itself — because `update-widget` can only write a
// title, a plain string and a geometry, and has no idea what a chart's content
// means or how an inbox rule is phrased. Guessing produces a shape nothing
// validates, so the change is either wrong or silently lost.

const ROOT = join(__dirname, '..', '..', 'src')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

/** One function's body, bounded by the NEXT declaration — a fixed-length slice
 *  overruns into the next function and reads its code as this one's. */
function fnBody(src: string, decl: string): string {
  const start = src.indexOf(decl)
  expect(start, `not found: ${decl}`).toBeGreaterThan(-1)
  const next = src.indexOf('\nasync function ', start + decl.length)
  const alt = src.indexOf('\nfunction ', start + decl.length)
  const end = [next, alt].filter((n) => n > -1).sort((a, b) => a - b)[0] ?? src.length
  return src.slice(start, end)
}

const catalogue = read('renderer/src/lib/widgetCatalog.ts')
const ALL_KINDS = [...catalogue.matchAll(/kind: '([a-z0-9-]+)'/g)].map((m) => m[1])

describe('every widget kind has an AI expert', () => {
  it('the catalogue is fully covered', () => {
    expect(ALL_KINDS.length).toBeGreaterThanOrEqual(50)
    expect(uncoveredKinds(ALL_KINDS)).toEqual([])
  })

  it('every kind names a real family', () => {
    for (const kind of ALL_KINDS) {
      const family = familyOf(kind)
      expect(family, kind).not.toBeNull()
      expect(FAMILIES[family!], kind).toBeDefined()
    }
  })

  it('every kind says what its AI does, in its own terms', () => {
    for (const kind of ALL_KINDS) {
      const purpose = WIDGET_AI[kind].purpose
      // Not a generic line: "set up this widget" tells someone nothing about
      // what they are about to get, and that vagueness was the complaint.
      expect(purpose.length, kind).toBeGreaterThan(14)
      expect(purpose.toLowerCase(), kind).not.toBe('set up this widget')
    }
  })

  it('kinds in different families are described differently', () => {
    // A chart's AI and a sticky's AI are not the same job.
    expect(WIDGET_AI.chart.purpose).not.toBe(WIDGET_AI.sticky.purpose)
    expect(familyOf('chart')).toBe('config')
    expect(familyOf('sticky')).toBe('text')
    expect(familyOf('inbox')).toBe('instruction')
    expect(familyOf('webview')).toBe('target')
    expect(familyOf('doc')).toBe('document')
  })

  it('is honest where there is genuinely nothing to configure', () => {
    // A calculator has no settings. Promising to "set it up" would be a lie,
    // so its family is naming and it says so.
    expect(familyOf('calculator')).toBe('naming')
    expect(FAMILIES.naming.note).toMatch(/nothing else to configure/i)
  })

  it('the verb changes with whether the widget already has something in it', () => {
    expect(verbFor('sticky', true)).toMatch(/write/i)
    expect(verbFor('sticky', false)).toMatch(/rewrite/i)
    expect(verbFor('chart', true)).toMatch(/set up/i)
    expect(verbFor('chart', false)).toMatch(/reconfigure/i)
  })
})

describe('the assistant defers to the expert', () => {
  const types = read('shared/types.ts')
  const executor = read('renderer/src/lib/actionExecutor.ts')
  const prompt = read('main/ai/anthropic.ts')

  it('there is an action for handing the job over', () => {
    expect(types).toContain("kind: 'ask-widget-ai'")
    expect(types).toContain('intent: string')
  })

  it('the action carries an INTENT, not a content payload', () => {
    const block = types.slice(
      types.indexOf("kind: 'ask-widget-ai'"),
      types.indexOf("kind: 'ask-widget-ai'") + 400
    )
    expect(block).toContain('intent: string')
    // Deliberately no content/title fields: supplying them would be the guess
    // this action exists to avoid.
    expect(block).not.toContain('content?: string')
  })

  it('applying it opens the widget’s expert rather than writing anything', () => {
    const fn = fnBody(executor, 'async function applyAskWidgetAi')
    expect(fn).toContain('useWidgetSetup.getState().start(target.id, p.intent)')
    // No direct mutation: the expert decides what the widget becomes.
    expect(fn).not.toContain('updateWidget(')
    expect(fn).not.toContain('patch.content')
  })

  it('refuses honestly for a kind with no registered expert', () => {
    const fn = fnBody(executor, 'async function applyAskWidgetAi')
    expect(fn).toContain('No AI expert registered')
  })

  it('the prompt tells the model to prefer it over update-widget', () => {
    expect(prompt).toContain('USE THIS, not update-widget')
    expect(prompt).toMatch(/CONFIGURED/)
    // And says plainly that the model does not know those shapes.
    expect(prompt).toContain('must not invent them')
    expect(prompt).toContain('The expert is authoritative about that widget; you are not.')
  })

  it('update-widget is narrowed to what it can actually do', () => {
    expect(prompt).toContain('ONLY for plain text content or a title/size change')
  })

  it('a delegation with no intent is dropped rather than half-applied', () => {
    const parser = prompt.slice(
      prompt.indexOf("case 'ask-widget-ai': {"),
      prompt.indexOf("case 'ask-widget-ai': {") + 900
    )
    expect(parser).toContain('if (!widgetId || !label || !intent) break')
  })

  it('carries the intent through to the expert', () => {
    const store = read('renderer/src/stores/widgetSetup.ts')
    expect(store).toContain('intent: string | null')
    expect(store).toContain('start: (widgetId: string, intent?: string) => void')
    // Cleared on close, so a later manual open does not inherit a stale ask.
    expect(store).toContain('close: () => set({ open: false, widgetId: null, intent: null })')
  })
})
