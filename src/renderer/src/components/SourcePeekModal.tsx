import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from './Icon'
import { useSourcePeek } from '../stores/sourcePeek'
import { goToSourceTarget } from '../lib/goToSourceTarget'
import { renderWidgetInline } from '../lib/renderWidgetInline'
import type { Widget } from '@shared/types'

// Looking at a reference without leaving what you were doing.
//
// A citation used to take you to the thing, which answers "where is it" and
// loses "what was I reading". When the reference is the evidence behind a
// proposal you are deciding on, being moved is the wrong answer: you wanted to
// check it, not go there. So this shows it in place, lets you work in it, and
// keeps "Open where it lives" one click away for when going there IS what you
// meant.
//
// Only kinds with a real inline renderer reach here (see canPeek). Anything
// else still navigates, because a viewer that cannot show the thing is a
// pointless stop on the way to it.

function Frame({
  title,
  subtitle,
  onGo,
  onClose,
  children
}: {
  title: string
  subtitle: string
  onGo: () => void
  onClose: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/40 p-8"
      onClick={onClose}
      data-testid="source-peek-backdrop"
    >
      <div
        className="fb-glass-panel rounded-[var(--radius-card)] fb-pop-in flex flex-col w-[900px] max-w-full h-[640px] max-h-full overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
        data-testid="source-peek"
      >
        <div className="px-4 py-2.5 border-b border-[var(--edge-soft)] flex items-center gap-3 shrink-0">
          <div className="min-w-0 flex-1">
            <p className="fb-t-label font-semibold text-[var(--ink-100)] truncate">{title}</p>
            <p className="fb-t-caption text-[var(--ink-50)] truncate">{subtitle}</p>
          </div>
          {/* Going there is still one click away — this replaces navigation as
              the DEFAULT, not as the option. */}
          <button
            onClick={onGo}
            className="btn-ghost shrink-0 inline-flex items-center gap-1.5"
            data-testid="source-peek-go"
          >
            <Icon name="open_in_new" size={14} />
            <span>Open where it lives</span>
          </button>
          <button onClick={onClose} className="icon-btn shrink-0" aria-label="Close">
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">{children}</div>
      </div>
    </div>
  )
}

/** A widget or table, rendered by the same inline renderer focus mode uses. */
function WidgetPeek({ widgetId, label }: { widgetId: string; label: string | null }): JSX.Element {
  const [widget, setWidget] = useState<Widget | null | 'missing'>(null)
  const close = useSourcePeek((s) => s.close)

  useEffect(() => {
    let live = true
    void (async () => {
      if (typeof window.api.widgets.get !== 'function') {
        if (live) setWidget('missing')
        return
      }
      const w = await window.api.widgets.get(widgetId).catch(() => null)
      if (live) setWidget(w ?? 'missing')
    })()
    return () => {
      live = false
    }
  }, [widgetId])

  const go = useCallback(() => {
    close()
    void goToSourceTarget({ kind: 'widget', widgetId })
  }, [close, widgetId])

  if (widget === null) {
    return (
      <Frame title={label || 'Loading…'} subtitle="Opening" onGo={go} onClose={close}>
        <p className="fb-t-caption text-[var(--ink-50)] p-6">Loading…</p>
      </Frame>
    )
  }
  if (widget === 'missing') {
    // Honest: the reference resolved to a widget that is no longer there, which
    // is different from an empty one.
    return (
      <Frame title={label || 'Not found'} subtitle="Reference" onGo={go} onClose={close}>
        <p className="fb-t-caption text-[var(--ink-50)] p-6">
          This no longer exists, or has not loaded. It may have been deleted since it was cited.
        </p>
      </Frame>
    )
  }
  return (
    <Frame
      title={widget.title || label || 'Widget'}
      subtitle={`On a desk · ${widget.kind}`}
      onGo={go}
      onClose={close}
    >
      <div className="h-full">{renderWidgetInline(widget)}</div>
    </Frame>
  )
}

/** One email, rendered by the mail-thread widget against the local mail store. */
function EmailPeek({ uid, label }: { uid: number; label: string | null }): JSX.Element {
  const close = useSourcePeek((s) => s.close)
  const go = useCallback(() => {
    close()
    void goToSourceTarget({ kind: 'email', uid })
  }, [close, uid])

  // A synthetic widget rather than a second reader: the mail-thread widget
  // already renders one stored message as a document, handles a body that has
  // not been fetched yet, and says so when the message is not in the local copy.
  const widget = {
    id: `peek-mail-${uid}`,
    kind: 'mail-thread',
    title: label || 'Email',
    content: JSON.stringify({ mode: 'one', uids: [uid], subject: label ?? undefined })
  } as unknown as Widget

  return (
    <Frame title={label || 'Email'} subtitle="Message" onGo={go} onClose={close}>
      <div className="h-full">{renderWidgetInline(widget)}</div>
    </Frame>
  )
}

export default function SourcePeekModal(): JSX.Element | null {
  const target = useSourcePeek((s) => s.target)
  const label = useSourcePeek((s) => s.label)
  const close = useSourcePeek((s) => s.close)

  // Escape closes, like every other overlay. Bound only while open so it never
  // competes with the canvas's own Escape.
  useEffect(() => {
    if (!target) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [target, close])

  if (!target) return null

  const body =
    target.kind === 'widget' ? (
      <WidgetPeek widgetId={target.widgetId} label={label} />
    ) : target.kind === 'table' ? (
      <WidgetPeek widgetId={target.tableId} label={label} />
    ) : target.kind === 'email' ? (
      <EmailPeek uid={target.uid} label={label} />
    ) : null

  if (!body) return null
  return createPortal(body, document.body)
}
