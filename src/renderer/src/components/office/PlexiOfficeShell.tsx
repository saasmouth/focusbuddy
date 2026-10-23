import { useCallback, useEffect, useMemo, useState } from 'react'
import HomeDashboard from '../views/HomeDashboard'
import OfficeBrowser from './OfficeBrowser'
import { writeDocumentDrag, canPlaceOnDesk } from '../../lib/documentDrag'
import { useDocumentsStore } from '../../stores/documents'
import { useViewStore } from '../../stores/view'
import { useAccountStore } from '../../stores/account'
import PageEnter from '../chrome/pageEnter'
import UpgradeCard from '../UpgradeCard'
import { useMailStore, selectMailUnread } from '../../stores/mail'
import { useMessagingStore } from '../../stores/messaging'
import { useCapabilityStore } from '../../stores/capabilities'
import { useOrgStore } from '../../stores/org'
import {
  computeEntitlement,
  capabilityForDocType,
  DOC_TYPE_LABEL,
  type Entitlement,
  type EntitlementInputs
} from '../../lib/entitlementReason'
import { CHANGELOG } from '../../lib/changelog'
import { promptUpgrade } from '../../stores/upgradePrompt'
import { VIEW_CAPABILITY, useViewKindEnabled } from '../../lib/viewCapability'
import CapabilityGate from '../CapabilityGate'
import WidgetFileView from '../views/WidgetFileView'
import DocumentEditorView from '../views/DocumentEditorView'
import { FilesDockSlot } from '../files/FilesDock'
import MailView from '../views/MailView'
import InboxView from '../views/InboxView'
import CalendarView from '../views/CalendarView'
import FilesView from '../views/FilesView'
import MessagesView from '../views/MessagesView'
import PlexiMeetView from '../views/PlexiMeetView'
import PlexiSignView from '../views/PlexiSignView'
import VaultView from '../views/VaultView'
import { useSharesStore } from '../../stores/shares'
import AreaAccordion from '../nav/AreaAccordion'
import PlexiiIcon, { PlexiiTileIcon, PlexiiDocIcon } from '../PlexiiIcon'
import { docTypeEntity, OFFICE_LIBRARY_ENTITY } from '../../lib/plexiiIconMap'
import Icon from '../Icon'
import WorkspaceSwitcher from '../WorkspaceSwitcher'
import {
  FLOATING_MENU_ASIDE_SCROLL,
  FLOATING_MENU_INSET,
  FLOATING_MENU_STYLE,
  MenuMinimizeButton,
  MenuRestorePill,
  useMinimizable
} from '../chrome/floatingMenu'
import type { DocType, DocumentMeta, TimeBlock } from '@shared/types'

// PlexiOffice — the office segment of the system. Its own full-bleed shell with a
// dedicated sidemenu: the place to create Docs, Sheets, Slides, Diagrams,
// Designs and Artwork, and to send documents for signature (PlexiSign) with an
// audit trail.
// Document-type apps open inline so the office sidebar stays put; Sign and Forms
// route to their own modules.

type OfficePage = 'home' | 'recent' | 'starred' | 'shared' | 'templates' | 'trash'

interface OfficeApp {
  key: string
  label: string
  blurb: string
  icon: string
  // Tailwind classes for the colored icon tile.
  tint: string
  // Tailwind text-* class colouring the bare icon in the side menu (no tile).
  tone: string
  // Document type to create inline, or null when the app routes elsewhere.
  docType: DocType | null
}

const APPS: OfficeApp[] = [
  { key: 'docs', label: 'PlexiiWrite', blurb: 'Create documents', icon: 'description', tint: 'bg-purple-600', tone: 'text-purple-600', docType: 'doc' },
  { key: 'sheets', label: 'PlexiiCells', blurb: 'Create spreadsheets', icon: 'table_chart', tint: 'bg-cyan-600', tone: 'text-cyan-600', docType: 'sheet' },
  { key: 'slides', label: 'PlexiiDeck', blurb: 'Create presentations', icon: 'slideshow', tint: 'bg-pink-500', tone: 'text-pink-500', docType: 'slides' },
  { key: 'diagrams', label: 'PlexiiDiagrams', blurb: 'Flowcharts and diagrams', icon: 'account_tree', tint: 'bg-violet-500', tone: 'text-violet-500', docType: 'map' },
  { key: 'design', label: 'PlexiiDesign', blurb: 'Page layout and print', icon: 'plexii:design', tint: 'bg-fuchsia-500', tone: 'text-fuchsia-500', docType: 'design' },
  { key: 'draw', label: 'PlexiiDraw', blurb: 'Vector and painting', icon: 'brush', tint: 'bg-rose-500', tone: 'text-rose-500', docType: 'draw' }
]

// The communication apps that now live inside PlexiOffice. Each renders its
// existing view inline so the office side menu stays put. These are distinct
// from the document-type apps above: they don't create a doc, they take over the
// content area with their own surface.
interface CommsApp {
  key: string
  label: string
  blurb: string
  icon: string
  tint: string
  tone: string
  render: () => JSX.Element
  /**
   * Which menu section lists it. This array is the RENDERING registry — what
   * takes over the content area — and that is a separate question from where a
   * person expects to find the thing. The Browser renders exactly like Mail
   * does and belongs nowhere near it in a menu: browsing the web is not
   * communicating, so it is listed with the apps. Default: 'communicate'.
   */
  section?: 'apps' | 'communicate'
}
// Listed under Apps rather than Communicate. Kept as a helper so the side menu
// and the home grid cannot disagree about where something lives.
export function appSectionComms(apps: CommsApp[]): CommsApp[] {
  return apps.filter((a) => a.section === 'apps')
}
export function commsSectionComms(apps: CommsApp[]): CommsApp[] {
  return apps.filter((a) => a.section !== 'apps')
}

