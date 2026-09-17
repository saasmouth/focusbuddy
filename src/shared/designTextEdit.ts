// Editing a story's text with a caret — the model under typing on the page.
//
// A caret lives in DOCUMENT space: a block index, an optional list-item index,
// and a character offset. Document space (rather than "the nth character of the
// flowed text") is what survives a re-flow: the moment you type, every line
// position changes, but the block you are in and how far through it you are do
// not. That is why the caret does not jump when a word pushes onto the next
// page.
//
// Blocks that hold no editable text — an image, a divider — have no slot, so the
// caret steps over them rather than landing somewhere it cannot type.

import type { ContentBlock, ContentDoc } from './designContent'

export interface DocCaret {
  block: number
  /** Present only inside a list, naming which item. */
  item?: number
  offset: number
}

export interface DocSelection {
  anchor: DocCaret
  focus: DocCaret
}

/** One editable run of text: a paragraph, a heading, or a single list item. */
export interface EditSlot {
  block: number
  item?: number
  text: string
  kind: ContentBlock['kind']
}

export const EDITABLE_KINDS: ContentBlock['kind'][] = ['title', 'subtitle', 'heading', 'paragraph', 'quote', 'list']

/** Every editable run in the document, in reading order. */
export function slots(doc: ContentDoc): EditSlot[] {
  const out: EditSlot[] = []
  doc.blocks.forEach((b, block) => {
    if (b.kind === 'list') {
      b.items.forEach((text, item) => out.push({ block, item, text, kind: 'list' }))
    } else if (b.kind === 'image' || b.kind === 'divider' || b.kind === 'pagebreak') {
      // Nothing to type into.
    } else {
      out.push({ block, text: b.text, kind: b.kind })
    }
  })
  return out
}

export function slotIndex(doc: ContentDoc, caret: DocCaret): number {
  const all = slots(doc)
  return all.findIndex((s) => s.block === caret.block && (s.item ?? -1) === (caret.item ?? -1))
}

export function caretFromSlot(slot: EditSlot, offset: number): DocCaret {
  return slot.item === undefined ? { block: slot.block, offset } : { block: slot.block, item: slot.item, offset }
}

/** The text at a caret's slot, or '' when the caret points at nothing editable. */
export function textAt(doc: ContentDoc, caret: DocCaret): string {
  const b = doc.blocks[caret.block]
  if (!b) return ''
  if (b.kind === 'list') return b.items[caret.item ?? 0] ?? ''
  if (b.kind === 'image' || b.kind === 'divider' || b.kind === 'pagebreak') return ''
  return b.text
}

/** Pull a caret back onto a real slot and a real offset within it. */
export function clampCaret(doc: ContentDoc, caret: DocCaret): DocCaret {
  const all = slots(doc)
  if (all.length === 0) return { block: 0, offset: 0 }
  let i = all.findIndex((s) => s.block === caret.block && (s.item ?? -1) === (caret.item ?? -1))
  if (i < 0) {
    // The slot is gone (its block was deleted); land on the nearest one before it.
    i = Math.max(0, all.findIndex((s) => s.block >= caret.block))
    if (i < 0) i = all.length - 1
  }
  const slot = all[Math.max(0, Math.min(all.length - 1, i))]
  return caretFromSlot(slot, Math.max(0, Math.min(slot.text.length, caret.offset)))
}

/** -1, 0 or 1 — reading order, so a selection always knows which end is which. */
export function compareCarets(doc: ContentDoc, a: DocCaret, b: DocCaret): number {
  const ia = slotIndex(doc, a)
  const ib = slotIndex(doc, b)
  if (ia !== ib) return ia < ib ? -1 : 1
  if (a.offset === b.offset) return 0
  return a.offset < b.offset ? -1 : 1
}

export function isCollapsed(doc: ContentDoc, sel: DocSelection): boolean {
  return compareCarets(doc, sel.anchor, sel.focus) === 0
}

/** The selection in reading order, whichever way round it was made. */
export function orderedSelection(doc: ContentDoc, sel: DocSelection): { from: DocCaret; to: DocCaret } {
  return compareCarets(doc, sel.anchor, sel.focus) <= 0 ? { from: sel.anchor, to: sel.focus } : { from: sel.focus, to: sel.anchor }
}

function setSlotText(doc: ContentDoc, slot: { block: number; item?: number }, text: string): ContentDoc {
  const blocks = doc.blocks.map((b, i) => {
    if (i !== slot.block) return b
    if (b.kind === 'list') {
      return { ...b, items: b.items.map((it, j) => (j === (slot.item ?? 0) ? text : it)) }
    }
    if (b.kind === 'image' || b.kind === 'divider' || b.kind === 'pagebreak') return b
    return { ...b, text }
  })
  return { blocks }
}

