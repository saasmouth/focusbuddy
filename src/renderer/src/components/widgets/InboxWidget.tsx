import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MailAccountPublic, MailListItem, Widget } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import Icon from '../Icon'
import { useWidgetStore } from '../../stores/widgets'
import { useNodeStore } from '../../stores/nodes'
import { useViewStore } from '../../stores/view'
import { useMailModalStore } from '../../stores/mailModal'
import { useMailTagStore } from '../../stores/mailTags'
import {
  applyRules,
  describeRules,
  rulesAreEmpty,
  seedRulesFromDeskTitle,
  type InboxRules
} from '../../lib/inboxFilter'

// The inbox, narrowed to this desk.
//
// The premise: an inbox is one undifferentiated pile, and the four emails that
// matter to the deal you are looking at are in there with six hundred that
// don't. The desk already knows what it is about, so it can hold the rule --
// "from Sarah or the conveyancer, about Ridge St, last 30 days" -- and show
// only that.
//
// Two things this deliberately does NOT do:
//
// It does not invent a link between a desk and a message. There is no table
// tying mail to a desk, so the filter is made only of what the mailbox
// actually returns -- sender, subject, read state, flag, attachments, date.
// The rule is visible, editable and stated on the face of the widget, because
// a filtered view that hides its own rule is one you cannot trust: no matches
// and a broken rule look identical.
//
// It does not show anything when there is no mailbox. No sample senders, no
// placeholder threads. If mail isn't connected it says so and offers the way
// to connect it.

interface InboxContent {
  rules?: InboxRules
  /** How many messages to pull before filtering. */
  scan?: number
  /** Show the rule editor rather than the results. */
  editing?: boolean
}

const DEFAULT_SCAN = 200

function parse(raw: string | null | undefined): InboxContent {
  if (!raw) return {}
  try {
    const p = JSON.parse(raw) as InboxContent
    return p && typeof p === 'object' ? p : {}
  } catch {
    return {}
  }
}

type Load =
  | { state: 'loading' }
  | { state: 'no-account' }
  | { state: 'unavailable'; why: string }
  | { state: 'error'; error: string }
  | { state: 'ready'; messages: MailListItem[] }

