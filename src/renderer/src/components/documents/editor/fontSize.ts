import type { Editor } from '@tiptap/react'

/**
 * The font size of the text at the caret, in whole pixels, whatever set it: a
 * size mark, a heading's style, the document's paragraph style or the page's
 * base size. Write's size field shows this when the text sets no size of its
 * own, so an empty document reads its real size instead of "—" (rails-tabs-41
 * shots). Measured from the DOM because the size can come from CSS that the
 * document model never sees (StylesPanel's heading styles, the prose layer).
 * Undefined while the editor is not on screen.
 */
export function caretFontSize(editor: Editor | null | undefined, styleOf: (el: Element) => CSSStyleDeclaration = (el) => getComputedStyle(el)): number | undefined {
  if (!editor || editor.isDestroyed) return undefined
  let view: Editor['view']
  try {
    view = editor.view
  } catch {
    return undefined // TipTap throws on .view before the editor mounts
  }
  if (!view?.dom?.isConnected) return undefined
  let node: Node
  try {
    node = view.domAtPos(editor.state.selection.from).node
    if (!node) return undefined
  } catch {
    return undefined
  }
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement
  if (!el) return undefined
  const px = parseFloat(styleOf(el).fontSize)
  return Number.isFinite(px) && px > 0 ? Math.round(px) : undefined
}