const COMMS_APPS: CommsApp[] = [
  // Office gains a dashboard of its own: the same personalisable grid Home
  // uses, so a document you live in can sit here instead of being re-opened.
  { key: 'home', label: 'Office Home', blurb: 'Your dashboard for documents and comms', icon: 'plexii:home', tint: 'bg-indigo-500', tone: 'text-indigo-500', render: () => <HomeDashboard surface="office" /> },
  { key: 'mail', label: 'Mail', blurb: 'Your email inbox', icon: 'mail', tint: 'bg-rose-500', tone: 'text-rose-500', render: () => <MailView /> },
  { key: 'inbox', label: 'Inbox', blurb: 'Notifications and share invites', icon: 'inbox', tint: 'bg-amber-500', tone: 'text-amber-500', render: () => <InboxView /> },
  // Calendar sits with Mail and Inbox because it is the same kind of thing: it
  // is where you answer people. It used to be two menus away from the inbox it
  // belongs beside. It renders INSIDE the office shell, like every other
  // Communicate app — opening your calendar should not throw you out of Office.
  { key: 'calendar', label: 'Calendar', blurb: 'Your week, and what is due', icon: 'calendar_month', tint: 'bg-violet-500', tone: 'text-violet-500', render: () => <CalendarView /> },
  { key: 'chat', label: 'PlexiiChat', blurb: 'Channels and direct messages', icon: 'forum', tint: 'bg-sky-500', tone: 'text-sky-500', render: () => <MessagesView /> },
  { key: 'meet', label: 'PlexiiCall', blurb: 'Video calls and meetings', icon: 'video_call', tint: 'bg-violet-500', tone: 'text-violet-500', render: () => <PlexiMeetView /> },
  { key: 'sign', label: 'Sign', blurb: 'Send and sign documents', icon: 'plexii:sign', tint: 'bg-teal-500', tone: 'text-teal-500', render: () => <PlexiSignView /> },
  // The browser that belongs to nobody. The desk browser is a widget and part
  // of that piece of work; this is for the other kind of browsing — looking
  // something up, keeping a reference open across several desks — which
  // previously had nowhere to live but a desk it had nothing to do with.
  { key: 'browser', label: 'Browser', blurb: 'Browse the web, no desk required', icon: 'public', tint: 'bg-indigo-500', tone: 'text-indigo-500', section: 'apps', render: () => <OfficeBrowser /> },
  // Files is an app, not a comms surface — it is listed with the Browser for
  // the same reason: looking something up is not communicating.
  { key: 'files', label: 'Files', blurb: 'Everything you have, in one drive', icon: 'folder', tint: 'bg-sky-500', tone: 'text-sky-500', section: 'apps', render: () => <FilesView /> },
  // Vault belongs here for the same reason Calendar and Files do: it is a place
  // you GO, not a preference you set. 4.3.25 filed it under Settings on the
  // reasoning that you look at it once when something needs checking — but a
  // credential store is a thing you open while working, and Settings is a modal
  // you have to dismiss to get back to what you were doing. Rendering it inside
  // the shell keeps the menu put, so opening the Vault does not throw you out
  // of Apps.
  { key: 'vault', label: 'PlexiiVault', blurb: 'Encrypted credentials', icon: 'lock', tint: 'bg-slate-500', tone: 'text-slate-500', section: 'apps', render: () => <VaultView /> }
]

// Which OS view kind each comms app stands in for, so we gate its menu entry and
// its inline render on the same capability MainPane's backbone enforces. Inbox is
// core (notifications and share invites) and is never gated.
const COMMS_VIEW_KIND: Record<string, string | null> = {
  mail: 'mail',
  calendar: 'calendar',
  files: 'files',
  inbox: null,
  chat: 'messages',
  meet: 'meetings',
  sign: 'sign',
  // Core: there is no separate entitlement for looking at a web page.
  browser: null,
  // Gated exactly as the standalone vault view is, so moving it in here cannot
  // become a way around password_vault.
  vault: 'vault'
}

function commsGate(key: string): { cap: string; label: string } | null {
  const vk = COMMS_VIEW_KIND[key]
  if (!vk) return null
  return VIEW_CAPABILITY[vk] ?? null
}

const TYPE_ICON: Record<string, { icon: string; tint: string }> = {
  doc: { icon: 'description', tint: 'text-sky-500' },
  sheet: { icon: 'table_chart', tint: 'text-emerald-500' },
  slides: { icon: 'slideshow', tint: 'text-orange-500' },
  map: { icon: 'account_tree', tint: 'text-violet-500' },
  design: { icon: 'plexii:design', tint: 'text-fuchsia-500' },
  draw: { icon: 'brush', tint: 'text-rose-500' }
}

// The document-library views, shared rather than rebuilt: this list was
// previously inlined in the side menu's NAV.
const LIBRARY_PAGES: { id: OfficePage; label: string; icon: string; tone: string }[] = [
  { id: 'home', label: 'All', icon: 'home', tone: 'text-indigo-500' },
  { id: 'recent', label: 'Recent', icon: 'schedule', tone: 'text-rose-500' },
  { id: 'starred', label: 'Starred', icon: 'star', tone: 'text-amber-500' },
  { id: 'shared', label: 'Shared with me', icon: 'group', tone: 'text-teal-500' },
  { id: 'templates', label: 'Templates', icon: 'plexii:templates', tone: 'text-sky-500' },
  { id: 'trash', label: 'Trash', icon: 'delete', tone: 'text-slate-500' }
]

const PRO_FEATURES = ['Advanced collaboration', 'Premium templates', 'AI productivity tools', 'Priority support']

const STAR_KEY = 'fb.office.starred'

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

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function startOfDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// The Recent table's type tabs. Document types map to real document records;
// 'mail' and 'meet' are honest categories with no document of their own, so
// those tabs show an honest empty state rather than fabricated rows.
type RecentTab = 'all' | DocType | 'mail' | 'meet'
const RECENT_TABS: { id: RecentTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'doc', label: 'Documents' },
  { id: 'sheet', label: 'Spreadsheets' },
  { id: 'slides', label: 'Decks' },
  { id: 'map', label: 'Draw' },
  { id: 'mail', label: 'Mail' },
  { id: 'meet', label: 'Calls' }
]

