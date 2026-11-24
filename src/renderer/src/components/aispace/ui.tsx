// Shared pieces for AI Space and Connections screens (SPEC-AI-SPACE.md §4, §5).
//
// Status is always icon + text, never colour alone. Purple (the accent) is only
// for selection, keyboard focus and the one primary action. Motion explains
// state and respects reduced motion (Tailwind motion-reduce variants).

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { create } from 'zustand'
import Icon from '../Icon'
import './aispace.css'

// ── Status ────────────────────────────────────────────────────────────────────

type Tone = 'ok' | 'busy' | 'warn' | 'bad' | 'idle' | 'info'

const TONE_CLASS: Record<Tone, string> = {
  ok: 'text-[color:var(--ais-ok)]',
  busy: 'text-[rgb(var(--accent))]',
  warn: 'text-[color:var(--ais-warn)]',
  bad: 'text-[color:var(--ais-bad)]',
  idle: 'text-[var(--ink-50)]',
  info: 'text-[var(--ink-70)]'
}

const STATUS: Record<string, { label: string; icon: string; tone: Tone }> = {
  // runs
  queued: { label: 'Queued', icon: 'schedule', tone: 'idle' },
  running: { label: 'Running', icon: 'progress_activity', tone: 'busy' },
  waiting: { label: 'Waiting for you', icon: 'pending_actions', tone: 'warn' },
  succeeded: { label: 'Succeeded', icon: 'check_circle', tone: 'ok' },
  failed: { label: 'Failed', icon: 'error', tone: 'bad' },
  cancelled: { label: 'Cancelled', icon: 'block', tone: 'idle' },
  unavailable: { label: 'Status unavailable', icon: 'help', tone: 'warn' },
  // connections
  draft: { label: 'Setup not finished', icon: 'edit_note', tone: 'warn' },
  ready: { label: 'Ready', icon: 'check_circle', tone: 'ok' },
  limited: { label: 'Limited', icon: 'warning', tone: 'warn' },
  reconnect_required: { label: 'Reconnect required', icon: 'link_off', tone: 'bad' },
  paused: { label: 'Paused', icon: 'pause_circle', tone: 'idle' },
  disconnected: { label: 'Disconnected', icon: 'power_off', tone: 'idle' },
  // outputs
  in_review: { label: 'Ready for review', icon: 'rate_review', tone: 'warn' },
  approved: { label: 'Approved', icon: 'verified', tone: 'ok' },
  changes_requested: { label: 'Changes requested', icon: 'edit', tone: 'warn' },
  // tasks
  todo: { label: 'To do', icon: 'radio_button_unchecked', tone: 'idle' },
  in_progress: { label: 'In progress', icon: 'progress_activity', tone: 'busy' },
  awaiting_review: { label: 'Awaiting review', icon: 'rate_review', tone: 'warn' },
  done: { label: 'Done', icon: 'check_circle', tone: 'ok' },
  blocked: { label: 'Blocked', icon: 'block', tone: 'bad' },
  // decisions
  open: { label: 'Decision due', icon: 'gavel', tone: 'warn' },
  superseded: { label: 'Superseded', icon: 'history', tone: 'idle' },
  resolved: { label: 'Resolved', icon: 'check_circle', tone: 'ok' },
  rejected: { label: 'Rejected', icon: 'cancel', tone: 'idle' }
}

export function statusInfo(status: string): { label: string; icon: string; tone: Tone } {
  return STATUS[status] ?? { label: status.replace(/_/g, ' '), icon: 'circle', tone: 'info' }
}

export function StatusBadge({ status, label, className = '' }: { status: string; label?: string; className?: string }): JSX.Element {
  const s = statusInfo(status)
  return (
    <span className={`inline-flex items-center gap-1 text-[12px] leading-none whitespace-nowrap ${TONE_CLASS[s.tone]} ${className}`} data-status={status}>
      <Icon name={s.icon} size={14} className={status === 'running' || status === 'in_progress' ? 'motion-safe:animate-spin [animation-duration:2.4s]' : ''} />
      <span>{label ?? s.label}</span>
    </span>
  )
}

