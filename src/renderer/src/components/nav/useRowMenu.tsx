import { useState } from 'react'
import CanvasContextMenu, { type CtxMenuItem } from '../CanvasContextMenu'
import { focusInvoker } from '../../lib/objectMenu'

/**
 * A right-click menu for one side-menu row or tile, on the context-menu kit.
 * `open(e, build)` builds the items at the moment of the click (so a desk
 * opened since the last render counts) and opens the menu; render `menu`
 * anywhere in the row. Focus goes to the row first so Escape returns to it.
 */
export function useRowMenu(): {
  open: (e: React.MouseEvent, build: () => CtxMenuItem[]) => void
  menu: JSX.Element | null
} {
  const [at, setAt] = useState<{ x: number; y: number; items: CtxMenuItem[] } | null>(null)
  const open = (e: React.MouseEvent, build: () => CtxMenuItem[]): void => {
    const items = build()
    if (!items.length) return
    e.preventDefault()
    e.stopPropagation()
    focusInvoker(e)
    setAt({ x: e.clientX, y: e.clientY, items })
  }
  const menu = at ? <CanvasContextMenu x={at.x} y={at.y} items={at.items} onClose={() => setAt(null)} /> : null
  return { open, menu }
}

/** A wrapper for a row or tile rendered in a list: right-click opens `build()`'s menu. */
export function RowMenu({ build, children }: { build: () => CtxMenuItem[]; children: React.ReactNode }): JSX.Element {
  const { open, menu } = useRowMenu()
  return (
    <div onContextMenu={(e) => open(e, build)}>
      {children}
      {menu}
    </div>
  )
}
