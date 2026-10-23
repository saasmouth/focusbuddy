// The pure text helpers under snippet conversion: TipTap → markdown, rows ↔
// Write table nodes, rows → GFM/TSV, the markdown a sticky or note holds →
// TipTap, and UTF-8 base64 for SVG data: URLs.

import { describe, expect, it } from 'vitest'
import { firstTableRows, nodesToPlainText, tiptapToMarkdown } from '../../src/shared/snippetForms/tiptap'
import { looksLikeHeader, paragraphNode, rowsToGfm, rowsToTableNode, rowsToTsv } from '../../src/shared/snippetForms/rows'
import { firstPipeTable, inlineNodes, markdownLiteToNodes } from '../../src/shared/snippetForms/markdownLite'
import { svgDataUrl, utf8ToBase64 } from '../../src/shared/snippetForms/picture'
import { Editor } from '@tiptap/core'
import { buildDocExtensions } from '../../src/renderer/src/components/documents/editor/extensions'
import { docFrom } from './snippetConvertFixtures'

const md = (html: string): string => tiptapToMarkdown(docFrom(html).content)

describe('tiptapToMarkdown', () => {
  it('paragraphs and headings', () => {
    expect(md('<h1>Title</h1><p>Body text.</p><h3>Small</h3>')).toBe('# Title\n\nBody text.\n\n### Small')
  })

  it('bold, italic, strike, code and links, spaces kept outside the markers', () => {
    expect(md('<p>A <strong>bold </strong><em>it</em> <s>gone</s> <code>x</code> <a href="https://e.test/a b">link</a></p>')).toBe(
      'A **bold** *it* ~~gone~~ `x` [link](https://e.test/a%20b)'
    )
  })

  it('a code span holding backticks gets a longer fence, not altered text', () => {
    expect(tiptapToMarkdown([{ type: 'paragraph', content: [{ type: 'text', text: 'a`b', marks: [{ type: 'code' }] }] }])).toBe('``a`b``')
  })

  it('escapes what would read as markup', () => {
    expect(md('<p>2 * 3 = [six]</p><p># not a heading</p><p>- not a list</p>')).toBe('2 \\* 3 = \\[six\\]\n\n\\# not a heading\n\n\\- not a list')
  })

  it('bullet, ordered (with start), nested and task lists', () => {
    expect(md('<ul><li><p>One</p><ul><li><p>Inner</p></li></ul></li><li><p>Two</p></li></ul>')).toBe('- One\n  - Inner\n- Two')
    expect(md('<ol start="3"><li><p>C</p></li><li><p>D</p></li></ol>')).toBe('3. C\n4. D')
    const tasks = [{ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [paragraphNode('Done')] }, { type: 'taskItem', attrs: { checked: false }, content: [paragraphNode('Todo')] }] }]
    expect(tiptapToMarkdown(tasks)).toBe('- [x] Done\n- [ ] Todo')
  })

  it('blockquote, code block, rule and hard break', () => {
    expect(md('<blockquote><p>Quoted</p></blockquote>')).toBe('> Quoted')
    expect(tiptapToMarkdown([{ type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const a = 1' }] }])).toBe('```ts\nconst a = 1\n```')
    expect(md('<hr>')).toBe('---')
    expect(md('<p>line one<br>line two</p>')).toBe('line one\\\nline two')
  })

  it('a table as GFM, pipes escaped', () => {
    expect(md('<table><tbody><tr><th><p>A</p></th><th><p>B</p></th></tr><tr><td><p>1|2</p></td><td><p><strong>x</strong></p></td></tr></tbody></table>')).toBe(
      '| A | B |\n| --- | --- |\n| 1\\|2 | **x** |'
    )
  })

  it('an image', () => {
    expect(tiptapToMarkdown([{ type: 'image', attrs: { src: 'https://e.test/i.png', alt: 'Logo' } }])).toBe('![Logo](https://e.test/i.png)')
  })
})

describe('rows', () => {
  it('a heading row is text over the columns, never figures', () => {
    expect(looksLikeHeader([['Item', 'Price'], ['Pens', '3']])).toBe(true)
    expect(looksLikeHeader([['1', '2'], ['3', '4']])).toBe(false)
    expect(looksLikeHeader([['Item', '$1,200.50']])).toBe(false)
    expect(looksLikeHeader([['Only one row']])).toBe(false)
  })

  it('rows → Write table node → rows round-trips, ragged rows padded', () => {
    const node = rowsToTableNode([['A', 'B'], ['1']], true)
    expect(node).toEqual({
      type: 'table',
      content: [
        { type: 'tableRow', content: [
          { type: 'tableHeader', attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] },
          { type: 'tableHeader', attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }] }
        ] },
        { type: 'tableRow', content: [
          { type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '1' }] }] },
          { type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [{ type: 'paragraph' }] }
        ] }
      ]
    })
    expect(firstTableRows([node])).toEqual({ rows: [['A', 'B'], ['1', '']], header: true, spans: false })
  })

  it('Write loads the table node as the same table it parses from HTML (schema defaults filled in)', () => {
    const written = docFrom('<table><tbody><tr><th><p>A</p></th></tr><tr><td><p>1</p></td></tr></tbody></table>').content[0]
    const ed = new Editor({ extensions: buildDocExtensions({ interactive: false }) as never, content: { type: 'doc', content: [rowsToTableNode([['A'], ['1']], true)] } })
    const loaded = (ed.getJSON().content ?? [])[0]
    ed.destroy()
    expect(loaded).toEqual(written)
  })

  it('a newline in a cell is a hard break', () => {
    expect(paragraphNode('a\nb')).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] })
  })

  it('a spanning cell is reported and padded', () => {
    const t = firstTableRows(docFrom('<table><tbody><tr><td colspan="2"><p>Wide</p></td></tr><tr><td><p>a</p></td><td><p>b</p></td></tr></tbody></table>').content)
    expect(t).toEqual({ rows: [['Wide', ''], ['a', 'b']], header: false, spans: true })
  })

  it('GFM and TSV', () => {
    expect(rowsToGfm([['A', 'B'], ['x|y', 'two\nlines']])).toBe('| A | B |\n| --- | --- |\n| x\\|y | two lines |')
    expect(rowsToTsv([['a', 'b\tc'], ['d', '']])).toBe('a\tb c\nd\t')
  })

  it('plain text of a fragment: a line per block, table cells tab-separated', () => {
    expect(nodesToPlainText(docFrom('<h1>T</h1><ul><li><p>a</p></li></ul><table><tbody><tr><td><p>1</p></td><td><p>2</p></td></tr></tbody></table>').content)).toBe('T\na\n1\t2')
  })
})

