// The "@" typeahead popover (Phase 4.3). Controlled by the TipTap suggestion
// plugin exactly the way SlashMenuList is: the plugin feeds it items and
// forwards keystrokes through an imperative handle, so ↑/↓/Enter/Tab work while
// the editor keeps focus and the caret keeps blinking.

import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import Icon from '../Icon'
import PlexiiIcon from '../PlexiiIcon'
import { mentionKindLabel, type MentionRef } from '../../lib/assistantMentions'

export interface MentionListHandle {
  onKeyDown: (e: KeyboardEvent) => boolean
}

interface Props {
  items: MentionRef[]
  loading: boolean
  // Set when the reference set is already full — the picker says so rather than
  // silently doing nothing when a choice is made.
  atCap: boolean
  command: (item: MentionRef) => void
  // Belt-and-braces handle registration (DEC-028 fix): ReactRenderer's `.ref`
  // came back null on this React/tiptap pairing, so ↑/↓/Enter/Tab silently
  // fell through to the composer (Enter even SENT the half-typed mention as a
  // message). The suggestion plugin passes this callback and keeps whichever
  // handle it can get; the keyboard contract finally works either way.
  bindKeys?: (h: MentionListHandle | null) => void
}

const MentionList = forwardRef<MentionListHandle, Props>(function MentionList(
  { items, loading, atCap, command, bindKeys },
  ref
): JSX.Element {
  const [selected, setSelected] = useState(0)
  useEffect(() => setSelected(0), [items])

  const handle: MentionListHandle = {
    onKeyDown: (e: KeyboardEvent): boolean => {
      if (items.length === 0) return false
      if (e.key === 'ArrowDown') {
        setSelected((s) => (s + 1) % items.length)
        return true
      }
      if (e.key === 'ArrowUp') {
        setSelected((s) => (s - 1 + items.length) % items.length)
        return true
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const item = items[Math.min(selected, items.length - 1)]
        if (item) command(item)
        return true
      }
      return false
    }
  }
  useImperativeHandle(ref, () => handle)
  useEffect(() => {
    bindKeys?.(handle)
    return () => bindKeys?.(null)
  })

  if (atCap) {
    return (
      <div
        data-testid="mention-picker"
        data-mention-state="at-cap"
        className="w-72 rounded-lg border border-[var(--edge-soft)] bg-[var(--surface-raised)] shadow-xl p-2.5 text-[11.5px] text-[var(--ink-60)]"
      >
        This conversation already references the maximum number of items. Remove one to add another.
      </div>
    )
  }

  if (loading && items.length === 0) {
    return (
      <div
        data-testid="mention-picker"
        data-mention-state="loading"
        className="w-72 rounded-lg border border-[var(--edge-soft)] bg-[var(--surface-raised)] shadow-xl p-2.5 text-[11.5px] text-[var(--ink-40)]"
      >
        Searching…
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div
        data-testid="mention-picker"
        data-mention-state="empty"
        className="w-72 rounded-lg border border-[var(--edge-soft)] bg-[var(--surface-raised)] shadow-xl p-2.5 text-[11.5px] text-[var(--ink-40)]"
      >
        Nothing found. Mention a desk, document, work widget, file or PlexiiBrain entry.
      </div>
    )
  }

  return (
    <div
      data-testid="mention-picker"
      data-mention-state="results"
      className="w-72 max-h-72 overflow-auto rounded-lg border border-[var(--edge-soft)] bg-[var(--surface-raised)] shadow-xl py-1"
    >
      {items.map((item, i) => (
        <button
          key={`${item.kind}:${item.id}`}
          type="button"
          data-testid="mention-option"
          data-mention-id={item.id}
          aria-selected={i === selected}
          onMouseEnter={() => setSelected(i)}
          onClick={() => command(item)}
          // The highlight has to READ as "Enter/Tab takes this one" — a 10%
          // tint did not (operator live QA: "it doesn't automatically
          // highlight"). Tint + an accent left bar + full-strength ink.
          className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 text-left ${
            i === selected
              ? 'bg-accent/[0.14] shadow-[inset_2px_0_0_rgb(var(--accent))]'
              : 'hover:bg-[var(--surface-sunken)]'
          }`}
        >
          {item.entity ? (
            <PlexiiIcon kind={item.entity.kind} id={item.entity.id} size={17} fallback={item.icon} fallbackClassName="text-[var(--ink-70)]" className="shrink-0" />
          ) : (
            <Icon name={item.icon} size={15} className="shrink-0 text-[var(--ink-70)]" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block text-[12.5px] text-[var(--ink-90)] truncate">{item.title}</span>
            <span className="block text-[10.5px] text-[var(--ink-40)]">
              {mentionKindLabel(item.kind)}
            </span>
          </span>
        </button>
      ))}
    </div>
  )
})

export default MentionList
