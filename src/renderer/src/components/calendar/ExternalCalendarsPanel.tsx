import { useCallback, useEffect, useState } from 'react'
import { CALENDAR_COLORS, type ExternalCalendar, type ExternalCalendarSyncResult } from '@shared/types'
import Icon from '../Icon'

// Adding somebody's Google or Outlook calendar.
//
// Two routes, and the difference between them is stated plainly rather than
// buried: a feed URL works immediately and is read-only; signing in gives the
// same events through the provider's API but needs an OAuth client that only
// the account holder can register. Most people want the first one and are
// never told it exists, because it is three clicks deep in both products.

type Provider = 'google' | 'microsoft'

const FEED_HELP: Record<string, { label: string; steps: string[] }> = {
  google: {
    label: 'Google Calendar',
    steps: [
      'Google Calendar → hover the calendar → ⋮ → Settings and sharing',
      'Scroll to “Integrate calendar”',
      'Copy “Secret address in iCal format”'
    ]
  },
  outlook: {
    label: 'Outlook',
    steps: [
      'Outlook → Settings → Calendar → Shared calendars',
      'Under “Publish a calendar”, pick the calendar and “Can view all details”',
      'Publish, then copy the ICS link'
    ]
  }
}

type Api = {
  list: () => Promise<ExternalCalendar[]>
  add: (d: unknown) => Promise<{ ok: true; result: ExternalCalendarSyncResult } | { ok: false; error: string }>
  update: (id: string, patch: unknown) => Promise<unknown>
  remove: (id: string) => Promise<boolean>
  sync: (id: string) => Promise<ExternalCalendarSyncResult>
  accounts: () => Promise<Array<{ id: string; provider: string; email: string | null }>>
  getProviderConfig: (p: Provider) => Promise<{ configured: boolean; clientId: string }>
  setProviderConfig: (p: Provider, clientId: string) => Promise<{ ok: true }>
  connect: (p: Provider) => Promise<{ ok: boolean; email?: string; error?: string }>
  remoteCalendars: (
    accountId: string
  ) => Promise<
    | { ok: true; calendars: Array<{ id: string; name: string; color?: string; primary?: boolean }> }
    | { ok: false; error: string }
  >
  // Plexii's own calendars, listed and coloured beside the linked ones.
  addInternal?: (name: string, color: string | null) => Promise<ExternalCalendar>
  setDefaultInternal?: (id: string) => Promise<ExternalCalendar[]>
  pushNow?: (id: string) => Promise<{ ok: boolean; created: number; updated: number; error?: string }>
}

