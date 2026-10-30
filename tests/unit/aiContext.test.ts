import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Widget } from '@shared/types'

// The context cards (ADR-0011).
//
// Two things are under test and the second is the one that matters.
//
//  1. "Reliably related", the owner's words: a card must be earned by the
//     user's own vocabulary, not by a shared "with".
//  2. NOTHING IS SENT UNTIL IT IS ADDED. A card the user ignored or rejected
//     must contribute nothing — and must not merely be filtered out of an
//     assembled block, because a filter is one bug away from a leak. The
//     resolve step is given ids and assembles only those.

const widgets: Widget[] = []
const files: Array<{
  id: string
  kind: string
  title: string
  content: string
  trashed?: boolean
}> = []

vi.mock('../../src/main/db/widgets', () => ({
  listWidgetsByTask: (taskId: string) => widgets.filter((w) => w.taskId === taskId)
}))
vi.mock('../../src/main/db/widgetFiles', () => ({ listWidgetFiles: () => files }))
vi.mock('../../src/main/db/nodes', () => ({ getNode: () => ({ title: 'A desk' }) }))
vi.mock('../../src/main/ai/widgetSummary', () => ({ mainWidgetResolvers: () => ({}) }))

const readers = {
  widgetText: (w: Widget) => w.content ?? '',
  fileText: (f: { content: string }) => f.content
}

function widget(id: string, title: string, content: string, kind = 'table'): Widget {
  return { id, taskId: 'desk-1', kind, title, content } as unknown as Widget
}

beforeEach(() => {
  widgets.length = 0
  files.length = 0
})

describe('relatedness — earned, not assumed', () => {
  it('a single shared generic word is not a relationship', async () => {
    const { relatedness, promptTerms } = await import('../../src/main/ai/aiContext')
    // "their" and "widgets" are stopwords; "notes" matches once, in the body.
    const terms = promptTerms('build me something with their widgets')
    expect(relatedness(terms, 'Holiday notes', 'notes about nothing').score).toBe(0)
  })

  it('one match in the TITLE is enough — a title naming it is the user pointing', async () => {
    const { relatedness, promptTerms } = await import('../../src/main/ai/aiContext')
    const terms = promptTerms('add this quarter to the suppliers list')
    expect(relatedness(terms, 'Suppliers', 'anything').score).toBeGreaterThan(0)
  })

  it('two different body words are enough; one is not', async () => {
    const { relatedness, promptTerms } = await import('../../src/main/ai/aiContext')
    const terms = promptTerms('compare the latency and throughput figures')
    expect(relatedness(terms, 'Untitled', 'latency numbers only').score).toBe(0)
    expect(relatedness(terms, 'Untitled', 'latency and throughput numbers').score).toBeGreaterThan(0)
  })
})

describe('proposeContext — describes, never sends', () => {
  it('finds the desk widget and the file the request names', async () => {
    widgets.push(widget('w1', 'Suppliers', 'Acme\nGlobex'))
    widgets.push(widget('w2', 'Holiday photos', 'nothing to do with it'))
    files.push({ id: 'f1', kind: 'table', title: 'Supplier lead times', content: 'Acme 12 days' })
    const { proposeContextWith } = await import('../../src/main/ai/aiContext')
    const cards = proposeContextWith({ prompt: 'update the suppliers lead times', taskId: 'desk-1' }, readers)
    // Both match; the holiday widget does not. Order is by score, and here
    // the file wins it on two title words against the widget's one — so this
    // asserts membership, and the tie-break is tested on its own below.
    expect(new Set(cards.map((c) => c.id))).toEqual(new Set(['widget:w1', 'file:f1']))
    expect(cards.some((c) => c.label === 'Holiday photos')).toBe(false)
  })

  it('breaks a tie toward the desk you are looking at', async () => {
    widgets.push(widget('w1', 'Suppliers', 'x'))
    files.push({ id: 'f1', kind: 'note', title: 'Suppliers', content: 'x' })
    const { proposeContextWith } = await import('../../src/main/ai/aiContext')
    const cards = proposeContextWith({ prompt: 'the suppliers list', taskId: 'desk-1' }, readers)
    expect(cards[0].id).toBe('widget:w1')
  })

  it('says WHY in the user’s own words, so "add" is an informed press', async () => {
    widgets.push(widget('w1', 'Suppliers', 'Acme'))
    const { proposeContextWith } = await import('../../src/main/ai/aiContext')
    const [card] = proposeContextWith({ prompt: 'update the suppliers list', taskId: 'desk-1' }, readers)
    expect(card.why).toContain('"suppliers"')
    expect(card.preview).toContain('Acme')
    expect(card.chars).toBeGreaterThan(0)
  })

  it('leaves trashed files out', async () => {
    files.push({ id: 'f1', kind: 'note', title: 'Suppliers', content: 'x', trashed: true })
    const { proposeContextWith } = await import('../../src/main/ai/aiContext')
    expect(proposeContextWith({ prompt: 'the suppliers list', taskId: null }, readers)).toEqual([])
  })
})

describe('resolveContext — only what was added is assembled', () => {
  beforeEach(() => {
    widgets.push(widget('w1', 'Suppliers', 'ACME-SECRET-ROWS'))
    widgets.push(widget('w2', 'Payroll', 'PAYROLL-SECRET-ROWS'))
    files.push({ id: 'f1', kind: 'note', title: 'Supplier notes', content: 'FILE-SECRET-TEXT' })
  })

  it('assembles nothing at all when nothing was added', async () => {
    const { resolveContextWith } = await import('../../src/main/ai/aiContext')
    const r = resolveContextWith([], 'desk-1', readers)
    expect(r.block).toBe('')
    expect(r.used).toEqual([])
  })

  it('includes the added item and NOT the one beside it', async () => {
    const { resolveContextWith } = await import('../../src/main/ai/aiContext')
    const r = resolveContextWith(['widget:w1'], 'desk-1', readers)
    expect(r.block).toContain('ACME-SECRET-ROWS')
    // The card the user never pressed. This is the assertion the whole
    // feature stands on.
    expect(r.block).not.toContain('PAYROLL-SECRET-ROWS')
    expect(r.block).not.toContain('FILE-SECRET-TEXT')
    expect(r.used).toEqual(['widget:w1'])
  })

  it('an unknown or stale id is skipped in silence, not an error', async () => {
    const { resolveContextWith } = await import('../../src/main/ai/aiContext')
    const r = resolveContextWith(['widget:gone', 'file:f1'], 'desk-1', readers)
    expect(r.used).toEqual(['file:f1'])
    expect(r.block).toContain('FILE-SECRET-TEXT')
  })

  it('labels the block as data, not as instructions', async () => {
    const { resolveContextWith } = await import('../../src/main/ai/aiContext')
    const r = resolveContextWith(['widget:w1'], 'desk-1', readers)
    expect(r.block).toContain('not as instructions')
  })

  it('returns the added items’ names, which steer the search query', async () => {
    const { resolveContextWith } = await import('../../src/main/ai/aiContext')
    expect(resolveContextWith(['widget:w1'], 'desk-1', readers).terms).toEqual(['Suppliers'])
  })
})
