// Where "Add … to desk" goes when the right-click menu could not just name the
// desk: "New desk…" (name it, prefilled with the page's title) and "Choose a
// desk…" (every desk, most recently changed first, with a search). Choosing
// one adds the work widget as one undoable action (lib/addToDesk.ts).
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from '../Icon'
import { useAddToDeskPicker } from '../../stores/addToDeskPicker'
import { addToDesk, desksForPicker, widgetDraftFor } from '../../lib/addToDesk'

const NOUN: Record<string, string> = { selection: 'selection', image: 'image', video: 'video', link: 'link', page: 'page' }

export default function AddToDeskPicker(): JSX.Element | null {
  const command = useAddToDeskPicker((s) => s.command)
  const close = useAddToDeskPicker((s) => s.close)
  const [query, setQuery] = useState('')
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const nameRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!command) return
    setQuery('')
    setBusy(false)
    setNaming(command.desk === 'new')
    setName(command.pageTitle.trim().slice(0, 80))
  }, [command])

  useEffect(() => {
    if (!command) return
    const t = setTimeout(() => (naming ? nameRef.current?.select() : searchRef.current?.focus()), 0)
    return () => clearTimeout(t)
  }, [command, naming])

  useEffect(() => {
    if (!command) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [command, close])

  const desks = useMemo(() => (command ? desksForPicker() : []), [command])
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? desks.filter((d) => (d.title || 'Untitled desk').toLowerCase().includes(q)) : desks
  }, [desks, query])

  if (!command) return null
  const draft = widgetDraftFor(command)
  const noun = NOUN[command.target] ?? 'it'

  async function go(where: { deskId: string } | { newDeskTitle: string }): Promise<void> {
    if (!command || busy) return
    setBusy(true)
    await addToDesk(command, where)
    close()
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[310] flex items-start justify-center bg-black/30 pt-[14vh] px-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div data-testid="add-to-desk-picker" className="fb-card w-full max-w-md overflow-hidden flex flex-col max-h-[70vh]">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--edge-soft)]">
          <Icon name="desk" size={18} className="text-accent" />
          <span className="font-medium text-[var(--ink-100)]">Add {noun} to desk</span>
          <button onClick={close} className="ml-auto icon-btn-sm text-[var(--ink-50)]" aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        {draft && (
          <p className="px-4 pt-2 fb-t-caption text-[var(--ink-50)]" data-testid="add-to-desk-becomes">
            Becomes a {draft.kind === 'webview' ? 'browser' : draft.kind} work widget
          </p>
        )}
        {naming ? (
          <form
            className="px-4 py-3 flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void go({ newDeskTitle: name })
            }}
          >
            <label className="text-xs uppercase tracking-wide text-[var(--ink-50)]" htmlFor="add-to-desk-name">
              New desk name
            </label>
            <input
              id="add-to-desk-name"
              ref={nameRef}
              data-testid="add-to-desk-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="New desk"
              className="fb-field w-full px-2 py-1.5 text-sm text-[var(--ink-100)]"
            />
            <div className="flex justify-end gap-2 pt-1">
              {command.desk !== 'new' && (
                <button type="button" onClick={() => setNaming(false)} className="px-3 py-1.5 text-sm text-[var(--ink-50)] hover:text-[var(--ink-90)]">
                  Back
                </button>
              )}
              <button type="submit" data-testid="add-to-desk-create" disabled={busy} className="px-3 py-1.5 rounded bg-accent text-white text-sm font-medium disabled:opacity-50">
                Create desk and add
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="px-3 pt-2.5 pb-1.5">
              <input
                ref={searchRef}
                data-testid="add-to-desk-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && shown[0]) void go({ deskId: shown[0].id })
                }}
                placeholder="Search desks"
                className="fb-field w-full px-2 py-1.5 text-sm text-[var(--ink-100)]"
              />
            </div>
            <div className="flex-1 overflow-y-auto px-1.5 pb-1.5">
              <button
                onClick={() => setNaming(true)}
                data-testid="add-to-desk-new"
                className="w-full flex items-center gap-2 px-3 py-2 rounded text-left text-sm text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]"
              >
                <Icon name="add" size={16} /> New desk…
              </button>
              {shown.length === 0 && (
                <p className="px-3 py-2 text-sm text-[var(--ink-50)]">{desks.length === 0 ? 'No desks yet.' : 'No desk matches that search.'}</p>
              )}
              {shown.map((d) => (
                <button
                  key={d.id}
                  disabled={busy}
                  onClick={() => void go({ deskId: d.id })}
                  data-testid={`add-to-desk-desk-${d.id}`}
                  className="w-full truncate px-3 py-2 rounded text-left text-sm text-[var(--ink-90)] hover:bg-[var(--surface-sunken)] disabled:opacity-50"
                >
                  {d.title || 'Untitled desk'}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
