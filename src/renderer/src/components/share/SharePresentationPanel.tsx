import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from '../Icon'
import { useDeskViewStore, resolveDeskView } from '../../stores/deskView'
import { useAccountStore } from '../../stores/account'
import { cloudAppUrl } from '../../lib/signalConfig'
import { SHARE_VIEWS, type SharePresentationRequest, type ShareView, type SiteChoice, type SiteShow } from '@shared/sitePresentation'
import {
  choiceOptions,
  loadChoices,
  presentationRequest,
  saveChoices,
  selectedChoice,
  showLabel,
  shownFor,
  type PresentationChoices
} from './sharePresentationChoices'

// How an "anyone with the link" desk is presented: the view it opens in, and
// what each website on it shows. Lives in the share sheet beside the link
// controls; the sheet asks it for the request when a link is made or updated.
// See shared/sitePresentation.ts for why websites need deciding at all.

type Prepared = Extract<Awaited<ReturnType<typeof window.api.sitePreview.prepare>>, { ok: true }>

export interface SiteRow {
  widgetId: string
  url: string
  host: string
  title: string
  state: 'checking' | 'ready' | 'failed'
  result: Prepared | null
  error: string | null
}

export interface SharePresentationState {
  choices: PresentationChoices
  setView: (view: ShareView) => void
  setLockView: (lock: boolean) => void
  setSite: (widgetId: string, choice: SiteChoice) => void
  sites: SiteRow[]
  /** Sites still being visited. */
  checking: number
  /** Visit every site again (new pictures). */
  retake: () => void
  /** What to send with a mint or an update. */
  request: () => SharePresentationRequest
  /** Bumped on every change of choice, so the sheet can say an existing link needs updating. */
  revision: number
}

/** Visits run three at a time in the main process; asking for more only queues there. */
const PARALLEL = 3

export function useSharePresentation(kind: 'folder' | 'task', entityId: string, enabled: boolean): SharePresentationState {
  const currentView = useDeskViewStore((s) => resolveDeskView(s, entityId))
  const [choices, setChoices] = useState<PresentationChoices>(() => loadChoices(entityId, currentView))
  const [revision, setRevision] = useState(0)
  const [sites, setSites] = useState<SiteRow[]>([])
  const [generation, setGeneration] = useState(0)
  const forceNext = useRef(false)

  // A different desk: its own remembered choices. (The current view only seeds
  // a desk the sender has never shared, read once here, not followed.)
  useEffect(() => {
    setChoices(loadChoices(entityId, useDeskViewStore.getState().get(entityId)))
  }, [entityId])

  const change = useCallback(
    (patch: (c: PresentationChoices) => PresentationChoices) => {
      setChoices((c) => {
        const next = patch(c)
        saveChoices(entityId, next)
        return next
      })
      setRevision((r) => r + 1)
    },
    [entityId]
  )

  useEffect(() => {
    if (!enabled || !window.api?.sitePreview) return
    let alive = true
    const force = forceNext.current
    forceNext.current = false
    const origin = (() => {
      try {
        return cloudAppUrl() ? new URL(cloudAppUrl()).origin : ''
      } catch {
        return ''
      }
    })()
    void (async () => {
      const list = await window.api.sitePreview.list(entityId).catch(() => [])
      if (!alive) return
      setSites(list.map((s) => ({ ...s, state: 'checking', result: null, error: null })))
      const queue = [...list]
      const worker = async (): Promise<void> => {
        while (alive && queue.length) {
          const s = queue.shift()!
          const res = await window.api.sitePreview
            .prepare(s.widgetId, origin, force)
            .catch((e: Error) => ({ ok: false as const, widgetId: s.widgetId, error: e.message }))
          if (!alive) return
          setSites((rows) =>
            rows.map((r) =>
              r.widgetId !== s.widgetId
                ? r
                : res.ok
                  ? { ...r, state: 'ready', result: res, error: null }
                  : { ...r, state: 'failed', result: null, error: res.error }
            )
          )
        }
      }
      await Promise.all(Array.from({ length: PARALLEL }, worker))
    })()
    return () => {
      alive = false
    }
  }, [enabled, entityId, generation])

  return {
    choices,
    setView: (view) => change((c) => ({ ...c, view })),
    setLockView: (lockView) => change((c) => ({ ...c, lockView })),
    setSite: (widgetId, choice) => change((c) => ({ ...c, sites: { ...c.sites, [widgetId]: choice } })),
    sites,
    checking: sites.filter((s) => s.state === 'checking').length,
    retake: () => {
      forceNext.current = true
      setGeneration((g) => g + 1)
    },
    // Read when the link is made: whoever is signed in then is whose layouts these are.
    request: () =>
      presentationRequest(kind, entityId, choices, {
        accountId: useAccountStore.getState().account?.id ?? null,
        cloudAppUrl: cloudAppUrl()
      }),
    revision
  }
}

