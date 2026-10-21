// The one-time card shown the first time PlexiiDraw opens after the switch to
// Illustrator's keys: exactly what moved (old -> new), a link to every
// shortcut, and a dismissal kept per profile.

import { useState } from 'react'
import Icon from '../../../Icon'
import type { EditorCtx } from '../editor/types'
import { changeNote, dismissNotice, KEY_CHANGES, noticeDismissed } from '../commands/keyChanges'
import { formatKey } from '../commands/keys'

export default function KeysNotice({ ctx }: { ctx: EditorCtx }): JSX.Element | null {
  const [open, setOpen] = useState(() => !noticeDismissed())
  if (!open) return null
  const close = (): void => {
    dismissNotice()
    setOpen(false)
  }
  return (
    <div
      role="status"
      aria-labelledby="draw-keys-notice-title"
      data-testid="draw-keys-notice"
      className="shrink-0 mx-2 mt-1.5 mb-0.5 px-3 py-2 rounded-[var(--radius-row)] border border-[var(--edge-soft)] bg-[var(--surface-sunken)] text-[12px]"
    >
      <div className="flex items-start gap-2">
        <Icon name="keyboard" size={16} className="text-accent shrink-0 mt-px" />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-3 flex-wrap">
            <h3
              id="draw-keys-notice-title"
              className="text-[13px] font-semibold text-[var(--ink-90)]"
            >
              PlexiiDraw now uses Illustrator&rsquo;s shortcuts
            </h3>
            <button
              className="text-accent hover:underline"
              data-testid="draw-keys-notice-see-all"
              onClick={() => ctx.set({ dialog: { id: 'keyboard-shortcuts' } })}
            >
              See all shortcuts
            </button>
          </div>
          <ul
            className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[var(--ink-70)]"
            aria-label="Keys that changed"
          >
            {KEY_CHANGES.map((c) => {
              const note = changeNote(c)
              return (
                <li
                  key={`${c.kind}:${c.id}`}
                  data-testid={`draw-keys-notice-change-${c.id}`}
                  title={note}
                >
                  <span>{c.what}</span>{' '}
                  <kbd className="fb-tabular text-[var(--ink-50)] line-through decoration-[var(--ink-30)]">
                    {formatKey(c.from)}
                  </kbd>
                  <span aria-label="becomes"> → </span>
                  {c.to ? (
                    <kbd className="fb-tabular font-medium text-[var(--ink-90)]">
                      {formatKey(c.to)}
                    </kbd>
                  ) : (
                    <span className="text-[var(--ink-50)]">no key</span>
                  )}
                  {note && <span className="text-[var(--ink-40)]"> ({note})</span>}
                </li>
              )
            })}
          </ul>
        </div>
        <button
          className="icon-btn shrink-0"
          title="Dismiss"
          aria-label="Dismiss"
          data-testid="draw-keys-notice-dismiss"
          onClick={close}
        >
          <Icon name="close" size={15} />
        </button>
      </div>
    </div>
  )
}
