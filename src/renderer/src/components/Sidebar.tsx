import { useEffect, useState } from 'react'
import { ATTENTION_FILTERS } from '../lib/attentionQueues'
import type { AiBuildSuggestion, FbNode, NodeKind } from '@shared/types'
import { useNodeStore } from '../stores/nodes'
import { useWorkItemStore } from '../stores/workItems'
import { useCaptureConsole, type CaptureSource } from '../stores/captureConsole'
import PlexiiLogo from './PlexiiLogo'
import { useWidgetStore } from '../stores/widgets'
import { useConnectedAppsStore } from '../stores/connectedApps'
import SyncIndicator from './SyncIndicator'
import UpgradeCard from './UpgradeCard'
import { useViewStore, type View } from '../stores/view'
import { catalogFor } from '../lib/widgetCatalog'
import { useViewKindEnabled } from '../lib/viewCapability'

import { chimeIn } from '../lib/audioBeep'
import { AREA_TONES, attentionFilterTone } from '../lib/areaTones'
import NewNodeDialog from './NewNodeDialog'
import AISetupDialog from './AISetupDialog'
import AddConnectedAppDialog from './AddConnectedAppDialog'
import { useSharesStore } from '../stores/shares'
import Icon from './Icon'
import WorkspaceSwitcher from './WorkspaceSwitcher'
import AreaAccordion from './nav/AreaAccordion'
import { WidgetsRail } from './nav/WidgetsSection'
import { materializeSuggestion } from '../lib/materializeSuggestion'
import AppLogo from './AppLogo'
import {
  FLOATING_MENU_ASIDE,
  FLOATING_MENU_ASIDE_GLASS,
  FLOATING_MENU_GLASS_STYLE,
  FLOATING_MENU_STYLE,
  MenuMinimizeButton
} from './chrome/floatingMenu'

// MIME used when dragging a Connected App row from the sidebar onto the canvas.
// The Canvas drop handler reads this to spawn a webview widget bound to the app.
export const CONNECTED_APP_DRAG_MIME = 'text/fb-connected-app'

interface Props {
  collapsed?: boolean
  onToggle?: () => void
  // True while the desk canvas runs full-bleed beneath the dock column: the
  // menu becomes chrome glass so the desk shows through it (Phase 1b spike).
  glass?: boolean
}

