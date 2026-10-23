// The markdown a person types into a sticky, a note or a markdown work widget,
// read into PlexiiWrite's TipTap nodes. "Lite" on purpose: it covers what those
// widgets render (headings, bullet/numbered/task lists with nesting, quotes,
// fenced code, rules, GFM pipe tables, and bold/italic/strike/code/link), and
// anything else stays as the text the person wrote. Pure and deterministic.

import { looksLikeHeader, rowsToTableNode } from './rows'
import { padRows } from './tiptap'

type Node = Record<string, unknown>
type Mark = { type: string; attrs?: Record<string, unknown> }

// ── Inline ───────────────────────────────────────────────────────────────────

const INLINE = /(\*\*|__)(?=\S)([\s\S]*?\S)\1|~~(?=\S)([\s\S]*?\S)~~|(`+)([\s\S]*?)\4|\[([^\]]+)\]\(([^)\s]+)\)|(\*|_)(?=\S)([\s\S]*?\S)\8/

function textNode(text: string, marks: Mark[]): Node {
  return marks.length ? { type: 'text', text, marks: marks.map((m) => ({ ...m })) } : { type: 'text', text }
}

function unescape(s: string): string {
  return s.replace(/\\([\\`*_[\]~#>+\-.!|()])/g, '$1')
}

/** Inline markdown as TipTap text nodes with marks. */
export function inlineNodes(src: string, marks: Mark[] = []): Node[] {
  const out: Node[] = []
  let rest = src
  while (rest) {
    const m = INLINE.exec(rest)
    if (!m) {
      out.push(textNode(unescape(rest), marks))
      break
    }
    if (m.index > 0) out.push(textNode(unescape(rest.slice(0, m.index)), marks))
    if (m[1]) out.push(...inlineNodes(m[2], [...marks, { type: 'bold' }]))
    else if (m[3] !== undefined) out.push(...inlineNodes(m[3], [...marks, { type: 'strike' }]))
    else if (m[4]) {
      const code = m[5].replace(/^ (.*) $/, '$1')
      if (code) out.push(textNode(code, [...marks, { type: 'code' }]))
    } else if (m[6] !== undefined) out.push(...inlineNodes(m[6], [...marks, { type: 'link', attrs: { href: m[7] } }]))
    else if (m[8]) out.push(...inlineNodes(m[9], [...marks, { type: 'italic' }]))
    rest = rest.slice(m.index + m[0].length)
  }
  return out.filter((n) => n.text !== '')
}

function para(text: string, inline: boolean): Node {
  const content: Node[] = []
  text.split('\n').forEach((line, i) => {
    if (i > 0) content.push({ type: 'hardBreak' })
    if (line) content.push(...(inline ? inlineNodes(line) : [textNode(line, [])]))
  })
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' }
}

// ── Tables ───────────────────────────────────────────────────────────────────

const SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|'
      i++
    } else if (s[i] === '|') {
      cells.push(cur.trim())
      cur = ''
    } else cur += s[i]
  }
  cells.push(cur.trim())
  return cells
}

function isTableStart(lines: string[], i: number): boolean {
  return lines[i].includes('|') && i + 1 < lines.length && SEP.test(lines[i + 1]) && lines[i + 1].includes('-')
}

export interface PipeTable {
  rows: string[][]
  /** Lines outside the table that held text. */
  otherText: boolean
}

/** The first GFM pipe table in the text, cells unescaped. Null when there is none. */
export function firstPipeTable(text: string): PipeTable | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!isTableStart(lines, i)) continue
    const rows = [splitRow(lines[i])]
    let j = i + 2
    for (; j < lines.length && lines[j].includes('|') && lines[j].trim(); j++) rows.push(splitRow(lines[j]))
    const otherText = [...lines.slice(0, i), ...lines.slice(j)].some((l) => l.trim() !== '')
    return { rows: padRows(rows.map((r) => r.map(unescape))), otherText }
  }
  return null
}

// ── Blocks ───────────────────────────────────────────────────────────────────

const LIST = /^(\s*)([-*+•]|\d+[.)])\s+(\[( |x|X)\]\s+)?(.*)$/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const FENCE = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/

interface ListLine {
  indent: number
  ordered: boolean
  task: boolean
  checked: boolean
  start: number
  text: string
}

