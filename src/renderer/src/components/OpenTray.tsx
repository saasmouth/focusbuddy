// The strip of what you have open, above the footer.
//
// The app navigates rather than opens: every destination replaces the last, and
// the way back is the history arrows. That suits a tool used one thing at a
// time and not one where a desk, the document written from it and the chat it
// is discussed in are the same piece of work. This is that set, so switching is
// a click instead of a retrace.
//
// Titles are resolved LIVE from the stores rather than stored on the entry, so
// renaming a desk renames its tab, and an entry whose subject has been deleted
// can say so instead of lying about a name it cached.

import { useMemo, useState } from 'react'
import Icon from './Icon'
import { useViewStore, type View } from '../stores/view'
import { useNodeStore } from '../stores/nodes'
import { useDocumentsStore } from '../stores/documents'
import { useOpenTrayStore } from '../stores/openTray'
import { activeKey, documentIdOf, orderTray, type TrayEntry } from '../lib/openTray'
import { lookupApp } from '../lib/segmentApps'
import {
  dragCarriesDocument,
  type DocumentDragPayload,
  readDocumentDrag,
  widgetDraftFor,
  writeDocumentDrag,
  canPlaceOnDesk
} from '../lib/documentDrag'
import { useWidgetStore } from '../stores/widgets'
import { useNoticeStore } from '../stores/notice'

interface Resolved {
  label: string
  icon: string
  /** The subject is gone. Kept visible so the user closes it deliberately. */
  missing?: boolean
}

