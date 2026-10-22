import { useState } from 'react'
import {
  ORG_SNIPPET_REACH_NOTE,
  ORG_SNIPPETS_SYNC,
  snippetBodyIsEmpty,
  snippetKindLabel,
  snippetSummary,
  type SnippetBody,
  type SnippetScope
} from '@shared/snippets'
import Icon from '../Icon'
import { useSnippetsStore } from '../../stores/snippets'
import { useOrgStore, PERSONAL_ORG_ID } from '../../stores/org'

// "Save as snippet": name what has been selected and keep it for reuse.
//
// The caller has already turned a selection into a body, so this dialog's job
// is the naming and the scope, plus one honest guard: a body with nothing in it
// is refused here rather than saved as an entry the user cannot later tell
// apart from any other empty one.
//
// Scope is only a real choice outside the personal workspace. In the personal
// workspace there is nobody to share with, so the control is not shown at all
// rather than offered and then quietly ignored.

export interface SaveSnippetDialogProps {
  body: SnippetBody
  /** Suggested name, usually derived from the selection. */
  suggestedName?: string
  /**
   * One line naming what in the selection the snippet will NOT keep, when the
   * surface knows (Cells: conditional formatting, column widths). Saying so at
   * save time is the difference between a known limit and a quiet loss.
   */
  notKept?: string | null
  onSaved?: (id: string) => void
  onClose: () => void
}

