import SegmentShell from './SegmentShell'
import { appMeta } from '../../lib/segmentApps'
import Canvas from '../Canvas'
import HomeDashboard from '../views/HomeDashboard'
import AllTasksView from '../views/AllTasksView'
import CalendarView from '../views/CalendarView'
import FilesView from '../views/FilesView'
import OrgAdminView from '../views/OrgAdminView'
import PlexiProjectsView from '../views/PlexiProjectsView'
import AgenticOpsView from '../views/AgenticOpsView'
import RecentView from '../views/RecentView'
import KnowledgeView from '../views/KnowledgeView'
import PlexiSearchView from '../views/PlexiSearchView'
import BrainMapView from '../views/BrainMapView'
import DecisionsView from '../views/DecisionsView'
import AssembleDeskView from '../views/AssembleDeskView'
import PlexiFlowView from '../views/PlexiFlowView'
import AgentsView from '../views/AgentsView'
import ConnectedAppsHubView from '../views/ConnectedAppsHubView'
import PlexiApiView from '../views/PlexiApiView'
import InsightsView from '../views/InsightsView'
import PeopleHomeView from '../views/PeopleHomeView'
import PeopleMapView from '../views/PeopleMapView'
import { useViewKindEnabled } from '../../lib/viewCapability'
import type { SegmentApp } from './SegmentShell'

// A segment app plus the view kind it stands in for, so we can hide the entry
// when that surface is gated off, using the same map MainPane enforces. Apps
// without a gateKind are core and always shown.
type GatedApp = SegmentApp & { gateKind?: string }

function visibleApps(apps: GatedApp[], enabled: (kind: string) => boolean): SegmentApp[] {
  return apps.filter((a) => !a.gateKind || enabled(a.gateKind))
}

// The four top-level segments. Each is a focused area with its own side menu
// and a home of app tiles, reusing the existing views inline (so the segment
// menu stays put as you move between its apps). PlexiOffice is the third segment
// and keeps its own richer shell (PlexiOfficeShell) because of its document
// create/open affordances.

export function PlexiDeskShell({ initialApp }: { initialApp?: string } = {}): JSX.Element {
  const enabled = useViewKindEnabled()
  const apps: GatedApp[] = [
    { ...appMeta('plexidesk', 'home'), blurb: 'Your dashboard and what is next', tint: 'bg-indigo-500', tone: 'text-indigo-500', render: () => <HomeDashboard /> },
    { ...appMeta('plexidesk', 'desk'), blurb: 'The working canvas you build on', tint: 'bg-sky-500', tone: 'text-sky-500', render: () => <Canvas /> },
    { ...appMeta('plexidesk', 'workspaces'), blurb: 'Organisations and sub-workspaces', tint: 'bg-teal-500', tone: 'text-teal-500', render: () => <OrgAdminView />, gateKind: 'organization' },
    { ...appMeta('plexidesk', 'plans'), blurb: 'Timelines, milestones and Gantt charts', tint: 'bg-violet-500', tone: 'text-violet-500', render: () => <PlexiProjectsView /> },
    { ...appMeta('plexidesk', 'ops'), blurb: 'Your agent workforce: triage, proposals and boardrooms', tint: 'bg-cyan-600', tone: 'text-cyan-600', render: () => <AgenticOpsView /> },
    { ...appMeta('plexidesk', 'tasks'), blurb: 'Every desk across your rooms, in one list', tint: 'bg-emerald-500', tone: 'text-emerald-500', render: () => <AllTasksView /> },
    { ...appMeta('plexidesk', 'calendar'), blurb: 'Your work by date', tint: 'bg-amber-500', tone: 'text-amber-500', render: () => <CalendarView />, gateKind: 'calendar' },
    { ...appMeta('plexidesk', 'files'), blurb: 'Every file in your workspace', tint: 'bg-orange-500', tone: 'text-orange-500', render: () => <FilesView />, gateKind: 'files' },
    { ...appMeta('plexidesk', 'recent'), blurb: 'Documents you last opened', tint: 'bg-rose-500', tone: 'text-rose-500', render: () => <RecentView /> }
  ]
  return (
    <SegmentShell
      initialApp={initialApp}
      def={{
        kind: 'plexidesk',
        wordmark: 'PLEXIDESK',
        title: 'PlexiDesk',
        subtitle: 'Your workspace. Your desk, plans, tasks, calendar and files in one place.',
        icon: 'desktop_windows',
        apps: visibleApps(apps, enabled)
      }}
    />
  )
}

