import { useState } from 'react'
import type { FbNode } from '@shared/types'
import { useViewStore } from '../stores/view'
import { useNodeStore } from '../stores/nodes'
import ShareDialog from './ShareDialog'
import Icon from './Icon'
import { StatusPill } from './plexi'
import ContextHealthStrip from './ContextHealthStrip'

interface Props {
  project: FbNode
  scope: 'project' | 'global'
  activeTab: WorkspaceTab
  onTabChange: (tab: WorkspaceTab) => void
}

export type WorkspaceTab =
  | 'overview'
  | 'tasks'
  | 'notes'
  | 'files'
  | 'calendar'
  | 'activity'

const TABS: Array<{ id: WorkspaceTab; label: string; icon: string }> = [
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'tasks', label: 'Tasks', icon: 'checklist' },
  { id: 'notes', label: 'Notes', icon: 'sticky_note_2' },
  { id: 'files', label: 'Files', icon: 'folder' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar_month' },
  { id: 'activity', label: 'Activity', icon: 'history' }
]

// WorkspaceHeader — the strip at the top of a project view in the 2.0
// mockup. Renders title + Private chip + Focus Mode + members + Share
// button, then a tabs row underneath. Tabs filter the view: Overview
// shows the full dashboard, Tasks/Notes/Files filter the dashboard to
// surface only matching cards, Calendar jumps to the calendar view
// scoped to this project, Activity opens the recent-activity feed.
//
// Per the user's rule (no deprecation), every existing surface stays
// reachable — this header is purely additive on the project view, and
// not used at all on the home view (home doesn't have a project to
// brand).
export default function WorkspaceHeader({
  project,
  activeTab,
  onTabChange
}: Props): JSX.Element {
  const [shareOpen, setShareOpen] = useState(false)
  const goCalendar = useViewStore((s) => s.goCalendar)
  const setActiveTask = useNodeStore((s) => s.setActive)

  // Project description lives in node.description (already present in
  // the schema). Falls back to a calm one-liner so the strip never
  // looks empty.
  const description =
    (project as unknown as { description?: string | null }).description ||
    'Drop tasks, pin connected apps, and shape this space into the workspace this project deserves.'

  return (
    <>
      <div className="border-b border-[var(--edge-soft)] fb-glass-chrome px-6 py-4">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-xl font-semibold fb-display text-[var(--ink-100)] truncate">
                {project.title || '(untitled project)'}
              </h1>
              <StatusPill tone="offline" label="Private" />
            </div>
            <p className="text-[12px] text-[var(--ink-70)] leading-relaxed line-clamp-2 max-w-3xl">
              {description}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <MemberAvatars />
            <button
              onClick={() => setShareOpen(true)}
              className="btn-ghost !text-[12px]"
              title="Share this project"
            >
              <Icon name="share" size={13} />
              <span>Share</span>
            </button>
            <button
              onClick={() => {
                // Focus mode = jump into the project's first task and
                // expand it. If no task exists, scroll-anchor stays here.
                const firstTask = useNodeStore
                  .getState()
                  .nodes.find(
                    (n) => n.parentId === project.id && n.kind === 'task' && !n.archived
                  )
                if (firstTask) {
                  setActiveTask(firstTask.id)
                  useViewStore.getState().goTask(firstTask.id)
                }
              }}
              className="btn-primary !text-[12px]"
              title="Open the project's most actionable task"
            >
              <Icon name="center_focus_strong" size={13} />
              <span>Focus Mode</span>
            </button>
          </div>
        </div>
        {/* Context Health: what changed since last visit + related-desk health */}
        <ContextHealthStrip deskId={project.id} />
        {/* Tabs */}
        <div className="mt-3 flex items-center gap-0.5 -mb-1">
          {TABS.map((t) => {
            const active = activeTab === t.id
            return (
              <button
                key={t.id}
                onClick={() => {
                  if (t.id === 'calendar') {
                    goCalendar()
                    return
                  }
                  onTabChange(t.id)
                }}
                className={`relative px-3 py-1.5 inline-flex items-center gap-1.5 text-[12px] transition-colors ${
                  active
                    ? 'text-accent font-medium'
                    : 'text-[var(--ink-70)] hover:text-[var(--ink-100)]'
                }`}
              >
                <Icon name={t.icon} size={12} className={active ? 'text-accent' : ''} />
                <span>{t.label}</span>
                {active && (
                  <span className="absolute bottom-[-1px] left-2 right-2 h-[2px] rounded-full bg-accent" />
                )}
              </button>
            )
          })}
        </div>
      </div>
      {shareOpen && (
        <ShareDialog
          kind="folder"
          entityId={project.id}
          label={project.title || '(untitled project)'}
          onClose={() => setShareOpen(false)}
        />
      )}
    </>
  )
}

// Pseudonymous member-avatar stack. In v1 every project is a solo
// workspace; the avatars are placeholders representing accepted shares
// (when the cloud-share path lands). For now we render a single avatar
// for the current user — it's still better than an empty row and keeps
// the visual rhythm of the mockup.
function MemberAvatars(): JSX.Element {
  // Hard-coded count of 1 for now (just the user). When shares-with-real-
  // accounts ship, replace with the deduped accepted-share count.
  return (
    <div className="flex items-center -space-x-1.5">
      <div
        className="h-6 w-6 rounded-full bg-accent/20 border-2 border-[var(--surface-raised)] inline-flex items-center justify-center text-[9px] font-medium text-accent"
        title="You"
      >
        Y
      </div>
    </div>
  )
}