/** The selected text, exactly as it reads — used by copy and cut. */
export function selectedText(doc: ContentDoc, sel: DocSelection): string {
  const { from, to } = orderedSelection(doc, sel)
  const all = slots(doc)
  const a = slotIndex(doc, from)
  const b = slotIndex(doc, to)
  if (a < 0 || b < 0) return ''
  if (a === b) return all[a].text.slice(from.offset, to.offset)
  const parts = [all[a].text.slice(from.offset)]
  for (let i = a + 1; i < b; i++) parts.push(all[i].text)
  parts.push(all[b].text.slice(0, to.offset))
  return parts.join('\n')
}

/**
 * Replace everything between two carets with `text`. This is the single
 * primitive: typing, deleting and pasting plain text are all one call to it.
 *
 * A selection spanning several blocks collapses into the FIRST block, which
 * keeps its kind — deleting across a heading and the paragraph under it leaves a
 * heading, the way every editor behaves.
 */
export function replaceRange(doc: ContentDoc, sel: DocSelection, text: string): { doc: ContentDoc; caret: DocCaret } {
  const all = slots(doc)
  if (all.length === 0) {
    const next: ContentDoc = { blocks: [{ kind: 'paragraph', text }] }
    return { doc: next, caret: { block: 0, offset: text.length } }
  }
  const { from, to } = orderedSelection(doc, sel)
  const a = slotIndex(doc, from)
  const b = slotIndex(doc, to)
  if (a < 0 || b < 0) return { doc, caret: clampCaret(doc, from) }

  const head = all[a].text.slice(0, from.offset)
  const tail = all[b].text.slice(to.offset)
  const merged = head + text + tail
  const caretOffset = head.length + text.length

  if (a === b) {
    return { doc: setSlotText(doc, all[a], merged), caret: caretFromSlot(all[a], caretOffset) }
  }

  // A multi-slot replacement: write the merged text into the first slot and drop
  // every slot it swallowed.
  const doomed = new Set<string>()
  for (let i = a + 1; i <= b; i++) doomed.add(`${all[i].block}:${all[i].item ?? -1}`)

  const blocks: ContentBlock[] = []
  doc.blocks.forEach((blk, bi) => {
    if (blk.kind === 'list') {
      const items = blk.items.filter((_, item) => !doomed.has(`${bi}:${item}`))
      const withEdit = items.length
        ? blk.items
            .map((it, item) => (bi === all[a].block && item === (all[a].item ?? -1) ? merged : it))
            .filter((_, item) => !doomed.has(`${bi}:${item}`))
        : []
      if (withEdit.length) blocks.push({ ...blk, items: withEdit })
      return
    }
    const key = `${bi}:-1`
    if (doomed.has(key)) return
    if (bi === all[a].block && all[a].item === undefined) {
      if (blk.kind === 'image' || blk.kind === 'divider' || blk.kind === 'pagebreak') blocks.push(blk)
      else blocks.push({ ...blk, text: merged } as ContentBlock)
      return
    }
    blocks.push(blk)
  })

  const nextDoc: ContentDoc = { blocks }
  return { doc: nextDoc, caret: clampCaret(nextDoc, caretFromSlot(all[a], caretOffset)) }
}

/** Type (or paste plain text) at the selection. */
export function insertText(doc: ContentDoc, sel: DocSelection, text: string): { doc: ContentDoc; caret: DocCaret } {
  return replaceRange(doc, sel, text)
}

/**
 * Enter: break the slot in two. A list item splits into a new item; everything
 * else splits into a new block. Breaking at the end of a heading gives a
 * PARAGRAPH, because the next thing after a heading is virtually never another
 * heading.
 */
