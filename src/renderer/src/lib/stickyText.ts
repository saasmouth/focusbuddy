// Pure string transforms for the sticky note's markdown-lite body. A sticky
// stores plain text in widget.content; these classify and rewrite lines so
// checkboxes and bullets persist naturally in that same string with nothing new
// in the schema. Kept pure and separate from the component so the tick-and-
// reload behaviour is unit-testable.

export const STICKY_CHECK_RE = /^\[( |x|X)\]\s?(.*)$/
export const STICKY_BULLET_RE = /^[-*]\s+(.*)$/

// A GFM table row: starts (after optional space) with a pipe and has a closing
// pipe. A separator row is the "|---|---|" line (dashes, optional colons, pipes).
const TABLE_ROW_RE = /^\s*\|(.+)\|\s*$/
function isSeparatorRow(line: string): boolean {
  if (!/-/.test(line)) return false
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && /\|/.test(line)
}
function splitCells(rowLine: string): string[] {
  const m = TABLE_ROW_RE.exec(rowLine)
  const inner = m ? m[1] : rowLine.replace(/^\s*\|/, '').replace(/\|\s*$/, '')
  // A cell may hold an escaped pipe ("a \\| b", how a pasted or inserted
  // grid writes a value containing one): split only on bare pipes.
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

export type StickyBlock =
  | { type: 'table'; headers: string[]; rows: string[][] }
  // `index` is the original line number, so checkbox toggling stays correct.
  | { type: 'line'; text: string; index: number }

// Split a sticky body into blocks so the rendered view can show a pasted
// markdown table as a real table while everything else stays line-by-line. A
// table is a "| ... |" row immediately followed by a "|---|---|" separator.
export function splitStickyBlocks(text: string): StickyBlock[] {
  const lines = text.split('\n')
  const blocks: StickyBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const next = lines[i + 1]
    if (TABLE_ROW_RE.test(line) && next !== undefined && isSeparatorRow(next)) {
      const headers = splitCells(line)
      const rows: string[][] = []
      let j = i + 2
      while (j < lines.length && TABLE_ROW_RE.test(lines[j]) && !isSeparatorRow(lines[j])) {
        rows.push(splitCells(lines[j]))
        j++
      }
      blocks.push({ type: 'table', headers, rows })
      i = j
      continue
    }
    blocks.push({ type: 'line', text: line, index: i })
    i++
  }
  return blocks
}

export function hasChecklist(text: string): boolean {
  return text.split('\n').some((l) => STICKY_CHECK_RE.test(l.trim()))
}

// Flip one checklist line between done and not, addressed by line index. Lines
// that are not checklist lines are returned unchanged. Indentation is kept.
export function toggleCheckLine(text: string, lineIndex: number): string {
  return text
    .split('\n')
    .map((line, i) => {
      if (i !== lineIndex) return line
      const m = STICKY_CHECK_RE.exec(line.trim())
      if (!m) return line
      const done = m[1].toLowerCase() === 'x'
      const indent = line.slice(0, line.length - line.trimStart().length)
      return `${indent}[${done ? ' ' : 'x'}] ${m[2]}`
    })
    .join('\n')
}

// Turn the whole body into a checklist (prefix each non-empty line with an
// empty checkbox, replacing any leading bullet), or strip the checkboxes if it
// already is one.
export function toggleChecklist(text: string): string {
  const lines = text.split('\n')
  return hasChecklist(text)
    ? lines.map((l) => l.replace(/^(\s*)\[( |x|X)\]\s?/, '$1')).join('\n')
    : lines
        .map((l) => (l.trim() === '' ? l : l.replace(/^(\s*)(?:[-*]\s+)?/, '$1[ ] ')))
        .join('\n')
}