function SiteLine({
  row,
  choice,
  onChoose
}: {
  row: SiteRow
  choice: SiteChoice
  onChoose: (c: SiteChoice) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const r = row.result
  const shows: SiteShow = r ? shownFor(choice, r.options) : 'link'
  const name = row.title && row.title !== row.url ? row.title : row.host
  const status =
    row.state === 'checking'
      ? 'Checking…'
      : row.state === 'failed'
        ? row.error ?? 'Could not be checked.'
        : showLabel(shows, r?.provider ?? null)
  // Why this site is a link card although more was asked for.
  const why = r && shows === 'link' && choice !== 'link' ? r.refusal : null
  const thumb = r?.thumbnail ?? null
  return (
    <div className="py-1" data-testid={`share-site-${row.widgetId}`} data-site-shows={row.state === 'ready' ? shows : row.state}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => thumb && setOpen((v) => !v)}
          disabled={!thumb}
          aria-expanded={thumb ? open : undefined}
          title={thumb ? (open ? 'Hide the picture' : 'Show the picture') : undefined}
          className="shrink-0 h-[34px] w-[56px] rounded-[5px] overflow-hidden border border-[var(--edge-soft)] bg-[var(--surface-sunken)] flex items-center justify-center"
        >
          {thumb ? (
            <img src={thumb} alt="" className="h-full w-full object-cover object-top" draggable={false} />
          ) : (
            <Icon
              name={row.state === 'checking' ? 'autorenew' : 'public'}
              size={14}
              className={`text-[var(--ink-40)] ${row.state === 'checking' ? 'animate-spin' : ''}`}
            />
          )}
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11.5px] text-[var(--ink-90)]" title={row.url}>
            {name}
          </div>
          <div className="truncate text-[10.5px] text-[var(--ink-50)]">
            {row.host} · {status}
          </div>
        </div>
        {r && (
          <select
            value={selectedChoice(choice, r.options)}
            onChange={(e) => onChoose(e.target.value as SiteChoice)}
            aria-label={`How ${name} shows`}
            data-testid={`share-site-choice-${row.widgetId}`}
            className="fb-field w-auto shrink-0 text-[11px] px-1.5 py-1 bg-[var(--surface-raised)] text-[var(--ink-90)]"
          >
            {choiceOptions(r.options).map((o) => (
              <option key={o.choice} value={o.choice}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </div>
      {why && <p className="mt-0.5 pl-[64px] text-[10.5px] text-[var(--ink-50)] leading-snug">{why}</p>}
      {open && thumb && (
        <img
          src={thumb}
          alt={`What ${row.host} looks like to someone who is not signed in`}
          className="mt-1.5 w-full rounded-[var(--radius-row)] border border-[var(--edge-soft)]"
          draggable={false}
        />
      )}
    </div>
  )
}

export default function SharePresentationPanel({
  kind,
  state
}: {
  kind: 'folder' | 'task'
  state: SharePresentationState
}): JSX.Element | null {
  const { choices, sites, checking } = state
  if (kind !== 'task' && sites.length === 0) return null
  return (
    <div className="space-y-2" data-testid="share-presentation">
      {kind === 'task' && (
        <div>
          <div className="text-[10px] uppercase tracking-wider font-semibold text-[var(--ink-50)] mb-1.5">
            Opens in
          </div>
          <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Which view the link opens in">
            {SHARE_VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                role="radio"
                aria-checked={choices.view === v.id}
                onClick={() => state.setView(v.id)}
                title={v.blurb}
                data-testid={`share-view-${v.id}`}
                className={`rounded-[var(--radius-row)] border px-2 py-1.5 text-[12px] transition-colors ${
                  choices.view === v.id
                    ? 'border-accent bg-accent/10 text-[var(--ink-90)] font-medium'
                    : 'border-[var(--edge-soft)] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
          <label className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[var(--ink-60)]">
            <input
              type="checkbox"
              checked={!choices.lockView}
              onChange={(e) => state.setLockView(!e.target.checked)}
              data-testid="share-view-switch"
              className="accent-[rgb(var(--accent))]"
            />
            Let them switch to other views
          </label>
        </div>
      )}

      {sites.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-0.5">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-[var(--ink-50)]">
              Websites · {sites.length}
            </div>
            <span className="text-[10.5px] text-[var(--ink-50)]" role="status" data-testid="share-sites-progress">
              {checking > 0 ? `Checking ${sites.length - checking} of ${sites.length}…` : ''}
            </span>
            <button
              type="button"
              onClick={state.retake}
              disabled={checking > 0}
              className="ml-auto text-[10.5px] px-1.5 py-0.5 rounded border border-[var(--edge-soft)] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] disabled:opacity-50 inline-flex items-center gap-1"
              title="Visit every site again and take new pictures"
              data-testid="share-sites-retake"
            >
              <Icon name="refresh" size={11} />
              Retake pictures
            </button>
          </div>
          <div className="divide-y divide-[var(--edge-soft)]">
            {sites.map((row) => (
              <SiteLine
                key={row.widgetId}
                row={row}
                choice={choices.sites[row.widgetId] ?? 'auto'}
                onChoose={(c) => state.setSite(row.widgetId, c)}
              />
            ))}
          </div>
          <p className="mt-1 text-[10.5px] text-[var(--ink-50)] leading-snug">
            Most sites will not show inside another page. Those appear as a picture, one click from
            the real site. Pictures are taken in a private, signed-out window, so none of your
            accounts appear in them.
          </p>
        </div>
      )}
    </div>
  )
}
