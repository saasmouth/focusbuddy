// Headless readers over TipTap JSON (PlexiiWrite's stored document nodes):
// plain text, markdown, what a fragment contains, and its first table as rows.
// Pure, so the same reading runs in either process and in the tests.
//
// Node names are Write's own: StarterKit's paragraph/heading/bulletList/
// orderedList/listItem/blockquote/codeBlock/horizontalRule/hardBreak, TaskKit's
// taskList/taskItem, TableKit's table/tableRow/tableHeader/tableCell (cells hold
// paragraphs), and Image's `image` (ResizableImage extends it with `width`).

export interface TipNode {
  type?: string
  attrs?: Record<string, unknown>
  content?: TipNode[]
  text?: string
  marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>
}

function asNode(v: unknown): TipNode {
  return v && typeof v === 'object' ? (v as TipNode) : {}
}

function kids(n: TipNode): TipNode[] {
  return Array.isArray(n.content) ? n.content.map(asNode) : []
}

/** Inline atoms that stand for text: a mention's label, a footnote's marker. */
function atomText(n: TipNode): string {
  const a = n.attrs ?? {}
  for (const k of ['label', 'text', 'title']) if (typeof a[k] === 'string' && a[k]) return a[k] as string
  return ''
}

/** The text of an inline run, hard breaks as newlines. */
export function inlineText(n: TipNode): string {
  if (typeof n.text === 'string') return n.text
  if (n.type === 'hardBreak') return '\n'
  const inner = kids(n)
  if (!inner.length) return atomText(n)
  return inner.map(inlineText).join('')
}

const TEXTBLOCKS = new Set(['paragraph', 'heading', 'codeBlock'])

/**
 * The fragment as plain text: one line per paragraph, heading, list item and
 * table row (cells tab-separated), code blocks kept line for line. Pictures and
 * rules add nothing. No trailing newline.
 */