export function splitAt(doc: ContentDoc, sel: DocSelection): { doc: ContentDoc; caret: DocCaret } {
  const cleared = isCollapsed(doc, sel) ? { doc, caret: orderedSelection(doc, sel).from } : replaceRange(doc, sel, '')
  const d = cleared.doc
  const caret = cleared.caret
  const blk = d.blocks[caret.block]
  if (!blk) return cleared

  if (blk.kind === 'list') {
    const item = caret.item ?? 0
    const text = blk.items[item] ?? ''
    const head = text.slice(0, caret.offset)
    const tail = text.slice(caret.offset)
    // Enter on an empty list item ends the list, the way it does everywhere.
    if (text === '') {
      const before: ContentBlock[] = blk.items.length > 1 ? [{ ...blk, items: blk.items.filter((_, i) => i !== item) }] : []
      const blocks = [...d.blocks.slice(0, caret.block), ...before, { kind: 'paragraph' as const, text: '' }, ...d.blocks.slice(caret.block + 1)]
      return { doc: { blocks }, caret: { block: caret.block + before.length, offset: 0 } }
    }
    const items = [...blk.items.slice(0, item), head, tail, ...blk.items.slice(item + 1)]
    return { doc: { blocks: d.blocks.map((b, i) => (i === caret.block ? { ...blk, items } : b)) }, caret: { block: caret.block, item: item + 1, offset: 0 } }
  }

  if (blk.kind === 'image' || blk.kind === 'divider' || blk.kind === 'pagebreak') return cleared

  const head = blk.text.slice(0, caret.offset)
  const tail = blk.text.slice(caret.offset)
  const nextKind: ContentBlock['kind'] = blk.kind === 'paragraph' || blk.kind === 'quote' ? blk.kind : 'paragraph'
  const first = { ...blk, text: head } as ContentBlock
  const second = (nextKind === 'quote' ? { kind: 'quote', text: tail } : { kind: 'paragraph', text: tail }) as ContentBlock
  const blocks = [...d.blocks.slice(0, caret.block), first, second, ...d.blocks.slice(caret.block + 1)]
  return { doc: { blocks }, caret: { block: caret.block + 1, offset: 0 } }
}

/** Backspace. At offset 0 it merges this slot into the one before it. */
export function deleteBackward(doc: ContentDoc, sel: DocSelection): { doc: ContentDoc; caret: DocCaret } {
  if (!isCollapsed(doc, sel)) return replaceRange(doc, sel, '')
  const caret = sel.focus
  if (caret.offset > 0) {
    return replaceRange(doc, { anchor: { ...caret, offset: caret.offset - 1 }, focus: caret }, '')
  }
  const all = slots(doc)
  const i = slotIndex(doc, caret)
  if (i <= 0) return { doc, caret }
  const prev = all[i - 1]
  return replaceRange(doc, { anchor: caretFromSlot(prev, prev.text.length), focus: caret }, '')
}

/** Delete forward. At the end of a slot it pulls the next one up into it. */
export function deleteForward(doc: ContentDoc, sel: DocSelection): { doc: ContentDoc; caret: DocCaret } {
  if (!isCollapsed(doc, sel)) return replaceRange(doc, sel, '')
  const caret = sel.focus
  const text = textAt(doc, caret)
  if (caret.offset < text.length) {
    return replaceRange(doc, { anchor: caret, focus: { ...caret, offset: caret.offset + 1 } }, '')
  }
  const all = slots(doc)
  const i = slotIndex(doc, caret)
  if (i < 0 || i >= all.length - 1) return { doc, caret }
  const next = all[i + 1]
  return replaceRange(doc, { anchor: caret, focus: caretFromSlot(next, 0) }, '')
}

/**
 * Paste structured content: the first pasted block merges into the slot the
 * caret is in, and the rest are inserted after it as their own blocks. That is
 * what makes pasting a Word document into the middle of a paragraph keep its
 * headings and lists instead of flattening into one run.
 */
export function insertBlocks(doc: ContentDoc, sel: DocSelection, incoming: ContentBlock[]): { doc: ContentDoc; caret: DocCaret } {
  const usable = incoming.filter((b) => b.kind !== 'pagebreak')
  if (usable.length === 0) return { doc, caret: clampCaret(doc, orderedSelection(doc, sel).from) }
  if (usable.length === 1 && usable[0].kind === 'paragraph') {
    return replaceRange(doc, sel, usable[0].text)
  }

  const cleared = isCollapsed(doc, sel) ? { doc, caret: orderedSelection(doc, sel).from } : replaceRange(doc, sel, '')
  const d = cleared.doc
  const caret = cleared.caret
  const all = slots(d)
  const i = slotIndex(d, caret)
  if (i < 0) return { doc: { blocks: [...d.blocks, ...usable] }, caret: clampCaret({ blocks: [...d.blocks, ...usable] }, caret) }

  const slot = all[i]
  const head = slot.text.slice(0, caret.offset)
  const tail = slot.text.slice(caret.offset)
  const first = usable[0]
  const rest = usable.slice(1)

  // The first incoming block's text joins whatever the caret was sitting in.
  const headText = head + (first.kind === 'list' ? first.items.join(' ') : 'text' in first ? first.text : '')
  let out = setSlotText(d, slot, headText)

  const trailing: ContentBlock[] = [...rest]
  if (tail) trailing.push({ kind: 'paragraph', text: tail })

  const at = slot.block + 1
  out = { blocks: [...out.blocks.slice(0, at), ...trailing, ...out.blocks.slice(at)] }

  const last = trailing[trailing.length - 1]
  if (!last) return { doc: out, caret: clampCaret(out, caretFromSlot(slot, headText.length)) }
  const lastBlock = at + trailing.length - 1
  const lastLen = last.kind === 'list' ? (last.items[last.items.length - 1]?.length ?? 0) : 'text' in last ? last.text.length : 0
  const lastItem = last.kind === 'list' ? last.items.length - 1 : undefined
  const endCaret: DocCaret = tail
    ? { block: lastBlock, offset: 0 }
    : lastItem === undefined
      ? { block: lastBlock, offset: lastLen }
      : { block: lastBlock, item: lastItem, offset: lastLen }
  return { doc: out, caret: clampCaret(out, endCaret) }
}

