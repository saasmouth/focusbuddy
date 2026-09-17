import { useEffect, useMemo, useRef, useState } from 'react'
import { useMailStore, selectMailUnread } from '../../stores/mail'
import { useViewStore } from '../../stores/view'
import type { MailAccountInput } from '@shared/types'
import { threadMailbox } from '../../lib/mailThreads'
import Icon from '../Icon'
import ComposeDialog from '../ComposeDialog'
import { useQuickCreate } from '../../stores/quickCreate'
import EmailTaskDialog from '../mail/EmailTaskDialog'

// Mail — the IMAP email inbox. The user connects their own mailbox (Gmail,
// Outlook, iCloud, Fastmail, any IMAP host) and reads it here, inside the
// workspace, next to their tasks. No Google/Azure app registration is needed;
// it is plain IMAP with an app password, set up in under a minute. Any message
// can become a PlexiDesk task in one click.

interface Preset {
  label: string
  host: string
  port: number
  secure: boolean
  note?: string
}

// Common providers. The note nudges users toward an app-specific password,
// which is the single most common reason a first connection fails.
const PRESETS: Preset[] = [
  { label: 'Gmail', host: 'imap.gmail.com', port: 993, secure: true, note: 'Needs an app password (Google account → Security → App passwords).' },
  { label: 'Outlook', host: 'outlook.office365.com', port: 993, secure: true },
  { label: 'iCloud', host: 'imap.mail.me.com', port: 993, secure: true, note: 'Needs an app-specific password from appleid.apple.com.' },
  { label: 'Fastmail', host: 'imap.fastmail.com', port: 993, secure: true, note: 'Needs an app password from Settings → Privacy & Security.' },
  { label: 'Yahoo', host: 'imap.mail.yahoo.com', port: 993, secure: true, note: 'Needs an app password from Account Security.' }
]

function fmtTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const thisYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(thisYear ? {} : { year: 'numeric' })
  })
}

