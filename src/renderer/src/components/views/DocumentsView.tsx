import { useEffect, useRef, useState } from 'react'
import { confirmDialog } from '../plexi/PromptDialog'
import type { DocType } from '@shared/types'
import { useDocumentsStore } from '../../stores/documents'
import { useViewStore } from '../../stores/view'
import { useAccountStore } from '../../stores/account'
import { createLiveDoc } from '../../lib/docCollabClient'
import Icon from '../Icon'
import { DashboardHeader } from '../plexi'
import DocFiledInChip from '../DocFiledInChip'
import { setDocDrag } from '../../lib/docMetaCache'

// Documents hub — the home for office files. The top panel is the AI-first
// create flow: pick what you are making, say what it is about and who it is
// for, and PlexiDesk hands you a finished first draft already open for editing.
// Below it are your recent documents, and a quiet "start blank" path for the
// times you want the empty page.

const TYPES: { type: DocType; label: string; icon: string; blurb: string }[] = [
  { type: 'doc', label: 'Document', icon: 'description', blurb: 'Writeups, briefs, proposals' },
  { type: 'sheet', label: 'Spreadsheet', icon: 'table_chart', blurb: 'Plans, budgets, trackers' },
  { type: 'slides', label: 'Slides', icon: 'slideshow', blurb: 'Decks and presentations' },
  { type: 'map', label: 'Map', icon: 'account_tree', blurb: 'Flowcharts and workflow maps' }
]

function typeIcon(t: DocType): string {
  return TYPES.find((x) => x.type === t)?.icon ?? 'description'
}

