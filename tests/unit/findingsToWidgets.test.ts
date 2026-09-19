import { describe, expect, it } from 'vitest'
import {
  planFindingsWidgets,
  planFindingsProposals,
  inferColumnType,
  humaniseField,
  titleFromTask,
  describePlacement,
  hasPlaceableFindings
} from '../../src/renderer/src/lib/findingsToWidgets'
import type { BrowseFindings } from '../../src/shared/browseFindings'

const f = (over: Partial<BrowseFindings> = {}): BrowseFindings => ({
  fields: ['name', 'rating', 'url'],
  records: [
    { name: 'Soup Co', rating: '4.8', url: 'https://a.test/1' },
    { name: 'Broth Bros', rating: '4.2', url: 'https://a.test/2' }
  ],
  answer: '',
  ...over
})

// Findings are already a field list and a record list — a table. Delivery used
// to hand them BACK to a model and ask it to retype every cell as a proposal,
// which truncated long runs inside the reply limit and let a model round a
// price it had never seen. These lock the path that replaced it.
describe('planFindingsProposals', () => {
  it('emits every record, however many there are', () => {
    // The reason this is built in code. Forty records did not fit in an
    // 8,000-token reply, and the half that landed looked like a whole table.
    const many = Array.from({ length: 120 }, (_, i) => ({ name: `Co ${i}`, rating: '4.0' }))
    const p = planFindingsProposals(f({ fields: ['name', 'rating'], records: many }), 'find soup', 'd1')
    expect(p.filter((x) => x.kind === 'add-table-row')).toHaveLength(120)
  })

  it('carries every value through verbatim', () => {
    const p = planFindingsProposals(f(), 'find soup', 'd1')
    const rows = p.filter((x) => x.kind === 'add-table-row') as Array<{ cells: Record<string, string> }>
    expect(rows[0].cells).toEqual({
      Name: 'Soup Co',
      Rating: '4.8',
      Url: 'https://a.test/1'
    })
  })

  it('points the rows at the table it just created', () => {
    // A row referencing a table that does not exist yet is rejected, and the
    // result is an empty table reported as a success.
    const p = planFindingsProposals(f(), 'find soup', 'd1')
    const table = p.find((x) => x.kind === 'create-table')!
    const row = p.find((x) => x.kind === 'add-table-row') as { tableId: string }
    expect(row.tableId).toBe(`$${table.id}`)
  })

  it('writes the prose answer into its own widget', () => {
    const p = planFindingsProposals(f({ answer: 'Soup Co is the best rated.' }), 'find soup', 'd1')
    const note = p.find((x) => x.kind === 'create-widget') as { widgetKind: string; content: string }
    expect(note.widgetKind).toBe('markdown')
    expect(note.content).toBe('Soup Co is the best rated.')
  })

  it('places a run that only answered a question, with no table', () => {
    const p = planFindingsProposals(
      { fields: [], records: [], answer: 'They refund within 30 days.' },
      'what is their refund policy',
      'd1'
    )
    expect(p.filter((x) => x.kind === 'create-table')).toHaveLength(0)
    expect(p.filter((x) => x.kind === 'create-widget')).toHaveLength(1)
  })

  it('places nothing at all when the run found nothing', () => {
    // An empty delivery reported as success is the failure this path exists to
    // prevent.
    expect(planFindingsProposals({ fields: [], records: [], answer: '' }, 'find soup', 'd1')).toEqual([])
  })

  it('skips a record with no usable cell rather than adding a blank row', () => {
    const p = planFindingsProposals(
      { fields: ['name'], records: [{ name: 'Real' }, {}], answer: '' },
      'find soup',
      'd1'
    )
    expect(p.filter((x) => x.kind === 'add-table-row')).toHaveLength(1)
  })
})

describe('inferColumnType', () => {
  it('types from the values, not the field name', () => {
    // A run names its own fields; "rating" holds 4.8 on one site and "Highly
    // rated" on another. A number column that rejects half its values is worse
    // than a text column that takes everything.
    expect(inferColumnType(['4.8', '4.2'])).toBe('number')
    expect(inferColumnType(['Highly rated', 'Average'])).toBe('text-short')
  })

  it('never makes a URL numeric or a date', () => {
    expect(inferColumnType(['https://a.test/12345'])).toBe('text-short')
  })

  it('gives prose a tall column', () => {
    expect(inferColumnType([
      'A long description that runs well past the point where a single-line cell stops being readable.'
    ])).toBe('text-long')
  })

  it('recognises dates', () => {
    expect(inferColumnType(['2026-01-02', '2026-03-04'])).toBe('date')
  })

  it('does not type a column from its gaps', () => {
    expect(inferColumnType(['', '  '])).toBe('text-short')
    // One stray non-number keeps the whole column text, so nothing is lost.
    expect(inferColumnType(['4.8', 'n/a'])).toBe('text-short')
  })
})

describe('naming', () => {
  it('turns a field name into a header', () => {
    expect(humaniseField('company_name')).toBe('Company name')
    expect(humaniseField('priceGBP')).toBe('Price GBP')
  })

  it('takes a title from the ask, not the instruction', () => {
    // "find X and put it in a table" is titled X, not the whole sentence.
    expect(titleFromTask('find the best chicken soup recipes and put them in a table', 'x')).toBe(
      'The best chicken soup recipes'
    )
    expect(titleFromTask('', 'Browsing results')).toBe('Browsing results')
  })
})

describe('describePlacement', () => {
  it('reports what the data actually holds', () => {
    // The old sentence came from a model describing what it INTENDED, so three
    // rows could be announced as a rich comparison of twenty.
    expect(describePlacement(f())).toBe('Put 2 results into a table of 3 columns.')
  })

  it('mentions the summary when there is one', () => {
    expect(describePlacement(f({ answer: 'Soup Co wins.' }))).toContain('summary beside it')
  })

  it('is honest about an empty run', () => {
    expect(describePlacement({ fields: [], records: [], answer: '' })).toContain('Nothing was found')
  })
})

describe('planFindingsWidgets', () => {
  it('gives a run that produced both a table AND the summary', () => {
    // The list is the data and the answer is what it means; dropping either
    // loses half the work.
    const p = planFindingsWidgets(f({ answer: 'Soup Co wins.' }), 'find soup')
    expect(p.table?.rows).toHaveLength(2)
    expect(p.note?.markdown).toBe('Soup Co wins.')
    expect(hasPlaceableFindings(p)).toBe(true)
  })

  it('knows when there is nothing worth placing', () => {
    expect(hasPlaceableFindings(planFindingsWidgets({ fields: [], records: [], answer: '' }, 't'))).toBe(false)
  })
})
