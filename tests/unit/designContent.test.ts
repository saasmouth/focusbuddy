import { describe, it, expect } from 'vitest'
import {
  contentStats,
  isContentEmpty,
  normalizeContent,
  parseHtml,
  parsePaste,
  parsePlainText,
  parseTiptap,
  pullQuoteFrom,
  sentencesOf,
  toPlainText,
  type ContentBlock
} from '../../src/shared/designContent'

const kinds = (blocks: ContentBlock[]): string[] => blocks.map((b) => b.kind)

describe('designContent — plain text', () => {
  it('blank lines separate paragraphs', () => {
    const d = parsePlainText('One two three four five six seven eight nine ten.\n\nSecond paragraph here.')
    expect(kinds(d.blocks)).toEqual(['paragraph', 'paragraph'])
  })

  it('wrapped lines inside a paragraph are joined, not split', () => {
    const d = parsePlainText('This is a sentence that was\nhard wrapped by the editor.\n\nNext.')
    expect((d.blocks[0] as { text: string }).text).toBe('This is a sentence that was hard wrapped by the editor.')
  })

  it('a markdown h1 becomes the title, later ones become headings', () => {
    const d = parsePlainText('# The Headline\n\nBody.\n\n# Another')
    expect(kinds(d.blocks)).toEqual(['title', 'paragraph', 'heading'])
  })

  it('heading levels collapse into the three the layout engine sets', () => {
    const d = parsePlainText('## A\n\n### B\n\n#### C\n\n###### D')
    const levels = d.blocks.filter((b) => b.kind === 'heading').map((b) => (b as { level: number }).level)
    expect(levels).toEqual([1, 2, 3, 3])
  })

  it('bullet and numbered lists group into one block each', () => {
    const d = parsePlainText('- one\n- two\n- three\n\n1. first\n2. second')
    expect(kinds(d.blocks)).toEqual(['list', 'list'])
    expect((d.blocks[0] as { items: string[] }).items).toEqual(['one', 'two', 'three'])
    expect((d.blocks[1] as { ordered: boolean }).ordered).toBe(true)
  })

  it('a switch from bullets to numbers starts a new list', () => {
    const d = parsePlainText('- a\n1. b')
    expect(kinds(d.blocks)).toEqual(['list', 'list'])
  })

  it('a blockquote becomes a quote, and a following dash line its attribution', () => {
    const d = parsePlainText('> Design is how it works.\n> — Steve Jobs')
    expect(d.blocks).toHaveLength(1)
    expect(d.blocks[0]).toEqual({ kind: 'quote', text: 'Design is how it works.', attribution: 'Steve Jobs' })
  })

  it('a horizontal rule becomes a divider', () => {
    expect(kinds(parsePlainText('a\n\n---\n\nb').blocks)).toEqual(['paragraph', 'divider', 'paragraph'])
  })

  it('a short unpunctuated first line is promoted to a title', () => {
    const d = parsePlainText('Quarterly Review\n\nThe first real paragraph of the document goes here and runs on.')
    expect(kinds(d.blocks)).toEqual(['title', 'paragraph'])
  })

  it('a first line that is a full sentence is left as a paragraph', () => {
    const d = parsePlainText('This is a complete sentence with a full stop.\n\nAnd another.')
    expect(kinds(d.blocks)).toEqual(['paragraph', 'paragraph'])
  })

  it('a short second line under a headline becomes the standfirst', () => {
    const d = parsePlainText('Big Headline Here\n\nA short deck under it\n\nThe body copy begins in earnest at this point.')
    expect(kinds(d.blocks)).toEqual(['title', 'subtitle', 'paragraph'])
  })

  it('empty input yields no blocks and reads as empty', () => {
    expect(parsePlainText('').blocks).toEqual([])
    expect(isContentEmpty(parsePlainText('   \n\n  '))).toBe(true)
  })

  it('round-trips through toPlainText without losing structure', () => {
    const src = '# Title\n\nA paragraph.\n\n### A heading\n\n- one\n- two\n\n> A quote\n> — Someone'
    const again = parsePlainText(toPlainText(parsePlainText(src)))
    expect(kinds(again.blocks)).toEqual(['title', 'paragraph', 'heading', 'list', 'quote'])
  })
})