// ── Setup form ──────────────────────────────────────────────────────────────
function SetupForm({ onConnected }: { onConnected: () => void }): JSX.Element {
  const account = useMailStore((s) => s.account)
  const save = useMailStore((s) => s.saveAccount)
  const test = useMailStore((s) => s.testAccount)

  const [email, setEmail] = useState(account?.email || account?.user || '')
  const [password, setPassword] = useState('')
  const [host, setHost] = useState(account?.host || '')
  const [port, setPort] = useState(account?.port || 993)
  const [secure, setSecure] = useState(account?.secure ?? true)
  const [advanced, setAdvanced] = useState(false)
  const [presetNote, setPresetNote] = useState<string | null>(null)
  const [busy, setBusy] = useState<'idle' | 'testing' | 'saving'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [tested, setTested] = useState(false)

  function applyPreset(p: Preset): void {
    setHost(p.host)
    setPort(p.port)
    setSecure(p.secure)
    setPresetNote(p.note ?? null)
    setTested(false)
  }

  function buildConfig(): MailAccountInput {
    return { host: host.trim(), port, secure, user: email.trim(), password, email: email.trim() }
  }

  const canSubmit = email.trim() && password && host.trim()

  async function onTest(): Promise<void> {
    setError(null)
    setBusy('testing')
    const r = await test(buildConfig())
    setBusy('idle')
    if (r.ok) {
      setTested(true)
    } else {
      setTested(false)
      setError(r.error ?? 'Connection failed.')
    }
  }

  async function onConnect(): Promise<void> {
    setError(null)
    setBusy('saving')
    const r = await save(buildConfig())
    setBusy('idle')
    if (r.ok) onConnected()
    else setError(r.error ?? 'Could not connect.')
  }

  return (
    <div className="h-full overflow-auto bg-[var(--surface-base)] text-[var(--ink-100)]">
      <div className="max-w-lg mx-auto px-6 py-10">
        <div className="flex items-center gap-3 mb-2">
          <div className="fb-card inline-flex items-center justify-center h-11 w-11 rounded-[var(--radius-row)]">
            <Icon name="mail" size={22} className="text-accent" />
          </div>
          <div>
            <h1 className="fb-t-hero text-[var(--ink-100)]">
              Connect your email
            </h1>
            <p className="fb-t-label text-[var(--ink-50)]">
              Read your inbox here, next to your work. Plain IMAP, no Google or Microsoft sign-in
              required.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 mt-5 mb-4">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => applyPreset(p)}
              className={`fb-t-label px-2.5 py-1 rounded-full border fb-press transition-colors ${
                host === p.host
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-[var(--edge-firm)] text-[var(--ink-60)] hover:border-[rgb(var(--accent)/0.6)]'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {presetNote && (
          <div className="mb-4 fb-t-label text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/25 rounded-[var(--radius-row)] px-3 py-2 flex gap-2">
            <Icon name="info" size={14} className="shrink-0 mt-0.5" />
            <span>{presetNote}</span>
          </div>
        )}

        <label className="block fb-t-label text-[var(--ink-70)] mb-1">
          Email address
        </label>
        <input
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            setTested(false)
          }}
          placeholder="you@example.com"
          className="w-full mb-3 fb-field fb-t-body"
        />

        <label className="block fb-t-label text-[var(--ink-70)] mb-1">
          Password
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value)
            setTested(false)
          }}
          placeholder="App password (recommended) or mailbox password"
          className="w-full mb-1 fb-field fb-t-body"
        />
        <p className="fb-t-caption mb-3">
          Stored encrypted on this device with your OS keychain. It never leaves your machine.
        </p>

        <button
          onClick={() => setAdvanced((v) => !v)}
          className="fb-t-label text-[var(--ink-50)] hover:text-accent inline-flex items-center gap-1 mb-2 fb-press"
        >
          <Icon name={advanced ? 'expand_more' : 'chevron_right'} size={14} />
          IMAP server settings
        </button>

        {advanced && (
          <div className="mb-3 grid grid-cols-[1fr_88px] gap-2">
            <div>
              <label className="block fb-t-caption mb-1">IMAP host</label>
              <input
                value={host}
                onChange={(e) => {
                  setHost(e.target.value)
                  setTested(false)
                }}
                placeholder="imap.example.com"
                className="w-full fb-field fb-t-body"
              />
            </div>
            <div>
              <label className="block fb-t-caption mb-1">Port</label>
              <input
                type="number"
                value={port}
                onChange={(e) => {
                  setPort(Number(e.target.value))
                  setTested(false)
                }}
                className="w-full fb-field fb-t-body"
              />
            </div>
            <label className="col-span-2 flex items-center gap-2 fb-t-label text-[var(--ink-60)]">
              <input
                type="checkbox"
                checked={secure}
                onChange={(e) => {
                  setSecure(e.target.checked)
                  setTested(false)
                }}
              />
              Use SSL/TLS (port 993). Uncheck for STARTTLS on 143.
            </label>
          </div>
        )}

        {!advanced && host && (
          <p className="fb-t-caption mb-3">
            Connecting to {host}:{port} {secure ? 'over SSL' : ''}
          </p>
        )}

        {error && (
          <div data-testid="mail-setup-error" className="mb-3 fb-t-label text-rose-500 bg-rose-500/10 border border-rose-500/25 rounded-[var(--radius-row)] px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={() => void onConnect()}
            disabled={!canSubmit || busy !== 'idle'}
            className="btn-primary"
          >
            {busy === 'saving' ? 'Connecting…' : 'Connect'}
          </button>
          <button
            onClick={() => void onTest()}
            disabled={!canSubmit || busy !== 'idle'}
            className="fb-t-body px-3 py-2 fb-btn-surface fb-press text-[var(--ink-70)] disabled:opacity-50"
          >
            {busy === 'testing' ? 'Testing…' : 'Test connection'}
          </button>
          {tested && (
            <span className="fb-t-label text-emerald-500 inline-flex items-center gap-1">
              <Icon name="check_circle" size={14} /> Connection works
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Reading pane ─────────────────────────────────────────────────────────────
function ReadingPane(): JSX.Element {
  const open = useMailStore((s) => s.open)
  const loading = useMailStore((s) => s.loadingOpen)
  const startCompose = useMailStore((s) => s.startCompose)
  const replyToOpen = useMailStore((s) => s.replyToOpen)
  const replyDraft = useMailStore((s) => s.replyDraft)
  const loadingDraft = useMailStore((s) => s.loadingDraft)
  const suggestReply = useMailStore((s) => s.suggestReply)
  const [taskState, setTaskState] = useState<'idle' | 'making' | 'done'>('idle')
  const [taskError, setTaskError] = useState<string | null>(null)
  const [taskDialogOpen, setTaskDialogOpen] = useState(false)
  const [draftDismissed, setDraftDismissed] = useState(false)
  // Block remote content by default: HTML email that loads remote images or CSS
  // discloses the recipient's IP and a read-receipt to the sender (tracking
  // pixels), which the empty sandbox does NOT stop. We inject a strict CSP into
  // the message document that permits only inline styles and data: images, and
  // offer a per-message "load remote content" opt-in. Reset on each message.
  const [showRemote, setShowRemote] = useState(false)
  useEffect(() => {
    setShowRemote(false)
  }, [open?.uid])
  const hasRemote =
    !!open?.html && /(?:src|background)\s*=\s*["']?https?:\/\/|url\(\s*["']?https?:\/\//i.test(open.html)
  const BLOCK_REMOTE_CSP =
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:"
  const mailSrcDoc =
    open?.html && !showRemote
      ? `<meta http-equiv="Content-Security-Policy" content="${BLOCK_REMOTE_CSP}">${open.html}`
      : (open?.html ?? '')

  useEffect(() => {
    setTaskState('idle')
    setTaskError(null)
    setTaskDialogOpen(false)
    setDraftDismissed(false)
  }, [open?.uid])

  // Open the composer with the AI draft on top of the quoted original.
  function applyDraft(replyText: string): void {
    const seed = replyToOpen(false)
    startCompose({
      ...(seed ?? {}),
      text: `${replyText}\n${seed?.text ?? ''}`,
      aiDrafted: true
    })
  }

  if (loading && !open) {
    return (
      <div className="flex-1 flex items-center justify-center fb-t-body text-[var(--ink-40)]">
        Loading message…
      </div>
    )
  }
  if (!open) {
    return (
      <div className="flex-1 flex items-center justify-center fb-t-body text-[var(--ink-40)]">
        Select an email to read it.
      </div>
    )
  }

  // The "Make a task" button now opens a dialog (choose destination / new
  // folder, due date, urgency) instead of creating a bare top-level task.

  function forwardOpen(): void {
    if (!open) return
    const when = open.date ? new Date(open.date).toLocaleString() : ''
    const header = `---------- Forwarded message ----------\nFrom: ${open.fromName} <${open.fromAddress}>\nDate: ${when}\nSubject: ${open.subject}\n\n`
    startCompose({
      subject: /^fwd:/i.test(open.subject) ? open.subject : `Fwd: ${open.subject}`,
      text: `\n\n${header}${open.text}`
    })
  }

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="px-5 pt-4 pb-3 border-b border-[var(--edge-soft)]">
        <h2 className="fb-t-title text-[var(--ink-100)] mb-1">
          {open.subject}
        </h2>
        <div className="flex items-center gap-2 fb-t-label text-[var(--ink-50)]">
          <span className="font-medium text-[var(--ink-70)]">{open.fromName}</span>
          {open.fromAddress && <span className="text-[var(--ink-40)]">&lt;{open.fromAddress}&gt;</span>}
          <span className="ml-auto">{fmtTime(open.date)}</span>
        </div>
        <div className="flex items-center gap-2 mt-2.5 flex-wrap">
          <button
            onClick={() => startCompose(replyToOpen(false) ?? undefined)}
            className="fb-t-label px-2.5 py-1 fb-btn-surface fb-press text-[var(--ink-70)] inline-flex items-center gap-1.5"
          >
            <Icon name="reply" size={13} />
            Reply
          </button>
          <button
            onClick={() => startCompose(replyToOpen(true) ?? undefined)}
            className="fb-t-label px-2.5 py-1 fb-btn-surface fb-press text-[var(--ink-70)] inline-flex items-center gap-1.5"
          >
            <Icon name="reply_all" size={13} />
            Reply all
          </button>
          <button
            onClick={forwardOpen}
            className="fb-t-label px-2.5 py-1 fb-btn-surface fb-press text-[var(--ink-70)] inline-flex items-center gap-1.5"
          >
            <Icon name="forward" size={13} />
            Forward
          </button>
          <button
            onClick={() => setTaskDialogOpen(true)}
            data-testid="mail-make-task"
            className="fb-t-label px-2.5 py-1 fb-btn-surface fb-press text-[var(--ink-70)] inline-flex items-center gap-1.5"
          >
            <Icon name={taskState === 'done' ? 'check' : 'add_task'} size={13} />
            {taskState === 'done' ? 'Task created' : 'Make a task'}
          </button>
          {open.attachments.length > 0 && (
            <span className="fb-t-label text-[var(--ink-50)] inline-flex items-center gap-1">
              <Icon name="attach_file" size={13} />
              {open.attachments.length} attachment{open.attachments.length > 1 ? 's' : ''}
            </span>
          )}
        </div>
        {taskError && (
          <div className="mt-1.5 fb-t-caption !text-rose-500">{taskError}</div>
        )}
      </div>

      {!draftDismissed && (loadingDraft || replyDraft) && (
        <div className="border-b border-[var(--edge-soft)] px-5 py-3 bg-violet-50/50 dark:bg-violet-950/10">
          {loadingDraft ? (
            <div className="flex items-center gap-2 fb-t-label text-violet-700 dark:text-violet-300">
              <Icon name="auto_awesome" size={14} className="animate-pulse" />
              Drafting a reply in your voice…
            </div>
          ) : replyDraft?.ok && replyDraft.reply ? (
            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <Icon name="auto_awesome" size={14} className="text-violet-600 dark:text-violet-400" />
                <span className="fb-t-caption uppercase tracking-wider font-medium !text-violet-700 dark:!text-violet-300">
                  Suggested reply
                </span>
                {typeof replyDraft.confidence === 'number' && (
                  <span className="fb-t-caption">
                    {Math.round(replyDraft.confidence * 100)}% confident
                  </span>
                )}
              </div>
              <p className="fb-t-body text-[var(--ink-90)] whitespace-pre-wrap leading-relaxed max-h-40 overflow-auto">
                {replyDraft.reply}
              </p>
              {replyDraft.note && (
                <p className="mt-1 fb-t-caption italic">
                  {replyDraft.note}
                </p>
              )}
              <div className="flex items-center gap-2 mt-2">
                <button
                  onClick={() => applyDraft(replyDraft.reply as string)}
                  className="fb-t-label px-2.5 py-1 rounded-[var(--radius-chip)] bg-accent text-white hover:brightness-110 inline-flex items-center gap-1.5 fb-press"
                >
                  <Icon name="edit" size={13} />
                  Edit and send
                </button>
                <button
                  onClick={() => open && void suggestReply(open)}
                  className="fb-t-label px-2 py-1 text-[var(--ink-50)] hover:text-[var(--ink-70)] fb-press"
                >
                  Redraft
                </button>
                <button
                  onClick={() => setDraftDismissed(true)}
                  className="ml-auto fb-t-label px-2 py-1 text-[var(--ink-40)] hover:text-[var(--ink-60)] fb-press"
                >
                  Dismiss
                </button>
              </div>
            </div>
          ) : replyDraft?.skip ? (
            <div className="flex items-center gap-2 fb-t-label text-[var(--ink-50)]">
              <Icon name="auto_awesome" size={13} />
              <span>AI saw no reply needed{replyDraft.skipReason ? ` — ${replyDraft.skipReason}` : ''}.</span>
              <button
                onClick={() => setDraftDismissed(true)}
                className="ml-auto text-[var(--ink-40)] hover:text-[var(--ink-60)] fb-press"
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          ) : replyDraft?.needsApiKey ? (
            <div className="fb-t-label text-[var(--ink-50)]">
              Add an Anthropic API key in Settings to get AI reply suggestions.
            </div>
          ) : replyDraft?.error ? (
            <div className="flex items-center gap-2 fb-t-label text-[var(--ink-50)]">
              <span>Could not draft a reply. {replyDraft.error}</span>
              <button
                onClick={() => open && void suggestReply(open)}
                className="text-accent hover:underline"
              >
                Try again
              </button>
            </div>
          ) : null}
        </div>
      )}

      {open.html && hasRemote && !showRemote && (
        <div className="shrink-0 px-4 py-1.5 fb-t-label bg-amber-500/10 border-b border-amber-500/20 text-[var(--ink-70)] flex items-center gap-2">
          <Icon name="visibility_off" size={13} className="shrink-0" />
          <span className="flex-1">Remote images are blocked to stop senders tracking when you open mail.</span>
          <button onClick={() => setShowRemote(true)} className="underline underline-offset-2 shrink-0" data-testid="mail-load-remote">
            Load remote content
          </button>
        </div>
      )}
      <div className="flex-1 overflow-auto">
        {open.html ? (
          // Sandboxed: scripts are disabled. By default a strict CSP is injected
          // (mailSrcDoc) so remote images/CSS cannot load either, defeating
          // tracking pixels; "Load remote content" re-renders with the original.
          <iframe
            title="Email body"
            sandbox=""
            srcDoc={mailSrcDoc}
            className="w-full h-full bg-white"
          />
        ) : (
          <pre className="px-5 py-4 fb-t-body text-[var(--ink-90)] whitespace-pre-wrap break-words font-sans leading-relaxed">
            {open.text || '(This message has no text body.)'}
          </pre>
        )}
      </div>

      {open.attachments.length > 0 && (
        <div className="border-t border-[var(--edge-soft)] px-5 py-2.5 flex flex-wrap gap-2">
          {open.attachments.map((a, i) => (
            <span
              key={i}
              className="fb-t-caption inline-flex items-center gap-1 rounded-[var(--radius-chip)] bg-[var(--surface-sunken)] px-2 py-1"
            >
              <Icon name="description" size={12} />
              {a.filename}
            </span>
          ))}
        </div>
      )}
      {taskDialogOpen && open && (
        <EmailTaskDialog
          email={{ subject: open.subject, fromName: open.fromName, fromAddress: open.fromAddress, text: open.text }}
          onClose={() => setTaskDialogOpen(false)}
          onCreated={() => {
            setTaskState('done')
            setTaskDialogOpen(false)
          }}
        />
      )}
    </div>
  )
}

// ── Main view ────────────────────────────────────────────────────────────────
export default function MailView(): JSX.Element {
  const view = useViewStore((s) => s.view)
  const account = useMailStore((s) => s.account)
  const loaded = useMailStore((s) => s.loadedAccount)
  const messages = useMailStore((s) => s.messages)
  const openUid = useMailStore((s) => s.openUid)
  const loadingList = useMailStore((s) => s.loadingList)
  const error = useMailStore((s) => s.error)
  const unread = useMailStore(selectMailUnread)
  const loadAccount = useMailStore((s) => s.loadAccount)
  const refresh = useMailStore((s) => s.refresh)
  const loadMore = useMailStore((s) => s.loadMore)
  const hasMore = useMailStore((s) => s.hasMore)
  const loadingMore = useMailStore((s) => s.loadingMore)
  const total = useMailStore((s) => s.total)
  const openMessage = useMailStore((s) => s.openMessage)
  const disconnect = useMailStore((s) => s.disconnect)
  const composing = useMailStore((s) => s.composing)
  const startCompose = useMailStore((s) => s.startCompose)
  const closeCompose = useMailStore((s) => s.closeCompose)

  const [reconfiguring, setReconfiguring] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  // First mount: learn whether an account is connected.
  useEffect(() => {
    if (!loaded) void loadAccount()
  }, [loaded, loadAccount])

  // Honour a deep link from the Inbox feed (open a specific email).
  const deepUid = view.kind === 'mail' ? view.openUid : undefined
  useEffect(() => {
    if (deepUid && account) void openMessage(deepUid)
  }, [deepUid, account, openMessage])

  // Palette quick-create ("Compose mail" from Cmd+K anywhere): open the
  // composer once the account is loaded. Without an account the setup form is
  // showing, so the request is consumed and dropped rather than left pending.
  const quickPending = useQuickCreate((s) => s.pending)
  useEffect(() => {
    if (quickPending === 'mail' && loaded && useQuickCreate.getState().consume('mail')) {
      if (account) startCompose()
    }
  }, [quickPending, loaded, account, startCompose])

  // Group the inbox into conversation threads (Gmail-style), newest first.
  const threads = useMemo(() => threadMailbox(messages), [messages])

  // Keep the highlighted thread inside the list's visible window. The list is
  // its own scroller under a fixed header bar, and nothing used to scroll it:
  // j/k (and an archive's advance, and a deep link from the Inbox) moved the
  // selection freely, so walking up landed on rows hidden above the fold —
  // tucked under the header — and walking down ran off the bottom, with the
  // reading pane showing a message whose row was nowhere on screen.
  //
  // Only this element's own scrollTop is touched. scrollIntoView() would also
  // scroll every scrollable ancestor (the PlexiOffice comms wrapper, the page
  // shell), which can shift the whole view for a row that is already in place.
  const listRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (openUid == null) return
    const list = listRef.current
    const row = list?.querySelector<HTMLElement>('[data-mail-thread-active="true"]')
    if (!list || !row) return
    const listBox = list.getBoundingClientRect()
    const rowBox = row.getBoundingClientRect()
    if (rowBox.top < listBox.top) {
      // Walking up onto the newest thread shows the top of the list — the
      // keyboard-hint line above it included — rather than parking that thread
      // flush under the header with the hint still scrolled away.
      const first = !row.previousElementSibling?.matches('[data-testid="mail-thread"]')
      list.scrollTop = first ? 0 : list.scrollTop - (listBox.top - rowBox.top)
    } else if (rowBox.bottom > listBox.bottom) {
      list.scrollTop += rowBox.bottom - listBox.bottom
    }
    // `threads` is a dependency because archiving replaces the list under the
    // selection: the row for the newly-opened uid only exists after that render.
  }, [openUid, threads])

  // Keyboard triage (power-user ask): j/k move through threads, Enter opens
  // the highlighted one, r starts a reply to the open message, a archives it.
  // Only when not typing, so the composer and search stay unaffected.
  const archive = useMailStore((s) => s.archive)
  useEffect(() => {
    function typing(): boolean {
      const el = document.activeElement as HTMLElement | null
      const tag = (el?.tagName ?? '').toLowerCase()
      return tag === 'input' || tag === 'textarea' || !!el?.isContentEditable
    }
    function onKey(e: KeyboardEvent): void {
      if (typing() || e.metaKey || e.ctrlKey || e.altKey) return
      const list = threadMailbox(useMailStore.getState().messages)
      if (list.length === 0) return
      const openNow = useMailStore.getState().open
      const idx = openNow ? list.findIndex((t) => t.messages.some((m) => m.uid === openNow.uid)) : -1
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault()
        const next = e.key === 'j' ? Math.min(idx + 1, list.length - 1) : Math.max(idx - 1, 0)
        const t = list[next]
        if (t) void useMailStore.getState().openMessage(t.latest.uid)
        return
      }
      if (e.key === 'a' && openNow) {
        e.preventDefault()
        // Archive, then advance to what is now at the same position.
        const at = idx
        void archive(openNow.uid).then((r) => {
          if (!r.ok) return
          const after = threadMailbox(useMailStore.getState().messages)
          const t = after[Math.min(at, after.length - 1)]
          if (t) void useMailStore.getState().openMessage(t.latest.uid)
        })
        return
      }
      if (e.key === 'r' && openNow) {
        e.preventDefault()
        const seed = useMailStore.getState().replyToOpen(false)
        if (seed) useMailStore.getState().startCompose(seed)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [archive])

  if (loaded && !account) {
    return <SetupForm onConnected={() => undefined} />
  }
  if (reconfiguring) {
    return <SetupForm onConnected={() => setReconfiguring(false)} />
  }

  return (
    <div className="h-full flex bg-[var(--surface-base)] text-[var(--ink-100)]">
      {/* List */}
      <div className="w-80 shrink-0 border-r border-[var(--edge-soft)] flex flex-col">
        <div className="px-3 py-3 flex items-center gap-2 border-b border-[var(--edge-soft)]">
          <Icon name="mail" size={16} className="text-accent shrink-0" />
          <div className="min-w-0 flex-1">
            <h1 className="fb-t-body font-semibold text-[var(--ink-100)] truncate">
              Mail{unread > 0 ? ` · ${unread} unread` : ''}
            </h1>
            <p className="fb-t-caption truncate">
              {account?.email}
            </p>
          </div>
          <button
            onClick={() => startCompose()}
            className="icon-btn"
            title="Compose a new message"
          >
            <Icon name="edit_square" size={15} />
          </button>
          <button onClick={() => void refresh()} className="icon-btn" title="Refresh">
            <Icon name="refresh" size={15} className={loadingList ? 'animate-spin' : ''} />
          </button>
          <div className="relative">
            <button onClick={() => setMenuOpen((v) => !v)} className="icon-btn" title="Account">
              <Icon name="more_vert" size={15} />
            </button>
            {menuOpen && (
              <div
                className="absolute right-0 top-8 z-10 w-44 rounded-[var(--radius-row)] fb-glass-panel fb-pop-in py-1 fb-t-label"
                onMouseLeave={() => setMenuOpen(false)}
              >
                <button
                  onClick={() => {
                    setMenuOpen(false)
                    setReconfiguring(true)
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--surface-sunken)] text-[var(--ink-90)] fb-press"
                >
                  Account settings
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false)
                    void disconnect()
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--surface-sunken)] text-rose-500 fb-press"
                >
                  Disconnect mailbox
                </button>
              </div>
            )}
          </div>
        </div>

        <div ref={listRef} className="flex-1 overflow-auto">
          {error && (
            <div className="m-2 fb-t-label text-rose-500 bg-rose-500/10 border border-rose-500/25 rounded-[var(--radius-row)] px-3 py-2">
              {error}
            </div>
          )}
          {threads.length > 0 && (
            <p className="px-3 py-1 fb-t-caption border-b border-[var(--edge-soft)]">
              j / k move through the inbox, r replies, a archives
            </p>
          )}
          {threads.length === 0 && !loadingList ? (
            <p className="fb-t-label text-[var(--ink-50)] px-3 py-4">
              {error ? 'Could not load your inbox.' : 'No messages.'}
            </p>
          ) : (
            threads.map((t, i) => {
              // A thread is "active" when the open message belongs to it.
              const active = openUid != null && t.messages.some((m) => m.uid === openUid)
              // Who to show: distinct participants, abbreviated for multi-person threads.
              const who =
                t.participants.length <= 2
                  ? t.participants.join(', ')
                  : `${t.participants[0]}, ${t.participants[1]} +${t.participants.length - 2}`
              return (
                <button
                  key={t.id}
                  data-testid="mail-thread"
                  data-mail-thread-active={active ? 'true' : undefined}
                  onClick={() => void openMessage(t.latest.uid)}
                  style={{ animationDelay: `${Math.min(i * 25, 250)}ms` }}
                  className={`w-full text-left px-3 py-2.5 border-b border-[var(--edge-soft)] hover:bg-[var(--surface-sunken)] fb-press fb-fade-in-up transition-colors ${
                    active ? 'bg-accent/[0.06]' : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {t.unread && <span className="h-2 w-2 rounded-full bg-accent shrink-0" />}
                    <span
                      className={`fb-t-body truncate flex-1 ${
                        t.unread
                          ? 'font-semibold text-[var(--ink-100)]'
                          : 'text-[var(--ink-60)]'
                      }`}
                    >
                      {who}
                    </span>
                    {t.count > 1 && (
                      <span
                        className="shrink-0 fb-t-caption font-medium bg-[var(--surface-sunken)] rounded-full px-1.5 leading-[16px]"
                        title={`${t.count} messages in this conversation`}
                        data-testid="mail-thread-count"
                      >
                        {t.count}
                      </span>
                    )}
                    {t.hasAttachments && (
                      <Icon name="attach_file" size={12} className="text-[var(--ink-40)] shrink-0" />
                    )}
                    <span className="fb-t-caption shrink-0">{fmtTime(t.date)}</span>
                  </div>
                  <div
                    className={`fb-t-label truncate mt-0.5 ${
                      t.unread
                        ? 'text-[var(--ink-90)]'
                        : 'text-[var(--ink-50)]'
                    }`}
                  >
                    {t.subject}
                  </div>
                </button>
              )
            })
          )}

          {/* Older mail is on the server, not in the app: this fetches the next
              page rather than revealing rows that were already downloaded. The
              count says what is held of what exists, so "showing 40" never has
              to be mistaken for "you have 40 emails". */}
          {messages.length > 0 && (
            <div className="px-3 py-3 flex flex-col items-center gap-1.5 border-t border-[var(--edge-soft)]">
              {hasMore ? (
                <button
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  data-testid="mail-load-more"
                  className="inline-flex items-center gap-1.5 h-8 px-3.5 rounded-lg fb-t-label font-medium fb-btn-surface fb-press text-[var(--ink-80)] disabled:opacity-50 disabled:pointer-events-none"
                >
                  <Icon
                    name={loadingMore ? 'progress_activity' : 'expand_more'}
                    size={15}
                    className={loadingMore ? 'animate-spin' : ''}
                  />
                  {loadingMore ? 'Fetching from the server…' : 'Show more'}
                </button>
              ) : (
                <span className="fb-t-caption" data-testid="mail-list-end">
                  That is the whole inbox.
                </span>
              )}
              {total > 0 && (
                <span className="fb-t-caption fb-tabular" data-testid="mail-loaded-count">
                  {messages.length} of {total} messages
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <ReadingPane />

      {composing && (
        <ComposeDialog initial={composing} onClose={closeCompose} onSent={() => void refresh()} />
      )}
    </div>
  )
}