// A relation label (Impact §2): "Used this version" vs "Possible match".
export function RelationTag({ relation }: { relation: 'recorded' | 'possible' | 'acted' | 'direct' }): JSX.Element {
  const map = {
    recorded: { text: 'Used this version', icon: 'link', cls: 'text-[var(--ink-70)] border-[var(--edge-soft)]' },
    possible: { text: 'Possible match', icon: 'help_center', cls: 'text-[color:var(--ais-warn)] border-[color-mix(in_oklab,var(--ais-warn)_40%,transparent)] border-dashed' },
    acted: { text: 'Agent revised it', icon: 'auto_fix_high', cls: 'text-[rgb(var(--accent))] border-[rgb(var(--accent)/0.35)]' },
    direct: { text: 'Directly affected', icon: 'adjust', cls: 'text-[var(--ink-70)] border-[var(--edge-soft)]' }
  }[relation]
  return (
    <span className={`inline-flex items-center gap-1 h-[20px] px-1.5 rounded-md border text-[11.5px] whitespace-nowrap ${map.cls}`}>
      <Icon name={map.icon} size={12} />
      {map.text}
    </span>
  )
}

// ── Buttons ───────────────────────────────────────────────────────────────────

export function PrimaryButton(props: { children: ReactNode; onClick?: () => void; disabled?: boolean; testId?: string; type?: 'button' | 'submit'; title?: string }): JSX.Element {
  return (
    <button
      type={props.type ?? 'button'}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      data-testid={props.testId}
      className="inline-flex items-center justify-center gap-1.5 min-h-[32px] px-3.5 rounded-lg bg-[rgb(var(--accent))] text-white text-[13px] font-medium hover:bg-accent-hover disabled:opacity-45 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--accent))] motion-safe:transition-colors motion-safe:duration-150"
    >
      {props.children}
    </button>
  )
}

export function QuietButton(props: { children: ReactNode; onClick?: () => void; disabled?: boolean; testId?: string; title?: string; danger?: boolean; icon?: string; ariaLabel?: string }): JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      aria-label={props.ariaLabel}
      data-testid={props.testId}
      className={`fb-btn-surface inline-flex items-center justify-center gap-1.5 min-h-[32px] px-3 rounded-lg text-[13px] disabled:opacity-45 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--accent))] ${props.danger ? 'text-[color:var(--ais-bad)]' : 'text-[var(--ink-90)]'}`}
    >
      {props.icon && <Icon name={props.icon} size={15} />}
      {props.children}
    </button>
  )
}

export function LinkButton(props: { children: ReactNode; onClick: () => void; testId?: string; title?: string }): JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={props.title}
      data-testid={props.testId}
      className="inline-flex items-center gap-1 text-[13px] text-[rgb(var(--accent))] hover:underline underline-offset-2 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))] min-h-[24px]"
    >
      {props.children}
    </button>
  )
}

export function Kbd({ children }: { children: ReactNode }): JSX.Element {
  return <kbd className="inline-flex items-center h-[18px] px-1.5 rounded border border-[var(--edge-soft)] bg-[var(--surface-sunken)] text-[11px] font-sans text-[var(--ink-70)]">{children}</kbd>
}

// ── Tabs (roving tabindex) ────────────────────────────────────────────────────

