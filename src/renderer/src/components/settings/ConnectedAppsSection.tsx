import { useEffect, useState } from 'react'
import Icon from '../Icon'
import { useConnectedAppsStore } from '../../stores/connectedApps'
import AddConnectedAppDialog from '../AddConnectedAppDialog'

// Managing connected apps, in Settings.
//
// The sidebar still lists them, but only while a desk is open — the rows there
// exist to be DRAGGED onto a canvas, so anywhere else they are a list you
// cannot use. Adding, removing and pinning are not canvas actions though, and
// they have to be reachable when no desk is open, which is what this is for.

export default function ConnectedAppsSection(): JSX.Element {
  const apps = useConnectedAppsStore((s) => s.apps)
  const loaded = useConnectedAppsStore((s) => s.loaded)
  const refresh = useConnectedAppsStore((s) => s.refresh)
  const remove = useConnectedAppsStore((s) => s.remove)
  const togglePinned = useConnectedAppsStore((s) => s.togglePinned)
  const [addOpen, setAddOpen] = useState(false)

  useEffect(() => {
    if (!loaded) void refresh()
  }, [loaded, refresh])

  return (
    <section className="px-3 py-3 space-y-2" data-testid="settings-connected-apps">
      <div className="flex items-center justify-between">
        <div className="fb-t-caption uppercase tracking-[0.12em] font-medium">Connected apps</div>
        <button
          onClick={() => setAddOpen(true)}
          data-testid="settings-connected-apps-add"
          className="icon-btn !h-5 !w-5"
          title="Add a connected app"
        >
          <Icon name="add" size={12} />
        </button>
      </div>

      {apps.length === 0 ? (
        // Honest empty state: no sample apps, no pretend integrations.
        <p className="text-[12px] text-[var(--ink-50)]" data-testid="settings-connected-apps-empty">
          No connected apps yet. Add one and it can be dragged onto any desk.
        </p>
      ) : (
        <div className="space-y-0.5">
          {apps.map((app) => (
            <div
              key={app.id}
              data-testid={`settings-connected-app-${app.id}`}
              className="flex items-center gap-2 px-1.5 py-1 rounded-[var(--radius-row)] hover:bg-[var(--surface-sunken)]"
            >
              <Icon
                name={app.kind === 'local' ? 'desktop_windows' : 'public'}
                size={13}
                className="shrink-0 text-[var(--ink-50)]"
              />
              <span className="flex-1 min-w-0 truncate text-[12px] text-[var(--ink-80)]">
                {app.title}
              </span>
              <button
                onClick={() => void togglePinned(app.id)}
                className="icon-btn !h-5 !w-5"
                title={app.pinned ? 'Unpin from the sidebar' : 'Pin to the sidebar'}
                aria-pressed={app.pinned}
              >
                <Icon name="push_pin" size={11} filled={app.pinned} />
              </button>
              <button
                onClick={() => void remove(app.id)}
                className="icon-btn !h-5 !w-5"
                title={`Remove ${app.title}`}
              >
                <Icon name="delete" size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {addOpen && <AddConnectedAppDialog onClose={() => setAddOpen(false)} />}
    </section>
  )
}
