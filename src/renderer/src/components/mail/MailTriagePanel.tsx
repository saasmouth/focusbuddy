import { useEffect, useMemo, useState, type JSX } from 'react'
import Icon from '../Icon'
import type { MailAction, MailSuggestion, MailTriagePlan } from '@shared/mailTriage'

// Reviewing what the assistant thinks should happen to an inbox.
//
// The shape of this screen is the argument: every row shows WHAT it proposes,
// WHY, and nothing happens until the person presses something. There is an
// "apply all" per group because reviewing sixty rows individually is its own
// kind of unusable — but the groups are separated precisely so that agreeing to
// file forty receipts is not the same gesture as agreeing to bin nine things.
//
// Destructive-ish groups (trash, spam) are collapsed by default and never carry
// an apply-all. Those are the ones worth reading one at a time.

type Applied = 'pending' | 'done' | 'skipped' | 'failed'

interface Row {
  suggestion: MailSuggestion
  subject: string
  from: string
  state: Applied
  error?: string
}

interface Props {
  onClose: () => void
  /** Subject/sender for a uid, so a row is recognisable without refetching. */
  describe: (uid: number) => { subject: string; from: string } | null
  /** Refresh the inbox after anything actually moved. */
  onChanged: () => void
}

const GROUP_LABEL: Record<MailAction, string> = {
  file: 'File into categories',
  unsubscribe: 'Unsubscribe',
  trash: 'Move to Trash',
  spam: 'Move to Junk',
  keep: 'Leave in the inbox'
}

const GROUP_NOTE: Partial<Record<MailAction, string>> = {
  trash: 'Moved to Trash, not erased — you can get these back.',
  spam: 'Moved to Junk and flagged. This teaches your own mail server; it does not report the sender to anyone.',
  unsubscribe: 'Opens the opt-out the sender published. Only shown where they published one.',
  keep: 'Nothing to do — these are here so you can see what was considered.'
}

/** Groups in the order a person would work through them: the safe bulk first,
 *  the ones that want a look last. */
const ORDER: MailAction[] = ['file', 'unsubscribe', 'trash', 'spam', 'keep']

