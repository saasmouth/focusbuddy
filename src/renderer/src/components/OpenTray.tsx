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

import { useEffect, useMemo, useRef, useState } from 'react'
import PlexiiIcon from './PlexiiIcon'
import { segmentAppEntity, type EntityRef } from '../lib/plexiiIconMap'
import Icon from './Icon'
import { widgetFileType } from '@shared/widgetFiles'
import { useViewStore, type View } from '../stores/view'
import { useNodeStore } from '../stores/nodes'
import { useDocumentsStore } from '../stores/documents'
import { useOpenTrayStore } from '../stores/openTray'
import { activeKey, documentIdOf, orderTray, type TrayEntry } from '../lib/openTray'
import { lookupApp } from '../lib/segmentApps'
import { humaniseKey, trayProductMeta } from '../lib/trayProductMeta'
import { AREA_TONES } from '../lib/areaTones'
import {
  dragCarriesDocument,
  type DocumentDragPayload,
  readDocumentDrag,
  placeDocumentOnDesk,
  writeDocumentDrag,
  canPlaceOnDesk
} from '../lib/documentDrag'
import { useWidgetStore } from '../stores/widgets'
import { useConnectedAppsStore } from '../stores/connectedApps'
import AppLogo from './AppLogo'
import type { ConnectedApp } from '@shared/types'
import { useNoticeStore } from '../stores/notice'
import CanvasContextMenu from './CanvasContextMenu'
import { trayTabMenuItems } from '../lib/trayTabMenu'
import { focusInvoker } from '../lib/objectMenu'

/** The readable part of a URL, for an app whose title was never set. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

interface Resolved {
  label: string
  icon: string
  /** The subject is gone. Kept visible so the user closes it deliberately. */
  missing?: boolean
  /**
   * The icon's colour, from the SAME sources the side menu uses — AREA_TONES
   * for places, the segment registry for apps and documents. Taken from
   * there rather than written here so a tab and the menu row that opened it
   * can never show the same thing in two colours, which is exactly what two
   * copies of a colour list produced in the menu itself.
   */
  tone?: string
  /**
   * A connected app, when the tab is one. Carried so the tab can show the
   * app's OWN logo — the favicon it was captured with — rather than a generic
   * "apps" glyph that makes every connected app look identical.
   */
  app?: ConnectedApp
  /** The app, tool or work widget the tab is, when it has a Plexii icon (lib/plexiiIconMap). */
  entity?: EntityRef | null
}