export function Tabs<T extends string>(props: { tabs: Array<{ id: T; label: string; count?: number }>; active: T; onChange: (id: T) => void; label: string; testIdPrefix?: string }): JSX.Element {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  function onKey(e: KeyboardEvent<HTMLDivElement>): void {
    const i = props.tabs.findIndex((t) => t.id === props.active)
    let n = -1
    if (e.key === 'ArrowRight') n = (i + 1) % props.tabs.length
    if (e.key === 'ArrowLeft') n = (i - 1 + props.tabs.length) % props.tabs.length
    if (e.key === 'Home') n = 0
    if (e.key === 'End') n = props.tabs.length - 1
    if (n >= 0) {
      e.preventDefault()
      props.onChange(props.tabs[n].id)
      refs.current[n]?.focus()
    }
  }
  return (
    <div role="tablist" aria-label={props.label} onKeyDown={onKey} className="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-[var(--surface-sunken)] border border-[var(--edge-hairline)]">
      {props.tabs.map((t, i) => {
        const on = t.id === props.active
        return (
          <button
            key={t.id}
            ref={(el) => (refs.current[i] = el)}
            role="tab"
            type="button"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            data-testid={props.testIdPrefix ? `${props.testIdPrefix}-${t.id}` : undefined}
            onClick={() => props.onChange(t.id)}
            className={`min-h-[28px] px-3 rounded-md text-[13px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))] motion-safe:transition-colors motion-safe:duration-150 ${on ? 'bg-[var(--surface-raised)] text-[rgb(var(--accent))] shadow-[var(--shadow-soft)] font-medium' : 'text-[var(--ink-70)] hover:text-[var(--ink-100)]'}`}
          >
            {t.label}
            {t.count ? <span className="ml-1.5 text-[11.5px] fb-tabular text-[var(--ink-50)]">{t.count}</span> : null}
          </button>
        )
      })}
    </div>
  )
}

// ── Empty state: one meaningful action ────────────────────────────────────────

export function EmptyState(props: { icon: string; title: string; body?: string; action?: { label: string; run: () => void; testId?: string }; children?: ReactNode; testId?: string }): JSX.Element {
  return (
    <div className="px-6 py-12 text-center" data-testid={props.testId}>
      <Icon name={props.icon} size={30} className="text-[var(--ink-30)]" />
      <p className="mt-3 text-[15px] text-[var(--ink-90)] font-medium">{props.title}</p>
      {props.body && <p className="mt-1.5 text-[14px] text-[var(--ink-60)] max-w-md mx-auto leading-relaxed">{props.body}</p>}
      {props.action && (
        <div className="mt-4">
          <PrimaryButton onClick={props.action.run} testId={props.action.testId}>
            {props.action.label}
          </PrimaryButton>
        </div>
      )}
      {props.children}
    </div>
  )
}

export function Section(props: { title: string; children: ReactNode; aside?: ReactNode; testId?: string; id?: string }): JSX.Element {
  const hid = useId()
  return (
    <section aria-labelledby={hid} className="mt-8 first:mt-0" data-testid={props.testId} id={props.id}>
      <div className="flex items-center gap-3 mb-3">
        <h2 id={hid} className="text-[18px] font-semibold text-[var(--ink-100)]">
          {props.title}
        </h2>
        <div className="ml-auto flex items-center gap-2">{props.aside}</div>
      </div>
      {props.children}
    </section>
  )
}

// ── Announcer (screen readers) ────────────────────────────────────────────────

interface AnnounceStore {
  text: string
  n: number
  say: (t: string) => void
}

export const useAnnounce = create<AnnounceStore>((set) => ({
  text: '',
  n: 0,
  say: (t) => set((s) => ({ text: t, n: s.n + 1 }))
}))

export function announce(text: string): void {
  useAnnounce.getState().say(text)
}

export function Announcer(): JSX.Element {
  const { text, n } = useAnnounce()
  return (
    <div aria-live="polite" role="status" className="sr-only" data-testid="ais-announcer">
      <span key={n}>{text}</span>
    </div>
  )
}

// ── Inspector (360 px; docks wide, overlays narrow; slides from the right) ────

const WIDTH_KEY = 'fb.aispace.inspectorWidth'
const MIN_W = 300
const MAX_W = 720

function loadWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(n) && n >= MIN_W && n <= MAX_W ? n : 360
  } catch {
    return 360
  }
}