export default function MailTriagePanel({ onClose, describe, onChanged }: Props): JSX.Element {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [plan, setPlan] = useState<MailTriagePlan | null>(null)
  const [targets, setTargets] = useState<Record<number, { kind: 'http' | 'mailto'; target: string }>>({})
  const [rows, setRows] = useState<Row[]>([])
  const [open, setOpen] = useState<Set<MailAction>>(new Set<MailAction>(['file', 'unsubscribe']))
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    void (async () => {
      const r = await window.api.mail.triage()
      if (!live) return
      setLoading(false)
      if (!r.ok) {
        setError(r.error ?? 'The inbox could not be read.')
        return
      }
      setPlan(r.plan)
      setTargets(r.unsubTargets ?? {})
      setRows(
        r.plan.suggestions.map((s) => {
          const d = describe(s.uid)
          return {
            suggestion: s,
            subject: d?.subject ?? `Message ${s.uid}`,
            from: d?.from ?? '',
            state: 'pending' as Applied
          }
        })
      )
    })()
    return () => {
      live = false
    }
  }, [describe])

  const grouped = useMemo(() => {
    const out = new Map<MailAction, Row[]>()
    for (const action of ORDER) {
      const inGroup = rows.filter((r) => r.suggestion.action === action)
      if (inGroup.length) out.set(action, inGroup)
    }
    return out
  }, [rows])

  const setRowState = (uid: number, state: Applied, err?: string): void =>
    setRows((prev) => prev.map((r) => (r.suggestion.uid === uid ? { ...r, state, error: err } : r)))

  /** Do one row for real. Every failure is shown on its own row rather than
   *  collapsing the batch — "12 of 15 applied" with no idea which three is not
   *  a result anyone can act on. */
  const apply = async (row: Row): Promise<boolean> => {
    const { suggestion: s } = row
    try {
      if (s.action === 'file' && s.category) {
        if (s.newCategory) {
          const made = await window.api.mail.createCategory(s.category)
          if (!made.ok) {
            setRowState(s.uid, 'failed', made.error)
            return false
          }
        }
        const moved = await window.api.mail.move(s.uid, s.category)
        if (!moved.ok) {
          setRowState(s.uid, 'failed', moved.error)
          return false
        }
      } else if (s.action === 'trash') {
        const r = await window.api.mail.trash(s.uid)
        if (!r.ok) {
          setRowState(s.uid, 'failed', r.error)
          return false
        }
      } else if (s.action === 'spam') {
        const r = await window.api.mail.spam(s.uid)
        if (!r.ok) {
          setRowState(s.uid, 'failed', r.error)
          return false
        }
      } else if (s.action === 'unsubscribe') {
        const t = targets[s.uid]
        if (!t) {
          setRowState(s.uid, 'failed', 'No opt-out address for this sender.')
          return false
        }
        // A mailto opt-out means SENDING mail as the person, which this app
        // does not do on anyone's behalf — the address is shown instead and
        // there is no button to press. Only an https target is opened, and
        // opening is all that happens: the form on the other side is theirs.
        if (t.kind !== 'http') {
          setRowState(s.uid, 'failed', 'This sender only accepts an emailed opt-out — write to the address shown.')
          return false
        }
        const opened = await window.api.files.openExternal(t.target)
        if (!opened.ok) {
          setRowState(s.uid, 'failed', opened.error)
          return false
        }
      }
      setRowState(s.uid, 'done')
      return true
    } catch (e) {
      setRowState(s.uid, 'failed', (e as Error).message)
      return false
    }
  }

  const applyGroup = async (action: MailAction): Promise<void> => {
    setBusy(true)
    let changed = false
    for (const row of rows.filter((r) => r.suggestion.action === action && r.state === 'pending')) {
      // Sequential on purpose: IMAP connections are shared and a burst of
      // parallel moves is how you get a half-applied mailbox.
      if (await apply(row)) changed = true
    }
    setBusy(false)
    if (changed) onChanged()
  }

  const pending = rows.filter((r) => r.state === 'pending').length

  return (
    <div
      className="absolute inset-0 z-30 flex flex-col bg-[var(--surface-base)]"
      data-testid="mail-triage-panel"
    >
      <header className="flex items-center gap-2 px-4 py-3 border-b border-[var(--edge-soft)] shrink-0">
        <Icon name="auto_awesome" size={16} className="text-accent" />
        <h2 className="fb-t-body font-semibold text-[var(--ink-100)]">Suggested tidy-up</h2>
        <span className="fb-t-caption text-[var(--ink-50)]" data-testid="mail-triage-count">
          {loading ? 'Reading your inbox…' : `${pending} suggestion${pending === 1 ? '' : 's'} to review`}
        </span>
        <button onClick={onClose} className="ml-auto icon-btn" title="Close" data-testid="mail-triage-close">
          <Icon name="close" size={15} />
        </button>
      </header>

      <div className="flex-1 overflow-auto px-4 py-3">
        {loading && <p className="fb-t-caption text-[var(--ink-50)]">Sorting through what is there…</p>}

        {error && (
          <p
            className="fb-t-label text-rose-500 bg-rose-500/10 border border-rose-500/25 rounded-[var(--radius-row)] px-3 py-2"
            data-testid="mail-triage-error"
          >
            {error}
          </p>
        )}

        {!loading && !error && rows.length === 0 && (
          <p className="fb-t-caption text-[var(--ink-50)]" data-testid="mail-triage-empty">
            Nothing to suggest — your inbox looks sorted already.
          </p>
        )}

        {[...grouped.entries()].map(([action, groupRows]) => {
          const isOpen = open.has(action)
          const actionable = action !== 'keep'
          const bulk = action === 'file'
          const left = groupRows.filter((r) => r.state === 'pending').length
          return (
            <section key={action} className="mb-4" data-testid={`mail-triage-group-${action}`}>
              <button
                onClick={() =>
                  setOpen((prev) => {
                    const next = new Set(prev)
                    if (next.has(action)) next.delete(action)
                    else next.add(action)
                    return next
                  })
                }
                className="w-full flex items-center gap-2 text-left fb-t-label font-medium text-[var(--ink-90)] py-1"
              >
                <Icon
                  name="plexii:chevron-right"
                  size={13}
                  style={{ transform: isOpen ? 'rotate(90deg)' : undefined, transition: 'transform 120ms' }}
                />
                {GROUP_LABEL[action]}
                <span className="fb-t-caption text-[var(--ink-50)]">{groupRows.length}</span>
                {bulk && left > 0 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      void applyGroup(action)
                    }}
                    disabled={busy}
                    data-testid={`mail-triage-apply-${action}`}
                    className="ml-auto btn-secondary fb-t-caption px-2 py-0.5 disabled:opacity-50"
                  >
                    File all {left}
                  </button>
                )}
              </button>

              {GROUP_NOTE[action] && isOpen && (
                <p className="fb-t-caption text-[var(--ink-50)] mb-1.5 pl-5">{GROUP_NOTE[action]}</p>
              )}

              {isOpen &&
                groupRows.map((row) => {
                  const s = row.suggestion
                  const t = targets[s.uid]
                  return (
                    <div
                      key={s.uid}
                      data-testid={`mail-triage-row-${s.uid}`}
                      className="flex items-start gap-3 py-1.5 pl-5 border-b border-[var(--edge-soft)] last:border-0"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="fb-t-label text-[var(--ink-100)] truncate">{row.subject}</p>
                        <p className="fb-t-caption text-[var(--ink-50)] truncate">
                          {row.from}
                          {s.reason ? ` · ${s.reason}` : ''}
                        </p>
                        {s.action === 'file' && s.category && (
                          <p className="fb-t-caption text-[var(--ink-70)]">
                            → {s.category}
                            {s.newCategory && <span className="text-accent"> (new category)</span>}
                          </p>
                        )}
                        {/* An opt-out you cannot see the destination of is one
                            you should not be asked to approve. */}
                        {s.action === 'unsubscribe' && t && (
                          <p className="fb-t-caption text-[var(--ink-70)] truncate" title={t.target}>
                            {t.kind === 'http' ? 'Opens ' : 'Write to '}
                            {t.target}
                          </p>
                        )}
                        {row.error && <p className="fb-t-caption text-rose-500">{row.error}</p>}
                      </div>

                      {actionable && row.state === 'pending' && !(s.action === 'unsubscribe' && t?.kind === 'mailto') && (
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => void apply(row).then((ok) => ok && onChanged())}
                            disabled={busy}
                            data-testid={`mail-triage-do-${s.uid}`}
                            className="btn-secondary fb-t-caption px-2 py-0.5 disabled:opacity-50"
                          >
                            {s.action === 'file' ? 'File' : s.action === 'trash' ? 'Trash' : s.action === 'spam' ? 'Junk' : 'Open'}
                          </button>
                          <button
                            onClick={() => setRowState(s.uid, 'skipped')}
                            data-testid={`mail-triage-skip-${s.uid}`}
                            className="icon-btn"
                            title="Leave this one alone"
                          >
                            <Icon name="close" size={13} />
                          </button>
                        </div>
                      )}
                      {s.action === 'unsubscribe' && t?.kind === 'mailto' && row.state === 'pending' && (
                        <span className="fb-t-caption text-[var(--ink-50)] shrink-0">write to them</span>
                      )}
                      {row.state === 'done' && <Icon name="check" size={14} className="text-accent shrink-0 mt-1" />}
                      {row.state === 'skipped' && (
                        <span className="fb-t-caption text-[var(--ink-50)] shrink-0">skipped</span>
                      )}
                    </div>
                  )
                })}
            </section>
          )
        })}

        {/* What the assistant asked for and was not allowed. Shown rather than
            swallowed: a plan that quietly drops its own suggestions is one
            nobody can reason about — and the commonest case here is an
            unsubscribe the sender never actually offered. */}
        {plan && plan.rejected.length > 0 && (
          <section className="mt-2 pt-2 border-t border-[var(--edge-soft)]" data-testid="mail-triage-rejected">
            <p className="fb-t-caption text-[var(--ink-50)] mb-1">
              {plan.rejected.length} suggestion{plan.rejected.length === 1 ? ' was' : 's were'} not offered:
            </p>
            {plan.rejected.slice(0, 8).map((r, i) => (
              <p key={i} className="fb-t-caption text-[var(--ink-50)] pl-2">
                · {r.proposed} — {r.because}
              </p>
            ))}
          </section>
        )}
      </div>
    </div>
  )
}