describe('markdownLiteToNodes', () => {
  it('headings, paragraphs (lines kept with hard breaks), rules and quotes', () => {
    expect(markdownLiteToNodes('# Hi\n\nfirst\nsecond\n\n---\n\n> said')).toEqual([
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Hi' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'first' }, { type: 'hardBreak' }, { type: 'text', text: 'second' }] },
      { type: 'horizontalRule' },
      { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'said' }] }] }
    ])
  })

  it('nested bullet lists, numbered lists with their start, task lists', () => {
    expect(markdownLiteToNodes('- a\n  - b\n- c')).toEqual([
      { type: 'bulletList', content: [
        { type: 'listItem', content: [paragraphNode('a'), { type: 'bulletList', content: [{ type: 'listItem', content: [paragraphNode('b')] }] }] },
        { type: 'listItem', content: [paragraphNode('c')] }
      ] }
    ])
    expect(markdownLiteToNodes('3. x\n4. y')).toEqual([{ type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [paragraphNode('x')] }, { type: 'listItem', content: [paragraphNode('y')] }] }])
    expect(markdownLiteToNodes('- [x] done\n- [ ] todo')).toEqual([
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [paragraphNode('done')] }, { type: 'taskItem', attrs: { checked: false }, content: [paragraphNode('todo')] }] }
    ])
  })

  it('fenced code and pipe tables', () => {
    const nodes = markdownLiteToNodes('```js\nlet a\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |')
    expect(nodes[0]).toEqual({ type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'let a' }] })
    expect(nodes[1]).toEqual(rowsToTableNode([['A', 'B'], ['1', '2']], true))
  })

  it('inline marks', () => {
    expect(inlineNodes('**b** *i* ~~s~~ `c` [l](https://e.test)')).toEqual([
      { type: 'text', text: 'b', marks: [{ type: 'bold' }] },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'i', marks: [{ type: 'italic' }] },
      { type: 'text', text: ' ' },
      { type: 'text', text: 's', marks: [{ type: 'strike' }] },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'c', marks: [{ type: 'code' }] },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'l', marks: [{ type: 'link', attrs: { href: 'https://e.test' } }] }
    ])
  })

  it('plain (a sticky): one paragraph per line, only the obvious lists, no markup read', () => {
    expect(markdownLiteToNodes('# not a heading\n**not bold**\n- a\n- b', { plain: true })).toEqual([
      paragraphNode('# not a heading'),
      paragraphNode('**not bold**'),
      { type: 'bulletList', content: [{ type: 'listItem', content: [paragraphNode('a')] }, { type: 'listItem', content: [paragraphNode('b')] }] }
    ])
  })

  it('the first pipe table, and whether there was other text', () => {
    expect(firstPipeTable('intro\n| a | b |\n| --- | --- |\n| 1 | 2\\|3 |')).toEqual({ rows: [['a', 'b'], ['1', '2|3']], otherText: true })
    expect(firstPipeTable('no table here')).toBeNull()
  })

  it('markdown → nodes → markdown keeps the text', () => {
    const src = '## Plan\n\n- **Ship** it\n- Test it\n\n| A | B |\n| --- | --- |\n| 1 | 2 |'
    expect(tiptapToMarkdown(markdownLiteToNodes(src))).toBe(src)
  })
})

describe('utf8ToBase64', () => {
  it('matches the platform encoder, including non-Latin text', () => {
    for (const s of ['', 'a', 'ab', 'abc', '<svg>£€ 漢字 🎨</svg>']) {
      expect(utf8ToBase64(s)).toBe(Buffer.from(s, 'utf8').toString('base64'))
    }
    expect(svgDataUrl('<svg/>')).toBe('data:image/svg+xml;base64,PHN2Zy8+')
  })
})