export default function SaveSnippetDialog({
  body,
  suggestedName,
  notKept,
  onSaved,
  onClose
}: SaveSnippetDialogProps): JSX.Element {
  const save = useSnippetsStore((s) => s.save)
  const activeOrgId = useOrgStore((s) => s.activeOrgId)
  const canShare = activeOrgId !== PERSONAL_ORG_ID

  const [name, setName] = useState(suggestedName ?? '')
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState('')
  const [scope, setScope] = useState<SnippetScope>('personal')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const empty = snippetBodyIsEmpty(body)

  async function submit(): Promise<void> {
    if (!name.trim()) {
      setError('Give the snippet a name so you can find it later.')
      return
    }
    setBusy(true)
    setError(null)
    const created = await save({
      kind: body.kind,
      name: name.trim(),
      description: description.trim(),
      body,
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      scope: canShare ? scope : 'personal'
    })
    setBusy(false)
    if (!created) {
      setError(useSnippetsStore.getState().error ?? 'The snippet could not be saved.')
      return
    }
    onSaved?.(created.id)
    onClose()
  }

  return (
    <div className="fb-scrim fixed inset-0 z-[60] flex items-center justify-center" onMouseDown={onClose}>
      <div
        className="fb-card w-[min(440px,calc(100vw-32px))] p-4"
        onMouseDown={(e) => e.stopPropagation()}
        data-testid="save-snippet-dialog"
      >
        <div className="mb-3 flex items-center gap-2">
          <Icon name="bookmark_add" size={17} className="text-accent" />
          <h3 className="text-[14px] font-semibold text-[var(--ink-90)]">Save as snippet</h3>
          <button onClick={onClose} className="ml-auto icon-btn" aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>

        {empty ? (
          <div className="rounded-[var(--radius-row)] border border-dashed border-[var(--edge-firm)] p-4 text-[12px] text-[var(--ink-50)]" data-testid="save-snippet-empty">
            There is nothing in the selection to save. Select some content first.
          </div>
        ) : (
          <>
            <div className="mb-2 rounded-[var(--radius-row)] bg-[var(--surface-sunken)] px-2.5 py-1.5">
              <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--ink-40)]">
                {snippetKindLabel(body.kind)}
              </div>
              <div className="truncate text-[12px] text-[var(--ink-70)]" data-testid="save-snippet-preview">
                {snippetSummary({
                  // Only the body matters to the summary; the rest is filled so
                  // the shared helper can be reused rather than reimplemented.
                  id: '',
                  kind: body.kind,
                  name,
                  description: '',
                  body,
                  tags: [],
                  scope: 'personal',
                  orgId: activeOrgId,
                  authorId: null,
                  revision: 1,
                  usageCount: 0,
                  createdAt: 0,
                  updatedAt: 0
                })}
              </div>
            </div>
            {notKept && (
              <div className="mb-2 text-[11px] text-[var(--ink-50)]" data-testid="save-snippet-not-kept">
                {notKept}
              </div>
            )}

            <label className="mb-1 block text-[11px] text-[var(--ink-60)]" htmlFor="snippet-name">
              Name
            </label>
            <input
              id="snippet-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
              }}
              placeholder="Payment terms, Pricing table, Sign-off block…"
              className="fb-field mb-2 w-full px-2 py-1 text-[13px]"
              data-testid="save-snippet-name"
            />

            <label className="mb-1 block text-[11px] text-[var(--ink-60)]" htmlFor="snippet-desc">
              Description <span className="text-[var(--ink-40)]">(optional)</span>
            </label>
            <input
              id="snippet-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="When to use this"
              className="fb-field mb-2 w-full px-2 py-1 text-[12px]"
              data-testid="save-snippet-description"
            />

            <label className="mb-1 block text-[11px] text-[var(--ink-60)]" htmlFor="snippet-tags">
              Tags <span className="text-[var(--ink-40)]">(comma separated, optional)</span>
            </label>
            <input
              id="snippet-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="legal, proposal"
              className="fb-field mb-3 w-full px-2 py-1 text-[12px]"
              data-testid="save-snippet-tags"
            />

            {canShare && (
              <div className="mb-3">
                <div className="mb-1 text-[11px] text-[var(--ink-60)]">Who can use it</div>
                <div className="inline-flex overflow-hidden rounded-full bg-[var(--surface-sunken)]">
                  <button
                    onClick={() => setScope('personal')}
                    className={`px-2.5 py-1 text-[11px] ${scope === 'personal' ? 'bg-accent/10 text-accent' : 'text-[var(--ink-60)]'}`}
                    data-testid="save-snippet-scope-personal"
                  >
                    Just me
                  </button>
                  <button
                    onClick={() => setScope('org')}
                    className={`px-2.5 py-1 text-[11px] ${scope === 'org' ? 'bg-accent/10 text-accent' : 'text-[var(--ink-60)]'}`}
                    data-testid="save-snippet-scope-org"
                  >
                    {ORG_SNIPPETS_SYNC ? 'Everyone in this organisation' : 'Mark as organisation-wide'}
                  </button>
                </div>
                {/*
                  Said plainly, not as small print. Workspace sync does not
                  carry snippets yet — the server rejects any item type outside
                  its whitelist — so an org snippet stays on this computer.
                  Marking it still records the intent and is what will travel
                  once sync carries them, but the user must not be told
                  teammates can see it when they cannot.
                */}
                {scope === 'org' && !ORG_SNIPPETS_SYNC && (
                  <div
                    className="mt-1.5 flex items-start gap-1.5 rounded-[var(--radius-row)] bg-[var(--surface-sunken)] px-2 py-1.5 text-[11px] text-[var(--ink-60)]"
                    data-testid="save-snippet-org-reach"
                  >
                    <Icon name="info" size={13} className="mt-0.5 shrink-0 text-[var(--ink-40)]" />
                    <span>{ORG_SNIPPET_REACH_NOTE}</span>
                  </div>
                )}
              </div>
            )}

            {error && (
              <div className="mb-2 text-[12px] text-red-600 dark:text-red-400" data-testid="save-snippet-error">
                {error}
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                onClick={() => void submit()}
                disabled={busy}
                className="btn-primary px-3 py-1.5 text-[12px] disabled:opacity-50"
                data-testid="save-snippet-confirm"
              >
                {busy ? 'Saving…' : 'Save snippet'}
              </button>
              <span className="text-[11px] text-[var(--ink-40)]">Cmd+Enter</span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