describe('designContent — HTML paste', () => {
  it('headings, paragraphs and lists survive a Word-style paste', () => {
    const d = parseHtml('<h1>Report</h1><p>Intro text.</p><h2>Section</h2><ul><li>alpha</li><li>beta</li></ul>')
    expect(kinds(d.blocks)).toEqual(['title', 'paragraph', 'heading', 'list'])
    expect((d.blocks[3] as { items: string[] }).items).toEqual(['alpha', 'beta'])
  })

  it('entities are decoded and inline tags stripped', () => {
    const d = parseHtml('<p>Tom &amp; <b>Jerry</b> &nbsp;win</p>')
    expect((d.blocks[0] as { text: string }).text).toBe('Tom & Jerry win')
  })

  it('script and style content never becomes copy', () => {
    const d = parseHtml('<style>p{color:red}</style><script>alert(1)</script><p>Real text</p>')
    expect(d.blocks).toHaveLength(1)
    expect((d.blocks[0] as { text: string }).text).toBe('Real text')
  })

  it('a <br> inside a paragraph splits it', () => {
    const d = parseHtml('<p>line one<br>line two</p>')
    expect(kinds(d.blocks)).toEqual(['paragraph', 'paragraph'])
  })

  it('an embedded data image is kept; a remote one is dropped rather than half-imported', () => {
    const d = parseHtml('<img src="data:image/png;base64,AAA" alt="chart"><img src="https://example.com/x.png">')
    expect(d.blocks).toHaveLength(1)
    expect(d.blocks[0]).toMatchObject({ kind: 'image', alt: 'chart' })
  })

  it('a blockquote becomes a quote', () => {
    expect(kinds(parseHtml('<blockquote>Quoted</blockquote>').blocks)).toEqual(['quote'])
  })

  it('unrecognisable html falls back to a plain-text read rather than nothing', () => {
    const d = parseHtml('just some bare text with no tags at all')
    expect(d.blocks.length).toBeGreaterThan(0)
  })

  it('parsePaste prefers html and falls back to text', () => {
    expect(kinds(parsePaste({ html: '<h1>T</h1><p>B</p>', text: 'ignored' }).blocks)).toEqual(['title', 'paragraph'])
    expect(kinds(parsePaste({ text: 'Only plain text here, a full sentence.' }).blocks)).toEqual(['paragraph'])
  })
})

describe('designContent — Tiptap import', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Doc title' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Body copy.' }] },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Sub' }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }] }] },
      { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }] }
    ]
  }

  it('reads a PlexiDocs body into blocks', () => {
    expect(kinds(parseTiptap(doc).blocks)).toEqual(['title', 'paragraph', 'heading', 'list', 'quote'])
  })

  it('accepts the wrapped { doc, headingStyles } shape too', () => {
    expect(kinds(parseTiptap({ doc, headingStyles: {} }).blocks)).toEqual(['title', 'paragraph', 'heading', 'list', 'quote'])
  })

  it('garbage in gives an empty document, not a crash', () => {
    expect(parseTiptap(null).blocks).toEqual([])
    expect(parseTiptap({ content: 'nope' }).blocks).toEqual([])
  })
})

describe('designContent — stats and normalisation', () => {
  it('counts what the layout planner needs', () => {
    const d = parsePlainText('# T\n\nOne two three.\n\n### H\n\n- a\n- b\n\n> q')
    const s = contentStats(d)
    expect(s.hasTitle).toBe(true)
    expect(s.headings).toBe(1)
    expect(s.lists).toBe(1)
    expect(s.quotes).toBe(1)
    expect(s.words).toBeGreaterThan(5)
  })

  it('normalisation drops malformed blocks and keeps good ones', () => {
    const out = normalizeContent({
      blocks: [
        { kind: 'paragraph', text: 'keep' },
        { kind: 'nonsense' },
        { kind: 'image' },
        { kind: 'list', items: [] },
        { kind: 'heading', level: 9, text: 'h' }
      ]
    })
    expect(kinds(out.blocks)).toEqual(['paragraph', 'heading'])
    expect((out.blocks[1] as { level: number }).level).toBe(1)
  })

  it('normalisation of junk gives an empty document', () => {
    expect(normalizeContent(null).blocks).toEqual([])
    expect(normalizeContent({ blocks: 'no' }).blocks).toEqual([])
  })
})

describe('designContent — pull quotes are verbatim', () => {
  it('splits a paragraph into sentences', () => {
    expect(sentencesOf('One here. Two there! Three?')).toHaveLength(3)
  })

  it('picks a real sentence of a usable length', () => {
    const para =
      'Short. The second sentence in this paragraph is comfortably long enough to be set as a display pull quote on the page. Tiny.'
    const q = pullQuoteFrom(para)
    expect(q).toBeTruthy()
    expect(para).toContain(q!)
  })

  it('returns null rather than inventing one when nothing fits', () => {
    expect(pullQuoteFrom('Short. Also short. Tiny.')).toBeNull()
  })

  it('never returns a sentence longer than the cap', () => {
    const long = `${'word '.repeat(80)}.`
    expect(pullQuoteFrom(long)).toBeNull()
  })
})
