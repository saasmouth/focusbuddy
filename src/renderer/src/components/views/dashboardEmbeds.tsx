import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { DocumentMeta, FbNode, Widget, WidgetKind } from '@shared/types'
import Icon from '../Icon'
import Modal from '../plexi/Modal'
import { renderWidget } from '../widgets/renderWidget'
import { WidgetSurfaceContext } from '../../lib/widgetSurface'
import OfficeDocWidget from '../widgets/OfficeDocWidget'
import { useWidgetStore } from '../../stores/widgets'
import { useNodeStore } from '../../stores/nodes'
import { widgetDisplayName } from '../../lib/widgetDisplayName'
import { catalogFor } from '../../lib/widgetCatalog'
import { useWidgetFilesStore } from '../../stores/widgetFiles'
import { widgetFromFile } from '@shared/widgetFiles'
import ConnectedAppView from './ConnectedAppView'
import DocFiledInChip from '../DocFiledInChip'

// Desk objects and office documents, live on a dashboard.
//
// Both cards render the REAL component, not a preview: the same switch the
// canvas uses for an object, the same editor the Office app uses for a
// document. What you type here is written to the same row the desk reads, so
// there is one copy of the truth and no sync step between the two surfaces.

// ── Desk object ─────────────────────────────────────────────────────────────

/**
 * One object from a desk. When that desk happens to be open, the store copy is
 * used so canvas and dashboard move together; otherwise the row is fetched
 * once. Edits persist either way -- the widget store's update writes through to
 * the database whether or not the object belongs to the desk currently loaded.
 */
export function DeskWidgetCard({
  deskId,
  widgetId,
  onPick
}: {
  deskId?: string
  widgetId?: string
  onPick?: () => void
}): JSX.Element {
  const fromStore = useWidgetStore((s) => s.widgets.find((w) => w.id === widgetId))
  const [fetched, setFetched] = useState<Widget | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    if (!widgetId || fromStore) return
    let cancelled = false
    void window.api.widgets
      .get(widgetId)
      .then((w) => {
        if (cancelled) return
        setFetched(w)
        setMissing(!w)
      })
      .catch(() => !cancelled && setMissing(true))
    return () => {
      cancelled = true
    }
  }, [widgetId, fromStore])

  const widget = fromStore ?? fetched

  if (!widgetId) {
    return (
      <EmptyCard
        icon="widgets"
        title="No object chosen"
        hint="Pick an object from one of your desks."
        action={onPick ? { label: 'Choose an object', run: onPick } : undefined}
      />
    )
  }
  if (missing) {
    // Honest empty state: the object was deleted or lives on a desk this
    // account can no longer read. Never a blank card pretending to load.
    return (
      <EmptyCard
        icon="link_off"
        title="Object unavailable"
        hint="It may have been deleted, or moved to a desk you cannot open."
        action={onPick ? { label: 'Choose another', run: onPick } : undefined}
      />
    )
  }
  if (!widget) return <EmptyCard icon="hourglass_empty" title="Loading…" hint="" />

  return (
    <div className="h-full w-full overflow-hidden flex flex-col">
      <DeskObjectHeader widget={widget} deskId={deskId} />
      {/* The real widget, in its real interactive form. Embedded surface: it
          fills the card and cannot be dragged or resized, so a dashboard can
          never write desk coordinates back to the desk it belongs to. */}
      <div className="flex-1 min-h-0 overflow-auto relative">
        <WidgetSurfaceContext.Provider value="embedded">
          {renderWidget(widget)}
        </WidgetSurfaceContext.Provider>
      </div>
    </div>
  )
}

function DeskObjectHeader({ widget, deskId }: { widget: Widget; deskId?: string }): JSX.Element {
  const setActive = useNodeStore((s) => s.setActive)
  const setFocused = useWidgetStore((s) => s.setFocused)
  const label = catalogFor(widget.kind)?.label ?? widget.kind
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 border-b border-[var(--edge-soft)] shrink-0">
      <Icon name={catalogFor(widget.kind)?.icon ?? 'widgets'} size={13} className="text-[var(--ink-40)] shrink-0" />
      <span className="flex-1 min-w-0 truncate text-[11.5px] text-[var(--ink-80)]">
        {widgetDisplayName(widget)}
      </span>
      <span className="text-[10px] uppercase tracking-wide text-[var(--ink-40)] shrink-0">{label}</span>
      <button
        className="shrink-0 text-[10.5px] px-1.5 py-0.5 rounded hover:bg-[var(--surface-sunken)] text-[var(--ink-50)]"
        title="Open on its desk"
        onClick={() => {
          // The desk the object lives on is authoritative; taskId is right even
          // when the card was configured from a stale deskId.
          setActive(widget.taskId || deskId || null)
          setFocused(widget.id)
        }}
      >
        Open ↗
      </button>
    </div>
  )
}

