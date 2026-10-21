// @vitest-environment node
// Editing a style sheet. The sheet has existed since the engine landed; what
// was missing was any way to change it. These are the operations the styles
// panel calls, and the interesting cases are the destructive ones: deleting a
// style that a family inherits from, or that a kind of block points at.
import { describe, it, expect } from 'vitest'
import {
  addCharacterStyle,
  addParagraphStyle,
  blockKindsUsing,
  deleteCharacterStyle,
  deleteParagraphStyle,
  findParagraphStyle,
  resolveCharacterStyle,
  resolveParagraphStyle,
  setBlockStyle,
  styleId,
  updateCharacterStyle,
  updateParagraphStyle,
  type DesignStyleSheet
} from '../../src/shared/designStyles'
import type { FlowParaStyle } from '../../src/shared/designFlow'

const base: FlowParaStyle = {
  fontSize: 10,
  lineHeight: 1.4,
  font: '10px Georgia',
  fontFamily: 'Georgia',
  align: 'left',
  color: '#111'
}

const sheet = (): DesignStyleSheet => ({
  paragraph: [
    { id: 'body', name: 'Body', props: { fontSize: 10, color: '#111', hyphenate: false } },
    { id: 'heading1', name: 'Heading 1', basedOn: 'body', props: { fontSize: 24, bold: true } },
    { id: 'kicker', name: 'Kicker', basedOn: 'heading1', props: { fontSize: 12, letterSpacing: 1 } }
  ],
  character: [
    { id: 'emphasis', name: 'Emphasis', props: { italic: true } },
    { id: 'strong-emphasis', name: 'Strong emphasis', basedOn: 'emphasis', props: { bold: true } }
  ],
  blockMap: { heading1: 'heading1', caption: 'kicker' }
})

describe('ids', () => {
  it('reads as the name, and never collides', () => {
    expect(styleId('Pull quote', [])).toBe('pull-quote')
    expect(styleId('Pull quote', ['pull-quote'])).toBe('pull-quote-2')
    expect(styleId('Pull quote', ['pull-quote', 'pull-quote-2'])).toBe('pull-quote-3')
  })

  it('always produces something, however unpromising the name', () => {
    expect(styleId('', [])).toBe('style')
    expect(styleId('…', [])).toBe('style')
    expect(styleId('…', ['style'])).toBe('style-2')
  })
})

describe('adding', () => {
  it('inherits from the style it was based on', () => {
    const { sheet: next, id } = addParagraphStyle(sheet(), { name: 'Standfirst', basedOn: 'body', props: { fontSize: 13 } })
    expect(id).toBe('standfirst')
    const r = resolveParagraphStyle(next, id, base)
    expect(r.fontSize).toBe(13)
    expect(r.color).toBe('#111')
  })

  it('ignores a basedOn that does not exist, rather than writing a dangling link', () => {
    const { sheet: next, id } = addParagraphStyle(sheet(), { name: 'Orphan', basedOn: 'nope' })
    expect(findParagraphStyle(next, id)?.basedOn).toBeUndefined()
  })

  it('does not touch the sheet it was given', () => {
    const s = sheet()
    addParagraphStyle(s, { name: 'New' })
    expect(s.paragraph).toHaveLength(3)
  })
})

describe('deleting a paragraph style', () => {
  it('re-bases its children onto its parent, so the family keeps what it inherited', () => {
    // Kicker is based on Heading 1, which is based on Body. Deleting Heading 1
    // must leave Kicker inheriting Body's ink, not nothing.
    const next = deleteParagraphStyle(sheet(), 'heading1')
    expect(findParagraphStyle(next, 'kicker')?.basedOn).toBe('body')
    expect(resolveParagraphStyle(next, 'kicker', { ...base, color: '#999' }).color).toBe('#111')
  })

  it('drops the basedOn entirely when the deleted style had no parent', () => {
    const s = sheet()
    s.paragraph.push({ id: 'free', name: 'Free', props: {} })
    s.paragraph.push({ id: 'child', name: 'Child', basedOn: 'free', props: {} })
    const next = deleteParagraphStyle(s, 'free')
    expect(findParagraphStyle(next, 'child')).toBeTruthy()
    expect('basedOn' in (findParagraphStyle(next, 'child') as object)).toBe(false)
  })

  it('removes it from the block map, so no kind of block points at nothing', () => {
    const next = deleteParagraphStyle(sheet(), 'kicker')
    expect(next.blockMap?.caption).toBeUndefined()
    expect(next.blockMap?.heading1).toBe('heading1')
  })

  it('refuses to delete Body, because every resolution ends there', () => {
    const s = sheet()
    expect(deleteParagraphStyle(s, 'body')).toBe(s)
  })

  it('is a no-op for a style that is not there', () => {
    const s = sheet()
    expect(deleteParagraphStyle(s, 'ghost')).toBe(s)
  })
})

