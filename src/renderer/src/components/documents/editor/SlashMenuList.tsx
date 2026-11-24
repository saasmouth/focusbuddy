// The dropdown shown when the user types "/" in the document. It is a controlled
// list driven by the Tiptap suggestion plugin: the plugin feeds it items and
// forwards keyboard events through the imperative handle so arrow keys and Enter
// work while the editor keeps focus.

import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import Icon from '../../Icon'

export interface SlashItem {
  title: string
  subtitle: string
  icon: string
  /** The ribbon command this item is, when it is one; asked of offeredHere() like the ribbon's button. */
  commandId?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  command: (props: { editor: any; range: any }) => void
}

export interface SlashListHandle {
  onKeyDown: (e: KeyboardEvent) => boolean
}

interface Props {
  items: SlashItem[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  command: (item: SlashItem) => void
}

const SlashMenuList = forwardRef<SlashListHandle, Props>(function SlashMenuList(
  { items, command },
  ref
): JSX.Element {
  const [selected, setSelected] = useState(0)

  useEffect(() => setSelected(0), [items])

  useImperativeHandle(ref, () => ({
    onKeyDown: (e: KeyboardEvent): boolean => {
      if (e.key === 'ArrowDown') {
        setSelected((s) => (s + 1) % Math.max(1, items.length))
        return true
      }
      if (e.key === 'ArrowUp') {
        setSelected((s) => (s - 1 + items.length) % Math.max(1, items.length))
        return true
      }
      if (e.key === 'Enter') {
        const item = items[selected]
        if (item) command(item)
        return true
      }
      return false
    }
  }))

  if (items.length === 0) {
    return (
      <div className="fb-card w-64 p-2 text-[12px] text-[var(--ink-40)]">
        No matching command
      </div>
    )
  }

  return (
    <div
      data-testid="doc-slash-menu"
      className="fb-card w-64 max-h-72 overflow-auto py-1"
    >
      {items.map((item, i) => (
        <button
          key={item.title}
          onMouseEnter={() => setSelected(i)}
          onClick={() => command(item)}
          className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 text-left ${
            i === selected ? 'bg-accent/10' : 'hover:bg-[var(--surface-sunken)]'
          }`}
        >
          <span className="h-7 w-7 shrink-0 inline-flex items-center justify-center rounded bg-[var(--surface-sunken)] text-[var(--ink-70)]">
            <Icon name={item.icon} size={15} />
          </span>
          <span className="min-w-0">
            <span className="block text-[12.5px] font-medium text-[var(--ink-90)]">
              {item.title}
            </span>
            <span className="block text-[11px] text-[var(--ink-40)] truncate">{item.subtitle}</span>
          </span>
        </button>
      ))}
    </div>
  )
})

export default SlashMenuList
