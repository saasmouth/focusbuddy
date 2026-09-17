import { useViewStore } from '../stores/view'
import Canvas from './Canvas'
import HomeDashboard from './views/HomeDashboard'
import AllTasksView from './views/AllTasksView'
import RoomsView from './views/RoomsView'
import DesksView from './views/DesksView'
import SharedView from './views/SharedView'
import TrashView from './views/TrashView'
import AttentionView from './views/AttentionView'
import ConnectedAppView from './views/ConnectedAppView'
import VaultView from './views/VaultView'
import CalendarView from './views/CalendarView'
import FlowView from './views/FlowView'
import InboxView from './views/InboxView'
import MailView from './views/MailView'
import DocumentsView from './views/DocumentsView'
import DesignsView from './views/DesignsView'
import DrawView from './views/DrawView'
import DocumentOpen from './views/DocumentOpen'
import LiveDocEditorView from './views/LiveDocEditorView'
import LiveFolderView from './views/LiveFolderView'
import CollaborationsView from './views/CollaborationsView'
import InsightsView from './views/InsightsView'
import FilesView from './views/FilesView'
import OrgAdminView from './views/OrgAdminView'
import PeopleMapView from './views/PeopleMapView'
import PlexiSignView from './views/PlexiSignView'
import PlexiSuiteHome from './suite/PlexiSuiteHome'
import ProductHome from './suite/ProductHome'
import KnowledgeView from './views/KnowledgeView'
import PlexiMeetView from './views/PlexiMeetView'
import PlexiBuildView from './views/PlexiBuildView'
import PlexiFormsView from './views/PlexiFormsView'
import PlexiSearchView from './views/PlexiSearchView'
import PlexiProjectsView from './views/PlexiProjectsView'
import PlexiReportsView from './views/PlexiReportsView'
import PlexiFlowView from './views/PlexiFlowView'
import PlexiApiView from './views/PlexiApiView'
import PlexiMarketplaceView from './views/PlexiMarketplaceView'
import ExternalMdEditorView from './views/ExternalMdEditorView'
import PlexiiHubView from './views/PlexiiHubView'
import CapabilityGate from './CapabilityGate'
import PageEnter from './chrome/pageEnter'
import { VIEW_CAPABILITY } from '../lib/viewCapability'
import type { View } from '../stores/view'

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
  return <PageEnter id={JSON.stringify(view)}>{renderView(view)}</PageEnter>
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