// ── Office document ─────────────────────────────────────────────────────────

/**
 * A doc, sheet or deck in its own editor. OfficeDocWidget keys entirely off
 * `widget.content` (the document id) and writes through the documents store, so
 * a synthetic widget row is enough -- nothing here depends on the object
 * existing on a desk.
 */
export function OfficeDocumentCard({
  documentId,
  documentTitle,
  onPick
}: {
  documentId?: string
  documentTitle?: string
  onPick?: () => void
}): JSX.Element {
  const [meta, setMeta] = useState<DocumentMeta | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    if (!documentId) return
    let cancelled = false
    void window.api.documents
      .get(documentId)
      .then((d) => {
        if (cancelled) return
        if (!d) {
          setMissing(true)
          return
        }
        setMeta({
          id: d.id,
          docType: d.docType,
          title: d.title,
          archived: d.archived,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt
        })
      })
      .catch(() => !cancelled && setMissing(true))
    return () => {
      cancelled = true
    }
  }, [documentId])

  const synthetic = useMemo<Widget | null>(() => {
    if (!documentId || !meta) return null
    return {
      // Not a stored row: OfficeDocWidget only reads `content` and edits the
      // document itself, so nothing is ever written against this id.
      id: `dashboard-doc-${documentId}`,
      taskId: '',
      kind: (meta.docType === 'sheet' ? 'sheet' : meta.docType === 'slides' ? 'slides' : 'doc') as WidgetKind,
      title: meta.title,
      content: documentId,
      x: 0,
      y: 0,
      width: 640,
      height: 420,
      zIndex: 0,
      color: null,
      status: null,
      pinned: false,
      pinnedScreenX: null,
      pinnedScreenY: null,
      pinnedZone: null,
      parentSectionId: null,
      layout: null,
      sourceAppId: null
    } as unknown as Widget
  }, [documentId, meta])

  if (!documentId) {
    return (
      <EmptyCard
        icon="description"
        title="No document chosen"
        hint="Pick a doc, sheet or deck to edit here."
        action={onPick ? { label: 'Choose a document', run: onPick } : undefined}
      />
    )
  }
  if (missing) {
    return (
      <EmptyCard
        icon="link_off"
        title={documentTitle ? `"${documentTitle}" is unavailable` : 'Document unavailable'}
        hint="It may have been deleted."
        action={onPick ? { label: 'Choose another', run: onPick } : undefined}
      />
    )
  }
  if (!synthetic) return <EmptyCard icon="hourglass_empty" title="Loading…" hint="" />

  return (
    <div className="h-full w-full overflow-hidden">
      <OfficeDocWidget widget={synthetic} inline />
    </div>
  )
}

