import { useEffect, useState } from 'react'
import { useViewStore } from '../../stores/view'
import { useAccountStore } from '../../stores/account'
import { useSignInPrompt } from '../../stores/signInPrompt'
import { listLiveDocs, type LiveDocListItem } from '../../lib/docCollabClient'
import { convertLiveCanvasToDesk } from '../../lib/liveCanvasMigrate'
import Icon from '../Icon'
import { PlexiiChipIcon } from '../PlexiiIcon'
import { docTypeEntity } from '../../lib/plexiiIconMap'

// Collaborations — the home for everything shared LIVE with you: desks
// (canvases), folders, and documents under the check-out model. Its own
// top-level destination, like PlexiInbox and Documents, rather than buried in a
// Documents sub-list. Clicking a row opens the live item in its collaborative
// editor.

function kindMeta(t: string): { icon: string; label: string } {
  switch (t) {
    case 'canvas':
      return { icon: 'space_dashboard', label: 'Desk' }
    case 'folder':
      return { icon: 'folder_shared', label: 'Folder' }
    case 'sheet':
      return { icon: 'table_chart', label: 'Spreadsheet' }
    case 'slides':
      return { icon: 'slideshow', label: 'Slides' }
    default:
      return { icon: 'description', label: 'Document' }
  }
}

function relTime(ms: number): string {
  const d = Date.now() - ms
  const mins = Math.round(d / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

export default function CollaborationsView(): JSX.Element {
  const token = useAccountStore((s) => s.sessionToken)
  const account = useAccountStore((s) => s.account)
  const requestSignIn = useSignInPrompt((s) => s.requestOpen)
  const goLiveDoc = useViewStore((s) => s.goLiveDoc)
  const goLiveFolder = useViewStore((s) => s.goLiveFolder)
  const goTask = useViewStore((s) => s.goTask)

  const [items, setItems] = useState<LiveDocListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  async function load(): Promise<void> {
    if (!token) {
      setItems([])
      setLoading(false)
      return
    }
    setLoading(true)
    const docs = await listLiveDocs(token)
    setItems(docs.sort((a, b) => b.updatedAt - a.updatedAt))
    setLoading(false)
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  async function open(d: LiveDocListItem): Promise<void> {
    if (d.docType === 'canvas') {
      // Legacy live canvases convert to a real shared desk on open (the canvas
      // mechanism is retired in favour of shared desks). Navigate to the desk, or
      // surface an honest error if the conversion could not run.
      setErr(null)
      const deskId = token ? await convertLiveCanvasToDesk(d.id, token, account?.id ?? null) : null
      if (deskId) goTask(deskId)
      else setErr('Could not open this shared desk. Check your connection and try again.')
      return
    }
    if (d.docType === 'folder') goLiveFolder(d.id)
    else goLiveDoc(d.id)
  }

  if (!account) {
    return (
      <div className="h-full flex items-center justify-center desk-paper no-tod px-6">
        <div className="text-center max-w-sm">
          <Icon name="group" size={32} className="text-[var(--ink-40)] mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-[var(--ink-100)] mb-1">Collaborations</h1>
          <p className="text-[13px] text-[var(--ink-50)] mb-4">
            Sign in to see the desks, folders and documents shared live with you, and to collaborate
            on them in real time.
          </p>
          <button onClick={() => requestSignIn()} className="btn-primary mx-auto">
            <Icon name="login" size={14} />
            <span>Sign in</span>
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto desk-paper no-tod" data-testid="collaborations-view">
      <div className="max-w-2xl mx-auto px-6 py-6">
        <header className="flex items-center gap-3 mb-4">
          <div className="inline-flex items-center justify-center h-10 w-10 rounded-[var(--radius-row)] bg-[var(--surface-sunken)] shrink-0">
            <Icon name="group" size={20} className="text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold text-[var(--ink-100)]">Collaborations</h1>
            <p className="text-[12px] text-[var(--ink-50)]">
              Desks, folders and documents shared live with you. Open one to work on it together.
            </p>
          </div>
          <button onClick={() => void load()} className="icon-btn" title="Refresh">
            <Icon name="refresh" size={16} />
          </button>
        </header>

        {err && (
          <div className="mb-3 rounded-lg border border-red-300 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-[12px] text-red-700 dark:text-red-300" data-testid="collaborations-error">
            {err}
          </div>
        )}

        {loading ? (
          <div className="text-[13px] text-[var(--ink-40)] px-1 py-8 text-center">Loading…</div>
        ) : items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--edge-firm)] p-10 text-center">
            <Icon name="group" size={26} className="text-[var(--ink-40)] mx-auto mb-2" />
            <p className="text-sm text-[var(--ink-70)]">Nothing shared live yet.</p>
            <p className="text-[12px] text-[var(--ink-50)] mt-1">
              Right-click a desk in the sidebar, or a folder in Files, and choose <em>Collaborate
              live</em> to share it. Anything shared with you shows up here.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" data-testid="collaborations-list">
            {items.map((d) => {
              const meta = kindMeta(d.docType)
              return (
                <div
                  key={d.id}
                  onClick={() => void open(d)}
                  data-testid="collaboration-item"
                  className="fb-card fb-press fb-lift flex items-center gap-3 px-3.5 py-3 cursor-pointer"
                >
                  <PlexiiChipIcon
                    entity={docTypeEntity(d.docType)}
                    fallback={meta.icon}
                    size={36}
                    glyphSize={17}
                    chipClassName="h-9 w-9 rounded-lg bg-accent/10 text-accent inline-flex items-center justify-center shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-[var(--ink-100)] truncate">
                      {d.title || `Untitled ${meta.label.toLowerCase()}`}
                    </div>
                    <div className="text-[11px] text-[var(--ink-40)] truncate">
                      {meta.label} · {relTime(d.updatedAt)}
                    </div>
                  </div>
                  <Icon name="chevron_right" size={16} className="text-[var(--ink-30)] shrink-0" />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
