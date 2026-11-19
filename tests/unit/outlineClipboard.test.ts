// A mind map branch as an outline on the clipboard, and an outline read back (lib/outlineClipboard).
import { describe, it, expect } from 'vitest'
import { outlineHtml, outlineText, parseOutline, type OutlineNode } from '../../src/renderer/src/lib/outlineClipboard'

const branch: OutlineNode = { label: 'Research', children: [{ label: 'Interviews', children: [{ label: 'Five <users>', children: [] }] }, { label: 'Survey', children: [] }] }

describe('outline clipboard', () => {
  it('copies a branch as tab-indented text and a nested, escaped list', () => {
    expect(outlineText(branch)).toBe('Research\n\tInterviews\n\t\tFive <users>\n\tSurvey')
    expect(outlineHtml(branch)).toContain('<ul><li>Research<ul><li>Interviews<ul><li>Five &lt;users&gt;</li></ul></li><li>Survey</li></ul></li></ul>')
  })
  it('reads back what it wrote', () => {
    expect(parseOutline(outlineText(branch))).toEqual([branch])
  })
  it('reads space indents, list marks and several top-level items; skips blank lines', () => {
    expect(parseOutline('- Budget\n  - Quotes\n  - [x] Invoices\n\n- Timeline\n    deep')).toEqual([
      { label: 'Budget', children: [{ label: 'Quotes', children: [] }, { label: 'Invoices', children: [] }] },
      { label: 'Timeline', children: [{ label: 'deep', children: [] }] }
    ])
    expect(parseOutline('\n  \n')).toEqual([])
  })
})