function EmptyCard({
  icon,
  title,
  hint,
  action
}: {
  icon: string
  title: string
  hint: string
  action?: { label: string; run: () => void }
}): JSX.Element {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center gap-1.5 p-4 text-center">
      <Icon name={icon} size={20} className="text-[var(--ink-30)]" />
      <div className="text-[12.5px] text-[var(--ink-80)]">{title}</div>
      {hint && <div className="text-[11px] text-[var(--ink-50)] max-w-[22rem]">{hint}</div>}
      {action && (
        <button
          className="mt-1 text-[11.5px] px-2 py-1 rounded bg-accent/10 text-[rgb(var(--accent))] hover:bg-accent/20"
          onClick={action.run}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}

// ── Pickers ─────────────────────────────────────────────────────────────────

/** Choose a desk, then one object on it. */
export function DeskWidgetPicker({
  onCancel,
  onConfirm
}: {
  onCancel: () => void
  onConfirm: (config: { deskId: string; widgetId: string; label?: string }) => void
}): JSX.Element {
  const nodes = useNodeStore((s) => s.nodes)
  const [deskId, setDeskId] = useState<string | null>(null)
  const [objects, setObjects] = useState<Widget[] | null>(null)
  const [query, setQuery] = useState('')

  const desks = useMemo(() => {
    const q = query.trim().toLowerCase()
    return nodes
      .filter((n: FbNode) => !n.archived && n.kind === 'task')
      .filter((n) => !q || (n.title || '').toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 30)
  }, [nodes, query])

  useEffect(() => {
    if (!deskId) return
    let cancelled = false
    setObjects(null)
    void window.api.widgets
      .listByTask(deskId)
      .then((ws) => !cancelled && setObjects(ws.filter((w) => w.kind !== 'minimap')))
      .catch(() => !cancelled && setObjects([]))
    return () => {
      cancelled = true
    }
  }, [deskId])

  return (
    <Modal
      onClose={onCancel}
      label="Choose a desk object"
      z={260}
      className="fb-glass-pillow rounded-2xl w-full max-w-md mx-4 overflow-hidden flex flex-col max-h-[70vh]"
      testId="dashboard-desk-widget-picker"
    >
      <div className="px-4 py-3 border-b border-[var(--edge-soft)] text-[13.5px] font-semibold text-[var(--ink-100)]">
        {deskId ? 'Which object?' : 'Which desk?'}
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {!deskId ? (
          <>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search desks"
              placeholder="Search desks…"
              className="fb-field w-full mb-2 px-3 py-2 fb-t-body text-[var(--ink-100)]"
            />
            {desks.length === 0 ? (
              <p className="py-6 text-center text-[12px] text-[var(--ink-50)]">No desks match.</p>
            ) : (
              <div className="space-y-0.5">
                {desks.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => setDeskId(d.id)}
                    data-testid={`dashboard-picker-desk-${d.id}`}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--surface-sunken)]"
                  >
                    <Icon name="space_dashboard" size={15} className="text-[var(--ink-50)] shrink-0" />
                    <span className="flex-1 min-w-0 truncate fb-t-body text-[var(--ink-100)]">
                      {d.title || 'Untitled desk'}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : objects === null ? (
          <p className="py-6 text-center text-[12px] text-[var(--ink-50)]">Loading objects…</p>
        ) : objects.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-[var(--ink-50)]">
            This desk has no objects yet.
          </p>
        ) : (
          <div className="space-y-0.5">
            {objects.map((w) => (
              <button
                key={w.id}
                onClick={() =>
                  onConfirm({ deskId, widgetId: w.id, label: widgetDisplayName(w) })
                }
                data-testid={`dashboard-picker-object-${w.id}`}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--surface-sunken)]"
              >
                <Icon
                  name={catalogFor(w.kind)?.icon ?? 'widgets'}
                  size={15}
                  className="text-[var(--ink-50)] shrink-0"
                />
                <span className="flex-1 min-w-0 truncate fb-t-body text-[var(--ink-100)]">
                  {widgetDisplayName(w)}
                </span>
                <span className="text-[10.5px] text-[var(--ink-40)] shrink-0">
                  {catalogFor(w.kind)?.label ?? w.kind}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="px-3 py-2 border-t border-[var(--edge-soft)] flex justify-between">
        {deskId ? (
          <button className="text-[12px] text-[var(--ink-60)]" onClick={() => setDeskId(null)}>
            ‹ Back
          </button>
        ) : (
          <span />
        )}
        <button className="text-[12px] text-[var(--ink-60)]" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </Modal>
  )
}

/** Choose an office document. */
export function DocumentPicker({
  onCancel,
  onConfirm
}: {
  onCancel: () => void
  onConfirm: (config: { documentId: string; documentTitle: string }) => void
}): JSX.Element {
  const [docs, setDocs] = useState<DocumentMeta[] | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    void window.api.documents
      .list()
      .then((all) => !cancelled && setDocs(all.filter((d) => !d.archived)))
      .catch(() => !cancelled && setDocs([]))
    return () => {
      cancelled = true
    }
  }, [])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (docs ?? [])
      .filter((d) => !q || d.title.toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 40)
  }, [docs, query])

  const icon = (t: DocumentMeta['docType']): string =>
    t === 'sheet' ? 'table_chart' : t === 'slides' ? 'slideshow' : t === 'map' ? 'account_tree' : t === 'design' ? 'palette' : t === 'draw' ? 'brush' : 'description'

  return (
    <Modal
      onClose={onCancel}
      label="Choose a document"
      z={260}
      className="fb-glass-pillow rounded-2xl w-full max-w-md mx-4 overflow-hidden flex flex-col max-h-[70vh]"
      testId="dashboard-document-picker"
    >
      <div className="px-4 py-3 border-b border-[var(--edge-soft)] text-[13.5px] font-semibold text-[var(--ink-100)]">
        Which document?
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search documents"
          placeholder="Search documents…"
          className="fb-field w-full mb-2 px-3 py-2 fb-t-body text-[var(--ink-100)]"
        />
        {docs === null ? (
          <p className="py-6 text-center text-[12px] text-[var(--ink-50)]">Loading documents…</p>
        ) : shown.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-[var(--ink-50)]">
            {(docs ?? []).length === 0 ? 'No documents yet.' : 'Nothing matches.'}
          </p>
        ) : (
          <div className="space-y-0.5">
            {shown.map((d) => (
              <button
                key={d.id}
                onClick={() => onConfirm({ documentId: d.id, documentTitle: d.title })}
                data-testid={`dashboard-picker-doc-${d.id}`}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--surface-sunken)]"
              >
                <Icon name={icon(d.docType)} size={15} className="text-[var(--ink-50)] shrink-0" />
                <span className="flex-1 min-w-0 truncate fb-t-body text-[var(--ink-100)]">
                  {d.title || 'Untitled'}
                </span>
                <span className="text-[10.5px] text-[var(--ink-40)] shrink-0">{d.docType}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="px-3 py-2 border-t border-[var(--edge-soft)] flex justify-end">
        <button className="text-[12px] text-[var(--ink-60)]" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </Modal>
  )
}

// ── A work widget file, live on a dashboard ─────────────────────────────────
//
// "Make it so widgets and apps both plexii and connected can be dragged to a
// dashboard and configured, and remain there", with the object existing
// "without a desk if its not related to one".
//
// IT ALREADY CAN, and that is why this card is short. docs/widget-files.md:
// "A work widget is a file, the way a document or a slide deck is. A desk is
// only the place it lives." Every work widget is a `documents` row with
// doc_type 'widget', so it exists with no desk, syncs, trashes and appears in
// Files without any of that being built here.
//
// So this holds a FILE ID, not the {deskId, widgetId} pair DeskWidgetCard
// takes. Nothing is created on a desk to back it. The same file may also sit
// on any number of desks as linked instances, and the dashboard is a peer of
// those rather than a copy of one.
//
// EDITS NEED NO WIRING. `widgetFromFile` gives the widget the synthetic id
// `wf:<file id>`, and the widget store already routes that id to the file
// instead of to a desk row (stores/widgets.ts, isWidgetFilePaneId). Typing
// here writes the file, which the main process fans out to every placed
// instance. Adding an onChange here would be a second, competing write path.
export function WorkWidgetCard({
  fileId,
  onPick
}: {
  fileId?: string
  onPick?: () => void
}): JSX.Element {
  const file = useWidgetFilesStore((s) => (fileId ? s.files[fileId] : undefined))
  const load = useWidgetFilesStore((s) => s.load)
  const [missing, setMissing] = useState(false)
  const [size, setSize] = useState({ width: 480, height: 320 })
  const bodyRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!fileId) return
    let alive = true
    void load(fileId).then((f) => {
      if (alive && !f) setMissing(true)
    })
    return () => {
      alive = false
    }
  }, [fileId, load])

  // The widget is built at the card's measured size, as the full-pane view
  // does: a table or a chart lays out to the box it is given.
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) setSize({ width: Math.round(r.width), height: Math.round(r.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [file?.id])

  const widget = useMemo(() => (file ? widgetFromFile(file, size) : null), [file, size])

  if (!fileId)
    return (
      <EmptyCard
        icon="widgets"
        title="No work widget yet"
        hint="Drag one from the side menu, or choose one you already have."
        action={onPick ? { label: 'Choose a work widget', run: onPick } : undefined}
      />
    )
  if (missing)
    return (
      <EmptyCard
        icon="help_outline"
        title="That work widget is gone"
        hint="It was trashed or has not synced to this device yet."
        action={onPick ? { label: 'Choose another', run: onPick } : undefined}
      />
    )
  if (!widget) return <EmptyCard icon="hourglass_empty" title="Loading…" hint="" />

  return (
    <div className="h-full w-full flex flex-col overflow-hidden rounded-[inherit]">
      <div ref={bodyRef} className="flex-1 min-h-0 overflow-hidden">
        <WidgetSurfaceContext.Provider value="embedded">
          {renderWidget(widget)}
        </WidgetSurfaceContext.Provider>
      </div>
      {/* Where this lives in Files, and one tap to put it somewhere. A widget
          dropped here has no desk, so without this the only way to file it
          would be to find it again in Files afterwards — which is the exact
          friction the file button was asked for. */}
      <div className="shrink-0 px-2 py-1 border-t border-[var(--edge-hairline)]">
        <DocFiledInChip docId={fileId} compact />
      </div>
    </div>
  )
}

// ── A connected app, live on a dashboard ────────────────────────────────────
//
// The real app, not a launcher tile: "the live app, embedded". This reuses
// the full-pane view rather than mounting its own <webview>, because that
// component carries the session partition, the OAuth pop-up routing and the
// unread-count plumbing — a second implementation would be a second set of
// those bugs. It is h-full and brings its own slim toolbar (back, forward,
// reload, open in browser), which an embedded app needs more than a full-pane
// one does.
export function ConnectedAppCard({
  appId,
  onPick
}: {
  appId?: string
  onPick?: () => void
}): JSX.Element {
  if (!appId)
    return (
      <EmptyCard
        icon="apps"
        title="No app yet"
        hint="Drag a connected app from the side menu onto this dashboard."
        action={onPick ? { label: 'Choose an app', run: onPick } : undefined}
      />
    )
  return (
    <div className="h-full w-full overflow-hidden rounded-[inherit]">
      <ConnectedAppView appId={appId} />
    </div>
  )
}

// ── A pinned page ───────────────────────────────────────────────────────────
//
// The browser's place on a dashboard. The other five apps embed their own
// view, which takes no props; a browser has no such view — it is a widget
// kind, and WebViewWidget writes its URL, title and source app back to its
// own `widgets` row. A dashboard card has no such row, so those writes would
// go nowhere and the card would quietly forget where it was.
//
// So this is a PINNED PAGE rather than a free browser: the URL lives on the
// card, in the dashboard's own layout, and the card always shows that page.
// Following a link works for as long as the card is mounted; it is not
// remembered, because the thing being remembered is the pin. Said plainly in
// the UI rather than left to be discovered.
export function BrowserCard({
  url,
  onPick
}: {
  url?: string
  onPick?: () => void
}): JSX.Element {
  if (!url)
    return (
      <EmptyCard
        icon="public"
        title="No page pinned"
        hint="Pin a page to keep it in front of you."
        action={onPick ? { label: 'Pin a page', run: onPick } : undefined}
      />
    )
  return (
    <div className="h-full w-full flex flex-col overflow-hidden rounded-[inherit]">
      <div className="shrink-0 px-2 py-1 flex items-center gap-1 border-b border-[var(--edge-hairline)]">
        <Icon name="public" size={13} className="text-[var(--ink-40)] shrink-0" />
        <span className="flex-1 min-w-0 truncate text-[11px] text-[var(--ink-50)]" title={url}>
          {url.replace(/^https?:\/\//, '')}
        </span>
        {onPick && (
          <button
            onClick={onPick}
            className="h-6 px-1.5 rounded-md text-[11px] text-[var(--ink-50)] hover:bg-[var(--surface-sunken)]"
            title="Pin a different page"
          >
            Change
          </button>
        )}
      </div>
      <webview
        src={url}
        className="flex-1 min-h-0 w-full"
        // In the JSX, not from an effect: Electron reads allowpopups when the
        // guest webContents is created, and an attribute added afterwards is
        // silently ignored (the same trap that once stopped every connected
        // app signing in). Needed here too — a pinned page may be an app
        // whose login opens a pop-up.
        // @ts-ignore — allowpopups is a valid <webview> attribute
        allowpopups="true"
      />
    </div>
  )
}

// ── An app view, contained ──────────────────────────────────────────────────
//
// The five app views are written for a full pane: their own padding, their
// own toolbars, and in places a width they assume they can have. Dropped
// straight into a grid cell they overflow it — measured, not guessed: Mail's
// connect form ran out past the card's left edge, Files' toolbar was clipped
// mid-word, and the vault's setup panel fell out of the bottom.
//
// So an embedded app gets a containing block that owns the overflow: the
// card scrolls, the page does not, and nothing escapes the rounded corner.
// `isolation` keeps a view's own z-indexed chrome inside the card instead of
// over its neighbours, and `contain: layout` stops a view that measures the
// viewport from reflowing the whole grid.
export function AppCard({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div
      className="h-full w-full min-w-0 overflow-auto rounded-[inherit] isolate"
      style={{ contain: 'layout paint' }}
      data-app-card
    >
      {children}
    </div>
  )
}