export default function ExternalCalendarsPanel(): JSX.Element {
  const api = (window as { api?: { externalCalendars?: Api } }).api?.externalCalendars

  const [calendars, setCalendars] = useState<ExternalCalendar[] | null>(null)
  const [accounts, setAccounts] = useState<Array<{ id: string; provider: string; email: string | null }>>([])
  const [feedUrl, setFeedUrl] = useState('')
  const [feedName, setFeedName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showHelp, setShowHelp] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [clientIds, setClientIds] = useState<Record<Provider, string>>({ google: '', microsoft: '' })

  const refresh = useCallback(async (): Promise<void> => {
    if (!api) {
      setCalendars([])
      return
    }
    setCalendars(await api.list())
    setAccounts(await api.accounts())
    for (const p of ['google', 'microsoft'] as Provider[]) {
      const cfg = await api.getProviderConfig(p)
      setClientIds((prev) => ({ ...prev, [p]: cfg?.clientId ?? '' }))
    }
  }, [api])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const addFeed = async (): Promise<void> => {
    if (!api || !feedUrl.trim()) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await api.add({
        provider: 'ics',
        name: feedName.trim() || 'Calendar',
        sourceRef: feedUrl.trim()
      })
      if (!res.ok) {
        setError(res.error)
        return
      }
      if (!res.result.ok) {
        // The row was created but could not be read. Say which, so the fix is
        // obvious — the calendar is listed below carrying the same error.
        setError(res.result.error ?? 'The feed could not be read.')
      } else {
        setNotice(
          res.result.events === 0
            ? 'Connected. The feed has no events in the next two years.'
            : `Connected — ${res.result.events} event${res.result.events === 1 ? '' : 's'} in view.`
        )
        setFeedUrl('')
        setFeedName('')
      }
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const connect = async (provider: Provider): Promise<void> => {
    if (!api) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await api.connect(provider)
      if (!res.ok) {
        setError(res.error ?? 'Sign-in did not complete.')
        return
      }
      setNotice(`Signed in${res.email ? ` as ${res.email}` : ''}. Now add its calendars.`)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const addFromAccount = async (accountId: string, provider: string): Promise<void> => {
    if (!api) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.remoteCalendars(accountId)
      if (!res.ok) {
        setError(res.error)
        return
      }
      let added = 0
      for (const c of res.calendars) {
        if (calendars?.some((x) => x.sourceRef === c.id && x.accountId === accountId)) continue
        await api.add({
          provider: provider === 'google' ? 'google' : 'microsoft',
          name: c.name,
          sourceRef: c.id,
          color: c.color ?? null,
          accountId
        })
        added++
      }
      setNotice(added === 0 ? 'Every calendar on that account is already here.' : `Added ${added}.`)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const syncOne = async (id: string): Promise<void> => {
    if (!api) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const r = await api.sync(id)
      if (!r.ok) setError(r.error ?? 'Sync failed.')
      else setNotice(`Refreshed — ${r.events} event${r.events === 1 ? '' : 's'}.`)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (cal: ExternalCalendar): Promise<void> => {
    if (!api) return
    await api.update(cal.id, { enabled: !cal.enabled })
    await refresh()
  }

  /** Colour is the whole point of the list: it is what tells entries apart. */
  const setColor = async (id: string, color: string): Promise<void> => {
    if (!api) return
    await api.update(id, { color })
    await refresh()
  }

  const makeDefault = async (id: string): Promise<void> => {
    if (!api?.setDefaultInternal) return
    await api.setDefaultInternal(id)
    await refresh()
  }

  /**
   * Choose where a Plexii calendar writes its blocks. Picking nothing is the
   * honest default — Plexii keeps its own diary to itself unless told otherwise.
   */
  const setPushTarget = async (id: string, targetId: string | null): Promise<void> => {
    if (!api) return
    await api.update(id, { pushTargetId: targetId, syncMode: targetId ? 'write' : 'read' })
    await refresh()
  }

  const pushNow = async (id: string): Promise<void> => {
    if (!api?.pushNow) return
    setBusy(true)
    try {
      const res = await api.pushNow(id)
      setNotice(
        res.ok
          ? `Wrote ${res.created} new and updated ${res.updated} on the linked calendar.`
          : (res.error ?? 'Could not write to the linked calendar.')
      )
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const addInternal = async (): Promise<void> => {
    if (!api?.addInternal) return
    const used = new Set(calendars?.map((c) => c.color) ?? [])
    const next = CALENDAR_COLORS.find((c) => !used.has(c)) ?? CALENDAR_COLORS[0]
    await api.addInternal('New calendar', next)
    await refresh()
  }

  const remove = async (cal: ExternalCalendar): Promise<void> => {
    if (!api) return
    await api.remove(cal.id)
    await refresh()
  }

  const saveClientId = async (provider: Provider): Promise<void> => {
    if (!api) return
    await api.setProviderConfig(provider, clientIds[provider])
    setNotice('Saved.')
    await refresh()
  }

  if (!api) {
    return (
      <div className="p-4 text-[12px] text-[var(--ink-60)]">
        Calendar subscriptions need the desktop app.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 p-4 text-[13px]">
      <section className="flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold text-[var(--ink-90)]">Add a calendar</h3>
        <p className="text-[12px] leading-snug text-[var(--ink-55)]">
          Paste the private ICS link from Google or Outlook. It works straight away, and it is
          read-only — your events appear in Plexii and nothing here changes them.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {(['google', 'outlook'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className="rounded-md border border-[var(--line)] px-2 py-1 text-[11px] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
              onClick={() => setShowHelp(showHelp === k ? null : k)}
            >
              Where is my {FEED_HELP[k].label} link?
            </button>
          ))}
        </div>
        {showHelp && (
          <ol className="ml-4 list-decimal text-[11px] leading-relaxed text-[var(--ink-60)]">
            {FEED_HELP[showHelp].steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        )}
        <div className="flex flex-col gap-1.5 sm:flex-row">
          <input
            className="min-w-0 flex-1 rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1.5 text-[12px]"
            placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
            value={feedUrl}
            onChange={(e) => setFeedUrl(e.target.value)}
          />
          <input
            className="w-full rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1.5 text-[12px] sm:w-[150px]"
            placeholder="Name"
            value={feedName}
            onChange={(e) => setFeedName(e.target.value)}
          />
          <button
            type="button"
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
            disabled={busy || !feedUrl.trim()}
            onClick={() => void addFeed()}
          >
            {busy ? 'Adding…' : 'Add'}
          </button>
        </div>
      </section>

      {error && (
        <p className="rounded-md bg-rose-50 px-2 py-1.5 text-[11px] leading-snug text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-md bg-emerald-50 px-2 py-1.5 text-[11px] text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
          {notice}
        </p>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold text-[var(--ink-90)]">Your calendars</h3>
        {calendars === null ? (
          <p className="text-[12px] text-[var(--ink-50)]">Loading…</p>
        ) : calendars.length === 0 ? (
          <p className="text-[12px] text-[var(--ink-50)]">
            None yet. Add one above and its events appear on every Plexii calendar.
          </p>
        ) : (
          <>
          <button
            type="button"
            onClick={() => void addInternal()}
            data-testid="calendar-add-internal"
            className="mb-1.5 self-start rounded px-2 py-1 text-[11px] text-[var(--ink-50)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-80)]"
          >
            + New Plexii calendar
          </button>
          <ul className="flex flex-col divide-y divide-[var(--line)] rounded-md border border-[var(--line)]">
            {calendars.map((c) => {
              const internal = c.provider === 'internal'
              const writable = c.provider === 'google' || c.provider === 'microsoft'
              return (
                <li key={c.id} className="flex flex-col gap-1.5 px-2 py-2" data-testid={`calendar-row-${c.id}`}>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void toggle(c)}
                      title={c.enabled ? 'Showing — click to hide' : 'Hidden — click to show'}
                      className={`h-3 w-3 shrink-0 rounded-full border ${
                        c.enabled ? 'border-transparent' : 'border-[var(--ink-30)] bg-transparent'
                      }`}
                      style={c.enabled ? { background: c.color ?? 'var(--accent)' } : undefined}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] text-[var(--ink-90)]">
                        {c.name}
                        {internal && c.isDefault && (
                          <span className="ml-1 text-[10px] text-[var(--ink-45)]">· default</span>
                        )}
                      </span>
                      <span className="block truncate text-[10px] text-[var(--ink-45)]">
                        {internal
                          ? 'Plexii'
                          : c.provider === 'ics'
                            ? 'Feed'
                            : c.provider === 'google'
                              ? 'Google'
                              : 'Outlook'}
                        {c.lastSyncError
                          ? ` · ${c.lastSyncError}`
                          : c.lastSyncAt
                            ? ` · updated ${new Date(c.lastSyncAt).toLocaleString()}`
                            : internal
                              ? ''
                              : ' · never synced'}
                      </span>
                    </span>
                    {!internal && (
                      <button
                        type="button"
                        className="shrink-0 rounded p-1 text-[var(--ink-40)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-80)]"
                        title="Refresh now"
                        onClick={() => void syncOne(c.id)}
                        disabled={busy}
                      >
                        <Icon name="refresh" size={14} />
                      </button>
                    )}
                    {internal && !c.isDefault && (
                      <button
                        type="button"
                        className="shrink-0 rounded px-1.5 py-1 text-[10px] text-[var(--ink-45)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-80)]"
                        title="New blocks land on this calendar"
                        data-testid={`calendar-make-default-${c.id}`}
                        onClick={() => void makeDefault(c.id)}
                      >
                        Make default
                      </button>
                    )}
                    <button
                      type="button"
                      className="shrink-0 rounded p-1 text-[var(--ink-40)] hover:bg-[var(--surface-sunken)] hover:text-rose-500"
                      title={internal && c.isDefault ? 'The default calendar cannot be removed' : 'Remove'}
                      onClick={() => void remove(c)}
                      disabled={internal && c.isDefault}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </div>

                  {/* Colour: the whole point is telling entries apart at a glance. */}
                  <div className="flex items-center gap-1 pl-5" data-testid={`calendar-colors-${c.id}`}>
                    {CALENDAR_COLORS.map((hex) => (
                      <button
                        key={hex}
                        type="button"
                        title={`Colour this calendar ${hex}`}
                        aria-label={`Colour ${c.name} ${hex}`}
                        aria-pressed={(c.color ?? '') === hex}
                        data-testid={`calendar-color-${c.id}-${hex.slice(1)}`}
                        onClick={() => void setColor(c.id, hex)}
                        className={`h-4 w-4 rounded-full transition-transform ${
                          (c.color ?? '') === hex ? 'ring-2 ring-offset-1 ring-[var(--ink-60)] ring-offset-[var(--surface)]' : 'hover:scale-110'
                        }`}
                        style={{ background: hex }}
                      />
                    ))}
                  </div>

                  {/* Direction. A feed is read-only by protocol, so it says so
                      instead of offering a switch that could not work. */}
                  <div className="flex items-center gap-2 pl-5 text-[10px] text-[var(--ink-45)]">
                    {c.provider === 'ics' ? (
                      <span>One-way: a published feed cannot be written back to.</span>
                    ) : internal ? (
                      <>
                        <span className="shrink-0">Write out to</span>
                        <select
                          value={c.syncMode === 'write' && c.pushTargetId ? c.pushTargetId : ''}
                          data-testid={`calendar-push-target-${c.id}`}
                          onChange={(e) => void setPushTarget(c.id, e.target.value || null)}
                          className="fb-field min-w-0 flex-1 px-1 py-0.5 text-[11px]"
                        >
                          <option value="">Keep in Plexii</option>
                          {calendars
                            .filter((t) => t.provider === 'google' || t.provider === 'microsoft')
                            .map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.name}
                              </option>
                            ))}
                        </select>
                        {c.syncMode === 'write' && c.pushTargetId && (
                          <button
                            type="button"
                            onClick={() => void pushNow(c.id)}
                            disabled={busy}
                            data-testid={`calendar-push-now-${c.id}`}
                            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-[var(--ink-50)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-80)]"
                          >
                            Write now
                          </button>
                        )}
                      </>
                    ) : (
                      <span>
                        {writable
                          ? 'Two-way: events here are read, and Plexii blocks can be written back.'
                          : 'One-way.'}
                      </span>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
          </>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <button
          type="button"
          className="flex items-center gap-1 text-left text-[12px] text-[var(--ink-60)] hover:text-[var(--ink-90)]"
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          <Icon name={showAdvanced ? 'expand_less' : 'expand_more'} size={14} />
          Sign in with Google or Microsoft instead
        </button>
        {showAdvanced && (
          <div className="flex flex-col gap-3 rounded-md border border-[var(--line)] p-3">
            <p className="text-[11px] leading-relaxed text-[var(--ink-55)]">
              Signing in reads your whole calendar list through the provider’s API rather than one
              feed. It needs an OAuth client ID, which only you can create — Google and Microsoft
              issue those per account and an app cannot ship one on your behalf. Create a{' '}
              <strong>Desktop app</strong> client and allow the redirect{' '}
              <code className="rounded bg-[var(--surface-sunken)] px-1">http://127.0.0.1</code> on
              any port.
            </p>
            {(['google', 'microsoft'] as Provider[]).map((p) => {
              const acct = accounts.find((a) => a.provider === p)
              return (
                <div key={p} className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-medium text-[var(--ink-80)]">
                    {p === 'google' ? 'Google' : 'Microsoft'}
                  </span>
                  <div className="flex gap-1.5">
                    <input
                      className="min-w-0 flex-1 rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1 text-[11px]"
                      placeholder={
                        p === 'google' ? '…apps.googleusercontent.com' : 'Application (client) ID'
                      }
                      value={clientIds[p]}
                      onChange={(e) => setClientIds({ ...clientIds, [p]: e.target.value })}
                    />
                    <button
                      type="button"
                      className="rounded-md border border-[var(--line)] px-2 py-1 text-[11px] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
                      onClick={() => void saveClientId(p)}
                    >
                      Save
                    </button>
                  </div>
                  {acct ? (
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-[var(--ink-60)]">
                        Signed in{acct.email ? ` as ${acct.email}` : ''}
                      </span>
                      <button
                        type="button"
                        className="rounded-md border border-[var(--line)] px-2 py-0.5 text-[11px] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
                        onClick={() => void addFromAccount(acct.id, acct.provider)}
                        disabled={busy}
                      >
                        Add its calendars
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="self-start rounded-md border border-[var(--line)] px-2 py-1 text-[11px] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] disabled:opacity-50"
                      onClick={() => void connect(p)}
                      disabled={busy || !clientIds[p]}
                      title={clientIds[p] ? '' : 'Save a client ID first'}
                    >
                      Sign in with {p === 'google' ? 'Google' : 'Microsoft'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
