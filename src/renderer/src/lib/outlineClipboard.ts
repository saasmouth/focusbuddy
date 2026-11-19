// A branch of a mind map on the clipboard, and an outline pasted into one.
//
// Copy writes the selected node and everything under it as an indented outline:
// text (one tab per level), which every outliner, note app and the assistant
// reads, and a nested HTML list, which documents and mail keep as a list.
// Paste reads an outline back: indented by tabs or spaces (the smallest indent
// in the paste is one level), with or without list marks (- * • 1. [ ]), one
// node per line. Blank lines are skipped.

export interface OutlineNode {
  label: string
  children: OutlineNode[]
}

export function outlineText(node: OutlineNode, depth = 0): string {
  const line = `${'\t'.repeat(depth)}${node.label.replace(/[\t\r\n]+/g, ' ')}`
  return [line, ...node.children.map((c) => outlineText(c, depth + 1))].join('\n')
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function outlineHtml(node: OutlineNode): string {
  const item = (n: OutlineNode): string =>
    `<li>${esc(n.label)}${n.children.length ? `<ul>${n.children.map(item).join('')}</ul>` : ''}</li>`
  return `<meta charset="utf-8"><ul>${item(node)}</ul>`
}

const MARK = /^(?:[-*•‣◦▪–]|\d{1,3}[.)]|\[[ xX✓✔]?\]|☐|☑)(?:\s+|$)/

/** The outline in pasted text, as a forest. Empty when there is nothing but blank lines. */
export function parseOutline(text: string): OutlineNode[] {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((raw) => {
      const lead = /^[\t ]*/.exec(raw)?.[0] ?? ''
      // A tab is one level; spaces are counted and scaled below.
      const tabs = (lead.match(/\t/g) ?? []).length
      const spaces = lead.length - tabs
      let label = raw.slice(lead.length).trim()
      // A mark that is the whole line is not a node; one before text is dropped.
      label = label.replace(MARK, '').replace(MARK, '').trim()
      return { tabs, spaces, label }
    })
    .filter((l) => l.label)
  if (!lines.length) return []
  const unit = Math.min(...lines.filter((l) => l.spaces > 0).map((l) => l.spaces), Infinity)
  const levelOf = (l: { tabs: number; spaces: number }): number => l.tabs + (Number.isFinite(unit) ? Math.round(l.spaces / unit) : 0)
  const roots: OutlineNode[] = []
  const stack: Array<{ level: number; node: OutlineNode }> = []
  for (const l of lines) {
    const node: OutlineNode = { label: l.label, children: [] }
    const level = levelOf(l)
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
    if (stack.length) stack[stack.length - 1].node.children.push(node)
    else roots.push(node)
    stack.push({ level, node })
  }
  return roots
}