export function useWideLayout(min = 1180): boolean {
  const [wide, setWide] = useState(() => (typeof window === 'undefined' ? true : window.innerWidth >= min))
  useEffect(() => {
    const on = (): void => setWide(window.innerWidth >= min)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [min])
  return wide
}

export function Inspector(props: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: ReactNode
  children: ReactNode
  expanded?: boolean
  onToggleExpand?: () => void
  testId?: string
  actions?: ReactNode
  // Docked inspectors push the workspace; overlays float above it.
  docked: boolean
}): JSX.Element | null {
  const [width, setWidth] = useState(loadWidth)
  const panelRef = useRef<HTMLDivElement>(null)
  const returnTo = useRef<HTMLElement | null>(null)
  const hid = useId()

  useEffect(() => {
    if (!props.open) return
    returnTo.current = document.activeElement as HTMLElement | null
    const t = setTimeout(() => panelRef.current?.querySelector<HTMLElement>('[data-autofocus], h2')?.focus(), 30)
    return () => {
      clearTimeout(t)
      // Restore focus to whatever opened the inspector.
      const back = returnTo.current
      if (back && document.contains(back)) setTimeout(() => back.focus(), 0)
    }
  }, [props.open])

  useEffect(() => {
    if (!props.open) return
    function onKey(e: globalThis.KeyboardEvent): void {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        // Escape closes only the topmost view: let open modals/menus handle it first.
        if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
        e.preventDefault()
        props.onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.open, props.onClose])

  const onResizeKey = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      setWidth((w) => {
        const n = Math.max(MIN_W, Math.min(MAX_W, w + (e.key === 'ArrowLeft' ? step : -step)))
        try {
          localStorage.setItem(WIDTH_KEY, String(n))
        } catch {
          /* private mode */
        }
        return n
      })
    }
  }, [])

  function startDrag(e: React.PointerEvent<HTMLDivElement>): void {
    const startX = e.clientX
    const startW = width
    const move = (ev: PointerEvent): void => setWidth(Math.max(MIN_W, Math.min(MAX_W, startW + (startX - ev.clientX))))
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setWidth((w) => {
        try {
          localStorage.setItem(WIDTH_KEY, String(w))
        } catch {
          /* private mode */
        }
        return w
      })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  if (!props.open) return null
  const style = props.expanded ? undefined : { width }
  return (
    <aside
      ref={panelRef}
      aria-labelledby={hid}
      role={props.docked ? 'complementary' : 'dialog'}
      aria-modal={props.docked ? undefined : false}
      data-testid={props.testId ?? 'ais-inspector'}
      data-docked={props.docked ? 'true' : 'false'}
      style={style}
      className={`${props.expanded ? 'absolute inset-0 z-[30]' : props.docked ? 'relative shrink-0 h-full' : 'absolute top-0 right-0 bottom-0 z-[30] shadow-[var(--shadow-deep)]'} flex flex-col bg-[var(--surface-raised)] border-l border-[var(--edge-soft)] motion-safe:animate-[ais-slide-in_200ms_var(--ease-glide,ease-out)]`}
    >
      {!props.expanded && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the inspector"
          aria-valuemin={MIN_W}
          aria-valuemax={MAX_W}
          aria-valuenow={width}
          tabIndex={0}
          onKeyDown={onResizeKey}
          onPointerDown={startDrag}
          className="absolute left-[-3px] top-0 bottom-0 w-[6px] cursor-col-resize focus-visible:bg-[rgb(var(--accent)/0.4)] hover:bg-[rgb(var(--accent)/0.2)]"
        />
      )}
      <header className="flex items-start gap-2 px-4 pt-3.5 pb-3 border-b border-[var(--edge-hairline)]">
        <div className="min-w-0 flex-1">
          <h2 id={hid} tabIndex={-1} className="text-[15px] font-semibold text-[var(--ink-100)] truncate outline-none">
            {props.title}
          </h2>
          {props.subtitle && <div className="mt-0.5 text-[12px] text-[var(--ink-60)]">{props.subtitle}</div>}
        </div>
        {props.actions}
        {props.onToggleExpand && (
          <button type="button" onClick={props.onToggleExpand} aria-label={props.expanded ? 'Back to side panel' : 'Expand to fill'} title={props.expanded ? 'Back to side panel' : 'Expand to fill'} className="icon-btn h-8 w-8 rounded-md inline-flex items-center justify-center text-[var(--ink-60)] hover:text-[var(--ink-100)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]">
            <Icon name={props.expanded ? 'close_fullscreen' : 'open_in_full'} size={16} />
          </button>
        )}
        <button type="button" onClick={props.onClose} aria-label="Close" title="Close (Esc)" className="icon-btn h-8 w-8 rounded-md inline-flex items-center justify-center text-[var(--ink-60)] hover:text-[var(--ink-100)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]" data-testid="ais-inspector-close">
          <Icon name="close" size={16} />
        </button>
      </header>
      <div className="flex-1 min-h-0 overflow-auto px-4 py-3">{props.children}</div>
    </aside>
  )
}

