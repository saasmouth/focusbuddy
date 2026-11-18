import { useEffect, useRef, useState } from 'react'
import { useAccountStore } from '../../stores/account'
import { useOrgStore, PERSONAL_ORG_ID } from '../../stores/org'
import { useNodeStore } from '../../stores/nodes'
import { useViewStore } from '../../stores/view'
import { getAccountState, setAccountState } from '../../lib/accountStateClient'
import type { DigestInput } from '../../lib/digestRouter'
import StandupOutputPicker from './StandupOutputPicker'
import RadarSuggestions from '../assistant/RadarSuggestions'
import Icon from '../Icon'

// The daily standup, promoted to the home hero (operator decision: the daily
// narrative IS the home screen). It weaves Work-Completed (look-back) with the
// brief (look-forward) into one narrative. The "since last time" cursor is synced
// per user (accountStateClient), so the diff is consistent across devices, and the
// day's narrative is cached until the date rolls over (a true DAILY standup, not a
// re-run on every home visit). Honest by construction: an empty workspace reads
// "all caught up", and with no AI key it shows the deterministic narrative.

const KEY = 'standup'

interface StandupRef {
  id: string
  title: string
  kind: 'node' | 'document'
}

interface StandupState {
  cursor: number
  lastRunDate: string
  scope: 'personal' | 'team'
  narrative: string
  completed: Array<{ objectId: string | null; title: string | null; at: string; kind: 'node' | 'document' | null }>
  nextUp: StandupRef[]
  counts: { completed: number; created: number; updated: number; deleted: number }
  aiUsed?: boolean
  needsApiKey?: boolean
}

// Open a referenced object in place — a desk/room/task node opens on the canvas,
// a document opens in its editor. This is the "hyperlink to it" behaviour.
function openRef(kind: 'node' | 'document' | null, id: string | null): void {
  if (!id) return
  if (kind === 'document') {
    useViewStore.getState().goDocument(id)
  } else {
    useNodeStore.getState().setActive(id)
    useViewStore.getState().goTask(id)
  }
}

function dayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function StandupHome(): JSX.Element | null {
  const account = useAccountStore((s) => s.account)
  const activeOrgId = useOrgStore((s) => s.activeOrgId)
  const orgs = useOrgStore((s) => s.orgs)
  const inSharedOrg = activeOrgId !== PERSONAL_ORG_ID && orgs.some((o) => o.id === activeOrgId && !o.personal)

  const [state, setState] = useState<StandupState | null>(null)
  const [loading, setLoading] = useState(true)
  const [scope, setScope] = useState<'personal' | 'team'>('personal')
  const ranRef = useRef(false)

  async function run(useScope: 'personal' | 'team', sinceCursor: number, persist: boolean): Promise<void> {
    setLoading(true)
    const token = useAccountStore.getState().sessionToken
    const isTeam = useScope === 'team' && inSharedOrg
    const res = await window.api.ai.standup({
      sinceCursor,
      scope: isTeam ? 'team' : 'personal',
      organisationId: isTeam ? activeOrgId : null
    })
    const next: StandupState = {
      cursor: res.toCursor,
      lastRunDate: dayKey(),
      scope: isTeam ? 'team' : 'personal',
      narrative: res.narrative,
      completed: res.completed,
      nextUp: res.nextUp ?? [],
      counts: res.counts,
      aiUsed: res.aiUsed,
      needsApiKey: res.needsApiKey
    }
    setState(next)
    setScope(next.scope)
    setLoading(false)
    // Only the daily run (and an explicit refresh) advances the synced cursor; a
    // scope toggle is view-only so it never eats tomorrow's diff.
    if (persist && token) void setAccountState(token, KEY, next)
  }

  // Daily trigger: show today's cached standup, else run once from the synced cursor.
  useEffect(() => {
    if (ranRef.current) return
    // Wait until the session is actually hydrated. If we run on the very first
    // mount before the token lands, give up-and-never-retry would leave the hero
    // blank; instead we no-op and let this effect re-fire when `account` arrives.
    const token = useAccountStore.getState().sessionToken
    if (!account || !token) {
      setLoading(false)
      return
    }
    ranRef.current = true
    void (async () => {
      const saved = await getAccountState<StandupState>(token, KEY)
      // A cache is only usable if it's from today AND carries the current shape
      // (nextUp arrived later; an older cache without it is treated as stale so the
      // new clickable refs populate rather than rendering an incomplete state).
      if (saved && saved.lastRunDate === dayKey() && saved.narrative && Array.isArray(saved.nextUp)) {
        setState({ ...saved, nextUp: saved.nextUp ?? [], completed: saved.completed ?? [] })
        setScope(saved.scope ?? 'personal')
        setLoading(false)
        return
      }
      await run(saved?.scope ?? 'personal', saved?.cursor ?? -1, true)
    })()
    // Re-fire once the account hydrates (token may not be ready on first mount).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account])

  // Signed out: Home still draws this tile, so say why it is empty instead of
  // leaving a blank card (4.3.50). Nothing is asked of the server.
  if (!account) {
    return (
      <section data-testid="standup-home" className="mb-6 fb-card p-5 flex flex-col min-h-0">
        <div className="flex items-center gap-2 mb-2 shrink-0">
          <span className="h-7 w-7 rounded-full bg-accent/10 inline-flex items-center justify-center">
            <Icon name="auto_awesome" size={15} className="text-accent" />
          </span>
          <span className="fb-t-title text-[var(--ink-90)]">Your standup</span>
        </div>
        <p data-testid="standup-signed-out" className="text-[12.5px] text-[var(--ink-50)] leading-relaxed">
          Sign in to get your daily standup: what you finished, what changed and what is worth a look.
        </p>
      </section>
    )
  }

  const savedCursor = state?.cursor ?? -1

  // What the output picker routes: the current standup as a portable digest. A
  // human date label keeps digestRouter free of locale concerns.
  const digestInput: DigestInput | null = state
    ? {
        narrative: state.narrative,
        completed: state.completed,
        counts: state.counts,
        scope: state.scope,
        dateLabel: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      }
    : null

  return (
    <section
      data-testid="standup-home"
      // DEC-132 — inside the home tile (its only host) the card fills the
      // tile: the title row stays pinned, everything under it scrolls, so
      // "Worth a look" is never cut off mid-row.
      className="mb-6 fb-card p-5 flex flex-col min-h-0"
    >
      <div className="flex items-center gap-2 mb-2 shrink-0">
        <span className="h-7 w-7 rounded-full bg-accent/10 inline-flex items-center justify-center">
          <Icon name="auto_awesome" size={15} className="text-accent" />
        </span>
        <span className="fb-t-title text-[var(--ink-90)]">Your standup</span>
        {inSharedOrg && (
          <div className="ml-2 inline-flex rounded-lg bg-[var(--surface-sunken)] overflow-hidden text-[11px]">
            {(['personal', 'team'] as const).map((s) => (
              <button
                key={s}
                onClick={() => {
                  if (s !== scope) void run(s, savedCursor, false)
                }}
                data-testid={`standup-scope-${s}`}
                className={`px-2.5 h-6 ${scope === s ? 'bg-[rgb(var(--accent))] text-white' : 'text-[var(--ink-60)] hover:bg-[var(--surface-sunken)]'}`}
              >
                {s === 'personal' ? 'You' : 'Team'}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <StandupOutputPicker input={digestInput} />
          <button
            onClick={() => void run(scope, savedCursor, true)}
            disabled={loading}
            title="Refresh the standup"
            data-testid="standup-refresh"
            className="icon-btn h-7 w-7 text-[var(--ink-40)] hover:text-[rgb(var(--accent))] disabled:opacity-50"
          >
            <Icon name={loading ? 'autorenew' : 'refresh'} size={15} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto" data-testid="standup-body">
      {loading && !state ? (
        <div className="text-[13px] text-[var(--ink-40)] py-3">Putting your standup together…</div>
      ) : state ? (
        <>
          <p className="text-[15px] leading-relaxed text-[var(--ink-100)] whitespace-pre-wrap">{state.narrative}</p>
          <div className="mt-3">
            <RadarSuggestions />
          </div>
          {state.completed.length > 0 && (
            <div className="mt-3 border-t border-[var(--edge-soft)] pt-3">
              <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--ink-50)] font-semibold mb-1.5">
                Completed since last time
              </div>
              <ul className="space-y-0.5">
                {state.completed.slice(0, 8).map((c, i) => {
                  const clickable = !!c.objectId && !!c.kind
                  return (
                    <li key={c.objectId ?? i}>
                      <button
                        disabled={!clickable}
                        onClick={() => openRef(c.kind, c.objectId)}
                        data-testid={c.objectId ? `standup-completed-${c.objectId}` : undefined}
                        className={`w-full flex items-center gap-2 text-[12px] rounded-md px-1.5 py-1 text-left ${
                          clickable
                            ? 'text-[var(--ink-80)] hover:bg-[var(--surface-sunken)] hover:text-[rgb(var(--accent))]'
                            : 'text-[var(--ink-70)] cursor-default'
                        }`}
                      >
                        <Icon name="check_circle" size={13} className="text-emerald-500 shrink-0" />
                        <span className="truncate">{c.title ?? 'A task'}</span>
                        {clickable && <Icon name="open_in_new" size={11} className="ml-auto shrink-0 text-[var(--ink-30)]" />}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
          {state.nextUp.length > 0 && (
            <div className="mt-3 border-t border-[var(--edge-soft)] pt-3">
              <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--ink-50)] font-semibold mb-1.5">
                Next up
              </div>
              <div className="flex flex-wrap gap-1.5">
                {state.nextUp.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => openRef(r.kind, r.id)}
                    data-testid={`standup-nextup-${r.id}`}
                    className="inline-flex items-center gap-1.5 rounded-full bg-[var(--surface-sunken)] px-2.5 h-7 text-[12px] text-[var(--ink-80)] hover:text-[rgb(var(--accent))]"
                  >
                    <Icon name="arrow_forward" size={12} className="text-[var(--ink-40)]" />
                    <span className="max-w-[180px] truncate">{r.title}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {state.needsApiKey ? (
            <div className="mt-3 text-[11px] text-[var(--ink-50)]">
              Showing a plain summary. Add an Anthropic key in Settings → AI for a written standup.
            </div>
          ) : state.aiUsed === false ? (
            <div className="mt-3 text-[11px] text-[var(--ink-50)]">
              Showing a plain summary. The written standup could not be generated just now.
            </div>
          ) : null}
        </>
      ) : (
        <div className="text-[13px] text-[var(--ink-40)] py-3">Sign in to see your daily standup.</div>
      )}
      </div>
    </section>
  )
}
