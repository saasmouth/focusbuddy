import { describe, it, expect } from 'vitest'
import { markdownToTiptap } from '../../src/main/ai/markdownToTiptap'

describe('markdownToTiptap', () => {
  it('produces a doc node with empty paragraph for empty input', () => {
    const doc = markdownToTiptap('')
    expect(doc.type).toBe('doc')
    expect(doc.content.length).toBe(1)
    expect(doc.content[0].type).toBe('paragraph')
  })

  it('parses headings at three levels', () => {
    const doc = markdownToTiptap('# H1\n\n## H2\n\n### H3')
    expect(doc.content.map((b) => b.type)).toEqual(['heading', 'heading', 'heading'])
    expect(doc.content[0].attrs?.level).toBe(1)
    expect(doc.content[1].attrs?.level).toBe(2)
    expect(doc.content[2].attrs?.level).toBe(3)
  })

  it('parses bullet list', () => {
    const doc = markdownToTiptap('- alpha\n- beta\n- gamma')
    expect(doc.content[0].type).toBe('bulletList')
    expect(doc.content[0].content?.length).toBe(3)
  })

  it('parses task list with checked + unchecked items', () => {
    const doc = markdownToTiptap('- [ ] open thing\n- [x] done thing')
    expect(doc.content[0].type).toBe('taskList')
    const items = doc.content[0].content ?? []
    expect(items.length).toBe(2)
    expect(items[0].attrs?.checked).toBe(false)
    expect(items[1].attrs?.checked).toBe(true)
  })

  it('parses ordered list', () => {
    const doc = markdownToTiptap('1. first\n2. second')
    expect(doc.content[0].type).toBe('orderedList')
    expect(doc.content[0].content?.length).toBe(2)
  })

  it('parses inline bold + italic + code + link', () => {
    const doc = markdownToTiptap('Hello **bold** *italic* `code` [link](https://x.com).')
    const para = doc.content[0]
    expect(para.type).toBe('paragraph')
    const marks = (para.content ?? [])
      .map((n) => ('marks' in n && n.marks ? n.marks[0]?.type : null))
      .filter(Boolean)
    expect(marks).toEqual(['bold', 'italic', 'code', 'link'])
  })

  it('parses blockquote and horizontal rule', () => {
    const doc = markdownToTiptap('> a quote\n\n---\n\nafter')
    const types = doc.content.map((b) => b.type)
    expect(types).toContain('blockquote')
    expect(types).toContain('horizontalRule')
  })

  // Desk builds now write pages as markdown (far fewer tokens than Tiptap JSON),
  // and the page editor's StarterKit renders codeBlock nodes, so a fence must
  // arrive as code — verbatim, line breaks and markdown-looking lines intact.
  it('turns a fenced block into a codeBlock with its language and exact text', () => {
    const doc = markdownToTiptap('Intro\n\n```bash\nnpm ci\n# not a heading\n- not a bullet\n```\nplain text after')
    expect(doc.content.map((b) => b.type)).toEqual(['paragraph', 'codeBlock', 'paragraph'])
    const code = doc.content[1]
    expect(code.attrs?.language).toBe('bash')
    expect(code.content).toEqual([{ type: 'text', text: 'npm ci\n# not a heading\n- not a bullet' }])
  })

  it('keeps an unclosed fence as code to the end rather than dropping it', () => {
    const doc = markdownToTiptap('```\nline one\nline two')
    expect(doc.content).toEqual([{ type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: 'line one\nline two' }] }])
  })

  it('an empty fence is an empty codeBlock, not a crash', () => {
    const doc = markdownToTiptap('```\n```')
    expect(doc.content).toEqual([{ type: 'codeBlock', attrs: { language: null } }])
  })
})
