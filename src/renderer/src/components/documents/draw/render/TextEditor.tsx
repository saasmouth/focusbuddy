import { useStore } from 'zustand'
import { artboardsBounds, deleteObjects, getObject, mapObject, nodeFrame } from '@shared/draw/ops'
import { fontShorthand } from '../textMeasure'
import { resolveKey } from '../commands/keys'
import type { EditorCtx } from '../editor/types'

/**
 * The in-place box for typing into a text object. One undo step covers the
 * whole session: creating the box pushed it, and the keystrokes since then go
 * through `replace`. An empty box the user walks away from is removed rather
 * than left as an invisible, unselectable object.
 */
export default function TextEditor({ ctx }: { ctx: EditorCtx }): JSX.Element | null {
  const editingText = useStore(ctx.store, (s) => s.editingText)
  const doc = useStore(ctx.store, (s) => s.doc)
  const zoom = useStore(ctx.store, (s) => s.zoom)
  const editing = editingText ? getObject(doc, editingText) : null
  const o = editing && editing.type === 'text' ? editing : null
  if (!o) return null
  // Positioned on the stage, whose top-left is the artboards' union's.
  const board = artboardsBounds(doc)
  return (
    <textarea
      autoFocus
      data-text-editing="1"
      value={o.text}
      data-testid="draw-text-editor"
      onChange={(e) => {
        const next = ctx.text.measure({ ...o, text: e.target.value })
        ctx.history.replace(mapObject(ctx.doc(), o.id, () => next))
      }}
      onBlur={() => {
        if (!o.text.trim()) {
          ctx.history.commit(deleteObjects(ctx.doc(), [o.id]), 'Delete')
          ctx.select([])
        }
        ctx.set({ editingText: null })
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur()
        // Save works while typing, as in Illustrator. Every keystroke is already
        // in the document (history.replace above), so nothing typed is lost.
        // Only where the host saves on request; otherwise ⌘S is left alone.
        else if (ctx.host.saveRequest?.()) {
          const hit = resolveKey(e.nativeEvent)
          if (hit?.kind === 'command' && hit.id === 'file.save') {
            e.preventDefault()
            ctx.run('file.save')
          }
        }
        e.stopPropagation()
      }}
      className="absolute bg-transparent outline outline-1 outline-[var(--accent)] resize-none overflow-hidden"
      style={{
        left: (o.x - board.x) * zoom,
        top: (o.y - board.y) * zoom,
        width: o.w * zoom,
        height: Math.max(nodeFrame(o).h, o.fontSize) * zoom,
        font: fontShorthand({ ...o, fontSize: o.fontSize * zoom }),
        lineHeight: String(o.lineHeight ?? 1.2),
        letterSpacing: `${(o.letterSpacing ?? 0) * zoom}px`,
        textAlign: o.align ?? 'left',
        color: o.fill.type === 'solid' ? o.fill.color : '#1c1917'
      }}
    />
  )
}
