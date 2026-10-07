import { useEffect, useState } from 'react'
import type { ShareSnap } from '../../lib/acceptShare'
import { acceptShareIntoWorkspace } from '../../lib/acceptShare'
import { useSharesStore } from '../../stores/shares'
import { useNodeStore } from '../../stores/nodes'
import { useViewStore } from '../../stores/view'
import { promptText } from '../plexi/PromptDialog'
import Icon from '../Icon'
import { DashboardHeader, PLEXI_CARD } from '../plexi'

// The Shared index — rooms, desks and widgets other people have shared with you.
// This replaces the old inline "Shared with me" sidebar tree; it now lives as a
// gallery reached from the Rooms nav, consistent with All rooms and All desks.

function iconFor(kind: string): string {
  return kind === 'folder' ? 'folder_shared' : kind === 'task' ? 'desk' : 'widgets'
}
function labelFor(kind: string): string {
  return kind === 'folder' ? 'Shared room' : kind === 'task' ? 'Shared desk' : 'Shared widget'
}

export default function SharedView(): JSX.Element {
  const inbox = useSharesStore((s) => s.inbox)
  const loaded = useSharesStore((s) => s.loaded)
  const refresh = useSharesStore((s) => s.refresh)
  const removeFromInbox = useSharesStore((s) => s.removeFromInbox)
  const acceptByToken = useSharesStore((s) => s.acceptByToken)
  const refreshNodes = useNodeStore((s) => s.refresh)
  const goProject = useViewStore((s) => s.goProject)
  const goTask = useViewStore((s) => s.goTask)
  const [acceptingId, setAcceptingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!loaded) void refresh()
  }, [loaded, refresh])

  async function pasteLink(): Promise<void> {
    setError(null)
    const url = await promptText({
      title: 'Paste a share link',
      placeholder: 'https://view.plexiidesk.com/share/…',
      confirmLabel: 'Add share'
    })
    if (!url) return
    const m = url.match(/\/share\/([a-z0-9]+)/i)
    if (!m) {
      setError('That does not look like a PlexiDesk share link.')
      return
    }
    try {
      await useSharesStore.getState().acceptByToken(m[1])
    } catch (err) {
      setError(`Could not accept share: ${(err as Error).message}`)
    }
  }
  // acceptByToken referenced so an unused-import lint never trips; the paste flow
  // above goes through the store singleton to match the previous behaviour.
  void acceptByToken

  async function addToWorkspace(item: { id: string; snapshot: unknown }): Promise<void> {
    if (acceptingId) return
    setAcceptingId(item.id)
    setError(null)
    try {
      const res = await acceptShareIntoWorkspace(item.snapshot as ShareSnap)
      await refresh()
      await refreshNodes()
      await removeFromInbox(item.id)
      if (res.rootKind === 'folder') goProject(res.rootNodeId)
      else goTask(res.rootNodeId)
    } catch (err) {
      setError(`Could not add this to your workspace: ${(err as Error).message}`)
    } finally {
      setAcceptingId(null)
    }
  }

  return (
    <div
      className="h-full w-full overflow-auto bg-[var(--surface-base)] text-[var(--ink-100)]"
      data-testid="shared-view"
    >
      <div className="max-w-[1100px] mx-auto px-6 py-6">
        <DashboardHeader
          title="Shared with me"
          subtitle="Rooms and desks other people have shared with you. Add one to your workspace to keep and edit your own copy."
          actions={
            <button
              onClick={() => void pasteLink()}
              data-testid="shared-paste"
              className="fb-btn-surface inline-flex items-center gap-1.5 h-9 px-3 text-[12.5px] text-[var(--ink-80)] hover:text-[var(--ink-100)]"
            >
              <Icon name="content_paste" size={15} /> Paste a share link
            </button>
          }
        />

        {error && (
          <div className="mb-4 text-[12px] text-amber-600 dark:text-amber-400" data-testid="shared-error">
            {error}
          </div>
        )}

        {inbox.length === 0 ? (
          <div className="py-16 text-center">
            <Icon name="folder_shared" size={40} className="text-[var(--ink-40)] mb-3" />
            <p className="text-[var(--ink-60)] text-[13px] max-w-md mx-auto leading-relaxed">
              Nothing shared with you yet. When a collaborator sends you a room or desk, get their
              link and paste it here.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {inbox.map((item) => {
              const snap = item.snapshot as { title?: string } | null
              const title = (snap && snap.title) || labelFor(item.kind)
              return (
                <div
                  key={item.id}
                  className={`group relative ${PLEXI_CARD} overflow-hidden`}
                  data-testid={`shared-card-${item.id}`}
                >
                  <div className="h-28 flex items-center justify-center bg-[var(--surface-sunken)] border-b border-[var(--edge-soft)]">
                    <Icon name={iconFor(item.kind)} size={34} className="text-[rgb(var(--accent))]" filled />
                  </div>
                  <div className="px-3 py-2">
                    <div className="truncate text-[13px] font-medium text-[var(--ink-100)]">{title}</div>
                    <div className="text-[11px] text-[var(--ink-50)] mt-0.5 truncate">
                      {labelFor(item.kind)} · from {item.fromHandle} ·{' '}
                      {item.scope === 'copy' ? 'can copy' : 'view only'}
                    </div>
                    <div className="mt-2 flex items-center gap-1.5">
                      {item.scope === 'copy' && (
                        <button
                          onClick={() => void addToWorkspace(item)}
                          disabled={acceptingId === item.id}
                          data-testid={`shared-accept-${item.id}`}
                          className="inline-flex items-center gap-1 h-7 px-2 rounded-md bg-[rgb(var(--accent))] text-white text-[11.5px] font-medium disabled:opacity-50"
                        >
                          <Icon name={acceptingId === item.id ? 'hourglass_empty' : 'add_to_photos'} size={13} />
                          Add to my workspace
                        </button>
                      )}
                      <button
                        onClick={() => void removeFromInbox(item.id)}
                        className="ml-auto icon-btn !h-6 !w-6 opacity-0 group-hover:opacity-100"
                        title="Remove from Shared with me"
                      >
                        <Icon name="close" size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