/** Turn the caret's block into a different kind — body, heading, quote, list. */
export function setBlockKind(doc: ContentDoc, caret: DocCaret, kind: 'paragraph' | 'heading1' | 'heading2' | 'heading3' | 'quote' | 'bullet' | 'ordered'): {
  doc: ContentDoc
  caret: DocCaret
} {
  const blk = doc.blocks[caret.block]
  if (!blk) return { doc, caret }
  const text = textAt(doc, caret)

  let next: ContentBlock
  if (kind === 'bullet' || kind === 'ordered') next = { kind: 'list', ordered: kind === 'ordered', items: [text] }
  else if (kind === 'quote') next = { kind: 'quote', text }
  else if (kind === 'paragraph') next = { kind: 'paragraph', text }
  else next = { kind: 'heading', level: kind === 'heading1' ? 1 : kind === 'heading2' ? 2 : 3, text }

  // Converting ONE item of a list splits the list around it, so the rest of the
  // list survives instead of being swallowed.
  if (blk.kind === 'list' && caret.item !== undefined) {
    const before = blk.items.slice(0, caret.item)
    const after = blk.items.slice(caret.item + 1)
    const replacement: ContentBlock[] = []
    if (before.length) replacement.push({ ...blk, items: before })
    replacement.push(next)
    if (after.length) replacement.push({ ...blk, items: after })
    const blocks = [...doc.blocks.slice(0, caret.block), ...replacement, ...doc.blocks.slice(caret.block + 1)]
    const at = caret.block + (before.length ? 1 : 0)
    const out = { blocks }
    return { doc: out, caret: clampCaret(out, next.kind === 'list' ? { block: at, item: 0, offset: caret.offset } : { block: at, offset: caret.offset }) }
  }

  const blocks = doc.blocks.map((b, i) => (i === caret.block ? next : b))
  const out = { blocks }
  return { doc: out, caret: clampCaret(out, next.kind === 'list' ? { block: caret.block, item: 0, offset: caret.offset } : { block: caret.block, offset: caret.offset }) }
}

// ── Caret movement ───────────────────────────────────────────────────────────

export function caretLeft(doc: ContentDoc, caret: DocCaret): DocCaret {
  if (caret.offset > 0) return { ...caret, offset: caret.offset - 1 }
  const all = slots(doc)
  const i = slotIndex(doc, caret)
  if (i <= 0) return caret
  return caretFromSlot(all[i - 1], all[i - 1].text.length)
}

export function caretRight(doc: ContentDoc, caret: DocCaret): DocCaret {
  const text = textAt(doc, caret)
  if (caret.offset < text.length) return { ...caret, offset: caret.offset + 1 }
  const all = slots(doc)
  const i = slotIndex(doc, caret)
  if (i < 0 || i >= all.length - 1) return caret
  return caretFromSlot(all[i + 1], 0)
}

export function caretHome(caret: DocCaret): DocCaret {
  return { ...caret, offset: 0 }
}

export function caretEnd(doc: ContentDoc, caret: DocCaret): DocCaret {
  return { ...caret, offset: textAt(doc, caret).length }
}

export function caretDocStart(doc: ContentDoc): DocCaret {
  const all = slots(doc)
  return all.length ? caretFromSlot(all[0], 0) : { block: 0, offset: 0 }
}

export function caretDocEnd(doc: ContentDoc): DocCaret {
  const all = slots(doc)
  return all.length ? caretFromSlot(all[all.length - 1], all[all.length - 1].text.length) : { block: 0, offset: 0 }
}

export function selectAll(doc: ContentDoc): DocSelection {
  return { anchor: caretDocStart(doc), focus: caretDocEnd(doc) }
}
