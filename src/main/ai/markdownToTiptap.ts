// Minimal markdown -> Tiptap doc JSON converter for living-page output.
//
// Why hand-rolled: tiptap-markdown lives in the renderer (it's a Tiptap
// extension that mounts onto an editor instance). The main process produces
// content as a string and the renderer parses widget.content via JSON.parse,
// so we need a server-side path that yields the same Tiptap doc shape the
// renderer expects.
//
// The subset we support is exactly what the AI is asked to emit:
//   # / ## / ### headings
//   - / * bullets (incl. - [ ] todo and - [x] done)
//   1. ordered lists
//   > blockquotes
//   --- horizontal rule
//   ``` fenced code blocks (with an optional language) → codeBlock
//   blank lines separating paragraphs
//   inline: **bold**, *italic*, `code`, [text](url)
//
// Anything fancier falls through to a paragraph with raw text, so a hallucinated
// table doesn't crash the renderer.

interface TextNode {
  type: 'text'
  text: string
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>
}

interface BlockNode {
  type: string
  attrs?: Record<string, unknown>
  content?: Array<BlockNode | TextNode>
}

export interface TiptapDoc {
  type: 'doc'
  content: BlockNode[]
}

// Inline parser — bold/italic/code/link. Order matters: code first to skip
// formatting inside backticks; then links; then bold; then italic.
function parseInline(input: string): TextNode[] {
  const out: TextNode[] = []
  const push = (text: string, marks: TextNode['marks']): void => {
    if (!text) return
    out.push(marks && marks.length > 0 ? { type: 'text', text, marks } : { type: 'text', text })
  }

  // Tokenise by walking left-to-right and consuming the leftmost match each time.
  let rest = input
  // eslint-disable-next-line no-control-regex
  const inlineRe = /(`[^`\n]+`)|(\[([^\]]+)\]\(([^)\s]+)\))|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)/

  while (rest.length > 0) {
    const m = rest.match(inlineRe)
    if (!m || m.index === undefined) {
      push(rest, undefined)
      break
    }
    if (m.index > 0) push(rest.slice(0, m.index), undefined)
    const token = m[0]
    if (token.startsWith('`')) {
      push(token.slice(1, -1), [{ type: 'code' }])
    } else if (token.startsWith('[')) {
      const linkText = m[3]
      const href = m[4]
      push(linkText, [{ type: 'link', attrs: { href, target: '_blank' } }])
    } else if (token.startsWith('**')) {
      push(token.slice(2, -2), [{ type: 'bold' }])
    } else if (token.startsWith('*')) {
      push(token.slice(1, -1), [{ type: 'italic' }])
    }
    rest = rest.slice(m.index + token.length)
  }
  return out
}

function paragraph(text: string): BlockNode {
  return { type: 'paragraph', content: parseInline(text) }
}

// Convert AI-emitted markdown to a Tiptap doc. Robust against partial /
// malformed input — anything we can't classify becomes a paragraph.
export function markdownToTiptap(md: string): TiptapDoc {
  const lines = md.split(/\r?\n/)
  const out: BlockNode[] = []

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (!trimmed) {
      i++
      continue
    }

    // Fenced code block. Checked first: the lines inside are code, so a
    // "# comment" or "- item" in them must not become a heading or a list.
    // An unclosed fence runs to the end (a cut-off reply keeps its code).
    const fence = /^```\s*([\w+#.-]*)\s*$/.exec(trimmed)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        body.push(lines[i])
        i++
      }
      i++ // past the closing fence (or the end)
      const text = body.join('\n')
      out.push({
        type: 'codeBlock',
        attrs: { language: fence[1] || null },
        ...(text ? { content: [{ type: 'text', text }] } : {})
      })
      continue
    }

    // Horizontal rule
    if (/^---+$/.test(trimmed)) {
      out.push({ type: 'horizontalRule' })
      i++
      continue
    }

    // Headings (# / ## / ###)
    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed)
    if (heading) {
      out.push({
        type: 'heading',
        attrs: { level: heading[1].length },
        content: parseInline(heading[2])
      })
      i++
      continue
    }

    // Blockquote
    if (/^>\s?/.test(trimmed)) {
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        buf.push(lines[i].trim().replace(/^>\s?/, ''))
        i++
      }
      out.push({
        type: 'blockquote',
        content: [paragraph(buf.join(' '))]
      })
      continue
    }

    // Task list — "- [ ] item" or "- [x] item". Has to be checked BEFORE
    // generic bullet because [ ]/[x] starts the same way.
    if (/^[-*]\s+\[[ xX]\]\s/.test(trimmed)) {
      const items: BlockNode[] = []
      while (i < lines.length && /^[-*]\s+\[[ xX]\]\s/.test(lines[i].trim())) {
        const m = /^[-*]\s+\[([ xX])\]\s+(.*)$/.exec(lines[i].trim())
        if (!m) break
        const checked = m[1].toLowerCase() === 'x'
        items.push({
          type: 'taskItem',
          attrs: { checked },
          content: [paragraph(m[2])]
        })
        i++
      }
      out.push({ type: 'taskList', content: items })
      continue
    }

    // Bullet list
    if (/^[-*]\s+/.test(trimmed)) {
      const items: BlockNode[] = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        const m = /^[-*]\s+(.*)$/.exec(lines[i].trim())
        if (!m) break
        items.push({ type: 'listItem', content: [paragraph(m[1])] })
        i++
      }
      out.push({ type: 'bulletList', content: items })
      continue
    }

    // Ordered list
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: BlockNode[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        const m = /^\d+\.\s+(.*)$/.exec(lines[i].trim())
        if (!m) break
        items.push({ type: 'listItem', content: [paragraph(m[1])] })
        i++
      }
      out.push({ type: 'orderedList', content: items })
      continue
    }

    // Fallback: collapse consecutive non-blank lines into a single paragraph.
    const buf: string[] = []
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i].trim())) {
      buf.push(lines[i].trim())
      i++
    }
    out.push(paragraph(buf.join(' ')))
  }

  if (out.length === 0) {
    out.push({ type: 'paragraph', content: [] })
  }
  return { type: 'doc', content: out }
}

function isBlockStart(s: string): boolean {
  return (
    /^#{1,3}\s+/.test(s) ||
    /^[-*]\s+/.test(s) ||
    /^\d+\.\s+/.test(s) ||
    /^>\s?/.test(s) ||
    /^---+$/.test(s) ||
    /^```/.test(s)
  )
}