// ── New updates, applied on request ───────────────────────────────────────────

// Content never moves under the pointer: while the person reads, changes are
// counted and offered; they apply when the person asks (§5 Motion).
export function useOnRequestUpdates(load: () => Promise<void>, matches: (p: { topic: string; projectId?: string | null }) => boolean): { pending: number; apply: () => void } {
  const [pending, setPending] = useState(0)
  const loadRef = useRef(load)
  loadRef.current = load
  const matchRef = useRef(matches)
  matchRef.current = matches
  useEffect(() => {
    const off = window.api?.aiSpace?.onChanged?.((p) => {
      if (matchRef.current(p)) setPending((n) => n + 1)
    })
    return () => off?.()
  }, [])
  const apply = useCallback(() => {
    setPending(0)
    void loadRef.current()
  }, [])
  return { pending, apply }
}

export function NewUpdatesBar({ count, onApply }: { count: number; onApply: () => void }): JSX.Element | null {
  if (count === 0) return null
  return (
    <div className="sticky top-0 z-[5] flex justify-center py-2 pointer-events-none">
      <button
        type="button"
        onClick={onApply}
        data-testid="ais-new-updates"
        className="pointer-events-auto inline-flex items-center gap-1.5 h-8 px-3.5 rounded-full bg-[var(--surface-raised)] border border-[rgb(var(--accent)/0.35)] text-[13px] text-[rgb(var(--accent))] shadow-[var(--shadow-cast)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]"
      >
        <Icon name="arrow_upward" size={15} />
        New updates
      </button>
    </div>
  )
}

// ── Formatting ────────────────────────────────────────────────────────────────

export function fmtAgo(t: number | null | undefined, now = Date.now()): string {
  if (!t) return '—'
  const s = Math.round((now - t) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 14) return `${d} d ago`
  return new Date(t).toLocaleDateString()
}

export function fmtDuration(ms: number | null): string {
  if (ms === null || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  return `${m} min ${s % 60} s`
}

export function fmtWhen(t: number): string {
  return new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}

export function fmtMoney(micros: number | null, currency = 'USD'): string {
  if (micros === null) return 'Unavailable'
  const v = micros / 1e6
  const digits = v !== 0 && Math.abs(v) < 0.1 ? 4 : 2
  return `${currency === 'USD' ? 'US$' : `${currency} `}${v.toFixed(digits)}`
}

export function authorLabel(author: string): string {
  if (author.startsWith('user:')) return 'You'
  if (author.startsWith('agent:')) return author.slice(6)
  if (author.startsWith('run:')) return 'A run'
  return author
}

// Highlight the exact matched span inside an evidence excerpt.
export function Excerpt({ text, start, end }: { text: string; start: number | null | undefined; end: number | null | undefined }): JSX.Element {
  if (start == null || end == null || end <= start) return <span>{text}</span>
  return (
    <span>
      {text.slice(0, start)}
      <mark className="bg-[color-mix(in_oklab,var(--ais-warn)_28%,transparent)] text-inherit rounded-[3px] px-0.5">{text.slice(start, end)}</mark>
      {text.slice(end)}
    </span>
  )
}
