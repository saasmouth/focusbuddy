import { useEffect, useState, useRef } from 'react'
import type { Widget } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import { useWidgetStore } from '../../stores/widgets'
import Icon from '../Icon'
import { resolveMediaSrc } from '../../lib/fileUrl'

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url.slice(0, 40)
  }
}

interface Props {
  widget: Widget
  inline?: boolean
}

export default function ImageWidget({ widget, inline = false }: Props): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  // Guards against re-attempting the same widget on every render.
  const internalisedRef = useRef<string | null>(null)

  // A linked image is stored in the Drive the first time it is rendered, so the
  // desk owns the picture rather than depending on a host -- and often a login
  // -- that is not ours. A widget pointing at a chat session renders for the
  // person who dropped it there and for nobody else, including that same person
  // in the cloud app or anyone the desk is shared with.
  //
  // Best-effort and silent on failure: if the fetch does not work the widget is
  // exactly as it was, still showing the link, which is no worse than before and
  // keeps the only clue about where the picture came from. Runs on the desktop
  // only -- the same fetch from a browser tab is refused by CORS for most hosts,
  // so the browser keeps rendering the link and inherits the rewrite when it
  // syncs back.
  useEffect(() => {
    const url = (widget.content ?? '').trim()
    if (!/^https?:\/\//i.test(url)) return
    if (!window.api?.files?.ingestUrl) return // browser runtime: not available
    if (internalisedRef.current === widget.id) return
    internalisedRef.current = widget.id
    let cancelled = false
    void window.api.files.ingestUrl(url, null).then((res) => {
      if (cancelled || !res?.ok || !res.file) return
      void update(widget.id, { content: `fb-file://${res.file.id}` })
    })
    return () => {
      cancelled = true
    }
  }, [widget.id, widget.content])

  const [editing, setEditing] = useState(!widget.content)
  const [draft, setDraft] = useState(widget.content)

  useEffect(() => {
    setDraft(widget.content)
    setEditing(!widget.content)
  }, [widget.id, widget.content])

  function commit(): void {
    const url = draft.trim()
    if (!url) return
    void update(widget.id, { content: url, title: hostnameOf(url) })
    setEditing(false)
  }

  const body = (
    <div className="h-full w-full bg-[var(--surface-sunken)] relative flex items-center justify-center">
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            commit()
          }}
          className="w-full h-full flex flex-col justify-center gap-2 p-4 bg-[var(--surface-raised)]"
        >
          <label className="text-xs uppercase tracking-wider text-[var(--ink-50)] flex items-center gap-1.5">
            <Icon name="image" size={16} />
            Image URL
          </label>
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="https://…/image.png"
            className="fb-field w-auto bg-[var(--surface-raised)] px-3 py-2 text-sm"
          />
          <div className="flex justify-end pt-1">
            <button type="submit" className="btn-primary">
              <Icon name="check" size={14} />
              <span>Load</span>
            </button>
          </div>
        </form>
      ) : (
        <>
          <img
            src={resolveMediaSrc(widget.content)}
            alt=""
            className="max-h-full max-w-full object-contain select-none"
            draggable={false}
          />
          <button
            onClick={(e) => {
              e.stopPropagation()
              setEditing(true)
            }}
            title="Change URL"
            className="absolute top-1 right-1 inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-[color-mix(in_oklab,var(--surface-raised)_90%,transparent)] border border-[var(--edge-firm)] hover:bg-[var(--surface-sunken)] text-[var(--ink-70)]"
          >
            <Icon name="edit" size={11} />
            <span>edit</span>
          </button>
        </>
      )}
    </div>
  )

  if (inline) return body

  return (
    <WidgetFrame
      widget={widget}
      headerLabel={`Image · ${widget.title || hostnameOf(widget.content || '')}`}
      headerAccent="bg-stone-200/70 dark:bg-white/[0.07]"
    >
      {body}
    </WidgetFrame>
  )
}