describe('the block map', () => {
  it('points a kind of block at a style, and clears back to the default', () => {
    const next = setBlockStyle(sheet(), 'quote', 'kicker')
    expect(next.blockMap?.quote).toBe('kicker')
    expect(setBlockStyle(next, 'quote', null).blockMap?.quote).toBeUndefined()
  })

  it('ignores a style that does not exist', () => {
    expect(setBlockStyle(sheet(), 'quote', 'nope').blockMap?.quote).toBeUndefined()
  })

  it('says which kinds a style sets, including the ones named by convention', () => {
    expect(blockKindsUsing(sheet(), 'kicker')).toEqual(['caption'])
    expect(blockKindsUsing(sheet(), 'heading1')).toEqual(['heading1'])
    // Body is the conventional id for 'paragraph'? No: the key is 'paragraph',
    // so Body sets nothing by convention and everything by fallback.
    expect(blockKindsUsing(sheet(), 'body')).toEqual([])
  })
})

describe('character styles', () => {
  it('adds, updates and resolves through its chain', () => {
    const { sheet: s1, id } = addCharacterStyle(sheet(), { name: 'Small caps', props: { letterSpacing: 0.5 } })
    expect(id).toBe('small-caps')
    const s2 = updateCharacterStyle(s1, id, { props: { fontSize: 9 } })
    expect(resolveCharacterStyle(s2, id)).toEqual({ letterSpacing: 0.5, fontSize: 9 })
    // The patch merges into props rather than replacing them.
    expect(resolveCharacterStyle(s2, 'strong-emphasis')).toEqual({ italic: true, bold: true })
  })

  it('re-bases children when a parent is deleted', () => {
    const next = deleteCharacterStyle(sheet(), 'emphasis')
    expect(next.character?.find((s) => s.id === 'strong-emphasis')?.basedOn).toBeUndefined()
    expect(resolveCharacterStyle(next, 'strong-emphasis')).toEqual({ bold: true })
  })

  it('renames without disturbing the id anything else points at', () => {
    const next = updateCharacterStyle(sheet(), 'emphasis', { name: 'Italic' })
    expect(next.character?.find((s) => s.id === 'emphasis')?.name).toBe('Italic')
    expect(next.character?.find((s) => s.id === 'strong-emphasis')?.basedOn).toBe('emphasis')
  })
})

describe('renaming and editing a paragraph style', () => {
  it('keeps the id, so the block map and every basedOn still point at it', () => {
    const next = updateParagraphStyle(sheet(), 'heading1', { name: 'Headline' })
    expect(findParagraphStyle(next, 'heading1')?.name).toBe('Headline')
    expect(next.blockMap?.heading1).toBe('heading1')
    expect(findParagraphStyle(next, 'kicker')?.basedOn).toBe('heading1')
  })

  it('carries a change on the parent through the whole family', () => {
    // This is what a style sheet is for, and it is worth asserting once.
    const next = updateParagraphStyle(sheet(), 'body', { props: { color: '#c00' } })
    expect(resolveParagraphStyle(next, 'kicker', base).color).toBe('#c00')
  })

  it('turns hyphenation on for the family from one property', () => {
    const next = updateParagraphStyle(sheet(), 'body', { props: { hyphenate: true } })
    expect(resolveParagraphStyle(next, 'body', base).hyphenate).toBe(true)
    expect(resolveParagraphStyle(next, 'kicker', base).hyphenate).toBe(true)
  })
})
