import { useEffect, useRef, useState } from 'react'
import type { AiContextCard } from '@shared/types'
import Icon from '../Icon'

// The context cards (ADR-0011).
//
// Before an AI request goes out, the app shows what of YOUR work it could
// include — the widgets on this desk and the files in Files whose names or
// content match what you typed. Each is a card with one action: Add to
// prompt. Nothing is attached until you press it.
//
// Rejecting is deliberately NOT the same as ignoring, even though both end
// with the item unsent. Ignoring leaves the card there, and a row of cards you
// have to keep re-reading is how a consent control turns into wallpaper you
// click through. Reject removes it for this session, so the list shrinks to
// the ones you are actually deciding about.
//
// The proposal call reads the local database and returns descriptions. It
// sends nothing — not the prompt, not the content — which is what makes it
// safe to run on every keystroke-ish refresh while the user is still typing.

interface Props {
  prompt: string
  taskId: string | null
  /** Ids the user has added. Owned by the parent: it makes the AI call. */
  added: Set<string>
  onToggle: (id: string) => void
  /** Hidden while the request is running, so cards cannot change under it. */
  disabled?: boolean
}

export default function ContextCards({
  prompt,
  taskId,
  added,
  onToggle,
  disabled
}: Props): JSX.Element | null {
  const [cards, setCards] = useState<AiContextCard[]>([])
  const [rejected, setRejected] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState(true)
  // Guards an out-of-order response overwriting a newer one: the user keeps
  // typing, and a slow proposal for three words back must not win.
  const seq = useRef(0)

  useEffect(() => {
    const text = prompt.trim()
    if (text.length < 8) {
      setCards([])
      return
    }
    const mine = ++seq.current
    const timer = setTimeout(() => {
      void window.api.aiContext
        .propose({ prompt: text, taskId })
        .then((found) => {
          if (seq.current === mine) setCards(found)
        })
        .catch(() => {
          // A proposal that fails leaves the user exactly where they were:
          // no cards, and a request that sends only what they typed.
          if (seq.current === mine) setCards([])
        })
    }, 400)
    return () => clearTimeout(timer)
  }, [prompt, taskId])

  const visible = cards.filter((c) => !rejected.has(c.id))
  if (visible.length === 0) return null

  const addedCount = visible.filter((c) => added.has(c.id)).length

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[11px] text-[var(--ink-50)] hover:text-[var(--ink-80)] transition-colors"
      >
        <Icon name={open ? 'expand_more' : 'chevron_right'} size={14} />
        <span>
          {visible.length} thing{visible.length === 1 ? '' : 's'} from your workspace look related
        </span>
        {addedCount > 0 && (
          <span className="text-accent">· {addedCount} added</span>
        )}
      </button>

      {open && (
        <div className="mt-1.5 flex flex-col gap-1">
          {visible.map((c) => {
            const isAdded = added.has(c.id)
            return (
              <div
                key={c.id}
                className={`group flex items-start gap-2 rounded-[10px] px-2.5 py-1.5 border transition-colors ${
                  isAdded
                    ? 'border-[var(--accent-40)] bg-[var(--accent-10)]'
                    : 'border-[var(--edge-soft)] hover:bg-[var(--surface-raise)]'
                }`}
              >
                <Icon
                  name={c.kind === 'file' ? 'description' : 'widgets'}
                  size={14}
                  className="mt-0.5 shrink-0 text-[var(--ink-40)]"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className="truncate text-[12px] text-[var(--ink-90)]">{c.label}</span>
                    <span className="shrink-0 text-[10px] text-[var(--ink-40)]">{c.detail}</span>
                  </div>
                  <div className="truncate text-[10px] text-[var(--ink-40)]" title={c.preview}>
                    {c.why}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onToggle(c.id)}
                  className={`shrink-0 rounded-[7px] px-2 py-0.5 text-[11px] transition-colors ${
                    isAdded
                      ? 'text-accent hover:bg-[var(--surface-raise)]'
                      : 'text-[var(--ink-60)] hover:text-[var(--ink-100)] hover:bg-[var(--surface-raise)]'
                  }`}
                >
                  {isAdded ? 'Added' : 'Add to prompt'}
                </button>
                <button
                  type="button"
                  aria-label={`Don't send ${c.label}`}
                  title="Don't send this"
                  disabled={disabled}
                  onClick={() => {
                    // Rejecting also un-adds: pressing "don't send" on
                    // something already added must actually not send it.
                    if (added.has(c.id)) onToggle(c.id)
                    setRejected((r) => new Set(r).add(c.id))
                  }}
                  className="shrink-0 rounded-[7px] p-0.5 text-[var(--ink-30)] opacity-0 transition-opacity hover:text-[var(--ink-70)] group-hover:opacity-100"
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