const RELATIVE = (ts: number): string => {
  if (!ts) return ''
  const diff = Date.now() - ts
  const min = Math.round(diff / 60_000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h`
  const d = Math.round(hr / 24)
  if (d < 7) return `${d}d`
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

const initials = (name: string, address: string): string => {
  const src = (name || address || '?').trim()
  const parts = src.split(/[\s@.]+/).filter(Boolean)
  return (
    parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') ||
    src[0]?.toUpperCase() ||
    '?'
  )
}

/** Terms edited as one comma-separated line, which is how people write a list. */
const termsToText = (t: string[] | undefined): string => (t ?? []).join(', ')
const textToTerms = (s: string): string[] =>
  s.split(',').map((p) => p.trim()).filter((p) => p.length > 0)

export default function InboxWidget({ widget }: { widget: Widget }): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const nodes = useNodeStore((s) => s.nodes)
  const model = useMemo(() => parse(widget.content), [widget.content])

  // The desk this widget sits on names what it is about, so it seeds the rule
  // the first time -- an inbox widget that opens showing the whole inbox has
  // not demonstrated anything.
  const deskTitle = useMemo(
    () => nodes.find((n) => n.id === widget.taskId)?.title ?? '',
    [nodes, widget.taskId]
  )
  // A mail tag declared to be about THIS desk. When one exists, the desk and
  // the mailbox stop being two places with two nearly-identical rules: the
  // tag is the single criterion and this widget follows it. An explicit rule
  // set on the widget still wins -- the user's most specific instruction is the
  // one that counts -- and with neither, the desk title seeds a starting guess.
  const tags = useMailTagStore((s) => s.tags)
  const refreshTags = useMailTagStore((s) => s.refresh)
  const loadedTags = useMailTagStore((s) => s.loaded)
  useEffect(() => {
    if (!loadedTags) void refreshTags()
  }, [loadedTags, refreshTags])

  const linkedTag = useMemo(
    () => tags.find((f) => f.nodeId && f.nodeId === widget.taskId) ?? null,
    [tags, widget.taskId]
  )

  const rules: InboxRules = useMemo(
    () => model.rules ?? linkedTag?.rules ?? seedRulesFromDeskTitle(deskTitle),
    [model.rules, linkedTag, deskTitle]
  )

  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [editing, setEditing] = useState(Boolean(model.editing))
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null)

  const save = useCallback(
    (next: Partial<InboxContent>): void => {
      void update(widget.id, {
        content: JSON.stringify({ ...model, rules, ...next })
      })
    },
    [update, widget.id, model, rules]
  )

  const fetchMail = useCallback(async (): Promise<void> => {
    const api = (window as { api?: Record<string, unknown> }).api
    const mail = api?.mail as
      | {
          getAccount?: () => Promise<MailAccountPublic>
          list?: (
            limit?: number
          ) => Promise<{ ok: true; items: MailListItem[] } | { ok: false; error: string }>
        }
      | undefined

    // The browser build has no IMAP client at all. Saying "no messages" there
    // would be a lie of a different kind -- the mailbox isn't empty, it's
    // unreachable -- so this state is named separately.
    if (!mail?.list || !mail?.getAccount) {
      setLoad({ state: 'unavailable', why: 'Mail runs in the desktop app.' })
      return
    }

    try {
      const account = await mail.getAccount()
      if (!account?.configured) {
        setLoad({ state: 'no-account' })
        return
      }
      const res = await mail.list(model.scan ?? DEFAULT_SCAN)
      if (!res?.ok) {
        setLoad({ state: 'error', error: res?.error || 'The mailbox did not respond.' })
        return
      }
      setLoad({ state: 'ready', messages: res.items ?? [] })
      setRefreshedAt(Date.now())
    } catch (e) {
      setLoad({ state: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  }, [model.scan])

  useEffect(() => {
    void fetchMail()
  }, [fetchMail])

  // New mail should land here without the user asking. The main process already
  // broadcasts it; we re-pull rather than splice so the filter applies to one
  // consistent list.
  useEffect(() => {
    const api = (window as { api?: Record<string, unknown> }).api
    const mail = api?.mail as { onNewMail?: (cb: () => void) => (() => void) | void } | undefined
    if (!mail?.onNewMail) return
    const off = mail.onNewMail(() => void fetchMail())
    return typeof off === 'function' ? off : undefined
  }, [fetchMail])

  const shown = useMemo(
    () => (load.state === 'ready' ? applyRules(load.messages, rules) : []),
    [load, rules]
  )
  const unread = shown.filter((m) => !m.seen).length
  const scanned = load.state === 'ready' ? load.messages.length : 0

  const setRules = (next: InboxRules): void => save({ rules: next })

  // A click opens the message in place. Leaving the desk to read one email --
  // and having to find your way back -- is exactly what this widget exists to
  // avoid; the full mailbox is still one click away for anything else.
  const openMessage = (uid: number): void => {
    useMailModalStore.getState().open(uid)
  }
  const openMailbox = (): void => {
    useViewStore.getState().goMail()
  }

  const body = ((): JSX.Element => {
    if (editing) {
      return (
        <div className="flex flex-col gap-3 p-3 text-[12px]">
          <Field
            label="From"
            placeholder="sarah, @ljhooker.com.au"
            hint="Name or address. Commas mean “or”."
            value={termsToText(rules.from)}
            onChange={(v) => setRules({ ...rules, from: textToTerms(v) })}
          />
          <Field
            label="Subject contains"
            placeholder="ridge st, settlement"
            hint="Commas mean “or”."
            value={termsToText(rules.subject)}
            onChange={(v) => setRules({ ...rules, subject: textToTerms(v) })}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Toggle
              label="Unread only"
              on={Boolean(rules.unreadOnly)}
              onChange={(v) => setRules({ ...rules, unreadOnly: v })}
            />
            <Toggle
              label="Flagged"
              on={Boolean(rules.flaggedOnly)}
              onChange={(v) => setRules({ ...rules, flaggedOnly: v })}
            />
            <Toggle
              label="Has attachment"
              on={Boolean(rules.withAttachments)}
              onChange={(v) => setRules({ ...rules, withAttachments: v })}
            />
          </div>
          <label className="flex items-center gap-2">
            <span className="w-[86px] shrink-0 text-[var(--ink-60)]">Last</span>
            <select
              className="widget-nodrag rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1"
              value={String(rules.sinceDays ?? 0)}
              onChange={(e) =>
                setRules({ ...rules, sinceDays: Number(e.target.value) || null })
              }
            >
              <option value="0">any time</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
            </select>
          </label>
          <div className="flex items-center justify-between border-t border-[var(--line)] pt-2">
            <button
              type="button"
              className="widget-nodrag text-[11px] text-[var(--ink-50)] hover:text-[var(--ink-80)]"
              onClick={() => setRules(seedRulesFromDeskTitle(deskTitle))}
            >
              Reset to this desk
            </button>
            <button
              type="button"
              className="widget-nodrag rounded-md bg-[var(--accent)] px-3 py-1 text-[11px] font-medium text-white"
              onClick={() => {
                setEditing(false)
                save({ editing: false })
              }}
            >
              Done
            </button>
          </div>
        </div>
      )
    }

    if (load.state === 'loading') {
      return <Empty icon="hourglass_empty" title="Reading the mailbox…" />
    }
    if (load.state === 'unavailable') {
      return <Empty icon="desktop_windows" title="Mail isn’t available here" note={load.why} />
    }
    if (load.state === 'no-account') {
      return (
        <Empty
          icon="mail_lock"
          title="No mailbox connected"
          note="Connect an account in Mail and this desk will filter it."
          action={{ label: 'Open Mail', onClick: openMailbox }}
        />
      )
    }
    if (load.state === 'error') {
      return (
        <Empty
          icon="error_outline"
          title="Couldn’t read the mailbox"
          note={load.error}
          action={{ label: 'Try again', onClick: () => void fetchMail() }}
        />
      )
    }
    if (shown.length === 0) {
      return (
        <Empty
          icon="filter_alt_off"
          title="Nothing matches"
          note={
            scanned === 0
              ? 'The mailbox came back empty.'
              : `No match in the last ${scanned} messages · ${describeRules(rules)}`
          }
          action={{ label: 'Edit filter', onClick: () => setEditing(true) }}
        />
      )
    }

    return (
      <ul className="widget-nodrag flex-1 overflow-y-auto">
        {shown.map((m) => (
          <li
            key={m.uid}
            className="flex cursor-pointer items-start gap-2 border-b border-[var(--line)] px-3 py-2 last:border-b-0 hover:bg-[var(--surface-sunken)]"
            onClick={() => openMessage(m.uid)}
            title="Open in Mail"
          >
            <span
              className={`mt-[2px] grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10px] font-semibold ${
                m.seen
                  ? 'bg-[var(--surface-sunken)] text-[var(--ink-50)]'
                  : 'bg-[color-mix(in_oklab,var(--accent)_15%,transparent)] text-[var(--accent)]'
              }`}
            >
              {initials(m.fromName, m.fromAddress)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span
                  className={`truncate text-[12px] ${m.seen ? 'text-[var(--ink-70)]' : 'font-semibold text-[var(--ink-90)]'}`}
                >
                  {m.fromName || m.fromAddress}
                </span>
                <span className="ml-auto shrink-0 text-[10px] tabular-nums text-[var(--ink-40)]">
                  {RELATIVE(m.date)}
                </span>
              </span>
              <span className="flex items-center gap-1">
                <span
                  className={`truncate text-[11px] ${m.seen ? 'text-[var(--ink-50)]' : 'text-[var(--ink-70)]'}`}
                >
                  {m.subject || '(no subject)'}
                </span>
                {m.hasAttachments && (
                  <Icon name="attach_file" className="shrink-0 text-[12px] text-[var(--ink-40)]" />
                )}
                {m.flagged && (
                  <Icon name="flag" className="shrink-0 text-[12px] text-amber-500" />
                )}
              </span>
            </span>
          </li>
        ))}
      </ul>
    )
  })()

  return (
    <WidgetFrame widget={widget} headerLabel="Inbox" headerAccent="bg-sky-200/50 dark:bg-sky-400/10">
      <div className="flex h-full flex-col bg-[var(--surface)]">
        <div className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-2">
          <Icon name="inbox" className="text-[14px] text-[var(--ink-50)]" />
          <span className="text-[12px] font-semibold text-[var(--ink-90)]">
            {shown.length > 0 ? `${shown.length} matching` : 'Inbox'}
          </span>
          {unread > 0 && (
            <span className="rounded-full bg-[var(--accent)] px-1.5 text-[10px] font-semibold text-white">
              {unread} new
            </span>
          )}
          <button
            type="button"
            className="widget-nodrag ml-auto grid h-6 w-6 place-items-center rounded text-[var(--ink-40)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-80)]"
            title="Refresh"
            onClick={() => void fetchMail()}
          >
            <Icon name="refresh" className="text-[14px]" />
          </button>
          <button
            type="button"
            className={`widget-nodrag grid h-6 w-6 place-items-center rounded hover:bg-[var(--surface-sunken)] ${
              editing ? 'text-[var(--accent)]' : 'text-[var(--ink-40)] hover:text-[var(--ink-80)]'
            }`}
            title="Edit filter"
            onClick={() => {
              const next = !editing
              setEditing(next)
              save({ editing: next })
            }}
          >
            <Icon name="tune" className="text-[14px]" />
          </button>
        </div>

        {/* The rule, always on the face of the widget. Without it an empty
            result is indistinguishable from a filter typed wrong. */}
        {!editing && (
          <button
            type="button"
            className="widget-nodrag flex items-center gap-1 px-3 py-1 text-left text-[10px] text-[var(--ink-45)] hover:text-[var(--ink-70)]"
            onClick={() => setEditing(true)}
            title="Edit filter"
          >
            <Icon
              name={!model.rules && linkedTag ? 'folder_managed' : 'filter_alt'}
              className="text-[11px]"
            />
            <span className="truncate">
              {!model.rules && linkedTag
                ? `Following the “${linkedTag.name}” mail tag`
                : describeRules(rules)}
            </span>
            {rulesAreEmpty(rules) && !linkedTag && (
              <span className="shrink-0">— tap to narrow</span>
            )}
          </button>
        )}

        {body}

        {!editing && load.state === 'ready' && shown.length > 0 && (
          <div className="border-t border-[var(--line)] px-3 py-1 text-[10px] text-[var(--ink-40)]">
            {shown.length} of {scanned} scanned
            {refreshedAt ? ` · updated ${RELATIVE(refreshedAt)}` : ''}
          </div>
        )}
      </div>
    </WidgetFrame>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  hint?: string
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[var(--ink-60)]">{label}</span>
      <input
        className="widget-nodrag rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1 text-[12px]"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <span className="text-[10px] text-[var(--ink-40)]">{hint}</span>}
    </label>
  )
}

function Toggle({
  label,
  on,
  onChange
}: {
  label: string
  on: boolean
  onChange: (v: boolean) => void
}): JSX.Element {
  return (
    <label className="widget-nodrag flex cursor-pointer items-center gap-1.5">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span className="text-[var(--ink-70)]">{label}</span>
    </label>
  )
}

function Empty({
  icon,
  title,
  note,
  action
}: {
  icon: string
  title: string
  note?: string
  action?: { label: string; onClick: () => void }
}): JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 py-6 text-center">
      <Icon name={icon} className="text-[22px] text-[var(--ink-30)]" />
      <span className="text-[12px] font-medium text-[var(--ink-70)]">{title}</span>
      {note && <span className="text-[11px] leading-snug text-[var(--ink-45)]">{note}</span>}
      {action && (
        <button
          type="button"
          className="widget-nodrag mt-1 rounded-md border border-[var(--line)] px-2 py-1 text-[11px] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
