// Where the caret actually is, in viewport pixels.
//
// A <textarea> has no Range API, so the only way to know where a character sits
// is to draw the same text somewhere you CAN measure. This mirrors the field
// into an off-screen div carrying its exact typography and box metrics, puts a
// marker at the caret, and reads the marker's position back.
//
// It matters because a picker anchored to the bottom of the FIELD rather than
// to the `@` is disorienting in exactly the way autocomplete must not be: in a
// tall note the menu opens inches away from what you are typing.

// Everything that changes where a glyph lands. Miss one and the mirror wraps
// differently from the real field, which is worse than not measuring at all --
// it is confidently wrong.
const MIRRORED = [
  'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth',
  'borderLeftWidth', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'fontSizeAdjust',
  'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent',
  'textDecoration', 'letterSpacing', 'wordSpacing', 'tabSize', 'whiteSpace',
  'wordBreak', 'overflowWrap'
] as const

export interface CaretPoint {
  /** Viewport coordinates of the caret's top-left. */
  left: number
  top: number
  /** Bottom of the caret's line, for placing a menu under it. */
  bottom: number
}

export function caretCoordinates(
  field: HTMLTextAreaElement | HTMLInputElement,
  index: number
): CaretPoint {
  const doc = field.ownerDocument
  const style = window.getComputedStyle(field)
  const mirror = doc.createElement('div')

  mirror.style.position = 'absolute'
  mirror.style.visibility = 'hidden'
  mirror.style.top = '0'
  mirror.style.left = '-9999px'
  // An <input> never wraps; a <textarea> does. Getting this backwards puts the
  // marker on the wrong line for every multi-line note.
  mirror.style.whiteSpace = field instanceof HTMLInputElement ? 'pre' : 'pre-wrap'
  mirror.style.overflowWrap = 'break-word'
  for (const prop of MIRRORED) {
    mirror.style[prop as never] = style[prop as never]
  }

  mirror.textContent = field.value.slice(0, index)
  const marker = doc.createElement('span')
  // A zero-width span collapses; one real character gives the line its height
  // and the marker a position to report.
  marker.textContent = field.value.slice(index) || '.'
  mirror.appendChild(marker)
  doc.body.appendChild(mirror)

  const rect = field.getBoundingClientRect()
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2
  const left = rect.left + marker.offsetLeft - field.scrollLeft
  const top = rect.top + marker.offsetTop - field.scrollTop

  doc.body.removeChild(mirror)

  return { left, top, bottom: top + lineHeight }
}
