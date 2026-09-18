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
import { useViewStore } from '../stores/view'
import { useNodeStore } from '../stores/nodes'
import { useDocumentsStore } from '../stores/documents'
import { useOpenTrayStore } from '../stores/openTray'
import { activeKey, orderTray, type TrayEntry } from '../lib/openTray'
import {
  dragCarriesDocument,
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
  const [menuFor, setMenuFor] = useState<string | null>(null)
  // The desk tab a document is currently hovering over.
  const [dropOn, setDropOn] = useState<string | null>(null)

  // Put a document on a desk without opening that desk first. The widget points
  // AT the document rather than copying it, so editing it here and editing it in
  // Office are the same file.
  const dropDocumentOn = async (deskId: string, dt: DataTransfer | null): Promise<void> => {
    const payload = readDocumentDrag(dt)
    setDropOn(null)
    if (!payload) return
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

  const current = activeKey(view)

  const resolve = useMemo(() => {
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
        case 'document': {
          const d = docs.find((x) => x.id === v.documentId)
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
        case 'office': {
          const app = v.app ?? ''
          const known: Record<string, Resolved> = {
            mail: { label: 'Mail', icon: 'mail' },
            inbox: { label: 'Inbox', icon: 'inbox' },
            chat: { label: 'Chat', icon: 'forum' },
            meet: { label: 'Meet', icon: 'video_call' },
            sign: { label: 'Sign', icon: 'plexii:sign' },
            browser: { label: 'Browser', icon: 'public' },
            docs: { label: 'PlexiDocs', icon: 'description' },
            sheets: { label: 'PlexiSheets', icon: 'table_chart' },
            slides: { label: 'PlexiSlides', icon: 'slideshow' },
            diagrams: { label: 'PlexiDiagrams', icon: 'account_tree' },
            design: { label: 'PlexiDesign', icon: 'plexii:design' },
            draw: { label: 'PlexiDraw', icon: 'brush' }
          }
          return known[app] ?? { label: app || 'Office', icon: 'apps' }
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
                draggable={e.view.kind === 'document'}
                onDragStart={(ev) => {
                  const v = e.view
                  if (v.kind !== 'document') return
                  const d = docs.find((x) => x.id === v.documentId)
                  if (!d || !canPlaceOnDesk(d.docType)) {
                    ev.preventDefault()
                    return
                  }
                  writeDocumentDrag(ev.dataTransfer, {
                    documentId: d.id,
                    docType: d.docType,
                    title: d.title || 'Untitled'
                  })
                }}
                onClick={() => useViewStore.getState().go(e.view)}
                onContextMenu={(ev) => {
                  ev.preventDefault()
                  setMenuFor(menuFor === e.key ? null : e.key)
                }}
                data-testid={`tray-item-${e.key}`}
                title={r.missing ? `${r.label} — no longer there` : r.label}
                className="flex min-w-0 items-center gap-1.5 fb-t-label"
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

            {menuFor === e.key && (
              <div
                className="absolute bottom-full right-0 z-30 mb-1 w-48 rounded-[var(--radius-row)] fb-glass-panel fb-pop-in py-1 fb-t-label"
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
                <p className="px-3 pt-1 pb-0.5 fb-t-caption">Closing only clears this strip.</p>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