export default function OpenTray(): JSX.Element | null {
  const trayRef = useRef<HTMLDivElement | null>(null)
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
  const [menuFor, setMenuFor] = useState<{ key: string; x: number; y: number } | null>(null)
  // The desk tab a document is currently hovering over.
  const [dropOn, setDropOn] = useState<string | null>(null)

  // Put a document on a desk without opening that desk first. The widget points
  // AT the document rather than copying it, so editing it here and editing it in
  // Office are the same file.
  const placeOnDesk = async (deskId: string, payload: DocumentDragPayload): Promise<void> => {
    const desk = nodes.find((n) => n.id === deskId)
    try {
      await placeDocumentOnDesk(payload, deskId)
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

  const connectedApps = useConnectedAppsStore((s) => s.apps)

  const current = activeKey(view)

  const resolve = useMemo(() => {
    const DOC_APP_KEY: Record<string, string> = {
      doc: 'docs',
      sheet: 'sheets',
      slides: 'slides',
      map: 'diagrams',
      design: 'design',
      draw: 'draw'
    }
    const resolveDoc = (id: string): Resolved => {
      const d = docs.find((x) => x.id === id)
      const tone = lookupApp('office', DOC_APP_KEY[d?.docType ?? ''])?.tone
      const icon =
        d?.docType === 'widget'
          ? (widgetFileType(d.widgetKind)?.icon ?? 'widgets')
          : d?.docType === 'sheet'
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
      // A widget file wears its kind's icon; a document, its app's.
      const entity: EntityRef | null =
        d?.docType === 'widget' && d.widgetKind
          ? { kind: 'widget', id: d.widgetKind }
          : DOC_APP_KEY[d?.docType ?? '']
            ? { kind: 'app', id: DOC_APP_KEY[d?.docType ?? ''] }
            : null
      return d
        ? { label: d.title || 'Untitled', icon, tone, entity }
        : { label: 'Document', icon: 'description', tone, missing: docs.length > 0 }
    }
    return (e: TrayEntry): Resolved => {
      const v = e.view
      switch (v.kind) {
        case 'task': {
          const n = nodes.find((x) => x.id === v.taskId)
          return n
            ? { label: n.title || 'Untitled desk', icon: 'desk', tone: AREA_TONES.desks }
            : // Only claim it is gone once the store has actually loaded, or
              // every tab reads "no longer there" for a moment on startup.
              { label: 'Desk', icon: 'desk', tone: AREA_TONES.desks, missing: nodes.length > 0 }
        }
        case 'project-dashboard': {
          const n = nodes.find((x) => x.id === v.projectId)
          return { label: n?.title || 'Project', icon: 'dashboard', tone: AREA_TONES.plans }
        }
        case 'desks': {
          const n = nodes.find((x) => x.id === v.roomId)
          return { label: n?.title || 'Room', icon: 'meeting_room', tone: AREA_TONES.rooms }
        }
        case 'document':
          return resolveDoc(v.documentId)
        case 'livedoc':
          return { label: 'Live doc', icon: 'sync', tone: AREA_TONES.files }
        case 'livefolder':
          return { label: 'Live folder', icon: 'folder_open', tone: AREA_TONES.files }
        case 'connected-app': {
          // Was `label: v.appId` — the tab showed a raw UUID. The store has
          // the title the user gave it and the logo it was captured with.
          const a = connectedApps.find((x) => x.id === v.appId)
          return a
            ? { label: a.title || hostnameOf(a.url) || 'App', icon: 'apps', app: a }
            : { label: 'App', icon: 'apps', missing: connectedApps.length > 0 }
        }
        case 'product': {
          // The catalog's canonical name and icon, as the launcher tile shows
          // them (trayProductMeta). Was the humanised key and a generic box.
          const p = trayProductMeta(v.productKey)
          return { label: p.label, icon: p.icon, tone: AREA_TONES.office, entity: p.entity }
        }
        case 'knowledge':
          return { label: 'Knowledge', icon: 'psychology', tone: AREA_TONES.brain }
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
            ? { label: meta.label, icon: meta.icon, tone: meta.tone, entity: segmentAppEntity(v.kind, meta.key) }
            : { label: v.app ? humaniseKey(v.app) : 'Office', icon: 'apps', tone: AREA_TONES.office }
        }
        case 'messages':
          return { label: 'PlexiiChat', icon: 'plexii:chat', tone: AREA_TONES.people, entity: { kind: 'app', id: 'chat' } }
        case 'mail':
          return { label: 'Mail', icon: 'mail', tone: AREA_TONES.calendar, entity: { kind: 'app', id: 'mail' } }
        default:
          return { label: 'Open', icon: 'circle' }
      }
    }
  }, [nodes, docs, connectedApps])

  // Hidden entirely until there is something in it: an empty strip is chrome
  // that costs height and says nothing.
  const shown = entries.length > 0

  // Publish where the bottom chrome STARTS, so fixed chrome can sit clear of
  // it. The Plexii pill is fixed to the bottom-right and was landing on the
  // tray's last tab on every desk.
  //
  // This publishes a position, not a height, and that distinction is the whole
  // fix. The first attempt published the tray's height and had the pill use
  // `calc(42px + var(...))`. It did not work, and the reason is worth keeping:
  // the app applies a user UI scale to the root, so a length written in CSS px
  // and a length measured with getBoundingClientRect are NOT in the same space
  // — the calc resolved to 52.6px where the arithmetic said 87px. Adding a
  // measured number to an authored one is the bug.
  //
  // So both numbers now come from the same place: measure the gap from the
  // viewport bottom to the top of this strip, add the gap we want, and publish
  // the finished offset. Nothing downstream does arithmetic on it.
  useEffect(() => {
    const root = document.documentElement
    const clear = (): void => { root.style.removeProperty("--fb-pill-bottom") }
    if (!shown) {
      clear()
      return
    }
    const el = trayRef.current
    if (!el) return
    const publish = (): void => {
      const top = el.getBoundingClientRect().top
      if (!Number.isFinite(top)) return
      root.style.setProperty('--fb-pill-bottom', `${Math.round(window.innerHeight - top + 14)}px`)
    }
    publish()
    const ro = new ResizeObserver(publish)
    ro.observe(el)
    window.addEventListener('resize', publish)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', publish)
      clear()
    }
  }, [shown])

  if (!shown) return null

  return (
    <div
      ref={trayRef}
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
                    ? // The open item: an accent tint and outline, so it reads as
                      // "you are here" at a glance and never looks like a hover.
                      'bg-[rgb(var(--accent)/0.12)] ring-1 ring-[rgb(var(--accent)/0.45)] text-[var(--ink-100)]'
                    : 'text-[var(--ink-60)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-90)]'
              }`}
            >
              {on && (
                // A short accent bar on the tab's top edge, pointing at the
                // content it is showing above the strip.
                <span
                  aria-hidden
                  data-testid={`tray-active-${e.key}`}
                  className="pointer-events-none absolute left-2 right-2 -top-1 h-[2px] rounded-full bg-[rgb(var(--accent))]"
                />
              )}
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
                  // The kit places and clamps the menu, and gives focus back to
                  // this tab when it closes (Escape included).
                  focusInvoker(ev)
                  setMenuFor({ key: e.key, x: ev.clientX, y: ev.clientY })
                }}
                data-testid={`tray-item-${e.key}`}
                aria-current={on ? 'page' : undefined}
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
                {r.app ? (
                  <span className={`shrink-0 ${r.missing ? 'opacity-40' : ''}`}>
                    <AppLogo app={r.app} size={14} glyphSize={10} />
                  </span>
                ) : r.entity ? (
                  <PlexiiIcon
                    kind={r.entity.kind}
                    id={r.entity.id}
                    size={16}
                    fallback={r.icon}
                    fallbackFilled
                    className={r.missing ? 'opacity-40' : ''}
                    fallbackClassName={r.missing ? '' : (r.tone ?? 'text-[var(--ink-60)]')}
                  />
                ) : (
                  <Icon
                    name={r.icon}
                    size={13}
                    filled
                    className={`shrink-0 ${
                      r.missing ? 'opacity-40' : (r.tone ?? 'text-[var(--ink-60)]')
                    }`}
                  />
                )}
                <span
                  className={`max-w-[150px] truncate ${on ? 'font-semibold' : ''} ${r.missing ? 'line-through opacity-50' : ''}`}
                >
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
              <CanvasContextMenu
                x={menuFor.x}
                y={menuFor.y}
                onClose={() => setMenuFor(null)}
                items={trayTabMenuItems({
                  entryKey: e.key,
                  pinned: !!e.pinned,
                  onTogglePin: () => togglePin(e.key),
                  onClose: () => close(e.key),
                  onCloseOthers: () => closeOthers(e.key),
                  onCloseAll: () => clear(),
                  hasOthers: entries.some((x) => x.key !== e.key && !x.pinned),
                  sendTo: draggableDoc(e.view)
                    ? {
                        desks: desks.map((n) => ({ id: n.id, title: n.title || 'Untitled desk' })),
                        send: (deskId) => {
                          const d = draggableDoc(e.view)
                          if (d) void placeOnDesk(deskId, d)
                        }
                      }
                    : undefined
                })}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