export function PlexiPeopleShell({ initialApp }: { initialApp?: string } = {}): JSX.Element {
  const enabled = useViewKindEnabled()
  const apps: GatedApp[] = [
    { ...appMeta('plexipeople', 'home'), blurb: 'Team status and who is around', tint: 'bg-indigo-500', tone: 'text-indigo-500', render: () => <HomeDashboard surface="people" /> },
    { ...appMeta('plexipeople', 'directory'), blurb: 'Everyone in your workspace', tint: 'bg-sky-500', tone: 'text-sky-500', render: () => <PeopleHomeView /> },
    { ...appMeta('plexipeople', 'workspaces'), blurb: 'Members, roles, offices and profiles', tint: 'bg-teal-500', tone: 'text-teal-500', render: () => <OrgAdminView />, gateKind: 'organization' },
    { ...appMeta('plexipeople', 'map'), blurb: 'Everyone by office and reporting line', tint: 'bg-violet-500', tone: 'text-violet-500', render: () => <PeopleMapView />, gateKind: 'people-map' }
  ]
  return (
    <SegmentShell
      initialApp={initialApp}
      def={{
        kind: 'plexipeople',
        wordmark: 'PLEXIPEOPLE',
        title: 'PlexiPeople',
        subtitle: 'Your team. Who is here, the people directory and your organisation map.',
        icon: 'groups',
        apps: visibleApps(apps, enabled)
      }}
    />
  )
}

export function PlexiBrainShell({ initialApp }: { initialApp?: string } = {}): JSX.Element {
  return (
    <SegmentShell
      initialApp={initialApp}
      def={{
        kind: 'plexibrain',
        wordmark: 'PLEXIBRAIN',
        title: 'PlexiBrain',
        subtitle: 'Your knowledge, search, automation and insights, with AI woven through.',
        icon: 'neurology',
        apps: [
          { ...appMeta('plexibrain', 'home'), blurb: 'Your dashboard for what the workspace knows', tint: 'bg-indigo-500', tone: 'text-indigo-500', render: () => <HomeDashboard surface="brain" /> },
      { ...appMeta('plexibrain', 'ask'), blurb: 'Your knowledge base, ask anything', tint: 'bg-indigo-500', tone: 'text-indigo-500', render: () => <KnowledgeView /> },
          { ...appMeta('plexibrain', 'search'), blurb: 'Find anything across your workspace', tint: 'bg-sky-500', tone: 'text-sky-500', render: () => <PlexiSearchView /> },
          { ...appMeta('plexibrain', 'map'), blurb: 'Your knowledge as a linked graph', tint: 'bg-fuchsia-500', tone: 'text-fuchsia-500', render: () => <BrainMapView /> },
          { ...appMeta('plexibrain', 'decisions'), blurb: 'What was decided, and what a change puts at risk', tint: 'bg-red-500', tone: 'text-red-500', render: () => <DecisionsView /> },
          { ...appMeta('plexibrain', 'assemble'), blurb: 'Gather related items into a new desk', tint: 'bg-lime-600', tone: 'text-lime-600', render: () => <AssembleDeskView /> },
          { ...appMeta('plexibrain', 'flows'), blurb: 'Automations that run your work', tint: 'bg-violet-500', tone: 'text-violet-500', render: () => <PlexiFlowView /> },
          { ...appMeta('plexibrain', 'agents'), blurb: 'Standing AI workers on your desks', tint: 'bg-emerald-500', tone: 'text-emerald-500', render: () => <AgentsView /> },
          { ...appMeta('plexibrain', 'connect'), blurb: 'Your connected apps and integrations', tint: 'bg-cyan-500', tone: 'text-cyan-500', render: () => <ConnectedAppsHubView /> },
          { ...appMeta('plexibrain', 'api'), blurb: 'Connect and call external services', tint: 'bg-amber-500', tone: 'text-amber-500', render: () => <PlexiApiView /> },
          { ...appMeta('plexibrain', 'insights'), blurb: 'Dashboards and reporting', tint: 'bg-rose-500', tone: 'text-rose-500', render: () => <InsightsView /> }
        ]
      }}
    />
  )
}
