import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Reorder } from 'framer-motion'
import { useViewStore } from '../../stores/view'
import { useNodeStore } from '../../stores/nodes'
import { useDocumentsStore } from '../../stores/documents'
import { useConnectedAppsStore } from '../../stores/connectedApps'
import { useFocusSessionStore } from '../../stores/focusSession'
import { useMessagingStore } from '../../stores/messaging'
import { useAccountStore } from '../../stores/account'
import { usePresenceStore } from '../../stores/presence'
import { useCapabilityEnabled } from '../../stores/capabilities'
import { useWidgetStore } from '../../stores/widgets'
import { useChatStore } from '../../stores/chat'
import { splitFavourites } from '../../lib/connectedAppSort'
import { personDisplayName } from '../../lib/personName'
import { transcribeRecording } from '../../lib/transcribeRecording'
import { saveTranscriptDoc } from '../../lib/meetingWrapup'
import { RailCard } from '../plexi'
import Modal from '../plexi/Modal'
import Icon from '../Icon'
import AppLogo from '../AppLogo'
import AddConnectedAppDialog from '../AddConnectedAppDialog'
import NewMeetingDialog from '../NewMeetingDialog'
import type { ActivityEvent, FbNode, SearchHit } from '@shared/types'
import {
  describeShortcutTarget,
  faviconUrl,
  normalizeUrl,
  targetKey,
  urlLabel,
  visibleShortcuts
} from './homeShortcutTargets'
import type { ShortcutLookups } from './homeShortcutTargets'

// The home widget catalog — registry metadata for the gallery, plus the widget
// components that are not part of the original dashboard set. Every widget
// reads real stores directly and shows an honest empty state; nothing is
// seeded or invented. The original seven (standup, navigator, continue,
// agenda, pulse, quick, activity) render inside HomeDashboard, which owns
// their imperatively-loaded data.

// Registry data (ids, defs, sizes, quick-link routes) lives in
// homeWidgetDefs.ts — pure data with no JSX — and is re-exported here so
// existing imports keep working.
export type { HomeWidgetId, HomeWidgetConfig, HomeWidgetInstance, WidgetSize, HomeWidgetDef, QuickLinkRoute } from './homeWidgetDefs'
export { HOME_WIDGET_DEFS, widgetDef, QUICK_LINK_ROUTES } from './homeWidgetDefs'
import { QUICK_LINK_ROUTES } from './homeWidgetDefs'
import type { HomeWidgetConfig, ShortcutTarget, WidgetSize } from './homeWidgetDefs'