export default function Sidebar({ collapsed, onToggle, glass = false }: Props = {}): JSX.Element {
  const asideClass = glass ? FLOATING_MENU_ASIDE_GLASS : FLOATING_MENU_ASIDE
  const asideStyle = glass ? FLOATING_MENU_GLASS_STYLE : FLOATING_MENU_STYLE
  const setActive = useNodeStore((s) => s.setActive)
  const createWidget = useWidgetStore((s) => s.create)
  const bumpLayout = useWidgetStore((s) => s.bumpLayoutVersion)
  const view = useViewStore((s) => s.view)
  const goHome = useViewStore((s) => s.goHome)
  const goRooms = useViewStore((s) => s.goRooms)
  const goDesks = useViewStore((s) => s.goDesks)
  const goShared = useViewStore((s) => s.goShared)
  const goTrash = useViewStore((s) => s.goTrash)
  const goAttention = useViewStore((s) => s.goAttention)
  const activeAttentionFilter = useViewStore((st) =>
    st.view.kind === 'attention' ? st.view.filter : undefined
  )
  const goConnectedApp = useViewStore((s) => s.goConnectedApp)
  const goOffice = useViewStore((s) => s.goOffice)
  const goPlexiPeople = useViewStore((s) => s.goPlexiPeople)
  const goPlexiBrain = useViewStore((s) => s.goPlexiBrain)

  // No conversation sublist here any more (operator direction, 2026-10-08).
  // The Plexii row used to expand to the three most recent chats, which made
  // the nav a second, truncated history competing with the assistant's own
  // list. Conversations now live in ONE place — the assistant panel, where
  // "Your conversations" opens the full grouped list with search. This row is
  // just the door to the hub.

  // Hide desk-nav entries that lead to a now-gated surface, using the same
  // view-kind -> capability map MainPane's CapabilityGate enforces, so nav and
  // surface agree and a user never clicks into a locked wall.
  const viewEnabled = useViewKindEnabled()

  const connectedApps = useConnectedAppsStore((s) => s.apps)
  const appsLoaded = useConnectedAppsStore((s) => s.loaded)
  const refreshApps = useConnectedAppsStore((s) => s.refresh)
  const launchLocal = useConnectedAppsStore((s) => s.launchLocal)
  const [addAppOpen, setAddAppOpen] = useState(false)
  useEffect(() => {
    if (!appsLoaded) void refreshApps()
  }, [appsLoaded, refreshApps])

  const [dialog, setDialog] = useState<
    | { mode: 'create'; parentId: string | null; kind: NodeKind }
    | { mode: 'edit'; node: FbNode }
    | null
  >(null)
  const [aiSetupTask, setAiSetupTask] = useState<FbNode | null>(null)

  // Section collapse state for the remaining sections.
  const [roomsNavOpen, setRoomsNavOpen] = useState(true)
  // Attention's filter submenu. Collapsed by default: the row itself is
  // "everything", and the six filters are a narrowing most sessions do not need.
  const [attentionOpen, setAttentionOpen] = useState(false)
  // Connected Apps show only while a desk is open: the rows are there to be
  // dragged onto a canvas, so anywhere else they are a list you cannot use.

  // Shared-with-me inbox — loaded once on mount, drives the "Shared" nav badge.
  const sharedInbox = useSharesStore((s) => s.inbox)
  const refreshShares = useSharesStore((s) => s.refresh)
  const sharesLoaded = useSharesStore((s) => s.loaded)

  useEffect(() => {
    if (!sharesLoaded) void refreshShares()
  }, [sharesLoaded, refreshShares])

  // Hook for the CommandCenter pill: "New" button dispatches a global
  // event so any sidebar mount can respond by opening the new-node
  // dialog. This avoids prop-drilling the dialog setter from App down
  // into the sidebar; either works, but the event keeps App.tsx lean.
  useEffect(() => {
    function onCmd(e: Event): void {
      // Callers may pass a room context and node kind so the wizard opens
      // pre-filed into the right Room (e.g. the Stage Manager's "New desk" /
      // "New room" buttons). Plain calls (the header "New") default to a
      // top-level Desk.
      const detail = (e as CustomEvent).detail as
        | { parentId?: string | null; kind?: NodeKind }
        | undefined
      setDialog({
        mode: 'create',
        parentId: detail?.parentId ?? null,
        kind: detail?.kind ?? 'task'
      })
      // Claim it, so requestNewDesk() can tell the dialog exists here.
      if (e.cancelable) e.preventDefault()
    }
    window.addEventListener('fb:command-new-task', onCmd)
    // The Attention capture seam (S3/S5, DEC-019): a dispatch WITH a title
    // creates directly (the programmatic path); `captureText` opens the
    // console PREFILLED (the @attention path); a bare dispatch opens it empty.
    function onNewWorkItem(e: Event): void {
      const detail = (e as CustomEvent).detail as
        | { title?: string; captureText?: string; notes?: string; source?: CaptureSource | null }
        | undefined
      const title = detail?.title?.trim()
      if (!title) {
        // CR-09 D-A: a MARK carries its object through to the confirm card —
        // and a marked SELECTION carries the full highlight as notes (DEC-044).
        useCaptureConsole
          .getState()
          .openConsole(detail?.captureText?.trim() || '', detail?.source ?? null, detail?.notes ?? '')
        return
      }
      void useWorkItemStore
        .getState()
        .create({ title })
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.warn('[workItems] create refused:', err instanceof Error ? err.message : err)
        })
    }
    window.addEventListener('fb:command-new-work-item', onNewWorkItem)
    return () => {
      window.removeEventListener('fb:command-new-task', onCmd)
      window.removeEventListener('fb:command-new-work-item', onNewWorkItem)
    }
  }, [])

  // The header "New" now creates a Desk (a canvas). The create dialog lets the
  // user file it into any Room via its searchable Room picker, or leave it at the
  // top level. Rooms are created from the All rooms page (the store still caps
  // top-level Rooms on the free tier as a backstop). Desks are not capped.
  function requestCreateDesk(): void {
    setDialog({ mode: 'create', parentId: null, kind: 'task' })
  }

  function viewIsActive(targetView: View): boolean {
    if (view.kind !== targetView.kind) return false
    if (view.kind === 'task' && targetView.kind === 'task') {
      return view.taskId === targetView.taskId
    }
    if (view.kind === 'project-dashboard' && targetView.kind === 'project-dashboard') {
      return view.projectId === targetView.projectId
    }
    if (view.kind === 'connected-app' && targetView.kind === 'connected-app') {
      return view.appId === targetView.appId
    }
    return true // home / all-tasks have no inner id
  }

  async function handleAISetupAccept(suggestions: AiBuildSuggestion[]): Promise<void> {
    const task = aiSetupTask
    if (!task) return
    let x = 80
    let y = 80
    let rowMaxH = 0
    const ROW_LIMIT = 720
    for (const s of suggestions) {
      const entry = catalogFor(s.kind)
      const w = entry?.defaultWidth ?? 320
      const h = entry?.defaultHeight ?? 240
      if (x !== 80 && x + w > ROW_LIMIT) {
        x = 80
        y += rowMaxH + 24
        rowMaxH = 0
      }
      // Configured, not a shell: a suggested table provisions its columns here
      // and a page its body — see lib/materializeSuggestion.
      const { content, title } = await materializeSuggestion(
        s,
        task.id,
        entry?.defaultContent ?? ''
      )
      await createWidget({
        taskId: task.id,
        kind: s.kind,
        title,
        content,
        x: Math.round(x),
        y: Math.round(y),
        width: w,
        height: h,
        color: s.kind === 'sticky' ? '#fef08a' : null
      })
      x += w + 24
      rowMaxH = Math.max(rowMaxH, h)
    }
    chimeIn()
    bumpLayout()
  }

  const [appsExpanded, setAppsExpanded] = useState(false)

  if (collapsed) {
    const showOffice = viewEnabled('documents')
    const showPeople = viewEnabled('people-map')
    const showBrain  = viewEnabled('knowledge')
    const hasSegments = showOffice || showPeople || showBrain

    return (
      <aside
        className={`${asideClass} flex flex-col overflow-hidden`}
        style={{ ...asideStyle, width: '100%' }}
        data-testid="desk-sidebar-collapsed"
      >
        {/* Scrollable icon column */}
        <div
          className="flex flex-col items-center py-2 gap-0.5 overflow-y-auto flex-1"
          style={{ scrollbarWidth: 'none' }}
        >
          {/* Expand toggle */}
          <button
            onClick={onToggle}
            title="Expand menu"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--ink-50)] hover:text-[var(--ink-90)] hover:bg-[var(--surface-sunken)] transition-colors shrink-0 mb-0.5"
          >
            <Icon name="left_panel_open" size={16} />
          </button>

          {/* ── Segments: Office / People / Brain ── */}
          {hasSegments && (
            <>
              <div className="w-6 h-px bg-[var(--edge-soft)] shrink-0 my-1" />
              {showOffice && (
                <CollapsedNavIcon
                  icon="plexii:office"
                  label="Office"
                  tone={AREA_TONES.office}
                  active={view.kind === 'office'}
                  onClick={() => goOffice()}
                />
              )}
              {showPeople && (
                <CollapsedNavIcon
                  icon="diversity_3"
                  label="People"
                  tone={AREA_TONES.people}
                  active={view.kind === 'plexipeople'}
                  onClick={() => goPlexiPeople()}
                />
              )}
              {showBrain && (
                <CollapsedNavIcon
                  icon="neurology"
                  label="PlexiiBrain"
                  tone={AREA_TONES.brain}
                  active={view.kind === 'plexibrain'}
                  onClick={() => goPlexiBrain()}
                />
              )}
            </>
          )}

          {/* ── Desk navigation ── */}
          <div className="w-6 h-px bg-[var(--edge-soft)] shrink-0 my-1" />

          <CollapsedNavIcon icon="plexii:home"  label="Home"         tone={AREA_TONES.home}  active={viewIsActive({ kind: 'home' })}       onClick={() => { setActive(null); goHome() }} />
          {/* Monochrome by plexidesk-75's rail rule: no tone, accent only when active. */}
          <CollapsedNavIcon icon="notifications" label="Attention"    tone={AREA_TONES.attention}  active={viewIsActive({ kind: 'attention' })} onClick={() => { setActive(null); goAttention() }} />
          <CollapsedNavIcon icon="meeting_room"  label="Rooms"        tone={AREA_TONES.rooms}     active={viewIsActive({ kind: 'rooms' })}      onClick={() => { setActive(null); goRooms() }} />
          <CollapsedNavIcon icon="desk"          label="Desks"        tone={AREA_TONES.desks}    active={viewIsActive({ kind: 'desks' })}      onClick={() => { setActive(null); goDesks() }} />
          <CollapsedNavIcon icon="folder_shared" label="Shared Desks" tone={AREA_TONES.shared} active={viewIsActive({ kind: 'shared' })}    onClick={() => { setActive(null); goShared() }} />
          <CollapsedNavIcon icon="delete"        label="Trash"        tone={AREA_TONES.trash}  active={viewIsActive({ kind: 'trash' })}     onClick={() => { setActive(null); goTrash() }} />
          {/* DEC-020: Plans / Desks (flat) / Calendar tabs retired — Attention
              absorbed them (feeders carry desk + plan due dates). The views
              stay reachable via the ⌘K palette; engines untouched (DEC-009). */}

          {/* ── Widgets (4.3.32): the main list as icons, Other widgets behind a
              toggle — the same section as the expanded menu, at rail width. */}
          <div className="w-6 h-px bg-[var(--edge-soft)] shrink-0 my-1" data-testid="rail-widgets-divider" />
          <WidgetsRail iconClass={railIconClass} />

          {/* ── Connected Apps ── */}
          <div className="w-6 h-px bg-[var(--edge-soft)] shrink-0 my-1" />

          <button
            onClick={() => setAppsExpanded(v => !v)}
            title="Connected Apps"
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors shrink-0 ${
              appsExpanded || view.kind === 'connected-app'
                ? 'bg-[rgb(var(--accent)/0.12)] text-[rgb(var(--accent))]'
                : 'text-[var(--ink-50)] hover:text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]'
            }`}
          >
            <Icon name="apps" size={16} />
          </button>

          {appsExpanded && (
            <>
              {connectedApps.length === 0 ? (
                <span className="text-[9px] text-[var(--ink-30)] text-center leading-tight px-1 py-1">
                  No apps
                </span>
              ) : (
                connectedApps.map((app) => (
                  <div
                    key={app.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(CONNECTED_APP_DRAG_MIME, app.id)
                      e.dataTransfer.setData('text/uri-list', app.url)
                      e.dataTransfer.setData('text/plain', app.url)
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                    className="shrink-0 cursor-grab active:cursor-grabbing"
                  >
                    <button
                      onClick={() => {
                        app.kind === 'local' ? void launchLocal(app.id) : goConnectedApp(app.id)
                      }}
                      title={app.title}
                      className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
                        viewIsActive({ kind: 'connected-app', appId: app.id })
                          ? 'bg-[rgb(var(--accent)/0.12)] text-[rgb(var(--accent))]'
                          : 'hover:bg-[var(--surface-sunken)]'
                      }`}
                    >
                      <AppLogo app={app} size={20} glyphSize={12} />
                    </button>
                  </div>
                ))
              )}
              <button
                onClick={() => setAddAppOpen(true)}
                title="Add app"
                className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors shrink-0 text-[var(--ink-40)] hover:text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]"
                style={{ border: '1.5px dashed var(--edge-firm)' }}
              >
                <Icon name="add" size={14} />
              </button>
            </>
          )}
        </div>

        {addAppOpen && (
          <AddConnectedAppDialog
            onClose={() => setAddAppOpen(false)}
            onAdded={(id) => goConnectedApp(id)}
          />
        )}
      </aside>
    )
  }

  // The desk list, hoisted so it can be the Desk SECTION BODY of the one
  // menu rather than a second list beside it. It stays richer than the
  // registry-built one on purpose: Attention keeps its six state/due filters
  // and Rooms keeps its sub-nav, both of which a flat list would have cost.
  const deskNav = (
    <>
        {/* Desk nav — one clean, single list in the same style as the Office /
            People / Brain menus, not a stack of labelled sections. */}
        <div className="px-2 pt-1 pb-2">
          <NavRow
            icon="plexii:home"
            label="Home"
            tone={AREA_TONES.home}
            active={viewIsActive({ kind: 'home' })}
            onClick={() => {
              setActive(null)
              goHome()
            }}
          />
          {/* Attention — what needs you, top-level by design (S6): the
              surface's whole job is being one glance away. */}
          <div className="fb-nav-item fb-nav-group pr-1 mb-0.5">
            <div className="flex-1 min-w-0">
              <NavRow
                icon="notifications"
                label="Attention"
                tone={AREA_TONES.attention}
                active={viewIsActive({ kind: 'attention' })}
                onClick={() => {
                  setActive(null)
                  goAttention()
                }}
              />
            </div>
            <button
              onClick={() => setAttentionOpen((v) => !v)}
              className="icon-btn !h-6 !w-6 shrink-0 self-center"
              title={attentionOpen ? 'Hide the Attention filters' : 'Show the Attention filters'}
              aria-expanded={attentionOpen}
              data-testid="sidebar-attention-toggle"
            >
              <Icon name={attentionOpen ? 'expand_less' : 'expand_more'} size={14} />
            </button>
          </div>
          {/* The six state/due filters. The row above is still "everything";
              these narrow it. Definitions live in lib/attentionQueues so the
              sidebar, the view and the predicate cannot drift. */}
          {attentionOpen && (
            <div className="ml-4 pl-2 border-l border-[var(--edge-soft)]" data-testid="sidebar-attention-filters">
              {ATTENTION_FILTERS.map((f) => (
                <NavRow
                  key={f.id}
                  icon={f.icon}
                  label={f.label}
                  tone={attentionFilterTone(f.id)}
                  active={viewIsActive({ kind: 'attention' }) && activeAttentionFilter === f.id}
                  testid={`sidebar-attention-${f.id}`}
                  onClick={() => {
                    setActive(null)
                    goAttention(f.id)
                  }}
                />
              ))}
            </div>
          )}
          {/* Calendar — the planning lens on the same items (DEC-052 reverses
              DEC-020's calendar clause by operator ruling: the rebuilt surface
              is a daily ritual, not the read-only grid the retirement judged).
              Attention and Calendar sit as peers deliberately. */}
          {/* Calendar moved into Office, beside the inbox — it is a comms
              surface in practice, and it sat here only because Attention and
              Calendar were once peers (DEC-052). */}
          {/* Plexii is not a nav row any more. The assistant is the one door
              to it — its header opens the hub — so the sidebar does not offer a
              second one. */}
          {/* Rooms — the workspace organiser. Clicking opens All Rooms; the
              chevron expands to the two index pages (All Rooms, All Desks). */}
          <div className="fb-nav-item fb-nav-group pr-1 mb-0.5">
            <div className="flex-1 min-w-0">
              <NavRow
                icon="meeting_room"
                label="Rooms"
                tone={AREA_TONES.rooms}
                active={viewIsActive({ kind: 'rooms' }) || viewIsActive({ kind: 'desks' })}
                onClick={() => {
                  setActive(null)
                  goRooms()
                }}
              />
            </div>
            <button
              onClick={() => setRoomsNavOpen((v) => !v)}
              title={roomsNavOpen ? 'Collapse' : 'Expand'}
              className="icon-btn !h-6 !w-6 shrink-0 self-center"
            >
              <Icon name={roomsNavOpen ? 'expand_more' : 'chevron_right'} size={16} />
            </button>
          </div>
          {roomsNavOpen && (
            <div className="ml-4 pl-2 border-l border-[var(--edge-soft)]">
              <NavRow
                icon="desk"
                label="All desks"
                tone={AREA_TONES.desks}
                active={viewIsActive({ kind: 'desks' })}
                onClick={() => {
                  setActive(null)
                  goDesks()
                }}
              />
              <NavRow
                icon="folder_shared"
                label="Shared"
                tone={AREA_TONES.shared}
                active={viewIsActive({ kind: 'shared' })}
                badge={sharedInbox.length ? String(sharedInbox.length) : undefined}
                onClick={() => {
                  setActive(null)
                  goShared()
                }}
              />
              <NavRow
                icon="delete"
                label="Trash"
                tone={AREA_TONES.trash}
                active={viewIsActive({ kind: 'trash' })}
                onClick={() => {
                  setActive(null)
                  goTrash()
                }}
              />
            </div>
          )}
          {/* DEC-020: Plans / Desks (flat) / Calendar tabs retired — Attention
              absorbed them (feeders carry desk + plan due dates). The views
              stay reachable via the ⌘K palette; engines untouched (DEC-009). */}
          {/* Files and the Vault both live in Apps now, beside the inbox. The
              Vault was filed under Settings on the reasoning that you only look
              at it when something needs checking; it is a place you open while
              working, so it sits with the other apps. */}

        </div>
    </>
  )

  return (
    <aside className={asideClass} style={asideStyle} data-testid="desk-sidebar">
      {/* Header — same silhouette as the PlexiOffice menu: the wordmark on the
          left, then the desk's own actions (New desk, hide) on the right. */}
      {/* Measured, not guessed: at the 232px minimum sidebar width this row had
          exactly zero slack (53px wordmark + 8px gap + 128px actions = the 189px
          of inner width), so flex solved it by compressing the New desk button
          to 87px against its natural 96px and squeezing the label. The button
          now refuses to deform (shrink-0 + whitespace-nowrap) and the row buys
          back the space it needs from its own padding and the divider's
          margins, which is spare. Re-measure with
          tests/e2e/_sidebarHeaderFit.spec.ts if anything here changes. */}
      <div className="flex items-center gap-2 px-3 h-14 border-b border-[var(--edge-soft)] min-w-0">
        <PlexiiLogo height={22} />
        <div className="ml-auto flex items-center shrink-0">
          <button
            onClick={requestCreateDesk}
            title="New desk — opens set-up with today's date pre-filled; Enter creates and opens it"
            className="inline-flex items-center gap-1 h-7 px-2 rounded-lg bg-[rgb(var(--accent))] text-white text-[12px] font-medium whitespace-nowrap shrink-0 hover:bg-[rgb(var(--accent-hover))]"
          >
            <Icon name="add" size={14} className="shrink-0" />
            <span>New desk</span>
          </button>
          {/* The minimise control is window chrome, not a desk action — a
              hairline and real spacing keep it from reading as part of New. */}
          {onToggle && (
            <>
              <span aria-hidden className="w-px h-4 bg-[var(--edge-soft)] ml-2 mr-1 shrink-0" />
              <MenuMinimizeButton onClick={onToggle} title="Minimise the menu to free the desk" />
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto py-1">
        {/* Workspace and area are ONE control. An area lives inside an
            organisation, so two stacked peers misdescribed the relationship and
            cost two rows to do it. See components/WorkspaceSwitcher.tsx. */}
        <WorkspaceSwitcher />


        {/* ONE menu. The area tab strip is gone and the desk list above is now
            this menu's Desk section body, so all four areas are sections of a
            single accordion and Apps / People / Brain are reachable from a desk
            without switching area first. Sections default to open so this is
            not c581655d with extra steps. See components/nav/AreaAccordion.tsx. */}
        <AreaAccordion deskSlot={deskNav} />

        {/* The Connected Apps LIST that used to sit here is gone.
            AreaAccordion above already shows every connected app as a grid of
            icons under Apps, so this rendered each of them a second time —
            once as a tile, once as a row with a "More apps" expander below
            it. Two lists of the same thing, in one menu, a few hundred pixels
            apart.
            The grid is the one that stays: it is the one the operator asked
            for, it carries the unread badges and the awake/asleep state, and
            it names which organisation each app belongs to. Dragging an app
            onto a canvas still works from the grid tiles and from the
            collapsed rail. Add, remove and pin remain in Settings and on the
            grid's own + . */}
      </div>

      {/* Pro card — the same upgrade block that sits at the foot of the
          PlexiOffice menu, so every area's menu ends the same way. */}
      <div className="px-3 pt-2">
        <UpgradeCard label="PlexiiDesk Pro" />
      </div>

      {/* Footer — sync indicator. Stays pinned to the bottom of the
          sidebar regardless of scroll position above. */}
      <SyncIndicator />

      {dialog && dialog.mode === 'create' && (
        <NewNodeDialog
          parentId={dialog.parentId}
          kind={dialog.kind}
          onClose={() => setDialog(null)}
          onRequestAISetup={(task) => setAiSetupTask(task)}
        />
      )}
      {dialog && dialog.mode === 'edit' && (
        <NewNodeDialog
          node={dialog.node}
          onClose={() => setDialog(null)}
          onRequestAISetup={(task) => setAiSetupTask(task)}
        />
      )}
      {aiSetupTask && (
        <AISetupDialog
          task={aiSetupTask}
          onClose={() => setAiSetupTask(null)}
          onAccept={handleAISetupAccept}
        />
      )}
      {addAppOpen && (
        <AddConnectedAppDialog
          onClose={() => setAddAppOpen(false)}
          onAdded={(id) => goConnectedApp(id)}
        />
      )}
    </aside>
  )
}

interface CollapsedNavIconProps {
  icon: string
  label: string
  // Same per-destination stroke colour as the expanded NavRow, so the collapsed
  // rail reads at a glance instead of as a column of grey glyphs. The active
  // state still wins with the accent pill.
  tone?: string
  active: boolean
  onClick: () => void
}

/** The rail icon's look, shared with the Widgets rail group so the two match. */
function railIconClass(active: boolean, tone?: string): string {
  return `w-8 h-8 rounded-lg flex items-center justify-center transition-colors shrink-0 fb-press ${
    active
      ? 'bg-[rgb(var(--accent)/0.12)] text-[rgb(var(--accent))]'
      : `${tone ?? 'text-[var(--ink-50)]'} hover:bg-[var(--surface-sunken)]`
  }`
}

function CollapsedNavIcon({ icon, label, tone, active, onClick }: CollapsedNavIconProps): JSX.Element {
  // Coloured, matching the expanded NavRow — which is what the prop's own
  // comment above always claimed, while the code voided it. The rail is the
  // same menu at a narrower width, so a destination cannot change colour just
  // because the sidebar is collapsed. Here the hue matters MORE, not less:
  // collapsed there is no label, so the colour is the only thing telling two
  // glyphs apart at 16px.
  return (
    <button
      onClick={onClick}
      title={label}
      className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors shrink-0 fb-press ${
        active
          ? 'bg-[rgb(var(--accent)/0.12)] text-[rgb(var(--accent))]'
          : `${tone ?? 'text-[var(--ink-50)]'} hover:bg-[var(--surface-sunken)]`
      }`}
    >
      <Icon name={icon} size={16} filled />
    </button>
  )
}

interface NavRowProps {
  icon: string
  label: string
  // Tailwind text-* class colouring the bare icon (no tile behind it).
  tone: string
  active: boolean
  onClick: () => void
  badge?: string
  testid?: string
}

function NavRow({ icon, label, tone, active, onClick, badge, testid }: NavRowProps): JSX.Element {
  // COLOURED, and filled rather than outlined.
  //
  // This reverses an earlier decision in this same component, so both sides are
  // worth recording. The hues were stripped out on the reasoning that colour
  // which differs per row without meaning anything is noise — you never compare
  // two nav rows, so the hue answers no question. That argument holds for a flat
  // list of twelve peers, which is what this was.
  //
  // It stopped holding when the four area menus merged into one. The menu is now
  // long and sectioned, the eye scans it rather than reads it, and a hue is how
  // you find Attention again without reading five labels — the same job the
  // coloured tiles already do under Apps. Leaving the desk half grey also made
  // the one menu visibly two, because the accordion's own rows were coloured and
  // these were not. So `tone` is honoured again, from the AREA_TONES map that
  // was deliberately left intact for exactly this.
  //
  // Filled, 17px, w-6 box: the same treatment as AreaAccordion's Row, because
  // these two render as one list and an outlined icon beside a filled one reads
  // as a different kind of thing. An outline at this size also reads as grey
  // whatever colour it is given.
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      className={`fb-nav-item fb-nav-row group text-[13px] mb-0.5 fb-press ${
        active
          ? 'bg-[rgb(var(--accent)/0.10)] text-[rgb(var(--accent))] font-medium'
          : 'text-[var(--ink-80)] hover:bg-[var(--surface-sunken)]'
      }`}
    >
      {/* The active row keeps the accent, so where-you-are still wins over the
          icon's own hue. */}
      <span
        className={`inline-flex items-center justify-center w-6 h-6 shrink-0 ${
          active ? '' : (tone ?? 'text-[var(--ink-50)]')
        }`}
      >
        <Icon name={icon} size={17} filled />
      </span>
      <span className="flex-1 min-w-0 truncate text-left leading-tight">{label}</span>
      {badge && (
        <span className="ml-auto text-[10px] fb-tabular text-[var(--ink-50)]">{badge}</span>
      )}
    </button>
  )
}