export default function PlexiOfficeShell({ initialApp }: { initialApp?: string } = {}): JSX.Element {
  const list = useDocumentsStore((s) => s.list)
  const refresh = useDocumentsStore((s) => s.refresh)
  const createBlank = useDocumentsStore((s) => s.createBlank)
  const remove = useDocumentsStore((s) => s.remove)
  const goHome = useViewStore((s) => s.goHome)
  const account = useAccountStore((s) => s.account)
  // Same view-kind -> capability check the backbone uses, so office menu entries
  // and initiators that lead to a gated comms surface hide/no-op when it is off.
  const viewEnabled = useViewKindEnabled()

  // Per-editor entitlements. Read the capability + source maps and the active
  // org once (subscribed) and resolve each docType with the pure helper so the
  // shell greys locked editors and blocks their create paths with the same
  // reason-aware copy the SegmentSwitcher uses. Canvas widgets are NOT gated
  // here — those live in PlexiDesk and stay available with Office off.
  const capabilities = useCapabilityStore((s) => s.capabilities)
  const capSources = useCapabilityStore((s) => s.sources)
  const orgRole = useCapabilityStore((s) => s.orgRole)
  const activeOrgId = useOrgStore((s) => s.activeOrgId)
  const orgName = useOrgStore((s) => s.orgs.find((o) => o.id === s.activeOrgId)?.name ?? null)
  const entInputs: EntitlementInputs = { capabilities, sources: capSources, orgRole, activeOrgId, orgName }
  const docEntitlement = (docType: DocType): Entitlement =>
    computeEntitlement(entInputs, capabilityForDocType(docType), DOC_TYPE_LABEL[docType])

  // Real unread sources. Mail unread is derived from the loaded IMAP envelope
  // list; the messaging store carries both the internal-inbox items and the
  // chat conversation unread total. Nothing here is invented: if a mailbox or
  // account is not connected the underlying lists are empty and the count is 0.
  const mailUnread = useMailStore(selectMailUnread)
  const refreshMail = useMailStore((s) => s.refresh)
  const loadMailAccount = useMailStore((s) => s.loadAccount)
  const startCompose = useMailStore((s) => s.startCompose)
  const inboxItems = useMessagingStore((s) => s.inboxItems)
  const chatUnread = useMessagingStore((s) => s.unreadTotal)
  const refreshInbox = useMessagingStore((s) => s.refreshInbox)
  const refreshConversations = useMessagingStore((s) => s.refreshConversations)
  const inboxUnread = useMemo(
    () => inboxItems.reduce((sum, it) => sum + (it.unread || 0), 0),
    [inboxItems]
  )

  // The office menu floats as a rounded card and can be minimised to free the
  // content area, matching the global Desk sidebar and the segment menus.
  const { minimized: menuMinimized, minimize: minimizeMenu, restore: restoreMenu } =
    useMinimizable('fb.officeMenu.minimized')

  const [page, setPage] = useState<OfficePage>('home')
  // WHICH DOCUMENT IS OPEN IS NAVIGATION, not local state. It used to be a
  // useState, which meant the document you had just created was invisible to
  // everything outside this component -- the tray could not list it, the
  // history arrows could not return to it, and nothing could tell you had it
  // open at all. Deriving it from the view fixes all three at once.
  const openDocId = useViewStore((s) => (s.view.kind === 'office' ? (s.view.doc ?? null) : null))
  const setOpenDocId = useCallback((id: string | null): void => {
    // Opening a document leaves whatever app you were in; closing returns to
    // the hub, which is what every call site here already did by hand.
    useViewStore.getState().goOffice(undefined, id ?? undefined)
  }, [])
  // The active communication app (Mail / Inbox / Chat / Meet / Sign / Browser),
  // or null when the document hub is showing — derived from the view for the
  // same reason the open document is. As local state it could not be cleared by
  // navigating: going back to the Office hub left the app still mounted and
  // still on screen, and in the browser's case left a live webview the agent
  // was still pointed at.
  const activeComms =
    initialApp && COMMS_APPS.some((a) => a.key === initialApp) ? initialApp : null
  const setActiveComms = useCallback((key: string | null): void => {
    useViewStore.getState().goOffice(key ?? undefined)
  }, [])
  const [tab, setTab] = useState<'all' | DocType>('all')
  useEffect(() => {
    // A deep link to a DOCUMENT app (PlexiDiagrams, PlexiDesign, PlexiDraw…)
    // lands on the hub filtered to that type rather than silently creating a
    // file the user did not ask for.
    const docApp = APPS.find((a) => a.key === initialApp)
    if (docApp?.docType) setTab(docApp.docType)
  }, [initialApp])
  const [recentTab, setRecentTab] = useState<RecentTab>('all')
  // Today's real time blocks. null = still loading; [] = loaded and genuinely
  // empty. We never seed a meeting.
  const [agenda, setAgenda] = useState<TimeBlock[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [starred, setStarred] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(STAR_KEY) || '[]'))
    } catch {
      return new Set()
    }
  })

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Load the real sources behind the home rail: today's time blocks, the mail
  // unread count, and the internal inbox + chat unread totals. Each guards
  // against failure by falling back to an honest empty/zero, never a fake row.
  useEffect(() => {
    const dayStart = startOfDay(Date.now())
    const dayEnd = dayStart + 86_400_000
    window.api.timeBlocks
      .list(dayStart, dayEnd)
      .then(setAgenda)
      .catch(() => setAgenda([]))
    void loadMailAccount().then(() => refreshMail().catch(() => {}))
    if (account) {
      void refreshInbox().catch(() => {})
      void refreshConversations().catch(() => {})
    }
  }, [account, loadMailAccount, refreshMail, refreshInbox, refreshConversations])

  const officeDocs = useMemo(
    () => list.filter((d) => ['doc', 'sheet', 'slides', 'map', 'design', 'draw'].includes(d.docType)).sort((a, b) => b.updatedAt - a.updatedAt),
    [list]
  )

  // The Recent table reads the same real documents, filtered by the selected
  // type tab. The Mail and Meet tabs have no document records, so they resolve
  // to an empty list and the table shows its honest empty state.
  const recentRows = useMemo<DocumentMeta[]>(() => {
    if (recentTab === 'mail' || recentTab === 'meet') return []
    const filtered = recentTab === 'all' ? officeDocs : officeDocs.filter((d) => d.docType === recentTab)
    return filtered.slice(0, 12)
  }, [officeDocs, recentTab])

  // Today's real events in time order. Empty array stays empty; we never invent.
  const todayEvents = useMemo<TimeBlock[]>(() => {
    if (!agenda) return []
    return [...agenda].sort((a, b) => a.startMs - b.startMs).slice(0, 6)
  }, [agenda])

  // Open Mail and start a compose window. Routes into the office's inline Mail
  // surface, then opens the real composer.
  function composeMail(): void {
    openComms('mail')
    startCompose()
  }

  // Open the real Meet surface inline.
  function openMeet(): void {
    openComms('meet')
  }

  function toggleStar(id: string): void {
    setStarred((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try {
        localStorage.setItem(STAR_KEY, JSON.stringify([...next]))
      } catch {
        /* ignore */
      }
      return next
    })
  }

  async function launch(app: OfficeApp): Promise<void> {
    if (app.docType === null) return
    // Gate the create on the editor's entitlement. A locked editor never
    // creates; a licensing gap offers the upgrade, a restriction is a dead end.
    const ent = docEntitlement(app.docType)
    if (!ent.enabled) {
      ent.onLockedClick()
      return
    }
    if (busy) return
    setBusy(true)
    try {
      // No custom title: the documents store already names a new file per type
      // ("Untitled document", "Untitled diagram", "Untitled artwork"), which is
      // both consistent with every other create path and better than the
      // product-name-plus-"draft" string this used to build.
      const doc = await createBlank(app.docType)
      await refresh()
      setOpenDocId(doc.id)
    } finally {
      setBusy(false)
    }
  }

  // Open a communication app inline (Mail / Inbox / Chat / Meet / Sign).
  // Every document row is a drag source. The tray shows desks alongside these,
  // which makes "drag it onto the desk it belongs to" the obvious gesture — and
  // until now there was no way to do it without opening the desk first.
  function docDragProps(d: { id: string; docType: DocType; title: string }): {
    draggable: boolean
    title?: string
    onDragStart: (ev: React.DragEvent) => void
  } {
    return {
      draggable: canPlaceOnDesk(d.docType),
      // A drag with no affordance is a feature nobody finds. The row stays a
      // click target, so the cursor stays a pointer and the tooltip does the
      // teaching.
      title: canPlaceOnDesk(d.docType)
        ? `${d.title || 'Untitled'} — open it, or drag it onto a desk in the tray below`
        : undefined,
      onDragStart: (ev) => {
        if (!canPlaceOnDesk(d.docType)) {
          ev.preventDefault()
          return
        }
        writeDocumentDrag(ev.dataTransfer, {
          documentId: d.id,
          docType: d.docType,
          title: d.title || 'Untitled'
        })
      }
    }
  }

  function openComms(key: string): void {
    // Navigation, not local state: that is what puts it in the tray and under
    // the history arrows, and what lets going back actually close it.
    setActiveComms(key)
  }

  async function createType(docType: DocType, title: string): Promise<void> {
    // Same gate for every "New <type>" and template create path.
    const ent = docEntitlement(docType)
    if (!ent.enabled) {
      ent.onLockedClick()
      return
    }
    if (busy) return
    setBusy(true)
    try {
      const doc = await createBlank(docType, title)
      await refresh()
      setOpenDocId(doc.id)
    } finally {
      setBusy(false)
    }
  }

  // An open document takes over the content area; the office sidebar stays.
  const openDocIsWidget = !!openDocId && list.some((d) => d.id === openDocId && d.docType === 'widget')
  if (openDocId) {
    return (
      <div className="h-full flex bg-[var(--surface-base)] relative">
        {menuMinimized ? (
          <MenuRestorePill onClick={restoreMenu} label="PlexiiOffice" title="Show the PlexiiOffice menu" />
        ) : (
          <OfficeSidebar onExit={goHome} onMinimize={minimizeMenu} />
        )}
        <FilesDockSlot belowPill={menuMinimized} />
        <div className="flex-1 min-w-0">
          {/* A widget file can surface in the office lists (it is a document
              row), and it opens as its widget, never in a text editor. */}
          {openDocIsWidget ? (
            <WidgetFileView fileId={openDocId} />
          ) : (
            <DocumentEditorView documentId={openDocId} onBack={() => { setOpenDocId(null); void refresh() }} />
          )}
        </div>
      </div>
    )
  }

  // A communication app (Mail / Inbox / Chat / Meet / Sign) takes over the
  // content area inline; the office side menu stays put.
  const comms = activeComms ? COMMS_APPS.find((a) => a.key === activeComms) ?? null : null
  if (comms) {
    // These comms surfaces render inline here rather than through MainPane, so a
    // deep link could otherwise reach a locked one. Wrap the render in the same
    // CapabilityGate the backbone uses so a gated comms app shows the reason-aware
    // locked panel instead of the surface. Inbox is core and never gated.
    const gate = commsGate(comms.key)
    const content = gate ? (
      <CapabilityGate capabilityKey={gate.cap} label={gate.label}>
        {comms.render()}
      </CapabilityGate>
    ) : (
      comms.render()
    )
    return (
      <div className="h-full flex bg-[var(--surface-base)] relative">
        {menuMinimized ? (
          <MenuRestorePill onClick={restoreMenu} label="PlexiiOffice" title="Show the PlexiiOffice menu" />
        ) : (
          <OfficeSidebar onExit={goHome} onMinimize={minimizeMenu} />
        )}
        <FilesDockSlot belowPill={menuMinimized} />
        <PageEnter id={`office-comms-${comms.key}`} className="flex-1 min-w-0 overflow-auto" testid={`office-comms-${comms.key}`}>{content}</PageEnter>
      </div>
    )
  }

  return (
    <div className="h-full flex bg-[var(--surface-base)] text-[var(--ink-100)] relative">
      {menuMinimized ? (
        <MenuRestorePill onClick={restoreMenu} label="PlexiiOffice" title="Show the PlexiiOffice menu" />
      ) : (
        <OfficeSidebar onExit={goHome} onMinimize={minimizeMenu} />
      )}
      <FilesDockSlot belowPill={menuMinimized} />

      <PageEnter id={`office-page-${page}`} className="flex-1 min-w-0 overflow-auto">
        <div className="w-full px-8 py-6">
          {/* Header */}
          <div className="flex items-start gap-4 mb-5">
            <div className="min-w-0">
              <h1 className="text-[22px] font-semibold">PlexiiOffice {pageTitle(page)}</h1>
              <p className="text-[13px] text-[var(--ink-50)]">Create, collaborate and get more done with PlexiiOffice.</p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => void createType('doc', 'Untitled document')}
                className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-[rgb(var(--accent))] text-white text-[13px] font-medium hover:bg-[rgb(var(--accent-hover))]"
                data-testid="office-create"
              >
                <Icon name="add" size={16} /> Create
              </button>
            </div>
          </div>

          {/* THE LIBRARY, moved here from the side menu.
              Recent / Starred / Shared / Templates / Trash are views of this
              dashboard's own document list — they were rows in the menu, which
              made the menu longer and put document filters next to area
              navigation, two different kinds of thing. They belong with the
              documents they filter. */}
          <div
            className="flex items-center gap-1.5 flex-wrap mb-5"
            data-testid="office-library-nav"
          >
            {LIBRARY_PAGES.map((n) => (
              <button
                key={n.id}
                onClick={() => {
                  setOpenDocId(null)
                  setActiveComms(null)
                  setPage(n.id)
                }}
                data-testid={`office-nav-${n.id}`}
                aria-current={page === n.id ? 'page' : undefined}
                className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px] whitespace-nowrap border transition-colors ${
                  page === n.id
                    ? 'border-accent bg-accent/10 text-[rgb(var(--accent))] font-medium'
                    : 'border-[var(--edge-soft)] text-[var(--ink-80)] hover:bg-[var(--surface-sunken)]'
                }`}
              >
                {OFFICE_LIBRARY_ENTITY[n.id] ? (
                  <PlexiiIcon
                    kind={OFFICE_LIBRARY_ENTITY[n.id].kind}
                    id={OFFICE_LIBRARY_ENTITY[n.id].id}
                    size={16}
                    fallback={n.icon}
                    fallbackFilled
                    fallbackClassName={page === n.id ? '' : n.tone}
                  />
                ) : (
                  <Icon name={n.icon} size={15} filled className={page === n.id ? '' : n.tone} />
                )}
                <span>{n.label}</span>
                {n.id === 'starred' && starred.size > 0 && (
                  <span className="text-[11px] text-[var(--ink-50)] fb-tabular">{starred.size}</span>
                )}
              </button>
            ))}
          </div>

          {/* App tiles — the document apps plus Meet, which opens the real
              meeting surface rather than creating a document. */}
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-8 gap-2.5 mb-6">
            {APPS.map((a) => {
              const ent = a.docType ? docEntitlement(a.docType) : null
              const locked = !!ent && !ent.enabled
              if (locked) {
                return (
                  <button
                    key={a.key}
                    onClick={ent.onLockedClick}
                    data-testid={`office-app-${a.key}`}
                    data-locked="true"
                    aria-disabled="true"
                    title={ent.reason}
                    className="fb-btn-surface relative flex flex-col items-center gap-2 p-3.5 opacity-50 cursor-not-allowed"
                  >
                    <PlexiiTileIcon kind="app" id={a.key} fallback={a.icon} tone={a.tone} />
                    <span className="text-[12.5px] font-medium">{a.label}</span>
                    <span className="text-[10.5px] text-[var(--ink-50)] text-center leading-tight">{a.blurb}</span>
                    <Icon name="lock" size={11} className="absolute top-1.5 right-2 text-[var(--ink-40)]" />
                  </button>
                )
              }
              return (
                <button
                  key={a.key}
                  onClick={() => void launch(a)}
                  data-testid={`office-app-${a.key}`}
                  className="fb-btn-surface flex flex-col items-center gap-2 p-3.5 hover:border-[rgb(var(--accent)/0.5)] hover:shadow-sm transition"
                >
                  <PlexiiTileIcon kind="app" id={a.key} fallback={a.icon} tone={a.tone} />
                  <span className="text-[12.5px] font-medium">{a.label}</span>
                  <span className="text-[10.5px] text-[var(--ink-50)] text-center leading-tight">{a.blurb}</span>
                </button>
              )
            })}
            {viewEnabled('meetings') && (
              <button
                onClick={openMeet}
                data-testid="office-app-meet"
                className="fb-btn-surface flex flex-col items-center gap-2 p-3.5 hover:border-[rgb(var(--accent)/0.5)] hover:shadow-sm transition"
              >
                <PlexiiTileIcon kind="app" id="meet" fallback="video_call" tone="text-violet-500" />
                <span className="text-[12.5px] font-medium">PlexiiCall</span>
                <span className="text-[10.5px] text-[var(--ink-50)] text-center leading-tight">Start a meeting</span>
              </button>
            )}
            {/* Apps that open a surface rather than creating a document. The
                Browser was only reachable under a "Communicate" heading it does
                not belong to, so it was missing from the one grid people
                actually launch things from. */}
            {appSectionComms(COMMS_APPS).map((a) => (
              <button
                key={a.key}
                onClick={() => openComms(a.key)}
                data-testid={`office-app-${a.key}`}
                className="fb-btn-surface flex flex-col items-center gap-2 p-3.5 hover:border-[rgb(var(--accent)/0.5)] hover:shadow-sm transition"
              >
                <PlexiiTileIcon kind="app" id={a.key} fallback={a.icon} tone={a.tone} />
                <span className="text-[12.5px] font-medium">{a.label}</span>
                <span className="text-[10.5px] text-[var(--ink-50)] text-center leading-tight">{a.blurb}</span>
              </button>
            ))}
          </div>

          <div className="flex gap-5">
            {/* Main column */}
            <div className="flex-1 min-w-0 space-y-5">
              {/* Templates */}
              <section className="fb-card p-4">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-[15px] font-semibold">Start with a template</h2>
                </div>
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {(['all', 'doc', 'sheet', 'slides', 'map', 'design', 'draw'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setTab(t)}
                      className={`px-2.5 py-1 rounded-full text-[12px] ${tab === t ? 'bg-[rgb(var(--accent))] text-white' : 'fb-btn-surface text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'}`}
                    >
                      {tabLabel(t)}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
                  {TEMPLATES.filter((tp) => tab === 'all' || tp.docType === tab).map((tp) => (
                    <button
                      key={tp.id}
                      onClick={() => void createType(tp.docType, tp.label)}
                      data-testid={`office-template-${tp.id}`}
                      className="fb-btn-surface group text-left overflow-hidden hover:border-[rgb(var(--accent)/0.5)] transition"
                    >
                      {/* A template whose app has a Plexii icon shows that tile on the card's
                          own surface, the way brand icons sit everywhere else
                          (the tile carries the colour), with a hairline above
                          the label. A sunken band read as a hole in dark. */}
                      <div
                        className={`h-24 flex items-center justify-center ${
                          docTypeEntity(tp.docType) ? 'border-b border-[var(--edge-hairline)]' : tp.preview
                        }`}
                      >
                        <PlexiiDocIcon docType={tp.docType} size={36} fallback={TYPE_ICON[tp.docType]?.icon ?? 'description'} fallbackClassName="text-white/90" />
                      </div>
                      <div className="px-2.5 py-2">
                        <div className="text-[12px] font-medium truncate">{tp.label}</div>
                        <div className="text-[10.5px] text-[var(--ink-50)]">{appLabel(tp.docType)}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </section>

              {/* Recent — real documents only, sorted by their real updatedAt and
                  filtered by the selected type tab. The Mail and Meet tabs have no
                  document records, so they show an honest empty state. We do not
                  add a Location column or collaborator avatars: those are not real
                  fields on a document, so they are omitted rather than invented. */}
              {page === 'home' ? (
                <section className="fb-card p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-[15px] font-semibold">Recent</h2>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    {RECENT_TABS.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => setRecentTab(t.id)}
                        data-testid={`office-recent-tab-${t.id}`}
                        className={`px-2.5 py-1 rounded-full text-[12px] ${recentTab === t.id ? 'bg-[rgb(var(--accent))] text-white' : 'fb-btn-surface text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'}`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                  {recentRows.length === 0 ? (
                    <p className="text-[12.5px] text-[var(--ink-50)] py-6 text-center" data-testid="office-recent-empty">
                      Nothing here yet.
                    </p>
                  ) : (
                    <div className="text-[12.5px]" data-testid="office-home-recent-table">
                      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-2 pb-1.5 text-[11px] uppercase tracking-wide text-[var(--ink-50)] border-b border-[var(--edge-soft)]">
                        <span>Name</span>
                        <span>Type</span>
                        <span>Last opened</span>
                        <span />
                      </div>
                      {recentRows.map((d) => {
                        const ti = TYPE_ICON[d.docType] ?? { icon: 'description', tint: 'text-[var(--ink-40)]' }
                        return (
                          <div
                            key={d.id}
                            {...docDragProps(d)}
                            onClick={() => setOpenDocId(d.id)}
                            data-testid={`office-recent-row-${d.id}`}
                            className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-2 py-2 items-center border-b border-[color-mix(in_oklab,var(--edge-soft)_60%,transparent)] cursor-pointer hover:bg-[var(--surface-sunken)] rounded"
                          >
                            <span className="flex items-center gap-2 min-w-0">
                              <PlexiiDocIcon docType={d.docType} size={18} fallback={ti.icon} fallbackClassName={ti.tint} className="shrink-0" />
                              <span className="truncate">{d.title || 'Untitled'}</span>
                            </span>
                            <span className="text-[var(--ink-60)] whitespace-nowrap">{appLabel(d.docType).replace('Plexii', '')}</span>
                            <span className="text-[var(--ink-60)] whitespace-nowrap fb-tabular">{relTime(d.updatedAt)}</span>
                            <span className="flex items-center gap-1">
                              <button onClick={(e) => { e.stopPropagation(); toggleStar(d.id) }} className={starred.has(d.id) ? 'text-amber-400' : 'text-[var(--ink-40)] hover:text-amber-400'} title="Star">
                                <Icon name="star" size={15} filled={starred.has(d.id)} />
                              </button>
                              <button onClick={(e) => { e.stopPropagation(); void remove(d.id) }} className="text-[var(--ink-40)] hover:text-rose-500" title="Delete">
                                <Icon name="delete" size={15} />
                              </button>
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </section>
              ) : (
                <LibraryPage
                  page={page}
                  docs={officeDocs}
                  starred={starred}
                  onOpen={(id) => setOpenDocId(id)}
                  onToggleStar={toggleStar}
                  onCreateType={(t, title) => void createType(t, title)}
                  dragProps={docDragProps}
                />
              )}
            </div>

            {/* Right rail */}
            <div className="w-[260px] shrink-0 space-y-4 hidden lg:block">
              {page === 'home' && (
                <>
                  {/* Your day — real time blocks for today. No invented meetings;
                      an empty day shows an honest empty state. A Join control is
                      not shown because a time block carries no real join target. */}
                  <RailCard title="Your day in PlexiiOffice">
                    <div data-testid="office-home-day">
                      {agenda === null ? (
                        <p className="text-[11.5px] text-[var(--ink-50)]">Loading your day…</p>
                      ) : todayEvents.length === 0 ? (
                        <p className="text-[11.5px] text-[var(--ink-50)]" data-testid="office-home-day-empty">
                          Nothing scheduled today.
                        </p>
                      ) : (
                        <ul className="space-y-1.5">
                          {todayEvents.map((b) => (
                            <li key={b.id} className="flex items-center gap-2.5" data-testid={`office-home-day-item-${b.id}`}>
                              <span className="shrink-0 text-[11px] text-[var(--ink-50)] fb-tabular w-12">{clockTime(b.startMs)}</span>
                              <span className="flex-1 min-w-0 truncate text-[12px] text-[var(--ink-90)]">{b.title || 'Time block'}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </RailCard>

                  {/* Quick actions — every action goes to a real destination. */}
                  <RailCard title="Quick actions">
                    <div className="space-y-0.5" data-testid="office-home-quickactions">
                      {viewEnabled('mail') && <QuickActionRow testid="office-qa-compose" icon="mail" label="Compose email" onClick={composeMail} />}
                      <QuickActionRow testid="office-qa-doc" icon="description" label="New document" onClick={() => void createType('doc', 'Untitled document')} />
                      <QuickActionRow testid="office-qa-sheet" icon="table_chart" label="New spreadsheet" onClick={() => void createType('sheet', 'Untitled spreadsheet')} />
                      <QuickActionRow testid="office-qa-slides" icon="slideshow" label="New presentation" onClick={() => void createType('slides', 'Untitled presentation')} />
                      {viewEnabled('meetings') && <QuickActionRow testid="office-qa-meet" icon="video_call" label="Start a meeting" onClick={openMeet} />}
                    </div>
                  </RailCard>

                  {/* Unread — real counts only. Mail comes from the loaded IMAP
                      envelope list, Inbox and Chat from the messaging store.
                      Mentions are not instrumented, so that row is omitted rather
                      than faked. When every real source is zero, the card shows an
                      honest caught-up state. */}
                  <RailCard title="Unread">
                    <div data-testid="office-home-unread">
                      {inboxUnread + chatUnread + mailUnread === 0 ? (
                        <p className="text-[11.5px] text-[var(--ink-50)]" data-testid="office-home-unread-empty">
                          You are all caught up.
                        </p>
                      ) : (
                        <div className="space-y-1">
                          <UnreadRow icon="inbox" label="Inbox" count={inboxUnread} onClick={() => openComms('inbox')} />
                          {viewEnabled('messages') && <UnreadRow icon="forum" label="Chat messages" count={chatUnread} onClick={() => openComms('chat')} />}
                          {viewEnabled('mail') && <UnreadRow icon="mail" label="Mail" count={mailUnread} onClick={() => openComms('mail')} />}
                        </div>
                      )}
                    </div>

                  </RailCard>
                </>
              )}

              <RailCard title="Pinned">
                {[...officeDocs].filter((d) => starred.has(d.id)).slice(0, 5).length === 0 ? (
                  <p className="text-[11.5px] text-[var(--ink-50)]">Star files to pin them here.</p>
                ) : (
                  officeDocs.filter((d) => starred.has(d.id)).slice(0, 5).map((d) => (
                    <button key={d.id} {...docDragProps(d)} onClick={() => setOpenDocId(d.id)} className="flex items-center gap-2 w-full text-left py-1 hover:text-[rgb(var(--accent))]">
                      <PlexiiDocIcon docType={d.docType} size={16} fallback={(TYPE_ICON[d.docType] ?? { icon: 'description' }).icon} fallbackClassName={(TYPE_ICON[d.docType] ?? { tint: '' }).tint} className="shrink-0" />
                      <span className="truncate text-[12px]">{d.title || 'Untitled'}</span>
                    </button>
                  ))
                )}
              </RailCard>

              <RailCard title="Storage">
                <p className="text-[12px] text-[var(--ink-70)]">
                  {officeDocs.length} document{officeDocs.length === 1 ? '' : 's'} in this workspace.
                </p>
                <p className="text-[11px] text-[var(--ink-50)] mt-1">Stored locally on this device.</p>
              </RailCard>

              <RailCard title="What's new">
                {CHANGELOG.slice(0, 3).map((c) => (
                  <div key={c.version} className="py-1">
                    <div className="text-[12px] font-medium truncate">{(c.title ?? c.version).replace(/^v?[0-9.]+\s*—\s*/, '')}</div>
                    <div className="text-[10.5px] text-[var(--ink-50)] fb-tabular">{c.version}</div>
                  </div>
                ))}
              </RailCard>

              <button
                onClick={() => promptUpgrade('PlexiiOffice Pro')}
                className="w-full rounded-2xl border border-[rgb(var(--accent)/0.3)] bg-[rgb(var(--accent)/0.06)] p-4 text-left"
                data-testid="office-upgrade"
              >
                <div className="flex items-center gap-1.5 mb-2">
                  <Icon name="auto_awesome" size={15} className="text-[rgb(var(--accent))]" />
                  <span className="text-[13px] font-semibold">Get more with PlexiiOffice Pro</span>
                </div>
                <ul className="space-y-1 mb-3">
                  {PRO_FEATURES.map((f) => (
                    <li key={f} className="flex items-center gap-1.5 text-[11.5px] text-[var(--ink-70)]">
                      <Icon name="check" size={13} className="text-emerald-500" /> {f}
                    </li>
                  ))}
                </ul>
                <span className="inline-flex items-center justify-center w-full h-8 rounded-lg bg-[rgb(var(--accent))] text-white text-[12.5px] font-medium">Upgrade Now</span>
              </button>
            </div>
          </div>

          {/* AI assistant bar */}
          <div className="fb-card mt-6 flex items-center gap-3 px-4 py-3">
            <span className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-[rgb(var(--accent)/0.15)] text-[rgb(var(--accent))]">
              <Icon name="auto_awesome" size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">PlexiiAssist</div>
              <div className="text-[11.5px] text-[var(--ink-50)] truncate">Ask anything about your documents, data or presentations.</div>
            </div>
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('fb:open-assistant'))}
              data-testid="office-ask-ai"
              className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-[rgb(var(--accent))] text-white text-[13px] font-medium hover:bg-[rgb(var(--accent-hover))]"
            >
              Ask AI
            </button>
          </div>
        </div>
      </PageEnter>
    </div>
  )
}

// ── The library views ────────────────────────────────────────────────────────
//
// Recent, Starred, Shared with me, Templates and Trash were ONE table with one
// filter in front of it — and `visibleDocs` returned `docs.slice(0, 12)` for
// everything except Starred, so Recent and Trash showed the identical twelve
// documents. Five menu items, one view, two of them lying about their content.
//
// Each is its own view now, and each is backed by data that actually exists:
// Trash reads documents.listTrashed(), Shared reads the real shares inbox,
// Templates reads the template list. Where there is nothing to show, the view
// says so rather than falling back to a list of unrelated documents.

function timeBucket(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const sameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(d, now)) return 'Today'
  if (sameDay(d, yesterday)) return 'Yesterday'
  if (now.getTime() - ms < 7 * 86_400_000) return 'Earlier this week'
  if (now.getTime() - ms < 30 * 86_400_000) return 'Earlier this month'
  return 'Older'
}

/** A library page's empty state. `page` names the page so it wears that page's owner icon. */
function Empty({ icon, page, title, hint }: { icon: string; page?: OfficePage; title: string; hint: string }): JSX.Element {
  const ent = page ? OFFICE_LIBRARY_ENTITY[page] : undefined
  return (
    <div className="py-10 text-center" data-testid="library-empty">
      {ent ? (
        <span className="inline-flex mb-2">
          <PlexiiIcon kind={ent.kind} id={ent.id} size={28} fallback={icon} fallbackClassName="text-[var(--ink-30)]" />
        </span>
      ) : (
        <Icon name={icon} size={28} className="text-[var(--ink-30)] mb-2" />
      )}
      <p className="text-[13px] text-[var(--ink-80)] font-medium">{title}</p>
      <p className="text-[12px] text-[var(--ink-50)] mt-1 max-w-sm mx-auto leading-snug">{hint}</p>
    </div>
  )
}

function DocCard({
  doc,
  starred,
  onOpen,
  onToggleStar,
  dragProps
}: {
  doc: DocumentMeta
  starred: boolean
  onOpen: () => void
  onToggleStar: () => void
  dragProps: (d: DocumentMeta) => Record<string, unknown>
}): JSX.Element {
  const ti = TYPE_ICON[doc.docType] ?? { icon: 'description', tint: 'text-[var(--ink-40)]' }
  return (
    <div
      {...dragProps(doc)}
      onClick={onOpen}
      data-testid={`office-file-${doc.id}`}
      className="fb-card p-3 cursor-pointer hover:bg-[var(--surface-sunken)] flex flex-col gap-2"
    >
      <div className="flex items-start gap-2">
        <PlexiiDocIcon docType={doc.docType} size={20} fallback={ti.icon} fallbackFilled fallbackClassName={ti.tint} className="shrink-0" />
        <span className="text-[13px] font-medium leading-snug line-clamp-2 flex-1 min-w-0">
          {doc.title || 'Untitled'}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onToggleStar()
          }}
          className={starred ? 'text-amber-400' : 'text-[var(--ink-40)] hover:text-amber-400'}
          title={starred ? 'Unstar' : 'Star'}
        >
          <Icon name="star" size={15} filled={starred} />
        </button>
      </div>
      <span className="text-[11px] text-[var(--ink-50)] fb-tabular">{relTime(doc.updatedAt)}</span>
    </div>
  )
}

function LibraryPage({
  page,
  docs,
  starred,
  onOpen,
  onToggleStar,
  onCreateType,
  dragProps
}: {
  page: OfficePage
  docs: DocumentMeta[]
  starred: Set<string>
  onOpen: (id: string) => void
  onToggleStar: (id: string) => void
  onCreateType: (t: DocType, title: string) => void
  dragProps: (d: DocumentMeta) => Record<string, unknown>
}): JSX.Element {
  // ── Trash: the real trashed rows, which nothing was reading ──────────────
  const [trashed, setTrashed] = useState<DocumentMeta[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const reloadTrash = useCallback(async (): Promise<void> => {
    try {
      setTrashed(await window.api.documents.listTrashed())
    } catch {
      setTrashed([])
    }
  }, [])
  useEffect(() => {
    if (page === 'trash') void reloadTrash()
  }, [page, reloadTrash])

  // ── Shared with me: the real inbox of things other people shared ─────────
  const shareInbox = useSharesStore((s) => s.inbox)

  if (page === 'recent') {
    const sorted = [...docs].sort((a, b) => b.updatedAt - a.updatedAt)
    if (sorted.length === 0) {
      return (
        <section className="fb-card p-4">
          <Empty
            icon="schedule"
            page="recent"
            title="Nothing opened yet"
            hint="Documents you create or open will be listed here, newest first."
          />
        </section>
      )
    }
    const groups: { label: string; items: DocumentMeta[] }[] = []
    for (const d of sorted) {
      const label = timeBucket(d.updatedAt)
      const last = groups[groups.length - 1]
      if (last && last.label === label) last.items.push(d)
      else groups.push({ label, items: [d] })
    }
    return (
      <section className="fb-card p-4" data-testid="library-recent">
        {/* Grouped by WHEN, which is the only thing "recent" means. A flat
            table sorted by date told you the same thing in a column you had to
            read row by row. */}
        {groups.map((g) => (
          <div key={g.label} className="mb-4 last:mb-0">
            <h3 className="text-[11px] uppercase tracking-[0.1em] text-[var(--ink-50)] font-semibold mb-2">
              {g.label}
            </h3>
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
              {g.items.map((d) => (
                <DocCard
                  key={d.id}
                  doc={d}
                  starred={starred.has(d.id)}
                  onOpen={() => onOpen(d.id)}
                  onToggleStar={() => onToggleStar(d.id)}
                  dragProps={dragProps}
                />
              ))}
            </div>
          </div>
        ))}
      </section>
    )
  }

  if (page === 'starred') {
    const items = docs.filter((d) => starred.has(d.id))
    return (
      <section className="fb-card p-4" data-testid="library-starred">
        {items.length === 0 ? (
          <Empty
            icon="star"
            page="starred"
            title="Nothing starred"
            hint="Star a document from any list and it will be kept here, so the few you return to are never buried."
          />
        ) : (
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
            {items.map((d) => (
              <DocCard
                key={d.id}
                doc={d}
                starred
                onOpen={() => onOpen(d.id)}
                onToggleStar={() => onToggleStar(d.id)}
                dragProps={dragProps}
              />
            ))}
          </div>
        )}
      </section>
    )
  }

  if (page === 'shared') {
    return (
      <section className="fb-card p-4" data-testid="library-shared">
        {shareInbox.length === 0 ? (
          <Empty
            icon="group"
            page="shared"
            title="Nothing shared with you yet"
            hint="When someone shares a desk or a folder with you, it appears here with who sent it. Document-level sharing is not available yet, so this lists shared desks rather than files."
          />
        ) : (
          <div className="text-[12.5px]">
            {/* The REAL shares inbox. These are desks, folders and widgets —
                named as such rather than dressed up as documents, because
                document-level sharing does not exist yet. */}
            {shareInbox.map((sh) => (
              <div
                key={sh.token}
                className="flex items-center gap-3 px-2 py-2.5 border-b border-[color-mix(in_oklab,var(--edge-soft)_60%,transparent)] last:border-b-0"
                data-testid={`library-share-${sh.token}`}
              >
                <Icon name="folder_shared" size={17} filled className="text-violet-500 shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="block truncate font-medium">{sh.kind}</span>
                  <span className="block text-[11px] text-[var(--ink-50)]">
                    from {sh.fromHandle}
                  </span>
                </span>
                <span className="text-[11px] text-[var(--ink-50)] fb-tabular whitespace-nowrap">
                  {relTime(sh.acceptedAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    )
  }

  if (page === 'templates') {
    return (
      <section className="fb-card p-4" data-testid="library-templates">
        {/* A gallery, because a template is chosen by the look of it. The same
            list used to render as rows of filenames. */}
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
          {TEMPLATES.map((t) => (
            <button
              key={t.id + t.docType}
              onClick={() => onCreateType(t.docType, t.label)}
              data-testid={`library-template-${t.docType}`}
              className="text-left group"
            >
              <span
                className={`block h-20 rounded-lg ${t.preview} mb-1.5 transition-transform group-hover:scale-[1.02]`}
              />
              <span className="block text-[12.5px] font-medium truncate">{t.label}</span>
              <span className="block text-[11px] text-[var(--ink-50)]">Create</span>
            </button>
          ))}
        </div>
      </section>
    )
  }

  // ── Trash ────────────────────────────────────────────────────────────────
  return (
    <section className="fb-card p-4" data-testid="library-trash">
      {trashed === null ? (
        <p className="text-[12.5px] text-[var(--ink-50)] py-6 text-center">Loading…</p>
      ) : trashed.length === 0 ? (
        <Empty
          icon="delete"
          page="trash"
          title="Trash is empty"
          hint="Deleted documents rest here until you remove them for good."
        />
      ) : (
        <div className="text-[12.5px]">
          {trashed.map((d) => {
            const ti = TYPE_ICON[d.docType] ?? { icon: 'description', tint: 'text-[var(--ink-40)]' }
            return (
              <div
                key={d.id}
                className="flex items-center gap-3 px-2 py-2 border-b border-[color-mix(in_oklab,var(--edge-soft)_60%,transparent)] last:border-b-0"
                data-testid={`library-trashed-${d.id}`}
              >
                <PlexiiDocIcon docType={d.docType} size={18} fallback={ti.icon} fallbackFilled fallbackClassName={ti.tint} className="shrink-0 opacity-60" />
                <span className="flex-1 min-w-0 truncate text-[var(--ink-70)]">
                  {d.title || 'Untitled'}
                </span>
                {/* Restore and purge are real operations, not a styled list. */}
                <button
                  disabled={busyId === d.id}
                  onClick={() => {
                    setBusyId(d.id)
                    void window.api.documents
                      .restore(d.id)
                      .then(() => reloadTrash())
                      .finally(() => setBusyId(null))
                  }}
                  className="text-[12px] px-2 py-1 rounded-md border border-[var(--edge-soft)] hover:bg-[var(--surface-sunken)] disabled:opacity-50"
                  data-testid={`library-restore-${d.id}`}
                >
                  Restore
                </button>
                <button
                  disabled={busyId === d.id}
                  onClick={() => {
                    setBusyId(d.id)
                    void window.api.documents
                      .purge(d.id)
                      .then(() => reloadTrash())
                      .finally(() => setBusyId(null))
                  }}
                  className="text-[12px] px-2 py-1 rounded-md text-rose-500 hover:bg-rose-500/10 disabled:opacity-50"
                  data-testid={`library-purge-${d.id}`}
                >
                  Delete forever
                </button>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function pageTitle(p: OfficePage): string {
  return p === 'home' ? 'Home' : p[0].toUpperCase() + p.slice(1)
}
function tabLabel(t: 'all' | DocType): string {
  return t === 'all' ? 'All' : t === 'doc' ? 'Docs' : t === 'sheet' ? 'Sheets' : t === 'slides' ? 'Slides' : t === 'map' ? 'Diagrams' : t === 'design' ? 'Designs' : t === 'draw' ? 'Artwork' : t
}
function appLabel(t: DocType): string {
  return t === 'doc' ? 'PlexiiWrite' : t === 'sheet' ? 'PlexiiCells' : t === 'slides' ? 'PlexiiDeck' : t === 'map' ? 'PlexiiDiagrams' : t === 'design' ? 'PlexiiDesign' : t === 'draw' ? 'PlexiiDraw' : 'PlexiiOffice'
}
const TEMPLATES: { id: string; label: string; docType: DocType; preview: string }[] = [
  { id: 'blank-doc', label: 'Blank document', docType: 'doc', preview: 'bg-gradient-to-br from-sky-500 to-sky-700' },
  { id: 'blank-sheet', label: 'Blank spreadsheet', docType: 'sheet', preview: 'bg-gradient-to-br from-emerald-500 to-emerald-700' },
  { id: 'blank-slides', label: 'Blank presentation', docType: 'slides', preview: 'bg-gradient-to-br from-orange-500 to-orange-700' },
  { id: 'blank-draw', label: 'Blank drawing', docType: 'map', preview: 'bg-gradient-to-br from-violet-500 to-violet-700' },
  { id: 'blank-design', label: 'Blank design', docType: 'design', preview: 'bg-gradient-to-br from-fuchsia-500 to-fuchsia-700' },
  { id: 'blank-draw', label: 'Blank artwork', docType: 'draw', preview: 'bg-gradient-to-br from-rose-500 to-rose-700' }
]

function RailCard({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="fb-card p-3.5">
      <h3 className="text-[12px] font-semibold mb-2">{title}</h3>
      {children}
    </div>
  )
}

function QuickActionRow({ testid, icon, label, onClick }: { testid: string; icon: string; label: string; onClick: () => void }): JSX.Element {
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      className="flex items-center gap-2.5 w-full px-2 py-1.5 rounded-lg text-[12.5px] text-[var(--ink-80)] hover:bg-[var(--surface-sunken)]"
    >
      <Icon name={icon} size={15} className="text-[var(--ink-50)]" />
      <span className="truncate">{label}</span>
    </button>
  )
}

function UnreadRow({ icon, label, count, onClick }: { icon: string; label: string; count: number; onClick: () => void }): JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2.5 w-full px-2 py-1.5 rounded-lg text-[12.5px] text-[var(--ink-80)] hover:bg-[var(--surface-sunken)]"
    >
      <Icon name={icon} size={15} className="text-[var(--ink-50)]" />
      <span className="flex-1 min-w-0 truncate text-left">{label}</span>
      {count > 0 && (
        <span className="shrink-0 min-w-[18px] text-center text-[10.5px] font-semibold rounded-full px-1.5 py-0.5 bg-[rgb(var(--accent)/0.15)] text-[rgb(var(--accent))] fb-tabular">
          {count}
        </span>
      )}
    </button>
  )
}

// ── The PlexiOffice-specific sidebar ─────────────────────────────────────────
// Chrome only now: the wordmark, the minimise/exit controls, the workspace
// selector and the shared accordion. Launching apps and listing comms surfaces
// moved to the accordion, and the document library moved to the dashboard
// beside the documents it filters (LIBRARY_PAGES).
function OfficeSidebar({
  onExit,
  onMinimize
}: {
  onExit: () => void
  onMinimize: () => void
}): JSX.Element {
  return (
    <div
      className={`shrink-0 h-full box-border ${FLOATING_MENU_INSET}`}
      style={{ width: 'var(--fb-sidebar-fixed, 260px)' }}
    >
    <aside className={FLOATING_MENU_ASIDE_SCROLL} style={FLOATING_MENU_STYLE} data-testid="office-sidebar">
      {/* Logo + app switcher */}
      <div className="flex items-center gap-2 px-4 h-14 border-b border-[var(--edge-soft)]">
        <span className="text-[15px] font-bold tracking-[0.14em] text-[var(--ink-100)]">PLEXIIOFFICE</span>
        <div className="ml-auto flex items-center gap-1.5">
          <MenuMinimizeButton onClick={onMinimize} title="Minimise the PlexiiOffice menu" />
          <button onClick={onExit} className="text-[var(--ink-50)] hover:text-[var(--ink-90)]" title="Back to PlexiiDesk" data-testid="office-exit">
            <PlexiiIcon kind="app" id="plexidesk" size={20} label="Back to PlexiiDesk" fallback="apps" />
          </button>
        </div>
      </div>

      {/* Workspace and area are ONE control. An area lives inside an
          organisation, so two stacked peers misdescribed the relationship and
          cost two rows to do it. See components/WorkspaceSwitcher.tsx. */}
      <WorkspaceSwitcher />

      {/* Then the ONE menu. The bespoke Office menu — its own Apps grid, a
          Communicate list and a Workspaces stub — is gone: every one of those
          surfaces is in the accordion, where it is reachable from any area
          instead of only from inside Office. See
          components/nav/AreaAccordion.tsx.
          The second WorkspaceSwitcher that used to sit here was a duplicate
          organisation selector — the original is directly above. */}
      <AreaAccordion />

      <div className="mt-auto p-3">
        <UpgradeCard label="PlexiiOffice Pro" />
      </div>
    </aside>
    </div>
  )
}
