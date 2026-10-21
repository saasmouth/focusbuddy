// The canvas's right-click menu: Illustrator's context menu, built from the
// SAME registered commands as the menu bar and the keys (Copy here is
// edit.copy, exactly what ⌘C and Edit › Copy run), so it can never do
// something different. Before 4.3.41 a right-click on the canvas showed no
// menu at all.

import { useEffect, useRef } from 'react'
import Icon from '../../../Icon'
import { commandById } from '../commands/registry'
import { commandShortcutLabel } from '../commands/keys'
import type { EditorCtx } from '../editor/types'

/** The commands, in groups (a separator between groups); ids that are not registered are left out. */
export const CANVAS_MENU: string[][] = [
  ['edit.undo', 'edit.redo'],
  ['edit.cut', 'edit.copy', 'edit.paste', 'edit.pasteInPlace', 'edit.copySvgCode'],
  ['object.group', 'object.ungroup', 'object.arrange.front', 'object.arrange.back'],
  ['artboard.new', 'artboard.fitToArtwork'],
  ['edit.duplicate', 'edit.delete'],
  ['edit.selectAll', 'edit.deselect']
]

export interface CanvasMenuEntry {
  id: string
  label: string
  icon?: string
  shortcut?: string
  enabled: boolean
}

/** What the menu shows now: every registered command in CANVAS_MENU, enabled exactly as the menu bar enables it. */
export function canvasMenuEntries(ctx: EditorCtx): Array<CanvasMenuEntry | 'sep'> {
  const out: Array<CanvasMenuEntry | 'sep'> = []
  for (const group of CANVAS_MENU) {
    const items: CanvasMenuEntry[] = []
    for (const id of group) {
      const c = commandById(id)
      if (!c) continue
      const label = id === 'edit.copySvgCode' ? 'Copy As SVG Code' : c.label
      const shortcut = commandShortcutLabel(id) ?? c.shortcut
      items.push({ id, label, ...(c.icon ? { icon: c.icon } : {}), ...(shortcut ? { shortcut } : {}), enabled: c.enabled ? c.enabled(ctx) : true })
    }
    if (!items.length) continue
    if (out.length) out.push('sep')
    out.push(...items)
  }
  return out
}

export default function CanvasContextMenu({ ctx, at, onClose }: { ctx: EditorCtx; at: { x: number; y: number }; onClose: () => void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const entries = canvasMenuEntries(ctx)
  useEffect(() => {
    function onDown(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])
  // Keep the menu on screen near the window's right and bottom edges.
  const left = Math.max(4, Math.min(at.x, window.innerWidth - 250))
  const top = Math.max(4, Math.min(at.y, window.innerHeight - entries.length * 30 - 16))
  return (
    <div
      ref={ref}
      role="menu"
      data-testid="draw-context-menu"
      className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in fixed z-50 min-w-[230px] py-1 select-none"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((it, i) =>
        it === 'sep' ? (
          <div key={`s${i}`} className="my-1 border-t border-[var(--edge-soft)]" />
        ) : (
          <button
            key={it.id}
            role="menuitem"
            data-testid={`draw-context-${it.id}`}
            disabled={!it.enabled}
            onClick={() => {
              onClose()
              ctx.run(it.id)
            }}
            className={`flex items-center gap-2.5 w-full px-3 py-1.5 text-[13px] text-left ${it.enabled ? 'text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]' : 'text-[var(--ink-30)] cursor-default'}`}
          >
            <span className="w-4 shrink-0 text-[var(--ink-50)]">{it.icon ? <Icon name={it.icon} size={15} /> : null}</span>
            <span className="flex-1 min-w-0 truncate">{it.label}</span>
            {it.shortcut && <span className="text-[11px] text-[var(--ink-40)] fb-tabular">{it.shortcut}</span>}
          </button>
        )
      )}
    </div>
  )
}