function relTime(ms: number): string {
  const d = Date.now() - ms
  const mins = Math.round(d / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  return `${days}d ago`
}

export default function DocumentsView(): JSX.Element {
  const list = useDocumentsStore((s) => s.list)
  const trashed = useDocumentsStore((s) => s.trashed)
  const refresh = useDocumentsStore((s) => s.refresh)
  const refreshTrashed = useDocumentsStore((s) => s.refreshTrashed)
  const createWithAI = useDocumentsStore((s) => s.createWithAI)
  const createBlank = useDocumentsStore((s) => s.createBlank)
  const importMap = useDocumentsStore((s) => s.importMap)
  const remove = useDocumentsStore((s) => s.remove)
  const restore = useDocumentsStore((s) => s.restore)
  const purge = useDocumentsStore((s) => s.purge)
  const goDocument = useViewStore((s) => s.goDocument)
  const goLiveDoc = useViewStore((s) => s.goLiveDoc)
  const token = useAccountStore((s) => s.sessionToken)

  const [docType, setDocType] = useState<DocType>('doc')
  const [prompt, setPrompt] = useState('')
  const [audience, setAudience] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const [showTrash, setShowTrash] = useState(false)

  useEffect(() => {
    void refresh()
    void refreshTrashed()
    // Backfill document embeddings so "ask your workspace" grounds by meaning.
    // Best-effort and silent: with no embedding key it is a no-op and grounding
    // stays keyword-based.
    void window.api.documents.reindex()
  }, [refresh, refreshTrashed])

  // Turn a local document into a live, shared one and open it. Its current body
  // becomes the server-canonical copy; from there members co-edit it in real
  // time, merging changes rather than taking turns.
  // Once live, it appears in the dedicated Collaborations section.
  async function collaborate(id: string): Promise<void> {
    if (!token) {
      setError('Sign in to collaborate on a document.')
      return
    }
    const full = await window.api.documents.get(id)
    if (!full) return
    const created = await createLiveDoc(token, {
      docType: full.docType,
      title: full.title,
      body: JSON.stringify(full.body)
    })
    if (created) {
      goLiveDoc(created.id)
    } else {
      setError('Could not start collaboration. Check your connection and that you are signed in.')
    }
  }

  async function create(): Promise<void> {
    if (!prompt.trim()) return
    setBusy(true)
    setError(null)
    const r = await createWithAI({ docType, prompt: prompt.trim(), audience: audience.trim() || undefined })
    setBusy(false)
    if (!r.ok) {
      setError(
        r.needsApiKey
          ? 'Add your Anthropic API key in Settings → AI to create with AI. You can still start blank.'
          : r.error || 'Could not create that.'
      )
      return
    }
    setPrompt('')
    setAudience('')
    if (r.id) goDocument(r.id)
  }

  async function blank(t: DocType): Promise<void> {
    const doc = await createBlank(t)
    goDocument(doc.id)
  }

  async function importVisio(): Promise<void> {
    setError(null)
    const r = await importMap()
    if (r.ok && r.id) goDocument(r.id)
    else if (r.error) setError(r.error)
  }

  const verb = docType === 'doc' ? 'document' : docType === 'sheet' ? 'spreadsheet' : 'deck'

  return (
    // Token surface, not desk-paper: atelier forces desk-paper to cream while its
    // ink ramp is light-on-navy, so token text on paper is invisible there. The
    // index views (the reference) render on --surface-base for exactly this reason.
    <div className="h-full overflow-auto bg-[var(--surface-base)] text-[var(--ink-100)]">
      <div className="w-full px-6 py-8">
        <DashboardHeader
          title="Documents"
          subtitle="Start with AI and get a real first draft, then make it yours. Documents, spreadsheets and slides, all in your workspace."
        />

        {/* Create with AI */}
        <div className="fb-card fb-fade-in-up p-5 mb-8">
          <div className="flex gap-2 mb-4">
            {TYPES.map((t) => (
              <button
                key={t.type}
                onClick={() => setDocType(t.type)}
                className={`flex-1 rounded-[var(--radius-row)] border p-3 text-left fb-press transition-colors ${
                  docType === t.type
                    ? 'border-accent bg-accent/[0.06]'
                    : 'border-[var(--edge-soft)] hover:border-[rgb(var(--accent)/0.5)]'
                }`}
              >
                <Icon name={t.icon} size={20} className={docType === t.type ? 'text-accent' : 'text-[var(--ink-40)]'} />
                <div className="fb-t-body font-medium text-[var(--ink-100)] mt-1.5">{t.label}</div>
                <div className="fb-t-caption">{t.blurb}</div>
              </button>
            ))}
          </div>

          <textarea
            ref={promptRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void create()
            }}
            placeholder={`Describe the ${verb} you want. For example: a one-page launch plan for our new pricing, with goals, timeline and risks.`}
            rows={3}
            className="fb-field fb-t-body px-3.5 py-2.5 resize-none"
          />
          <div className="flex items-center gap-2 mt-3">
            <input
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              placeholder="Who is it for? (optional)"
              className="fb-field fb-t-body flex-1"
            />
            <button onClick={() => void create()} disabled={busy || !prompt.trim()} className="btn-primary shrink-0">
              <Icon name="auto_awesome" size={15} />
              {busy ? 'Creating…' : 'Create with AI'}
            </button>
          </div>
          {error && <div className="fb-t-label text-rose-500 mt-2">{error}</div>}

          <div className="mt-3 pt-3 border-t border-[var(--edge-soft)] flex items-center gap-3 fb-t-label text-[var(--ink-50)]">
            <span>Or start blank:</span>
            {TYPES.map((t) => (
              <button key={t.type} onClick={() => void blank(t.type)} className="inline-flex items-center gap-1 fb-press hover:text-accent">
                <Icon name={t.icon} size={13} />
                {t.label}
              </button>
            ))}
            <span className="w-px h-3.5 bg-[var(--edge-soft)]" />
            <button
              onClick={() => void importVisio()}
              className="inline-flex items-center gap-1 fb-press hover:text-accent"
              data-testid="documents-import-vsdx"
              title="Import a Microsoft Visio diagram (.vsdx)"
            >
              <Icon name="upload_file" size={13} />
              Import Visio
            </button>
          </div>
        </div>

        {/* Recent */}
        <h2 className="fb-t-caption uppercase tracking-[0.1em] font-semibold mb-2">Recent</h2>
        {list.length === 0 ? (
          <div className="py-10 text-center rounded-[var(--radius-card)] border border-dashed border-[var(--edge-firm)]">
            <Icon name="description" size={26} className="text-[var(--ink-30)] mx-auto" />
            <p className="fb-t-body text-[var(--ink-50)] mt-2">No documents yet.</p>
            <button
              onClick={() => promptRef.current?.focus()}
              className="mt-3 inline-flex items-center gap-1.5 h-8 px-3 fb-btn-surface fb-press fb-t-label text-[var(--ink-90)]"
            >
              <Icon name="auto_awesome" size={14} /> Start writing
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {list.map((d, i) => (
              <div
                key={d.id}
                draggable
                onDragStart={(e) => setDocDrag(e, { id: d.id, docType: d.docType, title: d.title })}
                onClick={() => goDocument(d.id)}
                style={{ animationDelay: `${Math.min(i * 35, 350)}ms` }}
                className="group flex items-center gap-3 fb-tile fb-press fb-lift fb-fade-in-up px-3.5 py-3 cursor-pointer"
              >
                <div className="h-9 w-9 rounded-[var(--radius-chip)] bg-accent/10 text-accent inline-flex items-center justify-center shrink-0">
                  <Icon name={typeIcon(d.docType)} size={17} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="fb-t-body font-medium text-[var(--ink-100)] truncate">{d.title}</div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="fb-t-caption">Edited {relTime(d.updatedAt)}</span>
                    <span onClick={(e) => e.stopPropagation()}>
                      <DocFiledInChip docId={d.id} compact />
                    </span>
                  </div>
                </div>
                <div className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 flex items-center gap-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      void collaborate(d.id)
                    }}
                    className="text-[var(--ink-40)] hover:text-accent p-1.5 fb-press"
                    title="Collaborate (share live)"
                    data-testid="doc-collaborate"
                  >
                    <Icon name="group_add" size={15} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      // Recoverable: lands in the Trash below, with an Undo toast.
                      void remove(d.id)
                    }}
                    className="text-[var(--ink-40)] hover:text-rose-500 p-1.5 fb-press focus-visible:opacity-100"
                    title="Move to trash (recoverable below)"
                  >
                    <Icon name="delete" size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {/* Live, shared documents now live in their own Collaborations section. */}

        {/* Trash — soft-deleted documents. Restore any time, or delete forever. */}
        {trashed.length > 0 && (
          <div className="mt-6">
            <button
              onClick={() => setShowTrash((v) => !v)}
              className="inline-flex items-center gap-1.5 fb-t-body font-semibold text-[var(--ink-50)] hover:text-[var(--ink-90)] fb-press"
              aria-expanded={showTrash}
            >
              <Icon name={showTrash ? 'expand_more' : 'chevron_right'} size={15} />
              Trash ({trashed.length})
            </button>
            {showTrash && (
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                {trashed.map((d) => (
                  <div
                    key={d.id}
                    className="flex items-center gap-3 rounded-[var(--radius-row)] border-dashed bg-[var(--surface-sunken)] px-3.5 py-3"
                  >
                    <div className="h-9 w-9 rounded-[var(--radius-chip)] bg-[var(--surface-base)] text-[var(--ink-40)] inline-flex items-center justify-center shrink-0">
                      <Icon name={typeIcon(d.docType)} size={17} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="fb-t-body font-medium text-[var(--ink-50)] truncate line-through decoration-[var(--edge-firm)]">
                        {d.title}
                      </div>
                      <div className="fb-t-caption">In trash</div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => void restore(d.id)}
                        className="text-[var(--ink-40)] hover:text-accent p-1.5 fb-press"
                        title="Restore"
                        data-testid="doc-restore"
                      >
                        <Icon name="restore_from_trash" size={15} />
                      </button>
                      <button
                        onClick={() => {
                          void confirmDialog({
                            title: `Delete "${d.title}" forever?`,
                            body: 'This removes it permanently, including from the cloud mirror. It cannot be undone.',
                            confirmLabel: 'Delete forever',
                            danger: true
                          }).then((ok) => {
                            if (ok) void purge(d.id)
                          })
                        }}
                        className="text-[var(--ink-40)] hover:text-rose-500 p-1.5 fb-press"
                        title="Delete forever"
                        data-testid="doc-purge"
                      >
                        <Icon name="delete_forever" size={15} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