function relTime(ms: number): string {
  const diff = Date.now() - ms
  const m = Math.round(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const hrs = Math.round(m / 60)
  if (hrs < 24) return `${hrs}h ago`
  const d = Math.round(hrs / 24)
  if (d < 7) return `${d}d ago`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// my-auto: inside a home tile the content region is a flex column, so the
// empty state centers vertically instead of hugging the header.
function EmptyState({ text }: { text: string }): JSX.Element {
  return <p className="my-auto py-4 text-center text-[12px] text-[var(--ink-50)]">{text}</p>
}

function useOpenDesk(): (n: FbNode) => void {
  const v = useViewStore()
  const setActive = useNodeStore((s) => s.setActive)
  return (n) => {
    if (n.kind === 'folder') {
      // A folder node is a room: land on its dashboard, same as RoomsView.
      setActive(n.id)
      v.goRoom(n.id)
      return
    }
    setActive(n.id)
    v.goTask(n.id)
  }
}

// ── Navigation ───────────────────────────────────────────────────────────────

export function PinnedDeskWidget({
  deskId,
  onAddAnother
}: {
  deskId?: string
  onAddAnother?: () => void
}): JSX.Element {
  const node = useNodeStore((s) => s.nodes.find((n) => n.id === deskId) ?? null)
  const openDesk = useOpenDesk()
  return (
    <RailCard title="Pinned desk" icon="push_pin" tone="violet">
      {!node || node.archived ? (
        <EmptyState text="This desk is gone. Remove the widget or pin another." />
      ) : (
        <button
          onClick={() => openDesk(node)}
          data-testid={`home-pinned-desk-${node.id}`}
          className="flex w-full items-center gap-3 fb-tile-lit fb-press px-3 py-2.5 text-left"
        >
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-violet-500/10 text-violet-500 shrink-0">
            <Icon name={node.kind === 'folder' ? 'folder' : 'desk'} size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate fb-t-body font-medium text-[var(--ink-100)]">
              {node.title || 'Untitled desk'}
            </span>
            <span className="block fb-t-caption">Edited {relTime(node.updatedAt)}</span>
          </span>
          <Icon name="chevron_right" size={16} className="text-[var(--ink-40)] shrink-0" />
        </button>
      )}
      {/* Ghost row: pinning one more desk is always visibly one click away. */}
      {onAddAnother && (
        <button
          onClick={onAddAnother}
          data-testid="home-pinned-desk-add"
          className="fb-btn-surface mt-2 flex w-full items-center gap-3 border-dashed px-3 py-2.5 text-left text-[var(--ink-40)] hover:text-[rgb(var(--accent))] hover:border-[rgb(var(--accent)/0.5)] fb-press transition-colors"
        >
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-dashed border-[var(--edge-soft)] shrink-0">
            <Icon name="add" size={16} />
          </span>
          <span className="fb-t-body">Add desk</span>
        </button>
      )}
    </RailCard>
  )
}

export function RoomPortalWidget({ roomId, size = 'lg' }: { roomId?: string; size?: WidgetSize }): JSX.Element {
  const room = useNodeStore((s) => s.nodes.find((n) => n.id === roomId) ?? null)
  const nodes = useNodeStore((s) => s.nodes)
  const openDesk = useOpenDesk()
  // md is one row of tiles, lg is a 2x2 board.
  const cap = size === 'md' ? 2 : 6
  const desks = useMemo(
    () =>
      nodes
        .filter((n) => n.kind === 'task' && !n.archived && n.parentId === roomId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, cap),
    [nodes, roomId, cap]
  )
  return (
    <RailCard
      title={room && !room.archived ? room.title || 'Untitled room' : 'Room portal'}
      icon="door_open"
      tone="sky"
      action={room && !room.archived ? { label: 'Open', onClick: () => openDesk(room) } : undefined}
    >
      {!room || room.archived ? (
        <EmptyState text="This room is gone. Remove the widget or open another." />
      ) : desks.length === 0 ? (
        <EmptyState text="No desks in this room yet." />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 auto-rows-fr flex-1 min-h-0 gap-2" data-testid={`home-room-portal-${room.id}`}>
          {desks.map((n) => (
            <button
              key={n.id}
              onClick={() => openDesk(n)}
              className="flex items-center gap-2.5 fb-tile-lit fb-press px-2.5 py-2 text-left"
            >
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-teal-500/10 text-teal-500 shrink-0">
                <Icon name="desk" size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate fb-t-body text-[var(--ink-100)]">{n.title || 'Untitled desk'}</span>
                <span className="block fb-t-caption">Edited {relTime(n.updatedAt)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </RailCard>
  )
}

// One navigation map for PlexiDesk section shortcuts, shared by Quick Links
// and the Shortcuts widget's section targets so both always land identically.
type ViewStore = ReturnType<typeof useViewStore.getState>
function goSection(v: ViewStore, id: string): void {
  switch (id) {
    case 'rooms': v.goRooms(); break
    case 'desks': v.goDesks(); break
    case 'shared': v.goShared(); break
    case 'plans': v.goProjects(); break
    case 'tasks': v.goAllTasks(); break
    case 'calendar': v.goCalendar(); break
    case 'documents': v.goDocuments(); break
    case 'files': v.goFiles(); break
    case 'vault': v.goVault(); break
  }
}

export function AppLauncherWidget(): JSX.Element {
  const apps = useConnectedAppsStore((s) => s.apps)
  const launchLocal = useConnectedAppsStore((s) => s.launchLocal)
  const v = useViewStore()
  const [addOpen, setAddOpen] = useState(false)
  const { favourites } = useMemo(() => splitFavourites(apps), [apps])
  const shown = favourites.length > 0 ? favourites.slice(0, 8) : apps.slice(0, 8)
  return (
    <RailCard title="App launcher" icon="apps" tone="emerald">
      {/* Icon-only, fixed square tiles, top-aligned wrap — the tile shape
          never depends on how many apps there are or how wide the widget is.
          Names ride the tooltip. The trailing dashed tile keeps the widget
          subtly proactive: adding is always one click away. */}
      <div className="flex flex-wrap content-start gap-2" data-testid="home-app-launcher">
        {shown.map((a) => (
          <button
            key={a.id}
            onClick={() => (a.kind === 'local' ? void launchLocal(a.id) : v.goConnectedApp(a.id))}
            title={a.title}
            aria-label={a.title}
            data-testid={`home-app-launch-${a.id}`}
            className="h-16 w-16 shrink-0 flex items-center justify-center fb-tile-lit fb-press"
          >
            {/* Logos were never small (38px) — the dark well made them read
                that way. The lit ground is the fix; fallback glyph up to 24. */}
            <AppLogo app={a} size={38} glyphSize={24} />
          </button>
        ))}
        <button
          onClick={() => setAddOpen(true)}
          title="Add app"
          aria-label="Add app"
          data-testid="home-app-launcher-add"
          className="fb-btn-surface h-16 w-16 shrink-0 flex flex-col items-center justify-center gap-0.5 border-dashed text-[var(--ink-40)] hover:text-[rgb(var(--accent))] hover:border-[rgb(var(--accent)/0.5)] fb-press transition-colors"
        >
          <Icon name="add" size={18} />
          <span className="text-[9px] font-medium">Add app</span>
        </button>
      </div>
      {addOpen && (
        <AddConnectedAppDialog onClose={() => setAddOpen(false)} onAdded={(id) => v.goConnectedApp(id)} />
      )}
    </RailCard>
  )
}

// ── Shortcuts ────────────────────────────────────────────────────────────────
// A fully custom box of tiles that go anywhere: PlexiDesk sections, desks,
// rooms, documents, connected apps, and outside websites. Multi-instance with
// a name per box; the composer overlay adds, renames, reorders, and removes.

type ConnectedApp = ReturnType<typeof useConnectedAppsStore.getState>['apps'][number]

// The visual for one shortcut: favicon for websites (globe fallback), the real
// app logo for connected apps, a toned Plexii icon for everything else.
function ShortcutGlyph({
  target,
  icon,
  tone,
  apps,
  size
}: {
  target: ShortcutTarget
  icon: string
  tone: string
  apps: ConnectedApp[]
  size: number
}): JSX.Element {
  const [imgReady, setImgReady] = useState(false)
  if (target.kind === 'url') {
    // The globe shows immediately; the favicon replaces it only once it has
    // actually loaded, so the tile is never blank while the network thinks.
    const src = faviconUrl(target.url)
    return (
      <span
        className="relative inline-flex items-center justify-center shrink-0"
        style={{ width: size, height: size }}
      >
        {!imgReady && <Icon name="language" size={size} className="text-indigo-500" />}
        {src && (
          <img
            src={src}
            alt=""
            width={size}
            height={size}
            className={`absolute inset-0 rounded ${imgReady ? '' : 'opacity-0'}`}
            onLoad={() => setImgReady(true)}
            onError={() => setImgReady(false)}
          />
        )}
      </span>
    )
  }
  if (target.kind === 'connected-app') {
    const app = apps.find((a) => a.id === target.appId)
    if (app) return <AppLogo app={app} size={size + 8} glyphSize={size - 2} />
  }
  return <Icon name={icon} size={size} className={`${tone} shrink-0`} />
}

// The glyph in its tinted chip: the standard identity block for shortcut
// tiles and composer rows. The wash derives from currentColor (fb-chip-lit),
// so the tone class rides the chip itself and one recipe serves every tone
// at the themed alpha — any text colour class works, no per-tone map.
function ShortcutChip({
  target,
  icon,
  tone,
  apps,
  chip,
  glyph
}: {
  target: ShortcutTarget
  icon: string
  tone: string
  apps: ConnectedApp[]
  chip: number
  glyph: number
}): JSX.Element {
  return (
    <span
      className={`inline-flex items-center justify-center shrink-0 fb-chip-lit ${tone}`}
      style={{ width: chip, height: chip }}
    >
      <ShortcutGlyph target={target} icon={icon} tone={tone} apps={apps} size={glyph} />
    </span>
  )
}

export function ShortcutsWidget({
  config,
  size,
  onUpdate
}: {
  config?: HomeWidgetConfig
  size: WidgetSize
  onUpdate: (config: HomeWidgetConfig) => void
}): JSX.Element {
  const v = useViewStore()
  const nodes = useNodeStore((s) => s.nodes)
  const setActive = useNodeStore((s) => s.setActive)
  const docs = useDocumentsStore((s) => s.list)
  const apps = useConnectedAppsStore((s) => s.apps)
  const launchLocal = useConnectedAppsStore((s) => s.launchLocal)
  const conversations = useMessagingStore((s) => s.conversations)
  const setActiveConversation = useMessagingStore((s) => s.setActive)
  const startDm = useMessagingStore((s) => s.startDm)
  const [composerOpen, setComposerOpen] = useState(false)
  // An action tile in flight: its overlay renders from this widget.
  const [openAction, setOpenAction] = useState<'new-meeting' | 'transcribe' | null>(null)

  const targets = config?.targets ?? []

  // Backfill: document targets added before context captions existed carry no
  // Drive-location detail. Resolve them once per mount so old tiles say what
  // they are without being re-added. One guarded pass; commits only if a
  // location was actually found.
  const backfilledRef = useRef(false)
  const configForBackfill = useRef(config)
  configForBackfill.current = config
  useEffect(() => {
    if (backfilledRef.current) return
    const missing = (config?.targets ?? []).filter(
      (t): t is Extract<ShortcutTarget, { kind: 'document' }> => t.kind === 'document' && !t.detail
    )
    if (missing.length === 0) return
    backfilledRef.current = true
    void (async () => {
      const found = new Map<string, string>()
      for (const t of missing) {
        const loc = await window.api.fileManager.locateDocument(t.documentId).catch(() => null)
        const name = loc?.path?.length ? loc.path[loc.path.length - 1]?.name : null
        if (name) found.set(targetKey(t), name)
      }
      if (found.size === 0) return
      const cfg = configForBackfill.current
      const cur = cfg?.targets ?? []
      onUpdate({
        ...cfg,
        targets: cur.map((x) => {
          const detail = found.get(targetKey(x))
          return detail && !x.detail ? { ...x, detail } : x
        })
      })
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.targets])

  const lookups = useMemo<ShortcutLookups>(
    () => ({
      node: (id) => {
        const n = nodes.find((x) => x.id === id)
        if (!n) return null
        const parent = n.parentId ? nodes.find((x) => x.id === n.parentId) : null
        return { title: n.title || '', archived: !!n.archived, parentTitle: parent?.title || null }
      },
      document: (id) => {
        const d = docs.find((x) => x.id === id)
        return d ? { title: d.title, docType: d.docType, archived: d.archived } : null
      },
      app: (id) => {
        const a = apps.find((x) => x.id === id)
        return a ? { title: a.title } : null
      }
    }),
    [nodes, docs, apps]
  )

  const invoke = (t: ShortcutTarget): void => {
    if (!describeShortcutTarget(t, lookups).alive) {
      // A dead tile stops navigating; clicking it opens the composer so the
      // broken entry can be removed or replaced on the spot.
      setComposerOpen(true)
      return
    }
    switch (t.kind) {
      case 'url':
        void window.api.files.openExternal(t.url).catch(() => {})
        break
      case 'section':
        goSection(v, t.id)
        break
      case 'desk':
        setActive(t.nodeId)
        v.goTask(t.nodeId)
        break
      case 'room':
        v.goRoom(t.roomId)
        break
      case 'document':
        v.goDocument(t.documentId)
        break
      case 'connected-app': {
        const app = apps.find((a) => a.id === t.appId)
        if (app?.kind === 'local') void launchLocal(app.id)
        else v.goConnectedApp(t.appId)
        break
      }
      case 'desk-widget': {
        setActive(t.nodeId)
        v.goTask(t.nodeId)
        // The desk's widgets load after navigation; focusOn is the store's
        // surface-an-offscreen-widget primitive (BringMeBack uses it too).
        // Gate on layoutHydratedFor === this desk: Canvas restores the desk's
        // persisted camera on mount, and a focusOn fired before that hydration
        // would be clobbered a frame later by the restored pan/zoom. Widget
        // presence alone is not proof hydration ran; they are separate loads.
        // If the widget never appears (deleted), landing on the desk alone is
        // the honest outcome, so the poll just gives up quietly.
        const startedAt = Date.now()
        const tick = window.setInterval(() => {
          const st = useWidgetStore.getState()
          if (st.layoutHydratedFor === t.nodeId && st.widgets.some((w) => w.id === t.widgetId)) {
            window.clearInterval(tick)
            st.focusOn(t.widgetId)
          } else if (Date.now() - startedAt > 5000) {
            window.clearInterval(tick)
          }
        }, 150)
        break
      }
      case 'action':
        setOpenAction(t.action)
        break
      case 'person':
        void (async () => {
          const dm = conversations.find(
            (c) => c.kind === 'dm' && c.members.some((m) => m.accountId === t.accountId)
          )
          if (dm) {
            await setActiveConversation(dm.id)
            v.goMessages()
            return
          }
          if (t.handle) {
            const r = await startDm(t.handle)
            if (r.ok) {
              await setActiveConversation(r.id)
              v.goMessages()
              return
            }
          }
          v.goMessages()
        })()
        break
    }
  }

  const { shown, overflow } = visibleShortcuts(targets.length, size)
  const visible = targets.slice(0, shown)
  const title = config?.title?.trim() || 'Shortcuts'
  const openComposer = (): void => setComposerOpen(true)

  const addGhost = (compact: boolean): JSX.Element =>
    compact ? (
      <button
        onClick={openComposer}
        title="Add shortcut"
        aria-label="Add shortcut"
        data-testid="home-shortcuts-add"
        className="fb-btn-surface w-16 h-[72px] shrink-0 flex flex-col items-center justify-center gap-0.5 border-dashed text-[var(--ink-40)] hover:text-[rgb(var(--accent))] hover:border-[rgb(var(--accent)/0.5)] fb-press transition-colors"
      >
        <Icon name="add" size={18} />
        <span className="text-[9px] font-medium">Add</span>
      </button>
    ) : (
      <button
        onClick={openComposer}
        data-testid="home-shortcuts-add"
        className="fb-btn-surface flex items-center justify-center gap-1.5 border-dashed px-2.5 py-2 text-[var(--ink-40)] hover:text-[rgb(var(--accent))] hover:border-[rgb(var(--accent)/0.5)] fb-press transition-colors"
      >
        <Icon name="add" size={15} />
        <span className="text-[11.5px] font-medium">Add shortcut</span>
      </button>
    )

  const moreTile = (compact: boolean): JSX.Element => (
    <button
      onClick={openComposer}
      title={`${overflow} more`}
      data-testid="home-shortcuts-more"
      className={
        compact
          ? 'w-16 h-[72px] shrink-0 flex items-center justify-center fb-tile-lit fb-press text-[12px] font-semibold text-[var(--ink-60)]'
          : 'flex items-center justify-center fb-tile-lit fb-press px-2.5 py-2 text-[11.5px] font-semibold text-[var(--ink-60)]'
      }
    >
      +{overflow}
    </button>
  )

  return (
    <RailCard title={title} icon="link" tone="accent">
      {targets.length === 0 ? (
        <div className="my-auto flex flex-col items-center gap-2 py-2" data-testid="home-shortcuts-empty">
          {addGhost(true)}
          <p className="text-[12px] text-[var(--ink-50)] text-center">
            Take yourself anywhere: desks, documents, websites, apps.
          </p>
        </div>
      ) : size === 'sm' ? (
        <div className="flex flex-wrap content-start gap-2" data-testid="home-shortcuts">
          {visible.map((t, i) => {
            const view = describeShortcutTarget(t, lookups)
            return (
              <button
                key={targetKey(t)}
                onClick={() => invoke(t)}
                title={view.alive ? `${view.label} · ${view.caption}` : `${view.label} (gone)`}
                aria-label={view.label}
                data-testid={`home-shortcut-${i}`}
                className={`w-16 h-[72px] shrink-0 flex flex-col items-center justify-center gap-1.5 fb-tile-lit fb-press px-0.5 ${view.alive ? '' : 'opacity-40'}`}
              >
                <ShortcutChip target={t} icon={view.icon} tone={view.tone} apps={apps} chip={36} glyph={22} />
                <span className="max-w-full truncate text-[11px] font-medium leading-none text-[var(--ink-100)]">
                  {view.label}
                </span>
              </button>
            )
          })}
          {overflow > 0 && moreTile(true)}
          {addGhost(true)}
        </div>
      ) : size === 'md' ? (
        <div className="grid grid-cols-3 auto-rows-fr flex-1 min-h-0 gap-2" data-testid="home-shortcuts">
          {visible.map((t, i) => {
            const view = describeShortcutTarget(t, lookups)
            return (
              <button
                key={targetKey(t)}
                onClick={() => invoke(t)}
                title={view.alive ? undefined : `${view.label} (gone)`}
                data-testid={`home-shortcut-${i}`}
                className={`flex items-center gap-2.5 fb-tile-lit fb-press px-2.5 py-2 text-left ${view.alive ? '' : 'opacity-40'}`}
              >
                <ShortcutChip target={t} icon={view.icon} tone={view.tone} apps={apps} chip={36} glyph={22} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium text-[var(--ink-100)]">{view.label}</span>
                  <span className="block truncate text-[11px] text-[var(--ink-50)]">
                    {view.alive ? view.caption : 'Gone. Click to fix.'}
                  </span>
                </span>
              </button>
            )
          })}
          {overflow > 0 && moreTile(false)}
          {addGhost(false)}
        </div>
      ) : (
        <div
          className={`grid ${size === 'lg' ? 'grid-cols-2' : 'grid-cols-1'} auto-rows-fr flex-1 min-h-0 gap-1.5`}
          data-testid="home-shortcuts"
        >
          {visible.map((t, i) => {
            const view = describeShortcutTarget(t, lookups)
            return (
              <button
                key={targetKey(t)}
                onClick={() => invoke(t)}
                data-testid={`home-shortcut-${i}`}
                className={`flex items-center gap-2.5 fb-tile-lit fb-press px-2.5 py-1.5 text-left min-h-0 ${view.alive ? '' : 'opacity-40'}`}
              >
                {/* Dense list register: chip 32/20 — 36 does not clear the
                    stack size's ~42px auto-fr rows. Tiles are 36/22. */}
                <ShortcutChip target={t} icon={view.icon} tone={view.tone} apps={apps} chip={32} glyph={20} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium text-[var(--ink-100)]">{view.label}</span>
                  <span className="block truncate text-[10.5px] text-[var(--ink-50)]">
                    {view.alive ? view.caption : 'Gone. Click to fix.'}
                  </span>
                </span>
              </button>
            )
          })}
          {overflow > 0 && moreTile(false)}
          {addGhost(false)}
        </div>
      )}
      {composerOpen && (
        <ShortcutComposer config={config} onUpdate={onUpdate} onClose={() => setComposerOpen(false)} />
      )}
      {openAction === 'new-meeting' && <NewMeetingDialog onClose={() => setOpenAction(null)} />}
      {openAction === 'transcribe' && <TranscribeOverlay onClose={() => setOpenAction(null)} />}
    </RailCard>
  )
}

// The floating composer: name the box, paste a link or search everything,
// reorder and prune what is already inside. Every change commits live.
function ShortcutComposer({
  config,
  onUpdate,
  onClose
}: {
  config?: HomeWidgetConfig
  onUpdate: (config: HomeWidgetConfig) => void
  onClose: () => void
}): JSX.Element {
  const nodes = useNodeStore((s) => s.nodes)
  const docs = useDocumentsStore((s) => s.list)
  const apps = useConnectedAppsStore((s) => s.apps)
  const presencePeers = usePresenceStore((s) => s.peers)
  const presenceEnabled = useCapabilityEnabled('presence')
  const [query, setQuery] = useState('')
  const [deepHits, setDeepHits] = useState<SearchHit[]>([])
  const [renamingKey, setRenamingKey] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [boxName, setBoxName] = useState(config?.title ?? '')
  const inputRef = useRef<HTMLInputElement | null>(null)

  const targets = useMemo(() => config?.targets ?? [], [config])
  const taken = useMemo(() => new Set(targets.map(targetKey)), [targets])
  // Latest config for async enrichment callbacks (Drive lookups resolve after
  // the commit that added the target).
  const configRef = useRef(config)
  configRef.current = config

  const lookups = useMemo<ShortcutLookups>(
    () => ({
      node: (id) => {
        const n = nodes.find((x) => x.id === id)
        if (!n) return null
        const parent = n.parentId ? nodes.find((x) => x.id === n.parentId) : null
        return { title: n.title || '', archived: !!n.archived, parentTitle: parent?.title || null }
      },
      document: (id) => {
        const d = docs.find((x) => x.id === id)
        return d ? { title: d.title, docType: d.docType, archived: d.archived } : null
      },
      app: (id) => {
        const a = apps.find((x) => x.id === id)
        return a ? { title: a.title } : null
      }
    }),
    [nodes, docs, apps]
  )

  const commit = (next: Partial<HomeWidgetConfig>): void => onUpdate({ ...config, ...next })
  const commitTitle = (): void => {
    const t = boxName.trim()
    if (t !== (config?.title ?? '')) commit({ title: t || undefined })
  }
  const close = (): void => {
    commitTitle()
    onClose()
  }

  const toggle = (t: ShortcutTarget): void => {
    const key = targetKey(t)
    if (taken.has(key)) {
      commit({ targets: targets.filter((x) => targetKey(x) !== key) })
    } else {
      commit({ targets: [...targets, t] })
      // Documents get their Drive location stamped in after the fact, so the
      // tile can say "Spreadsheet · Flamelit" instead of a bare doc icon.
      if (t.kind === 'document') {
        void window.api.fileManager
          .locateDocument(t.documentId)
          .then((loc) => {
            const detail = loc?.path?.length ? loc.path[loc.path.length - 1]?.name : null
            if (!detail) return
            const cfg = configRef.current
            const cur = cfg?.targets ?? []
            if (!cur.some((x) => targetKey(x) === key)) return
            onUpdate({
              ...cfg,
              targets: cur.map((x) => (targetKey(x) === key ? { ...x, detail } : x))
            })
          })
          .catch(() => {})
      }
    }
    setQuery('')
    inputRef.current?.focus()
  }

  // Deep content search from the main process: finds desks, rooms, and
  // documents whose bodies match, not just their titles. Debounced; skipped
  // when the query is a pasted link.
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2 || normalizeUrl(q)) {
      setDeepHits([])
      return
    }
    const timer = window.setTimeout(() => {
      void window.api.search
        .query(q)
        .then((hits) =>
          setDeepHits(
            hits.filter(
              (h) => h.type === 'task' || h.type === 'folder' || h.type === 'document' || h.type === 'widget'
            )
          )
        )
        .catch(() => setDeepHits([]))
    }, 200)
    return () => window.clearTimeout(timer)
  }, [query])

  const url = normalizeUrl(query)

  interface Candidate {
    target: ShortcutTarget
    label: string
    icon: string
    tone: string
  }
  const groups = useMemo<{ name: string; items: Candidate[] }[]>(() => {
    const q = query.trim().toLowerCase()
    if (url) return []
    const out: { name: string; items: Candidate[] }[] = []
    const sectionItems = QUICK_LINK_ROUTES.filter((r) => !q || r.label.toLowerCase().includes(q)).map((r) => ({
      target: { kind: 'section' as const, id: r.id, label: r.label },
      label: r.label,
      icon: r.icon,
      tone: r.tone
    }))
    // Action tiles: a shortcut can DO something, not just go somewhere.
    const actionItems = (
      [
        { action: 'new-meeting' as const, label: 'New meeting', icon: 'plexii:meet', tone: 'text-rose-500' },
        { action: 'transcribe' as const, label: 'Transcribe', icon: 'plexii:mic', tone: 'text-violet-500' }
      ] as const
    )
      .filter((a) => !q || a.label.toLowerCase().includes(q))
      .map((a) => ({
        target: { kind: 'action' as const, action: a.action, label: a.label },
        label: a.label,
        icon: a.icon,
        tone: a.tone
      }))
    // People online now (presence is Team-tier; hidden when not entitled).
    const peopleItems = presenceEnabled
      ? Object.values(presencePeers)
          .filter((p) => !q || personDisplayName(p, p.handle).toLowerCase().includes(q))
          .slice(0, 5)
          .map((p) => ({
            target: {
              kind: 'person' as const,
              accountId: p.accountId,
              handle: p.handle,
              label: personDisplayName(p, p.handle)
            },
            label: personDisplayName(p, p.handle),
            icon: 'account_circle',
            tone: 'text-sky-500'
          }))
      : []
    const appItems = apps
      .filter((a) => !q || a.title.toLowerCase().includes(q))
      .slice(0, 6)
      .map((a) => ({
        target: { kind: 'connected-app' as const, appId: a.id, label: a.title },
        label: a.title,
        icon: 'apps',
        tone: 'text-emerald-500'
      }))
    if (!q) {
      // No query yet: the finite catalogs are browsable immediately;
      // everything else needs a few letters.
      if (actionItems.length) out.push({ name: 'Actions', items: actionItems })
      if (appItems.length) out.push({ name: 'Connected apps', items: appItems })
      if (sectionItems.length) out.push({ name: 'PlexiDesk sections', items: sectionItems })
      if (peopleItems.length) out.push({ name: 'People online', items: peopleItems })
      return out
    }
    if (actionItems.length) out.push({ name: 'Actions', items: actionItems })
    if (sectionItems.length) out.push({ name: 'PlexiDesk sections', items: sectionItems.slice(0, 4) })
    if (peopleItems.length) out.push({ name: 'People online', items: peopleItems })

    const nodeGroup = (kind: 'task' | 'folder', name: string): void => {
      const byTitle = nodes
        .filter((n) => n.kind === kind && !n.archived && (n.title || '').toLowerCase().includes(q))
        .sort((a, b) => b.updatedAt - a.updatedAt)
      const hitType = kind === 'task' ? 'task' : 'folder'
      const fromDeep = deepHits
        .filter((h) => h.type === hitType && !byTitle.some((n) => n.id === h.id))
        .map((h) => nodes.find((n) => n.id === h.id && !n.archived))
        .filter(Boolean) as FbNode[]
      const items = [...byTitle, ...fromDeep].slice(0, 5).map((n) => ({
        target:
          kind === 'task'
            ? { kind: 'desk' as const, nodeId: n.id, label: n.title || '' }
            : { kind: 'room' as const, roomId: n.id, label: n.title || '' },
        label: n.title || (kind === 'task' ? 'Untitled desk' : 'Untitled room'),
        icon: kind === 'task' ? 'desk' : 'meeting_room',
        tone: kind === 'task' ? 'text-violet-500' : 'text-sky-500'
      }))
      if (items.length) out.push({ name, items })
    }
    nodeGroup('task', 'Desks')
    nodeGroup('folder', 'Rooms')

    const docByTitle = docs.filter((d) => !d.archived && d.title.toLowerCase().includes(q))
    const docFromDeep = deepHits
      .filter((h) => h.type === 'document' && !docByTitle.some((d) => d.id === h.id))
      .map((h) => docs.find((d) => d.id === h.id && !d.archived))
      .filter(Boolean) as typeof docs
    const docItems = [...docByTitle, ...docFromDeep].slice(0, 5).map((d) => {
      const view = describeShortcutTarget({ kind: 'document', documentId: d.id }, lookups)
      return {
        target: { kind: 'document' as const, documentId: d.id, label: d.title },
        label: d.title || 'Untitled document',
        icon: view.icon,
        tone: view.tone
      }
    })
    if (docItems.length) out.push({ name: 'Documents', items: docItems })

    // Widgets on desks, via deep search (its 'widget' hits carry the desk id).
    // Only widgets whose desk still exists are offered.
    const widgetItems = deepHits
      .filter((h) => h.type === 'widget' && h.taskId)
      .map((h) => {
        const desk = nodes.find((n) => n.id === h.taskId && n.kind === 'task' && !n.archived)
        if (!desk) return null
        return {
          target: { kind: 'desk-widget' as const, nodeId: desk.id, widgetId: h.id, label: h.title },
          label: h.title || 'Untitled widget',
          icon: 'dashboard_customize',
          tone: 'text-teal-500'
        }
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .slice(0, 5)
    if (widgetItems.length) out.push({ name: 'Desk widgets', items: widgetItems })

    if (appItems.length) out.push({ name: 'Connected apps', items: appItems })
    return out
  }, [query, url, nodes, docs, apps, deepHits, lookups, presencePeers, presenceEnabled])

  const keys = targets.map(targetKey)
  const reorder = (nextKeys: string[]): void => {
    const byKey = new Map(targets.map((t) => [targetKey(t), t]))
    commit({ targets: nextKeys.map((k) => byKey.get(k)).filter(Boolean) as ShortcutTarget[] })
  }
  const rename = (key: string): void => {
    const label = renameDraft.trim()
    commit({
      targets: targets.map((t) => (targetKey(t) === key ? { ...t, label: label || undefined } : t))
    })
    setRenamingKey(null)
  }

  return (
    <Modal
      onClose={close}
      label="Edit shortcuts"
      z={260}
      className="fb-glass-pillow rounded-2xl w-full max-w-lg mx-4 overflow-hidden flex flex-col max-h-[76vh]"
      testId="home-shortcut-composer"
    >
      <div className="px-4 py-3 border-b border-[var(--edge-soft)] flex items-center gap-2.5">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-500 shrink-0">
          <Icon name="link" size={15} />
        </span>
        <input
          value={boxName}
          onChange={(e) => setBoxName(e.target.value)}
          onBlur={commitTitle}
          placeholder="Shortcuts"
          aria-label="Box name"
          data-testid="home-shortcut-composer-title"
          className="flex-1 min-w-0 bg-transparent text-[13.5px] font-semibold text-[var(--ink-100)] placeholder:text-[var(--ink-40)]"
        />
        <button
          onClick={close}
          title="Done"
          data-testid="home-shortcut-composer-done"
          className="shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-medium bg-[rgb(var(--accent))] text-white hover:bg-[rgb(var(--accent-hover))] transition-colors"
        >
          <Icon name="check" size={14} />
          Done
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
        <div>
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && url) {
                toggle({ kind: 'url', url, label: urlLabel(url) })
              }
            }}
            placeholder="Paste a link, or search desks, rooms, documents, apps"
            data-testid="home-shortcut-composer-input"
            className="fb-field w-full px-3 py-2 fb-t-body text-[var(--ink-100)] placeholder:text-[var(--ink-40)]"
          />

          {!query.trim() && (
            <p className="mt-1.5 px-1 text-[11px] leading-relaxed text-[var(--ink-40)]">
              Paste any web link (netsuite.com, a Google Doc URL, anything) and it becomes a tile with its own icon.
            </p>
          )}

          {url && (
            <button
              onClick={() => toggle({ kind: 'url', url, label: urlLabel(url) })}
              data-testid="home-shortcut-composer-add-url"
              className="fb-btn-surface mt-2 flex w-full items-center gap-2.5 px-2.5 py-2 text-left hover:border-[rgb(var(--accent)/0.5)] hover:bg-[var(--surface-sunken)] transition-colors"
            >
              <ShortcutChip target={{ kind: 'url', url }} icon="language" tone="text-indigo-500" apps={apps} chip={28} glyph={15} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium text-[var(--ink-100)]">{urlLabel(url)}</span>
                <span className="block truncate text-[10.5px] text-[var(--ink-50)]">{url}</span>
              </span>
              <span className="shrink-0 text-[11px] font-medium text-accent">
                {taken.has(targetKey({ kind: 'url', url })) ? 'Added' : 'Add link'}
              </span>
            </button>
          )}

          {groups.map((g) => (
            <div key={g.name} className="mt-2.5">
              <p className="px-1 mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--ink-40)]">
                {g.name}
              </p>
              <div className="space-y-0.5">
                {g.items.map((c, i) => {
                  const isTaken = taken.has(targetKey(c.target))
                  const caption = describeShortcutTarget(c.target, lookups).caption
                  return (
                    <button
                      key={targetKey(c.target)}
                      onClick={() => toggle(c.target)}
                      data-testid={`home-shortcut-composer-result-${g.name.toLowerCase().replace(/\s+/g, '-')}-${i}`}
                      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--surface-sunken)] transition-colors"
                    >
                      <ShortcutChip target={c.target} icon={c.icon} tone={c.tone} apps={apps} chip={28} glyph={15} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate fb-t-body text-[var(--ink-100)]">{c.label}</span>
                        <span className="block truncate text-[10px] text-[var(--ink-50)]">{caption}</span>
                      </span>
                      {isTaken && <Icon name="check" size={13} className="text-accent shrink-0" />}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}

          {query.trim() && !url && groups.length === 0 && (
            <p className="mt-3 py-3 text-center text-[12px] text-[var(--ink-50)]">Nothing matches.</p>
          )}
        </div>

        {targets.length > 0 && (
          <div>
            <p className="px-1 mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--ink-40)]">
              In this box
            </p>
            <Reorder.Group axis="y" values={keys} onReorder={reorder} className="space-y-0.5">
              {targets.map((t, i) => {
                const key = targetKey(t)
                const view = describeShortcutTarget(t, lookups)
                return (
                  <Reorder.Item
                    key={key}
                    value={key}
                    className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 bg-transparent hover:bg-[var(--surface-sunken)] transition-colors"
                    data-testid={`home-shortcut-composer-row-${i}`}
                  >
                    <Icon name="drag_indicator" size={15} className="text-[var(--ink-30)] shrink-0 cursor-grab" />
                    <ShortcutChip target={t} icon={view.icon} tone={view.tone} apps={apps} chip={28} glyph={15} />
                    {renamingKey === key ? (
                      <input
                        autoFocus
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onBlur={() => rename(key)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') rename(key)
                          if (e.key === 'Escape') setRenamingKey(null)
                        }}
                        data-testid="home-shortcut-composer-rename"
                        className="fb-field flex-1 min-w-0 px-1.5 py-0.5 text-[12.5px] text-[var(--ink-100)]"
                      />
                    ) : (
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-[12.5px] ${view.alive ? 'text-[var(--ink-100)]' : 'text-[var(--ink-50)] line-through'}`}>
                          {view.label}
                        </span>
                        <span className="block truncate text-[10.5px] text-[var(--ink-50)]">
                          {view.alive ? view.caption : 'Gone'}
                        </span>
                      </span>
                    )}
                    {t.kind === 'url' && renamingKey !== key && (
                      <button
                        onClick={() => {
                          setRenamingKey(key)
                          setRenameDraft(t.label ?? '')
                        }}
                        title="Rename"
                        data-testid={`home-shortcut-composer-rename-${i}`}
                        className="shrink-0 h-6 w-6 rounded inline-flex items-center justify-center text-[var(--ink-40)] hover:text-[var(--ink-90)] hover:bg-[var(--surface-sunken)] transition-colors"
                      >
                        <Icon name="edit" size={13} />
                      </button>
                    )}
                    <button
                      onClick={() => commit({ targets: targets.filter((x) => targetKey(x) !== key) })}
                      title="Remove"
                      data-testid={`home-shortcut-composer-remove-${i}`}
                      className="shrink-0 h-6 w-6 rounded inline-flex items-center justify-center text-[var(--ink-40)] hover:text-rose-500 hover:bg-[var(--surface-sunken)] transition-colors"
                    >
                      <Icon name="close" size={13} />
                    </button>
                  </Reorder.Item>
                )
              })}
            </Reorder.Group>
          </div>
        )}
      </div>
    </Modal>
  )
}

// ── Communication ────────────────────────────────────────────────────────────

// Start or schedule a PlexiMeet from Home. All the real mechanics live in
// NewMeetingDialog (entitlement gating, teammate invites, email invites,
// scheduling); this widget is just its Home doorway. The meeting itself runs
// in the global MeetingOverlay, so starting from Home works in place.
//
// Rendered at the ICON size tier (Caleb's ruling): a true app icon, not a
// card. No header, no chrome — the whole tile IS the colored surface, glyph
// and name inside, exactly how an icon sits on an Apple home screen. Four of
// these occupy a small widget's footprint.
export function AppIconWidget({
  name,
  icon,
  surface,
  testId,
  buttonTestId,
  onPress,
  children
}: {
  name: string
  icon: string
  // Tailwind classes for the colored icon surface (gradient).
  surface: string
  testId: string
  buttonTestId: string
  onPress: () => void
  children?: ReactNode
}): JSX.Element {
  return (
    <div className="relative h-full w-full" data-testid={testId}>
      <button
        onClick={onPress}
        data-testid={buttonTestId}
        aria-label={name}
        title={name}
        className={`absolute inset-0 flex flex-col items-center justify-center gap-1.5 rounded-2xl fb-press text-white ${surface}`}
      >
        <Icon name={icon} size={26} />
        <span className="max-w-full truncate px-2 text-[10.5px] font-semibold">{name}</span>
      </button>
      {children}
    </div>
  )
}

// The card form of an action widget, for the md size: icon block, title,
// blurb, one action. The icon size stays the pure app icon.
function ActionHeroCard({
  title,
  blurb,
  icon,
  chipClass,
  actionLabel,
  actionTone,
  testId,
  buttonTestId,
  onPress,
  children
}: {
  title: string
  blurb: string
  icon: string
  chipClass: string
  actionLabel: string
  actionTone: string
  testId: string
  buttonTestId: string
  onPress: () => void
  children?: ReactNode
}): JSX.Element {
  return (
    <RailCard title={title} icon={icon} tone="accent">
      <div className="flex-1 flex flex-col" data-testid={testId}>
        <button
          onClick={onPress}
          data-testid={buttonTestId}
          className="flex-1 flex w-full items-center gap-3 fb-tile-lit fb-press px-3 py-2.5 text-left"
        >
          <span className={`inline-flex h-11 w-11 items-center justify-center rounded-xl shrink-0 ${chipClass}`}>
            <Icon name={icon} size={21} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block fb-t-body font-semibold text-[var(--ink-100)]">{title}</span>
            <span className="block fb-t-caption truncate">{blurb}</span>
          </span>
          <span className={`shrink-0 inline-flex items-center gap-1 text-[12px] font-medium ${actionTone}`}>
            {actionLabel}
            <Icon name="chevron_right" size={15} />
          </span>
        </button>
      </div>
      {children}
    </RailCard>
  )
}

export function NewMeetingWidget({ size = 'icon' }: { size?: WidgetSize } = {}): JSX.Element {
  const [open, setOpen] = useState(false)
  const dialog = open && <NewMeetingDialog onClose={() => setOpen(false)} />
  if (size === 'md')
    return (
      <ActionHeroCard
        title="New meeting"
        blurb="Face to face beats forty messages"
        icon="plexii:meet"
        chipClass="bg-rose-500/10 text-rose-500"
        actionLabel="Start"
        actionTone="text-rose-500"
        testId="home-new-meeting"
        buttonTestId="home-new-meeting-start"
        onPress={() => setOpen(true)}
      >
        {dialog}
      </ActionHeroCard>
    )
  return (
    <AppIconWidget
      name="New meeting"
      icon="plexii:meet"
      surface="bg-gradient-to-b from-rose-500 to-rose-600"
      testId="home-new-meeting"
      buttonTestId="home-new-meeting-start"
      onPress={() => setOpen(true)}
    >
      {dialog}
    </AppIconWidget>
  )
}

// One tap, one fresh desk, straight in. Reuses the exact create path the
// Create new widget uses; the desk-limit prompt speaks for itself on failure.
export function NewDeskWidget(): JSX.Element {
  const v = useViewStore()
  const createNode = useNodeStore((s) => s.create)
  const setActive = useNodeStore((s) => s.setActive)
  const make = async (): Promise<void> => {
    try {
      const node = await createNode({ parentId: null, kind: 'task', title: 'New desk' })
      setActive(node.id)
      v.goTask(node.id)
    } catch {
      /* the desk-limit prompt already told the user what happened */
    }
  }
  return (
    <AppIconWidget
      name="New desk"
      icon="desk"
      surface="bg-gradient-to-b from-teal-500 to-teal-600"
      testId="home-new-desk"
      buttonTestId="home-new-desk-create"
      onPress={() => void make()}
    />
  )
}

// One tap into a fresh guided discovery (Plexii P6): a new conversation in
// discovery mode, opened on the Plexii hub. A distinct VERB — it starts the
// guided experience, not a second general door to the assistant — which is why
// it earns an icon under the no-duplicate-chrome ruling.
export function DiscoverWidget(): JSX.Element {
  const v = useViewStore()
  const setActive = useNodeStore((s) => s.setActive)
  const start = (): void => {
    const chat = useChatStore.getState()
    chat.newConversation()
    chat.setMode('discovery')
    chat.setPendingContext({
      kind: 'workspace',
      label: 'a new idea',
      title: '',
      icon: 'plexii:discover'
    })
    // The hub is no desk — same rule every other hub door follows.
    setActive(null)
    v.goPlexii()
  }
  return (
    <AppIconWidget
      name="Discover"
      icon="plexii:discover"
      surface="bg-gradient-to-b from-indigo-500 to-indigo-600"
      testId="home-discover"
      buttonTestId="home-discover-start"
      onPress={start}
    />
  )
}

// Initials for the pinned-conversation avatar; no invented images, just the
// name the store actually has.
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

// A conversation's display name: its title, else the other members' names.
// Exported for the conversation config picker in HomeDashboard.
export function conversationName(
  conv: { title: string; members: Array<{ accountId: string; handle: string | null; firstName?: string | null; lastName?: string | null }> },
  selfId: string | null
): string {
  if (conv.title.trim()) return conv.title
  const others = conv.members.filter((m) => m.accountId !== selfId)
  const names = others.map((m) => personDisplayName(m, m.handle ?? 'Someone'))
  return names.join(', ') || 'Conversation'
}

export function PinnedConversationWidget({
  config,
  size
}: {
  config?: HomeWidgetConfig
  size: WidgetSize
}): JSX.Element {
  const v = useViewStore()
  const conversations = useMessagingStore((s) => s.conversations)
  const setActive = useMessagingStore((s) => s.setActive)
  const startDm = useMessagingStore((s) => s.startDm)
  const selfId = useAccountStore((s) => s.account?.id ?? null)
  const presencePeers = usePresenceStore((s) => s.peers)
  const presenceEnabled = useCapabilityEnabled('presence')

  // Resolve the pin to a conversation: directly by id, or the DM whose other
  // member is the pinned person.
  const conv = useMemo(() => {
    if (config?.conversationId) return conversations.find((c) => c.id === config.conversationId) ?? null
    if (config?.personId)
      return (
        conversations.find((c) => c.kind === 'dm' && c.members.some((m) => m.accountId === config.personId)) ?? null
      )
    return null
  }, [conversations, config])

  const name = conv
    ? conversationName(conv, selfId)
    : config?.personName || config?.personHandle || 'Conversation'
  const online = presenceEnabled && !!config?.personId && !!presencePeers[config.personId]

  const open = async (): Promise<void> => {
    if (conv) {
      await setActive(conv.id)
      v.goMessages()
      return
    }
    if (config?.personHandle) {
      // No DM with them yet: start one for real, then land in it.
      const r = await startDm(config.personHandle)
      if (r.ok) {
        await setActive(r.id)
        v.goMessages()
        return
      }
    }
    v.goMessages()
  }

  // A person pin is never stale (the DM starts on first click); a conversation
  // pin dies only if the conversation no longer exists for this account.
  const dead = !!config?.conversationId && !conv

  return (
    <RailCard title="Pinned conversation" icon="plexii:chat" tone="sky">
      {dead ? (
        <EmptyState text="This conversation is gone. Remove the widget or pin another." />
      ) : (
        <button
          onClick={() => void open()}
          data-testid="home-pinned-conversation"
          className="flex w-full items-center gap-3 fb-tile-lit fb-press px-3 py-2.5 text-left"
        >
          <span className="relative shrink-0">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-sky-500/10 text-sky-600 dark:text-sky-400 text-[12px] font-semibold">
              {initials(name)}
            </span>
            {online && (
              <span
                className="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-[var(--surface-raised)]"
                data-testid="home-pinned-conversation-online"
              />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate fb-t-body font-medium text-[var(--ink-100)]">{name}</span>
            <span className="block fb-t-caption truncate">
              {size === 'md' && conv?.lastMessage?.body
                ? conv.lastMessage.body
                : conv
                  ? conv.unreadCount > 0
                    ? `${conv.unreadCount} unread`
                    : 'All caught up'
                  : 'Say hello'}
            </span>
          </span>
          {conv && conv.unreadCount > 0 && (
            <span
              className="shrink-0 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-[rgb(var(--accent))] text-white text-[10.5px] font-semibold fb-tabular"
              data-testid="home-pinned-conversation-unread"
            >
              {conv.unreadCount > 99 ? '99+' : conv.unreadCount}
            </span>
          )}
          <Icon name="chevron_right" size={16} className="text-[var(--ink-40)] shrink-0" />
        </button>
      )}
    </RailCard>
  )
}

// Start a transcription from Home. The pipeline is the app's one transcription
// path end to end: MediaRecorder capture with live caption preview, the
// recording ingested into Files first (so it survives a failed transcription),
// then the provider-aware transcribeRecording helper. The wrap-up confirms
// where it lands: a real voice-recorder widget on a chosen desk (full replay
// and AI processing there), or a transcript document via the same
// saveTranscriptDoc the meeting wrap-up uses.
export function TranscribeWidget({ size = 'icon' }: { size?: WidgetSize } = {}): JSX.Element {
  const [open, setOpen] = useState(false)
  const overlay = open && <TranscribeOverlay onClose={() => setOpen(false)} />
  if (size === 'md')
    return (
      <ActionHeroCard
        title="Transcribe"
        blurb="Say it once. Keep it forever"
        icon="plexii:mic"
        chipClass="bg-violet-500/10 text-violet-500"
        actionLabel="Record"
        actionTone="text-violet-500"
        testId="home-transcribe"
        buttonTestId="home-transcribe-start"
        onPress={() => setOpen(true)}
      >
        {overlay}
      </ActionHeroCard>
    )
  return (
    <AppIconWidget
      name="Transcribe"
      icon="plexii:mic"
      surface="bg-gradient-to-b from-violet-500 to-violet-600"
      testId="home-transcribe"
      buttonTestId="home-transcribe-start"
      onPress={() => setOpen(true)}
    >
      {overlay}
    </AppIconWidget>
  )
}

// Minimal Web Speech live-caption preview (Chromium ships it in Electron).
// Preview only, never stored; Whisper owns the real transcript.
interface CaptionRecognition {
  continuous: boolean
  interimResults: boolean
  onresult: ((e: { results: ArrayLike<{ 0: { transcript: string } }> }) => void) | null
  start: () => void
  stop: () => void
}

type TranscribePhase =
  | { kind: 'recording' }
  | { kind: 'transcribing' }
  | { kind: 'wrapup'; transcript: string; fileId: string; durationSec: number | null; language: string | null }
  | { kind: 'error'; message: string; canRetry: boolean }

function TranscribeOverlay({ onClose }: { onClose: () => void }): JSX.Element {
  const v = useViewStore()
  const nodes = useNodeStore((s) => s.nodes)
  const setActiveNode = useNodeStore((s) => s.setActive)
  const createDeskWidget = useWidgetStore((s) => s.create)

  const [phase, setPhase] = useState<TranscribePhase>({ kind: 'recording' })
  const [caption, setCaption] = useState('')
  const [seconds, setSeconds] = useState(0)
  const [title, setTitle] = useState('Transcription')
  const [deskQuery, setDeskQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [pickDesk, setPickDesk] = useState(false)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const captionRef = useRef<CaptionRecognition | null>(null)
  const timerRef = useRef<number | null>(null)
  const lastBufferRef = useRef<{ buffer: ArrayBuffer; mimeType: string; fileId: string } | null>(null)

  const stopEverything = (): void => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current)
    timerRef.current = null
    try {
      captionRef.current?.stop()
    } catch {
      /* already stopped */
    }
    captionRef.current = null
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try {
        recorderRef.current.stop()
      } catch {
        /* already stopped */
      }
    }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }

  // Recording starts the moment the overlay opens: one click from the widget
  // to a running recorder, no second confirmation.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        chunksRef.current = []
        const mr = new MediaRecorder(stream)
        mr.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data)
        }
        mr.onstop = () => {
          const mimeType = mr.mimeType || 'audio/webm'
          const blob = new Blob(chunksRef.current, { type: mimeType })
          chunksRef.current = []
          streamRef.current?.getTracks().forEach((t) => t.stop())
          streamRef.current = null
          void finishRecording(blob, mimeType)
        }
        mr.start(250)
        recorderRef.current = mr
        timerRef.current = window.setInterval(() => setSeconds((s) => s + 1), 1000)
        const Ctor =
          (window as unknown as { webkitSpeechRecognition?: new () => CaptionRecognition }).webkitSpeechRecognition ||
          (window as unknown as { SpeechRecognition?: new () => CaptionRecognition }).SpeechRecognition
        if (Ctor) {
          try {
            const rec = new Ctor()
            rec.continuous = true
            rec.interimResults = true
            rec.onresult = (e) => {
              let text = ''
              for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript
              setCaption(text.slice(-180))
            }
            rec.start()
            captionRef.current = rec
          } catch {
            /* captions are a bonus, never a blocker */
          }
        }
      } catch (err) {
        if (!cancelled)
          setPhase({
            kind: 'error',
            message: `Microphone access denied or unavailable: ${err instanceof Error ? err.message : String(err)}. On macOS: System Settings, Privacy & Security, Microphone, allow PlexiDesk.`,
            canRetry: false
          })
      }
    })()
    return () => {
      cancelled = true
      stopEverything()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function finishRecording(blob: Blob, mimeType: string): Promise<void> {
    setPhase({ kind: 'transcribing' })
    const buffer = await blob.arrayBuffer()
    // Files first: the recording survives even if transcription fails.
    let fileId: string
    try {
      const file = await window.api.files.ingestBuffer({
        buffer,
        originalName: `transcription-${Date.now()}.webm`,
        mimeType
      })
      fileId = file.id
    } catch (err) {
      setPhase({
        kind: 'error',
        message: `Could not save the recording: ${err instanceof Error ? err.message : String(err)}`,
        canRetry: false
      })
      return
    }
    lastBufferRef.current = { buffer, mimeType, fileId }
    await runTranscription(buffer, mimeType, fileId)
  }

  async function runTranscription(buffer: ArrayBuffer, mimeType: string, fileId: string): Promise<void> {
    setPhase({ kind: 'transcribing' })
    try {
      const r = await transcribeRecording(buffer, mimeType)
      if (!r.ok) {
        setPhase({
          kind: 'error',
          message: `The recording is safe in Files, but transcription failed: ${r.error}`,
          canRetry: true
        })
        return
      }
      setPhase({
        kind: 'wrapup',
        transcript: r.transcript,
        fileId,
        durationSec: r.durationSec,
        language: r.language
      })
    } catch (err) {
      setPhase({
        kind: 'error',
        message: `The recording is safe in Files, but transcription failed: ${err instanceof Error ? err.message : String(err)}`,
        canRetry: true
      })
    }
  }

  async function landOnDesk(deskId: string): Promise<void> {
    if (phase.kind !== 'wrapup' || saving) return
    setSaving(true)
    try {
      await createDeskWidget({
        taskId: deskId,
        kind: 'voice-recorder',
        title: title.trim() || 'Transcription',
        content: JSON.stringify({
          fileId: phase.fileId,
          captureMode: 'audio',
          transcript: phase.transcript,
          language: phase.language,
          durationSec: phase.durationSec,
          mode: 'summary',
          processedText: '',
          proposals: []
        })
      })
      onClose()
      setActiveNode(deskId)
      v.goTask(deskId)
    } catch (err) {
      setSaving(false)
      setPhase({
        kind: 'error',
        message: `Could not place the widget on that desk: ${err instanceof Error ? err.message : String(err)}`,
        canRetry: false
      })
    }
  }

  async function landInDocuments(): Promise<void> {
    if (phase.kind !== 'wrapup' || saving) return
    setSaving(true)
    const docId = await saveTranscriptDoc(title.trim() || 'Transcription', phase.transcript, null)
    if (docId) {
      onClose()
      v.goDocument(docId)
    } else {
      setSaving(false)
      setPhase({
        kind: 'error',
        message: 'Could not create the transcript document. The recording is safe in Files.',
        canRetry: false
      })
    }
  }

  const desks = nodes
    .filter((n) => n.kind === 'task' && !n.archived)
    .filter((n) => !deskQuery.trim() || (n.title || '').toLowerCase().includes(deskQuery.trim().toLowerCase()))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 12)

  const mm = Math.floor(seconds / 60)
  const ss = seconds % 60

  return (
    <Modal
      onClose={onClose}
      label="Transcribe"
      z={260}
      className="fb-glass-pillow rounded-2xl w-full max-w-md mx-4 overflow-hidden flex flex-col max-h-[76vh]"
      testId="home-transcribe-overlay"
    >
      <div className="px-4 py-3 border-b border-[var(--edge-soft)] flex items-center gap-2.5">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-violet-500/10 text-violet-500 shrink-0">
          <Icon name="plexii:mic" size={15} />
        </span>
        <span className="flex-1 text-[13.5px] font-semibold text-[var(--ink-100)]">Transcribe</span>
        {phase.kind === 'recording' && (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-rose-500 fb-tabular" data-testid="home-transcribe-timer">
            <span className="h-2 w-2 rounded-full bg-rose-500 animate-pulse" />
            {mm}:{String(ss).padStart(2, '0')}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {phase.kind === 'recording' && (
          <div className="flex flex-col gap-3" data-testid="home-transcribe-recording">
            <p className="text-[12.5px] text-[var(--ink-70)]">
              Recording. Speak naturally; the transcript comes when you stop.
            </p>
            <p className="min-h-[3.5rem] rounded-lg bg-[var(--surface-sunken)] px-3 py-2 text-[12px] leading-relaxed text-[var(--ink-60)] italic">
              {caption || 'Live preview appears here as you speak…'}
            </p>
            <button
              onClick={() => {
                if (timerRef.current !== null) window.clearInterval(timerRef.current)
                timerRef.current = null
                try {
                  captionRef.current?.stop()
                } catch {
                  /* stopped */
                }
                recorderRef.current?.stop()
              }}
              data-testid="home-transcribe-stop"
              className="self-center inline-flex items-center gap-1.5 h-10 px-5 rounded-lg text-[13px] font-medium bg-rose-500 text-white hover:bg-rose-600 transition-colors"
            >
              <Icon name="stop_circle" size={16} />
              Stop
            </button>
          </div>
        )}

        {phase.kind === 'transcribing' && (
          <div className="py-8 flex flex-col items-center gap-2" data-testid="home-transcribe-busy">
            <Icon name="progress_activity" size={20} className="animate-spin text-violet-500" />
            <p className="text-[12.5px] text-[var(--ink-60)]">Transcribing…</p>
          </div>
        )}

        {phase.kind === 'wrapup' && (
          <div className="flex flex-col gap-3" data-testid="home-transcribe-wrapup">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              aria-label="Transcription name"
              data-testid="home-transcribe-title"
              className="fb-field w-full px-3 py-2 text-[13px] font-medium text-[var(--ink-100)]"
            />
            <div className="max-h-40 overflow-y-auto rounded-lg bg-[var(--surface-sunken)] px-3 py-2 text-[12px] leading-relaxed text-[var(--ink-80)] whitespace-pre-wrap">
              {phase.transcript || 'Silence. Nothing was heard.'}
            </div>
            {!pickDesk ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-[11px] uppercase tracking-wide font-semibold text-[var(--ink-40)]">Keep it where?</p>
                <button
                  onClick={() => setPickDesk(true)}
                  disabled={saving}
                  data-testid="home-transcribe-to-desk"
                  className="flex items-center gap-2.5 fb-tile-lit fb-press px-3 py-2.5 text-left"
                >
                  <Icon name="desk" size={17} className="text-violet-500 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block fb-t-body font-medium text-[var(--ink-100)]">On a desk</span>
                    <span className="block fb-t-caption">A voice widget there: replay, clean up, pull out tasks</span>
                  </span>
                </button>
                <button
                  onClick={() => void landInDocuments()}
                  disabled={saving}
                  data-testid="home-transcribe-to-documents"
                  className="flex items-center gap-2.5 fb-tile-lit fb-press px-3 py-2.5 text-left"
                >
                  <Icon name="description" size={17} className="text-sky-500 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block fb-t-body font-medium text-[var(--ink-100)]">In Documents</span>
                    <span className="block fb-t-caption">A transcript document; the recording stays in Files</span>
                  </span>
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5" data-testid="home-transcribe-desk-picker">
                <input
                  autoFocus
                  value={deskQuery}
                  onChange={(e) => setDeskQuery(e.target.value)}
                  placeholder="Search desks…"
                  className="fb-field w-full px-3 py-2 fb-t-body text-[var(--ink-100)] placeholder:text-[var(--ink-40)]"
                />
                {desks.length === 0 ? (
                  <p className="py-4 text-center text-[12px] text-[var(--ink-50)]">No desks match.</p>
                ) : (
                  <div className="space-y-0.5 max-h-44 overflow-y-auto">
                    {desks.map((n) => (
                      <button
                        key={n.id}
                        onClick={() => void landOnDesk(n.id)}
                        disabled={saving}
                        data-testid={`home-transcribe-desk-${n.id}`}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--surface-sunken)] transition-colors"
                      >
                        <Icon name="desk" size={15} className="text-[var(--ink-50)] shrink-0" />
                        <span className="flex-1 min-w-0 truncate fb-t-body text-[var(--ink-100)]">
                          {n.title || 'Untitled desk'}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <button onClick={() => setPickDesk(false)} className="self-start btn-ghost text-[12px]">
                  Back
                </button>
              </div>
            )}
          </div>
        )}

        {phase.kind === 'error' && (
          <div className="flex flex-col gap-3" data-testid="home-transcribe-error">
            <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-[12px] leading-relaxed text-amber-700 dark:text-amber-300">
              {phase.message}
            </p>
            {phase.canRetry && lastBufferRef.current && (
              <button
                onClick={() => {
                  const last = lastBufferRef.current
                  if (last) void runTranscription(last.buffer, last.mimeType, last.fileId)
                }}
                data-testid="home-transcribe-retry"
                className="self-start inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg text-[12.5px] font-medium bg-[rgb(var(--accent))] text-white hover:bg-[rgb(var(--accent-hover))] transition-colors"
              >
                <Icon name="refresh" size={15} />
                Try again
              </button>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

// ── Actions ──────────────────────────────────────────────────────────────────

export function CreateWidget(): JSX.Element {
  const v = useViewStore()
  const createBlankDoc = useDocumentsStore((s) => s.createBlank)
  const createNode = useNodeStore((s) => s.create)
  const setActive = useNodeStore((s) => s.setActive)

  const newDoc = async (docType: 'doc' | 'sheet' | 'slides'): Promise<void> => {
    const doc = await createBlankDoc(docType)
    v.goDocument(doc.id)
  }
  const newDesk = async (): Promise<void> => {
    try {
      const node = await createNode({ parentId: null, kind: 'task', title: 'New desk' })
      setActive(node.id)
      v.goTask(node.id)
    } catch {
      /* the desk-limit prompt already told the user what happened */
    }
  }
  // Tones are the suite accents (Docs blue, Sheets green, Slides orange per
  // plexiSuite.ts; Desk teal, matching the desks section and hero): what you
  // create is a product object, and the chip says which one.
  const items = [
    { id: 'doc', label: 'Document', icon: 'description', tone: 'text-blue-500', onClick: () => void newDoc('doc') },
    { id: 'sheet', label: 'Spreadsheet', icon: 'table_chart', tone: 'text-green-500', onClick: () => void newDoc('sheet') },
    { id: 'slides', label: 'Deck', icon: 'slideshow', tone: 'text-orange-500', onClick: () => void newDoc('slides') },
    { id: 'desk', label: 'Desk', icon: 'desk', tone: 'text-teal-500', onClick: () => void newDesk() }
  ]
  return (
    <RailCard title="Create new" icon="add_circle" tone="accent">
      <div className="grid grid-cols-2 auto-rows-fr flex-1 min-h-0 gap-2" data-testid="home-create">
        {items.map((it) => (
          <button
            key={it.id}
            onClick={it.onClick}
            data-testid={`home-create-${it.id}`}
            className="flex flex-col items-center justify-center gap-1.5 fb-tile-lit fb-press px-1 py-2"
          >
            {/* Chip-over-label, the sm shortcut tile grammar: the ~95px-wide
                cols-2 cells cannot fit Document beside a chip, but fit it
                centred under one. */}
            <span
              className={`inline-flex h-8 w-8 items-center justify-center shrink-0 fb-chip-lit ${it.tone}`}
            >
              <Icon name={it.icon} size={20} />
            </span>
            <span className="max-w-full truncate text-[11px] font-medium leading-none text-[var(--ink-100)]">
              {it.label}
            </span>
          </button>
        ))}
      </div>
    </RailCard>
  )
}

export function FocusTimerWidget({ size = 'sm' }: { size?: WidgetSize } = {}): JSX.Element {
  const active = useFocusSessionStore((s) => s.active)
  const remainingSec = useFocusSessionStore((s) => s.remainingSec)
  const start = useFocusSessionStore((s) => s.start)
  const finish = useFocusSessionStore((s) => s.finish)
  const mm = Math.max(0, Math.floor(remainingSec / 60))
  const ss = Math.max(0, remainingSec % 60)
  // Icon size: the app-icon form of the five minute promise. Idle taps start
  // it; while a session runs the icon shows the live countdown and a tap
  // finishes the session.
  if (size === 'icon') {
    return (
      <div className="relative h-full w-full" data-testid="home-focus-timer">
        <button
          onClick={() => (active ? void finish('done') : void start(null, 5 * 60, '5min'))}
          data-testid={active ? 'home-focus-timer-stop' : 'home-focus-timer-start'}
          aria-label={active ? 'End focus session' : 'Start 5 minute focus'}
          title={active ? 'End focus session' : 'Start 5 minute focus'}
          className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 rounded-2xl fb-press text-white bg-gradient-to-b from-emerald-500 to-emerald-600"
        >
          {active ? (
            <>
              <span className="fb-display fb-tabular text-[20px] leading-none">
                {mm}:{String(ss).padStart(2, '0')}
              </span>
              <span className="max-w-full truncate px-2 text-[10.5px] font-semibold">Focusing</span>
            </>
          ) : (
            <>
              <Icon name="timer" size={26} />
              <span className="max-w-full truncate px-2 text-[10.5px] font-semibold">Focus</span>
            </>
          )}
        </button>
      </div>
    )
  }
  return (
    <RailCard title="Focus timer" icon="timer" tone="violet">
      <div className="flex-1 flex items-center gap-3" data-testid="home-focus-timer">
        {active ? (
          <>
            <span className="fb-display fb-tabular text-[26px] leading-none text-violet-500">
              {mm}:{String(ss).padStart(2, '0')}
            </span>
            <span className="flex-1 fb-t-caption">Focus session running. Hold the line.</span>
            <button
              onClick={() => void finish('done')}
              data-testid="home-focus-timer-stop"
              className="shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-medium bg-violet-500/15 text-violet-500 hover:bg-violet-500/25 transition-colors"
            >
              <Icon name="stop_circle" size={15} />
              End
            </button>
          </>
        ) : (
          <>
            <span className="flex-1 text-[12px] text-[var(--ink-70)]">
              Five minutes. Just start, that is the whole trick.
            </span>
            <button
              onClick={() => void start(null, 5 * 60, '5min')}
              data-testid="home-focus-timer-start"
              className="shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-medium bg-[rgb(var(--accent))] text-white hover:bg-[rgb(var(--accent-hover))] transition-colors"
            >
              <Icon name="bolt" size={15} />
              Start 5 min
            </button>
          </>
        )}
      </div>
    </RailCard>
  )
}

// ── Smart ────────────────────────────────────────────────────────────────────

export function OverdueRadarWidget({ size = 'sm' }: { size?: WidgetSize } = {}): JSX.Element {
  const nodes = useNodeStore((s) => s.nodes)
  const openDesk = useOpenDesk()
  const cap = size === 'md' ? 5 : 3
  const overdue = useMemo(() => {
    const dayStart = new Date()
    dayStart.setHours(0, 0, 0, 0)
    return nodes
      .filter(
        (n) => n.kind === 'task' && n.status !== 'done' && !n.archived && n.dueDate != null && n.dueDate < dayStart.getTime()
      )
      .sort((a, b) => (a.dueDate ?? 0) - (b.dueDate ?? 0))
      .slice(0, cap)
  }, [nodes, cap])
  return (
    <RailCard title="Overdue radar" icon="priority_high" tone="rose">
      {overdue.length === 0 ? (
        <p className="my-auto py-4 text-center text-[12px] text-[var(--ink-50)]" data-testid="home-overdue-empty">
          Nothing overdue. Clear skies.
        </p>
      ) : (
        <ul className="flex-1 min-h-0 flex flex-col justify-evenly" data-testid="home-overdue">
          {overdue.map((n) => (
            <li key={n.id}>
              <button
                onClick={() => openDesk(n)}
                className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left hover:bg-[var(--surface-sunken)] transition-colors"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-rose-500 shrink-0" />
                <span className="flex-1 min-w-0 truncate fb-t-body text-[var(--ink-100)]">{n.title || 'Untitled task'}</span>
                <span className="shrink-0 text-[10.5px] text-rose-500 fb-tabular">
                  due {new Date(n.dueDate ?? 0).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </RailCard>
  )
}

export function OneThingNowWidget(): JSX.Element {
  const nodes = useNodeStore((s) => s.nodes)
  const openDesk = useOpenDesk()
  // The single most pressing task: urgency x importance, due-date pressure as
  // the tiebreak. Deliberately not a list — one thing, then the next.
  const pick = useMemo(() => {
    const open = nodes.filter((n) => n.kind === 'task' && n.status !== 'done' && !n.archived)
    if (open.length === 0) return null
    return [...open].sort((a, b) => {
      const sa = (a.priority ?? 3) + (a.importance ?? 3)
      const sb = (b.priority ?? 3) + (b.importance ?? 3)
      if (sb !== sa) return sb - sa
      const da = a.dueDate ?? Infinity
      const db = b.dueDate ?? Infinity
      if (da !== db) return da - db
      return b.updatedAt - a.updatedAt
    })[0]
  }, [nodes])
  const room = useNodeStore((s) => (pick?.parentId ? s.nodes.find((n) => n.id === pick.parentId) ?? null : null))
  return (
    <RailCard title="One thing now" icon="target" tone="amber">
      {!pick ? (
        <EmptyState text="No open desks. Enjoy it." />
      ) : (
        <div className="flex-1 min-w-0 flex items-center gap-3" data-testid="home-one-thing">
          <div className="min-w-0 flex-1">
            <div className="fb-t-title text-[var(--ink-100)] truncate">{pick.title || 'Untitled task'}</div>
            <div className="mt-0.5 fb-t-caption truncate">
              {[room?.title, pick.dueDate ? `due ${new Date(pick.dueDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : null]
                .filter(Boolean)
                .join(' · ') || 'Picked by urgency and importance'}
            </div>
          </div>
          <button
            onClick={() => openDesk(pick)}
            data-testid="home-one-thing-open"
            className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg text-[12.5px] font-medium bg-[rgb(var(--accent))] text-white hover:bg-[rgb(var(--accent-hover))] transition-colors"
          >
            Start
            <Icon name="arrow_forward" size={15} />
          </button>
        </div>
      )}
    </RailCard>
  )
}

export function WhereWasIWidget({ activity }: { activity: ActivityEvent[] | null }): JSX.Element {
  const nodes = useNodeStore((s) => s.nodes)
  const setActive = useNodeStore((s) => s.setActive)
  const v = useViewStore()
  // Reconstruct the last real working context from the activity trail: the most
  // recent event tied to a desk, plus the last page visited for flavour.
  const last = useMemo(() => {
    if (!activity) return null
    const e = activity.find((a) => a.taskId != null)
    if (!e) return null
    const node = nodes.find((n) => n.id === e.taskId) ?? null
    if (!node || node.archived) return null
    const page = activity.find((a) => a.kind === 'browser_nav')
    const p = (page?.payload ?? {}) as Record<string, unknown>
    const pageTitle = typeof p.title === 'string' && p.title ? p.title : typeof p.host === 'string' ? p.host : null
    return { node, ts: e.ts, pageTitle }
  }, [activity, nodes])
  return (
    <RailCard title="Where was I" icon="undo" tone="sky">
      {!last ? (
        <EmptyState text="No trail yet. Work a little and this widget will remember for you." />
      ) : (
        <div className="flex-1 min-w-0 flex items-center gap-3" data-testid="home-where-was-i">
          <div className="min-w-0 flex-1">
            <div className="fb-t-body font-medium text-[var(--ink-100)] truncate">
              {last.node.title || 'Untitled desk'}
            </div>
            <div className="mt-0.5 fb-t-caption truncate">
              {relTime(last.ts)}
              {last.pageTitle ? ` · last page: ${last.pageTitle}` : ''}
            </div>
          </div>
          <button
            onClick={() => {
              setActive(last.node.id)
              v.goTask(last.node.id)
            }}
            data-testid="home-where-was-i-resume"
            className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 fb-t-body font-medium fb-btn-surface fb-press text-[var(--ink-90)]"
          >
            <Icon name="play_arrow" size={16} className="text-accent" />
            Resume
          </button>
        </div>
      )}
    </RailCard>
  )
}

export function StalledDeskWidget(): JSX.Element {
  const nodes = useNodeStore((s) => s.nodes)
  const openDesk = useOpenDesk()
  const stalled = useMemo(() => {
    const cutoff = Date.now() - 3 * 86_400_000
    return (
      nodes
        .filter((n) => n.kind === 'task' && n.status === 'in_progress' && !n.archived && n.updatedAt < cutoff)
        .sort((a, b) => a.updatedAt - b.updatedAt)[0] ?? null
    )
  }, [nodes])
  return (
    <RailCard title="Stalled desk" icon="hourglass_bottom" tone="amber">
      {!stalled ? (
        <p className="my-auto py-4 text-center text-[12px] text-[var(--ink-50)]" data-testid="home-stalled-empty">
          Nothing stalled. Everything in progress has been touched this week.
        </p>
      ) : (
        <button
          onClick={() => openDesk(stalled)}
          data-testid="home-stalled-open"
          className="flex w-full items-center gap-3 fb-tile-lit fb-press px-3 py-2.5 text-left"
        >
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-orange-500/10 text-orange-500 shrink-0">
            <Icon name="hourglass_bottom" size={17} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate fb-t-body font-medium text-[var(--ink-100)]">
              {stalled.title || 'Untitled desk'}
            </span>
            <span className="block fb-t-caption">
              in progress, untouched since {relTime(stalled.updatedAt)}
            </span>
          </span>
          <Icon name="chevron_right" size={16} className="text-[var(--ink-40)] shrink-0" />
        </button>
      )}
    </RailCard>
  )
}
