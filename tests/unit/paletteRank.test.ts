import { describe, it, expect } from 'vitest'
import { rankPaletteItems, EXACT_LABEL_SCORE } from '../../src/renderer/src/lib/paletteRank'

// Typing a command's full name and pressing Enter ran a web search: the omni
// search row scores a flat 175 and "New report" matched at 100.
const rows = [
  { id: 'omni-search', label: 'Search the web — “new report”', score: 175 },
  { id: 'new-report', label: 'New report', score: 100 },
  { id: 'omni-ask', label: 'Ask Plexii — “new report”', score: 60 },
  { id: 'unrelated', label: 'Calendar', score: 0 }
]

describe('command palette ranking', () => {
  it('a command typed by its full name is the first row, above the web search', () => {
    const out = rankPaletteItems(rows, 'new report')
    expect(out.map((r) => r.id)).toEqual(['new-report', 'omni-search', 'omni-ask'])
    expect(out[0].score).toBe(EXACT_LABEL_SCORE)
  })

  it('case and surrounding spaces do not matter', () => {
    expect(rankPaletteItems(rows, '  New Report ')[0].id).toBe('new-report')
  })

  it('a partial name keeps the web search first, as before', () => {
    expect(rankPaletteItems(rows, 'new rep')[0].id).toBe('omni-search')
  })

  it('a URL or question the classifier leads with still wins', () => {
    const lead = [{ id: 'omni-url', label: 'New report', score: 2000 }, { id: 'new-report', label: 'New report', score: 100 }]
    expect(rankPaletteItems(lead, 'new report')[0].id).toBe('omni-url')
  })

  it('an empty query keeps every row, zero scores included, by score', () => {
    expect(rankPaletteItems(rows, '').map((r) => r.id)).toEqual(['omni-search', 'new-report', 'omni-ask', 'unrelated'])
  })
})
