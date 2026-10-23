// Where in a textarea's text a screen point falls: the caret a drop at that
// point should land at (a file from the Files panel dropped on a sticky or a
// note).
//
// Chromium's caretPositionFromPoint answers inside a text control directly
// (offsetNode is the textarea, offset an index into its value). Where it does
// not, a mirror of the textarea (same box, font, padding, wrapping and scroll)
// is laid over it for one hit test with caretRangeFromPoint, which reads plain
// text nodes, and removed again. Null when neither can answer: the caller then
// lands at the caret it already has, or at the end.

/** The offset into `ta.value` nearest to the point, or null when it cannot be found. */
export function textareaCaretAt(ta: HTMLTextAreaElement, clientX: number, clientY: number): number | null {
  const doc = ta.ownerDocument
  const len = ta.value.length
  const clamp = (n: number): number => Math.max(0, Math.min(len, Math.round(n)))
  const cpf = (doc as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }).caretPositionFromPoint
  if (typeof cpf === 'function') {
    try {
      const p = cpf.call(doc, clientX, clientY)
      if (p && p.offsetNode === ta && Number.isFinite(p.offset)) return clamp(p.offset)
    } catch {
      // fall through to the mirror
    }
  }
  return mirrorCaret(ta, clientX, clientY)
}

const COPIED: readonly string[] = [
  'boxSizing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle',
  'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'fontVariant', 'fontStretch',
  'letterSpacing', 'wordSpacing', 'lineHeight', 'textTransform', 'textIndent', 'tabSize', 'direction'
]

function mirrorCaret(ta: HTMLTextAreaElement, clientX: number, clientY: number): number | null {
  const doc = ta.ownerDocument
  const win = doc.defaultView
  const crf = (doc as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint
  if (!win || typeof crf !== 'function') return null
  const rect = ta.getBoundingClientRect()
  if (!(rect.width > 0 && rect.height > 0)) return null
  const cs = win.getComputedStyle(ta)
  const m = doc.createElement('div')
  const st = m.style as unknown as Record<string, string>
  const from = cs as unknown as Record<string, string>
  for (const k of COPIED) st[k] = from[k]
  Object.assign(m.style, {
    position: 'fixed',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: '0',
    overflow: 'hidden',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    wordBreak: cs.wordBreak,
    borderColor: 'transparent',
    color: 'transparent',
    background: 'transparent',
    opacity: '0',
    pointerEvents: 'auto',
    zIndex: '2147483647'
  })
  // A zero-width space keeps a trailing newline's empty last line in the box.
  const text = doc.createTextNode(`${ta.value}​`)
  m.appendChild(text)
  doc.body.appendChild(m)
  try {
    m.scrollTop = ta.scrollTop
    m.scrollLeft = ta.scrollLeft
    const x = Math.max(rect.left + 1, Math.min(rect.right - 1, clientX))
    const y = Math.max(rect.top + 1, Math.min(rect.bottom - 1, clientY))
    const r = crf.call(doc, x, y)
    if (!r || r.startContainer !== text) return null
    return Math.max(0, Math.min(ta.value.length, r.startOffset))
  } catch {
    return null
  } finally {
    m.remove()
  }
}