export default function OpenTray(): JSX.Element | null {
  // Select the raw array — a selector that orders would hand zustand a new
  // identity on every read and re-render without end.
  const raw = useOpenTrayStore((s) => s.entries)
  const entries = useMemo(() => orderTray(raw), [raw])
  const close = useOpenTrayStore((s) => s.close)
  const closeOthers = useOpenTrayStore((s) => s.closeOthers)
  const togglePin = useOpenTrayStore((s) => s.togglePin)
  const clear = useOpenTrayStore((s) => s.clear)

  const view = useViewStore((s) => s.view)
  const nodes = useNodeStore((s) => s.nodes)
  const docs = useDocumentsStore((s) => s.list)
  // The menu is anchored in VIEWPORT coordinates and positioned `fixed`.
  // Absolute positioning put it inside the tray, where two things buried it:
  // the strip scrolls horizontally, and `overflow-x` clips the other axis too,
  // so a menu opening upwards was cut off; and the main content area paints
  // over the tray's stacking context, so what survived the clip sat behind the
  // page and swallowed every click. Fixed escapes both.
  const [menuFor, setMenuFor] = useState<{ key: string; left: number; bottom: number } | null>(null)
  // The desk tab a document is currently hovering over.
  const [dropOn, setDropOn] = useState<string | null>(null)

  // Put a document on a desk without opening that desk first. The widget points
  // AT the document rather than copying it, so editing it here and editing it in
  // Office are the same file.
  const placeOnDesk = async (deskId: string, payload: DocumentDragPayload): Promise<void> => {
    const desk = nodes.find((n) => n.id === deskId)
    try {
      await window.api.widgets.create(widgetDraftFor(payload, deskId))
      useNoticeStore.getState().show({
        text: `“${payload.title}” added to ${desk?.title || 'the desk'}`,
        icon: 'desk',
        action: { label: 'Open', run: () => useViewStore.getState().goTask(deskId) }
      })
      const v = useViewStore.getState().view
      if (v.kind === 'task' && v.taskId === deskId) {
        void useWidgetStore.getState().loadForTask(deskId, { refresh: true })
      }
    } catch {
      useNoticeStore.getState().show({ text: 'Could not add that to the desk.', icon: 'warning' })
    }
  }

  const dropDocumentOn = async (deskId: string, dt: DataTransfer | null): Promise<void> => {
    const payload = readDocumentDrag(dt)
    setDropOn(null)
    if (!payload) return
    await placeOnDesk(deskId, payload)
  }

  // The document a tab stands for, when that document can go on a desk. Drag
  // needs it, and so does the menu that exists for everyone who never discovers
  // the drag.
  const draggableDoc = (v: View): DocumentDragPayload | null => {
    const id = documentIdOf(v)
    if (!id) return null
    const d = docs.find((x) => x.id === id)
    if (!d || !canPlaceOnDesk(d.docType)) return null
    return { documentId: d.id, docType: d.docType, title: d.title || 'Untitled' }
  }

  // Every desk, not just the open ones: the point is to file something away on
  // a desk you are not currently looking at.
  const desks = useMemo(() => nodes.filter((n) => n.kind === 'task'), [nodes])

  const current = activeKey(view)

  const resolve = useMemo(() => {
    const resolveDoc = (id: string): Resolved => {
      const d = docs.find((x) => x.id === id)
      const icon =
        d?.docType === 'sheet'
          ? 'table'
          : d?.docType === 'slides'
            ? 'slideshow'
            : d?.docType === 'map'
              ? 'account_tree'
              : d?.docType === 'draw'
                ? 'brush'
                : d?.docType === 'design'
                  ? 'palette'
                  : 'description'
      return d
        ? { label: d.title || 'Untitled', icon }
        : { label: 'Document', icon: 'description', missing: docs.length > 0 }
    }
    return (e: TrayEntry): Resolved => {
      const v = e.view
      switch (v.kind) {
        case 'task': {
          const n = nodes.find((x) => x.id === v.taskId)
          return n
            ? { label: n.title || 'Untitled desk', icon: 'desk' }
            : // Only claim it is gone once the store has actually loaded, or
              // every tab reads "no longer there" for a moment on startup.
              { label: 'Desk', icon: 'desk', missing: nodes.length > 0 }
        }
        case 'project-dashboard': {
          const n = nodes.find((x) => x.id === v.projectId)
          return { label: n?.title || 'Project', icon: 'dashboard' }
        }
        case 'desks': {
          const n = nodes.find((x) => x.id === v.roomId)
          return { label: n?.title || 'Room', icon: 'meeting_room' }
        }
        case 'document':
          return resolveDoc(v.documentId)
        case 'livedoc':
          return { label: 'Live doc', icon: 'sync' }
        case 'livefolder':
          return { label: 'Live folder', icon: 'folder_open' }
        case 'connected-app':
          return { label: v.appId, icon: 'apps' }
        case 'product':
          return { label: v.productKey, icon: 'inventory_2' }
        case 'knowledge':
          return { label: 'Knowledge', icon: 'psychology' }
        case 'office':
        case 'plexidesk':
        case 'plexipeople':
        case 'plexibrain': {
          // A document open inside Office reads as the document, not as
          // "PlexiOffice" -- it is the thing you have open.
          if (v.kind === 'office' && v.doc) return resolveDoc(v.doc)
          // Names and icons come from the one registry the shells build their
          // menus from, so a tab can never disagree with the menu that opened
          // it -- which is exactly what a second copy of the list produced.
          const meta = lookupApp(v.kind, v.app)
          return meta
            ? { label: meta.label, icon: meta.icon }
            : { label: v.app || 'Office', icon: 'apps' }
        }
        case 'messages':
          return { label: 'Chat', icon: 'plexii:chat' }
        case 'mail':
          return { label: 'Mail', icon: 'mail' }
        default:
          return { label: 'Open', icon: 'circle' }
      }
    }
  }, [nodes, docs])

  // Hidden entirely until there is something in it: an empty strip is chrome
  // that costs height and says nothing.
  if (entries.length === 0) return null

  return (
    <div
      className="shrink-0 flex items-center gap-1 border-t border-[var(--edge-soft)] bg-[var(--surface-raised)] px-2 py-1 overflow-x-auto"
      data-testid="open-tray"
      aria-label="Open items"
    >
      {entries.map((e) => {
        const r = resolve(e)
        const on = current === e.key
        return (
          <div key={e.key} className="relative shrink-0">
            <div
              onDragOver={(ev) => {
                if (e.view.kind !== 'task' || !dragCarriesDocument(ev.dataTransfer)) return
                // preventDefault is what makes this a drop target at all.
                ev.preventDefault()
                ev.dataTransfer.dropEffect = 'copy'
                setDropOn(e.key)
              }}
              onDragLeave={() => setDropOn((k) => (k === e.key ? null : k))}
              onDrop={(ev) => {
                if (e.view.kind !== 'task') return
                ev.preventDefault()
                void dropDocumentOn(e.view.taskId, ev.dataTransfer)
              }}
              className={`group/tab flex items-center gap-1.5 rounded-lg pl-2 pr-1 py-1 transition-colors ${
                dropOn === e.key
                  ? 'bg-[rgb(var(--accent)/0.15)] ring-1 ring-[rgb(var(--accent))] text-[var(--ink-100)]'
                  : on
                    ? 'bg-[var(--surface-sunken)] text-[var(--ink-100)]'
                    : 'text-[var(--ink-60)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-90)]'
              }`}
            >
              <button
                draggable={draggableDoc(e.view) !== null}
                onDragStart={(ev) => {
                  const d = draggableDoc(e.view)
                  if (!d) {
                    ev.preventDefault()
                    return
                  }
                  writeDocumentDrag(ev.dataTransfer, d)
                }}
                onClick={() => useViewStore.getState().go(e.view)}
                onContextMenu={(ev) => {
                  ev.preventDefault()
                  if (menuFor?.key === e.key) {
                    setMenuFor(null)
                    return
                  }
                  const r = ev.currentTarget.getBoundingClientRect()
                  const MENU_W = 192 // w-48
                  setMenuFor({
                    key: e.key,
                    // Clamped so a tab near the right edge does not push the
                    // menu off screen.
                    left: Math.max(8, Math.min(r.left, window.innerWidth - MENU_W - 8)),
                    bottom: Math.max(8, window.innerHeight - r.top + 6)
                  })
                }}
                data-testid={`tray-item-${e.key}`}
                title={
                  r.missing
                    ? `${r.label} — no longer there`
                    : draggableDoc(e.view)
                      ? `${r.label} — drag onto a desk to put it there, or right-click`
                      : r.label
                }
                className={`flex min-w-0 items-center gap-1.5 fb-t-label ${
                  draggableDoc(e.view) ? 'cursor-grab active:cursor-grabbing' : ''
                }`}
              >
                {e.pinned && <Icon name="push_pin" size={11} className="shrink-0 opacity-70" />}
                <Icon
                  name={r.icon}
                  size={13}
                  className={`shrink-0 ${r.missing ? 'opacity-40' : ''}`}
                />
                <span className={`max-w-[150px] truncate ${r.missing ? 'line-through opacity-50' : ''}`}>
                  {r.label}
                </span>
              </button>
              <button
                onClick={() => close(e.key)}
                data-testid={`tray-close-${e.key}`}
                aria-label={`Close ${r.label}`}
                // The word is deliberate and so is the tooltip: this removes the
                // tab. Nothing it can reach deletes anything.
                title={`Close ${r.label} — removes it from here, nothing is deleted`}
                className="shrink-0 rounded p-0.5 opacity-0 group-hover/tab:opacity-60 hover:!opacity-100 hover:bg-[var(--surface-raised)] focus-visible:opacity-100"
              >
                <Icon name="close" size={12} />
              </button>
            </div>

            {menuFor?.key === e.key && (
              <div
                style={{ left: menuFor.left, bottom: menuFor.bottom }}
                // z-[80]: above the page, below modals (85) and the full-screen
                // widget focus takeover (90), both of which should cover it.
                className="fixed z-[80] w-48 rounded-[var(--radius-row)] fb-glass-panel fb-pop-in py-1 fb-t-label"
                onMouseLeave={() => setMenuFor(null)}
                data-testid={`tray-menu-${e.key}`}
              >
                <button
                  onClick={() => {
                    togglePin(e.key)
                    setMenuFor(null)
                  }}
                  className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-sunken)] text-[var(--ink-90)]"
                >
                  {e.pinned ? 'Unpin' : 'Pin — keep it here'}
                </button>
                <button
                  onClick={() => {
                    closeOthers(e.key)
                    setMenuFor(null)
                  }}
                  className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-sunken)] text-[var(--ink-90)]"
                >
                  Close the others
                </button>
                <button
                  onClick={() => {
                    clear()
                    setMenuFor(null)
                  }}
                  className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-sunken)] text-[var(--ink-90)]"
                >
                  Close all
                </button>
                {draggableDoc(e.view) && (
                  <>
                    <div className="my-1 border-t border-[var(--edge-soft)]" />
                    {desks.length === 0 ? (
                      <p className="px-3 py-1 fb-t-caption">No desks to send it to yet.</p>
                    ) : (
                      <>
                        <p className="px-3 pt-0.5 pb-1 fb-t-caption">Send to desk</p>
                        <div className="max-h-44 overflow-y-auto">
                          {desks.map((n) => (
                            <button
                              key={n.id}
                              onClick={() => {
                                const d = draggableDoc(e.view)
                                setMenuFor(null)
                                if (d) void placeOnDesk(n.id, d)
                              }}
                              data-testid={`tray-send-${e.key}-${n.id}`}
                              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--surface-sunken)] text-[var(--ink-90)]"
                            >
                              <Icon name="desk" size={12} className="shrink-0 opacity-70" />
                              <span className="truncate">{n.title || 'Untitled desk'}</span>
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </>
                )}
                <p className="px-3 pt-1 pb-0.5 fb-t-caption">Closing only clears this strip.</p>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