function readListLine(line: string, plain: boolean): ListLine | null {
  const m = LIST.exec(line)
  if (!m) return null
  const ordered = /\d/.test(m[2])
  // A sticky is plain text: "1." starting a line is a number, not always a list,
  // but a run of them is, and that is what a person means by typing them.
  if (plain && ordered && !/^\d+\.$/.test(m[2])) return null
  return {
    indent: m[1].replace(/\t/g, '  ').length,
    ordered,
    task: !!m[3],
    checked: !!m[4] && m[4].toLowerCase() === 'x',
    start: ordered ? parseInt(m[2], 10) || 1 : 1,
    text: m[5]
  }
}

/** Nested list nodes from consecutive list lines, nesting by indentation. */
function buildList(items: ListLine[], inline: boolean): Node {
  const first = items[0]
  const type = first.task ? 'taskList' : first.ordered ? 'orderedList' : 'bulletList'
  const itemType = first.task ? 'taskItem' : 'listItem'
  const content: Node[] = []
  let i = 0
  while (i < items.length) {
    const it = items[i]
    const children: ListLine[] = []
    let j = i + 1
    while (j < items.length && items[j].indent > it.indent) children.push(items[j++])
    const body: Node[] = [para(it.text, inline)]
    if (children.length) body.push(buildList(children, inline))
    content.push(first.task ? { type: itemType, attrs: { checked: it.checked }, content: body } : { type: itemType, content: body })
    i = j
  }
  return type === 'orderedList' && first.start !== 1 ? { type, attrs: { start: first.start }, content } : { type, content }
}

export interface MarkdownLiteOptions {
  /**
   * Plain text (a sticky): every line is its own paragraph and only the
   * obvious lists are read; no headings, quotes or inline marks.
   */
  plain?: boolean
}

/** Markdown-lite text as top-level TipTap nodes. Empty text gives no nodes. */
export function markdownLiteToNodes(text: string, opts: MarkdownLiteOptions = {}): Node[] {
  const plain = !!opts.plain
  const inline = !plain
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: Node[] = []
  let buf: string[] = []
  const flush = (): void => {
    if (buf.length) out.push(para(buf.join('\n'), inline))
    buf = []
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      flush()
      i++
      continue
    }
    if (plain) {
      const li = readListLine(line, true)
      if (li) {
        flush()
        const run: ListLine[] = []
        while (i < lines.length) {
          const next = readListLine(lines[i], true)
          if (!next || next.ordered !== li.ordered || next.task !== li.task) break
          run.push(next)
          i++
        }
        out.push(buildList(run.map((r) => ({ ...r, indent: 0 })), false))
        continue
      }
      out.push(para(line, false))
      i++
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++])
      i++
      const body = code.join('\n')
      out.push({ type: 'codeBlock', attrs: { language: fence[2] || null }, ...(body ? { content: [{ type: 'text', text: body }] } : {}) })
      continue
    }
    if (isTableStart(lines, i)) {
      flush()
      const rows = [splitRow(lines[i])]
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]))
      const cells = padRows(rows.map((r) => r.map(unescape)))
      // A pipe table always has a heading row in markdown, so it keeps one.
      out.push(rowsToTableNode(cells, looksLikeHeader(cells) || cells.length > 1))
      continue
    }
    const h = HEADING.exec(line)
    if (h) {
      flush()
      const content = inlineNodes(h[2])
      out.push({ type: 'heading', attrs: { level: h[1].length }, ...(content.length ? { content } : {}) })
      i++
      continue
    }
    if (RULE.test(line)) {
      flush()
      out.push({ type: 'horizontalRule' })
      i++
      continue
    }
    if (/^\s*>/.test(line)) {
      flush()
      const quoted: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ''))
      const inner = markdownLiteToNodes(quoted.join('\n'))
      out.push({ type: 'blockquote', content: inner.length ? inner : [{ type: 'paragraph' }] })
      continue
    }
    const li = readListLine(line, false)
    if (li) {
      flush()
      const run: ListLine[] = []
      const base = li.indent
      while (i < lines.length) {
        const next = readListLine(lines[i], false)
        if (!next) break
        if (next.indent <= base && (next.ordered !== li.ordered || next.task !== li.task)) break
        run.push(next)
        i++
      }
      out.push(buildList(run, true))
      continue
    }
    buf.push(line)
    i++
  }
  flush()
  return out
}