export function nodesToPlainText(nodes: unknown[]): string {
  const lines: string[] = []
  const walk = (n: TipNode): void => {
    if (n.type && TEXTBLOCKS.has(n.type)) {
      lines.push(...inlineText(n).split('\n'))
      return
    }
    if (n.type === 'tableRow') {
      lines.push(kids(n).map((cell) => cellText(cell).replace(/\n/g, ' ')).join('\t'))
      return
    }
    for (const k of kids(n)) walk(k)
  }
  for (const n of nodes) walk(asNode(n))
  // Write keeps an empty paragraph after a trailing table; it is not text.
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

/** The non-empty lines of the fragment's text, trimmed. */
export function nodesToLines(nodes: unknown[]): string[] {
  return nodesToPlainText(nodes)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

function cellText(cell: TipNode): string {
  return kids(cell)
    .map((b) => (b.type && TEXTBLOCKS.has(b.type) ? inlineText(b) : nodesToPlainText([b])))
    .join('\n')
}

// ── What a fragment holds ────────────────────────────────────────────────────

export interface DocFeatures {
  tables: number
  images: number
  /** Image nodes whose src is not embedded bytes (a file path or a web URL). */
  linkedImages: number
  headings: number
  lists: number
  quotes: number
  codeBlocks: number
  /** Every mark name used anywhere (bold, italic, link, textStyle…). */
  marks: Set<string>
  /** Node types outside the plain prose set (embeds, footnotes, a table of contents…). */
  other: Set<string>
}

const PROSE = new Set([
  'doc', 'paragraph', 'text', 'hardBreak', 'heading', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem',
  'blockquote', 'codeBlock', 'horizontalRule', 'table', 'tableRow', 'tableHeader', 'tableCell', 'image'
])

export function docFeatures(nodes: unknown[]): DocFeatures {
  const f: DocFeatures = { tables: 0, images: 0, linkedImages: 0, headings: 0, lists: 0, quotes: 0, codeBlocks: 0, marks: new Set(), other: new Set() }
  const walk = (n: TipNode): void => {
    switch (n.type) {
      case 'table':
        f.tables++
        break
      case 'image': {
        f.images++
        const src = typeof n.attrs?.src === 'string' ? n.attrs.src : ''
        if (!src.startsWith('data:')) f.linkedImages++
        break
      }
      case 'heading':
        f.headings++
        break
      case 'bulletList':
      case 'orderedList':
      case 'taskList':
        f.lists++
        break
      case 'blockquote':
        f.quotes++
        break
      case 'codeBlock':
        f.codeBlocks++
        break
    }
    if (n.type && !PROSE.has(n.type)) f.other.add(n.type)
    for (const m of n.marks ?? []) if (m?.type) f.marks.add(m.type)
    for (const k of kids(n)) walk(k)
  }
  for (const n of nodes) walk(asNode(n))
  return f
}

// ── First table as rows ──────────────────────────────────────────────────────

export interface TableRows {
  rows: string[][]
  /** Every cell of the first row is a header cell. */
  header: boolean
  /** A cell spanned several columns or rows; the grid repeats nothing into the gap. */
  spans: boolean
}

/** The first table in the fragment (depth first), as rows of cell text. Null when there is none. */
export function firstTableRows(nodes: unknown[]): TableRows | null {
  const find = (n: TipNode): TipNode | null => {
    if (n.type === 'table') return n
    for (const k of kids(n)) {
      const hit = find(k)
      if (hit) return hit
    }
    return null
  }
  let table: TipNode | null = null
  for (const n of nodes) {
    table = find(asNode(n))
    if (table) break
  }
  if (!table) return null
  let spans = false
  const trs = kids(table).filter((r) => r.type === 'tableRow')
  const rows = trs.map((tr) => {
    const out: string[] = []
    for (const cell of kids(tr)) {
      out.push(cellText(cell))
      const colspan = Number(cell.attrs?.colspan ?? 1)
      const rowspan = Number(cell.attrs?.rowspan ?? 1)
      if (colspan > 1 || rowspan > 1) spans = true
      for (let i = 1; i < colspan; i++) out.push('')
    }
    return out
  })
  const first = trs[0]
  const header = !!first && kids(first).length > 0 && kids(first).every((c) => c.type === 'tableHeader')
  return { rows: padRows(rows), header, spans }
}

/** Ragged rows padded with empty cells to the widest row. */
export function padRows(rows: string[][]): string[][] {
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0)
  return rows.map((r) => [...r, ...Array<string>(Math.max(0, cols - r.length)).fill('')])
}

// ── Markdown ─────────────────────────────────────────────────────────────────

const MD_INLINE_ESCAPE = /([\\`*_[\]~])/g

function escapeInline(s: string): string {
  return s.replace(MD_INLINE_ESCAPE, '\\$1')
}

/** A line that would read as block syntax if left bare is escaped at its start. */
function escapeLineStart(line: string): string {
  return line.replace(/^(\s*)(#{1,6}\s|>|[-+]\s|\d+[.)]\s)/, (_m, sp: string, tok: string) => `${sp}\\${tok}`)
}

function wrapKeepingSpace(s: string, open: string, close = open): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s)
  if (!m || !m[2]) return s
  return `${m[1]}${open}${m[2]}${close}${m[3]}`
}

function inlineMarkdown(n: TipNode): string {
  if (n.type === 'hardBreak') return '\\\n'
  if (typeof n.text === 'string') {
    const marks = new Map((n.marks ?? []).filter((m) => m?.type).map((m) => [m.type as string, m.attrs ?? {}]))
    let s = marks.has('code') ? codeSpan(n.text) : escapeInline(n.text)
    if (marks.has('bold')) s = wrapKeepingSpace(s, '**')
    if (marks.has('italic')) s = wrapKeepingSpace(s, '*')
    if (marks.has('strike')) s = wrapKeepingSpace(s, '~~')
    const link = marks.get('link')
    if (link && typeof link.href === 'string' && link.href) s = `[${s}](${link.href.replace(/[()\s]/g, encodeURIComponent)})`
    return s
  }
  if (n.type === 'image') return imageMarkdown(n)
  const inner = kids(n)
  return inner.length ? inner.map(inlineMarkdown).join('') : escapeInline(atomText(n))
}

/** A code span that survives backticks inside it: a fence one longer than the longest run. */
function codeSpan(text: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((m, run) => Math.max(m, run.length), 0)
  const fence = '`'.repeat(longest + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

function imageMarkdown(n: TipNode): string {
  const src = typeof n.attrs?.src === 'string' ? n.attrs.src : ''
  const alt = typeof n.attrs?.alt === 'string' ? n.attrs.alt : ''
  return src ? `![${escapeInline(alt)}](${src.replace(/[()\s]/g, encodeURIComponent)})` : ''
}

function textblockMarkdown(n: TipNode): string {
  return kids(n)
    .map(inlineMarkdown)
    .join('')
    .split('\n')
    .map((l, i) => (i === 0 ? escapeLineStart(l) : l))
    .join('\n')
}

function indent(text: string, pad: string, first: string): string {
  return text
    .split('\n')
    .map((l, i) => (i === 0 ? first + l : l ? pad + l : l))
    .join('\n')
}

function listMarkdown(n: TipNode): string {
  const start = Number(n.attrs?.start ?? 1) || 1
  return kids(n)
    .map((item, i) => {
      let marker = '- '
      if (n.type === 'orderedList') marker = `${start + i}. `
      else if (n.type === 'taskList') marker = `- [${item.attrs?.checked ? 'x' : ' '}] `
      const body = kids(item).map(blockMarkdown).filter((b) => b !== '').join('\n')
      return indent(body, ' '.repeat(marker.length), marker)
    })
    .join('\n')
}

function cellMarkdown(cell: TipNode): string {
  return kids(cell)
    .map((b) => (b.type === 'paragraph' || b.type === 'heading' ? kids(b).map(inlineMarkdown).join('') : nodesToPlainText([b])))
    .join(' ')
    .replace(/\\\n|\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim()
}

function tableMarkdown(n: TipNode): string {
  const rows = padRows(
    kids(n)
      .filter((r) => r.type === 'tableRow')
      .map((r) => kids(r).map(cellMarkdown))
  )
  return gfmTable(rows)
}

/** A GFM table. The first row is always the heading row: GFM has no table without one. */
export function gfmTable(rows: string[][]): string {
  const padded = padRows(rows)
  if (!padded.length || !padded[0].length) return ''
  const line = (r: string[]): string => `| ${r.map((c) => c || ' ').join(' | ')} |`
  const [head, ...body] = padded
  return [line(head), `| ${head.map(() => '---').join(' | ')} |`, ...body.map(line)].join('\n')
}

function blockMarkdown(n: TipNode): string {
  switch (n.type) {
    case 'paragraph':
      return textblockMarkdown(n)
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(n.attrs?.level ?? 1) || 1))
      return `${'#'.repeat(level)} ${kids(n).map(inlineMarkdown).join('').replace(/\\\n/g, ' ')}`
    }
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return listMarkdown(n)
    case 'blockquote':
      return kids(n)
        .map(blockMarkdown)
        .filter((b) => b !== '')
        .join('\n\n')
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n')
    case 'codeBlock': {
      const lang = typeof n.attrs?.language === 'string' ? n.attrs.language : ''
      const code = inlineText(n)
      const fence = code.includes('```') ? '~~~' : '```'
      return `${fence}${lang}\n${code}\n${fence}`
    }
    case 'horizontalRule':
      return '---'
    case 'table':
      return tableMarkdown(n)
    case 'image':
      return imageMarkdown(n)
    default: {
      const inner = kids(n)
      if (!inner.length) return escapeInline(atomText(n))
      // An inline-only wrapper reads as one paragraph; a block wrapper as its blocks.
      if (inner.every((k) => typeof k.text === 'string' || k.type === 'hardBreak')) return textblockMarkdown(n)
      return inner.map(blockMarkdown).filter((b) => b !== '').join('\n\n')
    }
  }
}

/**
 * TipTap nodes as GitHub-flavoured markdown: headings, paragraphs, bullet,
 * ordered and task lists (nested), quotes, fenced code, rules, tables, images,
 * hard breaks, and the bold/italic/strike/code/link marks. Anything else keeps
 * its text. Deterministic: the same nodes always give the same string.
 */
export function tiptapToMarkdown(nodes: unknown[]): string {
  return nodes
    .map((n) => blockMarkdown(asNode(n)))
    .filter((b) => b !== '')
    .join('\n\n')
}
