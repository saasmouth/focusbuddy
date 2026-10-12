import { lazy, Suspense } from 'react'
import { useViewStore } from '../stores/view'
import Canvas from './Canvas'
import HomeDashboard from './views/HomeDashboard'
import AllTasksView from './views/AllTasksView'
import RoomsView from './views/RoomsView'
import DesksView from './views/DesksView'
import SharedView from './views/SharedView'
import TrashView from './views/TrashView'
import AttentionView from './views/AttentionView'
import CapabilityGate from './CapabilityGate'
import PageEnter from './chrome/pageEnter'
import { VIEW_CAPABILITY } from '../lib/viewCapability'
import type { View } from '../stores/view'

// Keep the daily desk/task shell immediate and defer feature-specific products
// until navigation. This turns the existing Rollup vendor boundaries into a
// real cold-start improvement rather than eagerly fetching every editor.
const ConnectedAppView = lazy(() => import('./views/ConnectedAppView'))
const VaultView = lazy(() => import('./views/VaultView'))
const CalendarView = lazy(() => import('./views/CalendarView'))
const FlowView = lazy(() => import('./views/FlowView'))
const InboxView = lazy(() => import('./views/InboxView'))
const MailView = lazy(() => import('./views/MailView'))
const DocumentsView = lazy(() => import('./views/DocumentsView'))
const DesignsView = lazy(() => import('./views/DesignsView'))
const DrawView = lazy(() => import('./views/DrawView'))
const DocumentOpen = lazy(() => import('./views/DocumentOpen'))
const LiveDocEditorView = lazy(() => import('./views/LiveDocEditorView'))
const LiveFolderView = lazy(() => import('./views/LiveFolderView'))
const CollaborationsView = lazy(() => import('./views/CollaborationsView'))
const InsightsView = lazy(() => import('./views/InsightsView'))
const FilesView = lazy(() => import('./views/FilesView'))
const OrgAdminView = lazy(() => import('./views/OrgAdminView'))
const PeopleMapView = lazy(() => import('./views/PeopleMapView'))
const PlexiSignView = lazy(() => import('./views/PlexiSignView'))
const PlexiSuiteHome = lazy(() => import('./suite/PlexiSuiteHome'))
const ProductHome = lazy(() => import('./suite/ProductHome'))
const KnowledgeView = lazy(() => import('./views/KnowledgeView'))
const PlexiMeetView = lazy(() => import('./views/PlexiMeetView'))
const PlexiBuildView = lazy(() => import('./views/PlexiBuildView'))
const PlexiFormsView = lazy(() => import('./views/PlexiFormsView'))
const PlexiSearchView = lazy(() => import('./views/PlexiSearchView'))
const PlexiProjectsView = lazy(() => import('./views/PlexiProjectsView'))
const PlexiReportsView = lazy(() => import('./views/PlexiReportsView'))
const PlexiFlowView = lazy(() => import('./views/PlexiFlowView'))
const PlexiApiView = lazy(() => import('./views/PlexiApiView'))
const PlexiMarketplaceView = lazy(() => import('./views/PlexiMarketplaceView'))
const ExternalMdEditorView = lazy(() => import('./views/ExternalMdEditorView'))
const PlexiiHubView = lazy(() => import('./views/PlexiiHubView'))

// Feature surfaces that respect an entitlement live in lib/viewCapability so the
// enforcement backbone here and every navigation surface (sidebar, per-area
// menus, suite/home tiles) read the SAME view-kind -> capability mapping and can
// never disagree. Anything not in that map is core and always available (home,
// tasks, desks, search, inbox, suite, etc.). The standalone Office editors gate
// on product_office; the doc/sheet/etc widgets on a desk canvas are NOT — they
// live in the 'task' canvas view, which is never gated.

// The MainPane routes the central area between the OS-level views.
// Existing Canvas + chat behavior is preserved for the 'task' view; everything else
// is new surface introduced by the OS Phase 1 sidebar restructure.
export default function MainPane(): JSX.Element {
  const view = useViewStore((s) => s.view)
  const gate = VIEW_CAPABILITY[view.kind]
  if (gate) {
    return (
      <CapabilityGate capabilityKey={gate.cap} label={gate.label}>
        <MainPaneSurface />
      </CapabilityGate>
    )
  }
  return <MainPaneSurface />
}

function MainPaneSurface(): JSX.Element {
  const view = useViewStore((s) => s.view)
  // Home runs its own richer first-paint cascade; the page-level rise would
  // stack under it and double the motion. Every other view unravels in.
  if (view.kind === 'home') return renderView(view)
  return (
    <PageEnter id={JSON.stringify(view)}>
      <Suspense fallback={<RouteLoading />}>{renderView(view)}</Suspense>
    </PageEnter>
  )
}

function RouteLoading(): JSX.Element {
  return (
    <div className="h-full w-full flex items-center justify-center text-[13px] text-[var(--ink-50)]" role="status">
      <span className="inline-flex items-center gap-2">
        <span className="h-3 w-3 rounded-full border-2 border-[var(--edge-strong)] border-t-[rgb(var(--accent))] animate-spin" />
        Opening…
      </span>
    </div>
  )
}

function renderView(view: View): JSX.Element {
  switch (view.kind) {
    case 'home':
      return <HomeDashboard />
    case 'all-tasks':
      return <AllTasksView />
    case 'rooms':
      return <RoomsView />
    case 'desks':
      return <DesksView roomId={view.roomId} />
    case 'shared':
      return <SharedView />
    case 'trash':
      return <TrashView />
    case 'attention':
      return <AttentionView />
    // Every desk is a canvas: a top-level folder-desk opens the same drag-onto
    // canvas as a task (App keeps activeTaskId pointed at the folder's node).
    case 'project-dashboard':
      return <Canvas />
    case 'task':
      return <Canvas />
    case 'connected-app':
      return <ConnectedAppView appId={view.appId} />
    case 'vault':
      return <VaultView />
    case 'calendar':
      return <CalendarView />
    case 'messages':
      return <FlowView />
    case 'inbox':
      return <InboxView />
    case 'mail':
      return <MailView />
    case 'documents':
      return <DocumentsView />
    case 'design':
      return <DesignsView />
    case 'draw':
      return <DrawView />
    case 'document':
      return <DocumentOpen documentId={view.documentId} />
    case 'livedoc':
      return <LiveDocEditorView liveDocId={view.liveDocId} />
    case 'livefolder':
      return <LiveFolderView liveFolderId={view.liveFolderId} />
    case 'collaborations':
      return <CollaborationsView />
    case 'insights':
      return <InsightsView />
    case 'files':
      return <FilesView />
    case 'organization':
      return <OrgAdminView />
    case 'people-map':
      return <PeopleMapView />
    case 'suite':
      return <PlexiSuiteHome />
    case 'product':
      return <ProductHome productKey={view.productKey} />
    case 'knowledge':
      return <KnowledgeView />
    case 'meetings':
      return <PlexiMeetView />
    case 'apps':
      return <PlexiBuildView />
    case 'forms':
      return <PlexiFormsView />
    case 'sign':
      return <PlexiSignView />
    case 'search':
      return <PlexiSearchView />
    case 'projects':
      return <PlexiProjectsView />
    case 'reports':
      return <PlexiReportsView />
    case 'flows':
      return <PlexiFlowView />
    case 'api':
      return <PlexiApiView />
    case 'marketplace':
      return <PlexiMarketplaceView />
    case 'mdext':
      return <ExternalMdEditorView path={view.path} />
    case 'plexii':
      return <PlexiiHubView />
    default:
      return <HomeDashboard />
  }
}
