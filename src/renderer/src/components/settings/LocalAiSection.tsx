import { useEffect, useState } from 'react'
import { useLocalAiEngine } from '../../lib/localAiEngine'
import {
  AI_FEATURES,
  AI_FEATURE_COPY,
  AI_FEATURE_ROUTES,
  LOCAL_LABEL_COPY,
  featureNowLabel,
  type AiFeature,
  type AiFeatureRoute,
  type LocalAiStatus,
  type LocalDownloadProgress
} from '@shared/localAi'

// Settings → AI → Local on this device.
//
// Everything this panel says is read from main: which model tiers this
// computer can run (by its RAM), what is downloaded, how a download is going,
// and — per feature — how well the on-device model did in our measured eval
// against cloud AI (src/shared/localAiGates.ts). Nothing here is an estimate.

interface Coverage {
  documents: {
    total: number
    withText: number
    indexed: number
    embedded: number
    meaningUsable?: number
    meaningStale?: number
    enriched: number
    memoryScanned: number
  }
  files: { total: number; indexed: number }
  conversations: { total: number; indexed: number }
  knowledge: { total: number; meaningUsable?: number }
  meaningModel?: string | null
}

const gb = (n: number): string => `${(n / 1e9).toFixed(1)} GB`
const pct = (n: number | null): string => (n === null ? 'not measured' : `${Math.round(n * 100)}%`)

export default function LocalAiSection(): JSX.Element {
  const [st, setSt] = useState<LocalAiStatus | null>(null)
  const [progress, setProgress] = useState<LocalDownloadProgress | null>(null)
  const [coverage, setCoverage] = useState<Coverage | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [trial, setTrial] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    try {
      const s = await window.api.localAi.getStatus()
      setSt(s)
      setProgress(s.download)
    } catch {
      setSt(null)
    }
    // Coverage is reported separately: a failure here must leave the number
    // ABSENT rather than showing a zero that reads like a real measurement.
    try {
      setCoverage(await window.api.localAi.coverage())
    } catch {
      setCoverage(null)
    }
  }

  useEffect(() => {
    void refresh()
    const offP = window.api.localAi.onProgress((p) => setProgress(p))
    const offC = window.api.localAi.onChanged(() => void refresh())
    return () => {
      offP()
      offC()
    }
  }, [])

  async function act(fn: () => Promise<{ ok: boolean; error?: string }>, done?: string): Promise<void> {
    setBusy(true)
    setNote(null)
    try {
      const r = await fn()
      setNote(r.ok ? (done ?? null) : (r.error ?? 'Something went wrong.'))
    } catch (e) {
      setNote((e as Error).message || 'Something went wrong.')
    } finally {
      setBusy(false)
      void refresh()
    }
  }

  async function tryIt(): Promise<void> {
    setTrial('Running on this device…')
    const r = await window.api.localAi.tryIt()
    setTrial(
      r.ok
        ? `“${r.text}” — ${((r.ms ?? 0) / 1000).toFixed(1)} s, first words after ${((r.ttftMs ?? 0) / 1000).toFixed(1)} s (includes loading the model the first time).`
        : (r.error ?? 'The on-device model did not answer.')
    )
  }

  async function enrich(): Promise<void> {
    setBusy(true)
    setNote(null)
    try {
      const r = await window.api.documents.enrichAll(false)
      if (r.reason === 'no_local_model') {
        setNote('No on-device model is installed, so nothing was described.')
      } else {
        setNote(
          `Described ${r.enriched} document${r.enriched === 1 ? '' : 's'}` +
            (r.skipped ? `, ${r.skipped} already done` : '') +
            (r.failed ? `, ${r.failed} skipped` : '') +
            '. PlexiiAssist now has richer context to answer from.'
        )
      }
    } catch (e) {
      setNote(`Describing documents failed: ${(e as Error).message || 'unknown error'}`)
    } finally {
      setBusy(false)
      void refresh()
    }
  }

  const btn = 'fb-t-caption px-2.5 py-1.5 fb-btn-surface fb-press text-[var(--ink-80)] disabled:opacity-50'
  const downloading = progress && ['checking', 'downloading', 'verifying'].includes(progress.state)
  const installed = st?.tiers.find((t) => t.id === st.activeTier && t.installed) ?? null

  return (
    <div className="mt-3 pt-3 border-t border-[var(--edge-soft)]" data-testid="local-ai-section">
      <div className="fb-t-caption uppercase tracking-wider text-[var(--ink-50)] mb-1.5">Local on this device</div>
      <div className="fb-t-caption text-[var(--ink-60)] leading-snug mb-2">
        An AI model that runs on this computer. It works offline and costs nothing per use. It is smaller than cloud
        AI: good at answering from your desks and documents, writing, summaries and tidying; weaker at building whole
        desks and at agents. Each feature below shows how it did in our tests.
      </div>

      {st?.hardware === 'cpu' && (
        <div className="fb-card rounded-[var(--radius-field)] px-2.5 py-2 mb-2 fb-t-caption text-amber-700 dark:text-amber-300 leading-snug" data-testid="local-ai-cpu-note">
          This Mac has an Intel processor, so the on-device model runs on the CPU without graphics acceleration, which
          is much slower than on Apple silicon. Use Try it below to see how long an answer takes on this Mac before
          relying on it.
        </div>
      )}

      {st && st.tiers.length === 0 && (
        <div className="fb-card rounded-[var(--radius-field)] px-2.5 py-2 mb-2 fb-t-caption text-[var(--ink-60)]">
          No on-device model is available in this version.
        </div>
      )}

      {st && st.tiers.length > 0 && (
        <div className="space-y-1.5 mb-2" data-testid="local-ai-tiers">
          {st.tiers.map((t) => {
            const active = st.activeTier === t.id
            const rec = st.recommendedTier === t.id
            const tooBig = !t.offered
            const diskShort = st.freeDiskBytes !== null && !t.installed && st.freeDiskBytes < t.sizeBytes + 1e9
            return (
              <div
                key={t.id}
                className={`fb-card rounded-[var(--radius-field)] px-2.5 py-2 fb-t-caption ${active ? 'ring-1 ring-accent' : ''}`}
                data-testid={`local-ai-tier-${t.id}`}
              >
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 flex-1 min-w-0">
                    <input
                      type="radio"
                      name="local-ai-tier"
                      checked={active}
                      disabled={busy || tooBig}
                      onChange={() => void act(() => window.api.localAi.setTier(t.id))}
                    />
                    <span className="font-medium text-[var(--ink-90)]">{t.name}</span>
                    {rec && <span className="px-1.5 rounded bg-accent/15 text-accent">Recommended for {st.ramGB} GB</span>}
                  </label>
                  <span className="text-[var(--ink-50)]">{gb(t.sizeBytes)}</span>
                </div>
                <div className="text-[var(--ink-50)] mt-0.5 leading-snug">
                  {t.id === 'compact'
                    ? `For computers with ${t.minRamGB} GB of memory or more.`
                    : `Better answers; for ${t.recommendedRamGB} GB of memory or more.`}{' '}
                  {t.license} licence ·{' '}
                  <a href={t.sourceUrl} target="_blank" rel="noreferrer" className="underline">
                    source
                  </a>
                </div>
                {tooBig && (
                  <div className="text-amber-700 dark:text-amber-300 mt-0.5">
                    Needs {t.minRamGB} GB of memory; this computer has {st.ramGB} GB.
                  </div>
                )}
                {!tooBig && diskShort && (
                  <div className="text-amber-700 dark:text-amber-300 mt-0.5">
                    Not enough free disk space ({st.freeDiskBytes !== null ? gb(st.freeDiskBytes) : 'unknown'} free).
                  </div>
                )}
                <div className="flex gap-1.5 mt-1.5">
                  {t.installed && t.source === 'bundle' ? (
                    <span className="text-emerald-700 dark:text-emerald-400 self-center" data-testid={`local-ai-bundled-${t.id}`}>
                      Included with PlexiiDesk
                    </span>
                  ) : t.installed ? (
                    <>
                      <span className="text-emerald-700 dark:text-emerald-400 self-center">Downloaded and verified</span>
                      <button
                        className={btn}
                        disabled={busy}
                        data-testid={`local-ai-delete-${t.id}`}
                        onClick={() => void act(() => window.api.localAi.deleteModel(t.id), 'Deleted.')}
                      >
                        Delete
                      </button>
                    </>
                  ) : downloading && progress?.tierId === t.id ? (
                    <button className={btn} onClick={() => void window.api.localAi.cancelDownload()} data-testid="local-ai-cancel">
                      Cancel
                    </button>
                  ) : (
                    <button
                      className={btn}
                      disabled={busy || !!downloading || tooBig || diskShort}
                      data-testid={`local-ai-download-${t.id}`}
                      onClick={() => void act(() => window.api.localAi.download(t.id), 'Downloaded and verified.')}
                    >
                      Download
                    </button>
                  )}
                </div>
                {progress && progress.tierId === t.id && progress.state !== 'done' && (
                  <div className="mt-1.5" data-testid="local-ai-progress">
                    <div className="h-1.5 rounded bg-[var(--surface-sunken)] overflow-hidden">
                      <div
                        className="h-full bg-accent"
                        style={{ width: `${Math.min(100, (progress.receivedBytes / Math.max(1, progress.totalBytes)) * 100)}%` }}
                      />
                    </div>
                    <div className="text-[var(--ink-50)] mt-0.5">
                      {progress.state === 'verifying'
                        ? 'Checking the file’s checksum…'
                        : progress.state === 'cancelled'
                          ? `Paused at ${gb(progress.receivedBytes)}. Download again to resume.`
                          : progress.state === 'error'
                            ? progress.error
                            : `${gb(progress.receivedBytes)} of ${gb(progress.totalBytes)}${progress.file !== t.file ? ' (search model)' : ''}`}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {installed && (
        <div className="mb-2">
          <button className={btn} onClick={() => void tryIt()} data-testid="local-ai-try">
            Try it
          </button>
          {trial && <div className="fb-t-caption text-[var(--ink-60)] mt-1 leading-snug" data-testid="local-ai-trial">{trial}</div>}
          <EngineStatusLine />
        </div>
      )}

      {st && (
        <div className="mt-2 fb-t-caption" data-testid="local-ai-policy">
          <div className="uppercase tracking-wider text-[var(--ink-50)] mb-1">When a feature scored lower on this device</div>
          {(
            [
              ['measured', 'Ask before using cloud', 'Features that measured well run here; the rest ask before sending that request to cloud AI.'],
              ['local-first', 'Run everything this device can', 'Weaker features run here with a label; if an answer comes back unusable, you are asked whether to try cloud AI for it.']
            ] as const
          ).map(([id, label, sub]) => (
            <label key={id} className="flex items-start gap-1.5 mb-1 leading-snug text-[var(--ink-70)]">
              <input
                type="radio"
                name="local-ai-policy"
                checked={st.policy === id}
                disabled={busy}
                data-testid={`local-ai-policy-${id}`}
                onChange={() => void act(() => window.api.localAi.setPolicy(id))}
              />
              <span>
                <span className="text-[var(--ink-90)] font-medium">{label}</span>
                <span className="text-[var(--ink-50)]"> — {sub}</span>
              </span>
            </label>
          ))}
          <div className="text-[var(--ink-50)] leading-snug">Either way, nothing goes to cloud AI unless you say yes.</div>
        </div>
      )}

      {st && <FeatureRoutes st={st} busy={busy} onChange={(f, r) => void act(() => window.api.localAi.setFeatureRoute(f, r))} />}

      <div className="fb-t-caption uppercase tracking-wider text-[var(--ink-50)] mt-3 mb-1.5">PlexiiBrain on this device</div>
      <div className="fb-t-caption text-[var(--ink-60)] leading-snug mb-2">
        {st?.embeddings.installed
          ? `Search by meaning uses ${st.embeddings.name}, which runs on this computer. Document descriptions are written by the on-device model.`
          : 'Search by meaning needs the small search model that downloads with the on-device model. Until then, PlexiiBrain searches by keyword.'}
      </div>

      {coverage && (
        <div className="fb-card rounded-[var(--radius-field)] px-2.5 py-2 mb-2 fb-t-caption" data-testid="brain-coverage">
          <div className="text-[var(--ink-50)] uppercase tracking-wider mb-1">What PlexiiAssist can see</div>
          <div className="text-[var(--ink-70)] leading-snug">
            {/*
              Denominator is documents that actually hold text: a blank document
              is not a coverage gap, and counting it as one would invent one.
            */}
            Searchable: <Stat n={coverage.documents.indexed} of={coverage.documents.withText} /> documents
            {coverage.documents.total > coverage.documents.withText && (
              <span className="text-[var(--ink-50)]"> ({coverage.documents.total - coverage.documents.withText} empty)</span>
            )}
            , <Stat n={coverage.files.indexed} of={coverage.files.total} /> files,{' '}
            <Stat n={coverage.conversations.indexed} of={coverage.conversations.total} /> conversations.
            <br />
            Described: <Stat n={coverage.documents.enriched} of={coverage.documents.withText} />
            {/*
              "Ranked by meaning" counts what the search model in use can
              actually compare. A vector written by a different model counts
              for nothing at search time, so it is shown as waiting, not as done.
              Older main processes omit meaningUsable: fall back to the raw count.
            */}
            {' · '}Ranked by meaning:{' '}
            <span data-testid="brain-coverage-meaning">
              <Stat n={coverage.documents.meaningUsable ?? coverage.documents.embedded} of={coverage.documents.withText} />
            </span>
            {/* Only claim re-indexing when there is a model to re-index with. */}
            {coverage.meaningModel && (coverage.documents.meaningStale ?? 0) > 0 && (
              <span className="text-[var(--ink-50)]"> ({coverage.documents.meaningStale} from an earlier search model, re-indexing)</span>
            )}
            {' · '}Read for memory: <Stat n={coverage.documents.memoryScanned} of={coverage.documents.withText} />
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button onClick={() => void enrich()} disabled={busy || !installed} data-testid="local-ai-enrich" className={btn}>
          {busy ? 'Working…' : 'Describe my documents'}
        </button>
        <button onClick={() => void refresh()} disabled={busy} className={btn}>
          Refresh status
        </button>
      </div>

      {note && (
        <div className="fb-t-caption text-[var(--ink-60)] mt-2 leading-snug" data-testid="local-ai-note">
          {note}
        </div>
      )}

      <details className="mt-3 fb-t-caption text-[var(--ink-50)]">
        <summary className="cursor-pointer">Advanced: Ollama</summary>
        <div className="mt-1 leading-snug">
          If no on-device model is downloaded, document descriptions and search by meaning use an Ollama server running
          on this computer (localhost:11434, or FB_OLLAMA_URL), if there is one. The on-device model above is used
          first whenever it is downloaded.
        </div>
      </details>
    </div>
  )
}

// Live: whether the model is loaded, loading, or failed, and how long the last
// load took. A cold start is seconds; saying so here and at the point of use
// (lib/localAiEngine.ts) keeps it from looking like a hang.
function EngineStatusLine(): JSX.Element {
  const e = useLocalAiEngine()
  const secs = e.lastLoadMs !== null ? ` (last start took ${(e.lastLoadMs / 1000).toFixed(1)} s)` : ''
  if (e.state === 'error' && e.error)
    return <div className="fb-t-caption text-rose-600 dark:text-rose-400 mt-1 leading-snug" data-testid="local-ai-engine-status">{e.error}</div>
  return (
    <div className="fb-t-caption text-[var(--ink-60)] mt-1 leading-snug" data-testid="local-ai-engine-status">
      {e.state === 'loading'
        ? 'Starting local AI… this happens once per session.'
        : e.state === 'ready'
          ? `Loaded and ready${secs}.`
          : `Not loaded right now: it starts in the background after launch, or when first used, and unloads after 10 minutes unused${secs}.`}
    </div>
  )
}

const ROUTE_LABEL: Record<AiFeatureRoute, string> = {
  local: 'On this device',
  cloud: 'Cloud AI (account default)',
  anthropic: 'Your Anthropic key',
  openai: 'Your OpenAI key',
  credits: 'Plexii AI credits'
}

function sourceLabel(p: LocalAiStatus['provider']): string {
  return p === 'local' ? 'on this device' : p === 'openai' ? 'your OpenAI key' : p === 'byok' ? 'your Anthropic key' : 'Plexii AI credits'
}

function FeatureRoutes({
  st,
  busy,
  onChange
}: {
  st: LocalAiStatus
  busy: boolean
  onChange: (f: AiFeature, route: AiFeatureRoute | null) => void
}): JSX.Element {
  const available = (r: AiFeatureRoute): boolean =>
    r === 'local' || (r === 'cloud' ? st.cloudProviders.anthropic || st.cloudProviders.credits : st.cloudProviders[r])
  const bothKeys = st.cloudProviders.anthropic && st.cloudProviders.openai
  return (
    <div className="mt-2" data-testid="local-ai-features">
      <div className="fb-t-caption uppercase tracking-wider text-[var(--ink-50)] mb-1">Feature by feature</div>
      <div className="fb-t-caption text-[var(--ink-50)] leading-snug mb-1.5">
        Where each feature runs right now, and how the on-device model scored against cloud AI in our tests of the
        app’s real prompts. Writing, PlexiiWrite / PlexiiCells / PlexiiDeck drafts and Build with AI use your own
        Anthropic or OpenAI key when one is saved, and run on this device otherwise.
      </div>
      {st.provider === 'local' && (
        <div className="flex flex-wrap items-center gap-2 fb-t-caption mb-1.5" data-testid="local-ai-content-writing">
          <span className="text-[var(--ink-70)]">Writing and drafts:</span>
          <select
            value={st.contentWriting}
            disabled={busy}
            onChange={(e) => void window.api.localAi.setContentWriting(e.target.value as 'cloud-if-key' | 'local' | 'ask')}
            className="fb-t-caption bg-transparent border border-[var(--edge-soft)] rounded px-1 py-0.5"
          >
            <option value="cloud-if-key">Use my own key when saved, else this device</option>
            <option value="local">Always this device</option>
            <option value="ask">Ask before using cloud AI</option>
          </select>
          {bothKeys && st.contentWriting === 'cloud-if-key' && (
            <>
              <span className="text-[var(--ink-70)]">Prefer:</span>
              <select
                value={st.preferredKey}
                disabled={busy}
                data-testid="local-ai-preferred-key"
                onChange={(e) => void window.api.localAi.setPreferredKey(e.target.value as 'anthropic' | 'openai')}
                className="fb-t-caption bg-transparent border border-[var(--edge-soft)] rounded px-1 py-0.5"
              >
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
              </select>
            </>
          )}
        </div>
      )}
      <div className="space-y-1">
        {AI_FEATURES.map((f) => {
          const g = st.gates[f]
          const route = st.featureRoutes[f] ?? null
          const now = st.effectiveRoutes[f]
          return (
            <div key={f} className="fb-card rounded-[var(--radius-field)] px-2.5 py-1.5 fb-t-caption" data-testid={`local-ai-feature-${f}`}>
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-[var(--ink-90)] font-medium">{AI_FEATURE_COPY[f].label}</div>
                  <div className="text-[var(--ink-50)] leading-snug">{AI_FEATURE_COPY[f].covers}</div>
                  <div className="text-[var(--ink-70)] mt-0.5" data-testid={`local-ai-now-${f}`}>
                    Now: {featureNowLabel(f, st)}
                  </div>
                </div>
                {now !== 'local' && f !== 'media' && (
                  <button
                    type="button"
                    disabled={busy}
                    data-testid={`local-ai-test-local-${f}`}
                    onClick={() => onChange(f, 'local')}
                    className="fb-btn-surface fb-t-caption px-2 py-0.5 rounded"
                    title="Run this feature on this device until you switch it back"
                  >
                    Test with local
                  </button>
                )}
                {route !== null && (
                  <button
                    type="button"
                    disabled={busy}
                    data-testid={`local-ai-route-reset-${f}`}
                    onClick={() => onChange(f, null)}
                    className="fb-t-caption underline text-[var(--ink-60)]"
                  >
                    Back to default
                  </button>
                )}
                <select
                  aria-label={`Where ${AI_FEATURE_COPY[f].label} runs`}
                  data-testid={`local-ai-route-${f}`}
                  value={route ?? 'default'}
                  disabled={busy}
                  onChange={(e) => onChange(f, e.target.value === 'default' ? null : (e.target.value as AiFeatureRoute))}
                  className="fb-t-caption bg-transparent border border-[var(--edge-soft)] rounded px-1 py-0.5"
                >
                  <option value="default">Default ({sourceLabel(st.provider)})</option>
                  {AI_FEATURE_ROUTES.map((r) => (
                    <option key={r} value={r} disabled={!available(r) && route !== r}>
                      {ROUTE_LABEL[r]}
                      {!available(r) ? (r === 'credits' ? ' (sign in)' : ' (no key saved)') : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="text-[var(--ink-60)] mt-0.5 leading-snug">
                On this device: {pct(g.localPassRate)} · cloud: {pct(g.cloudPassRate)}
                {now === 'local' && g.gate === 'labelled' && <> · {LOCAL_LABEL_COPY}</>}
                {now === 'local' && g.gate === 'cloud-only' && (
                  <> · Not run on this device; you are asked before each request whether to use cloud AI instead.</>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {st.cloudProviders.openai && <OpenAIModels st={st} busy={busy} />}
    </div>
  )
}

// Which OpenAI model serves each tier of request when OpenAI is used. The app's
// requests are sized fast / standard / best; the list comes from the account.
function OpenAIModels({ st, busy }: { st: LocalAiStatus; busy: boolean }): JSX.Element {
  const [models, setModels] = useState<string[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void window.api.localAi.listOpenAIModels().then((r) => {
      if (!live) return
      if (r.ok) setModels(r.models)
      else setErr(r.error ?? 'Could not list your OpenAI models.')
    })
    return () => {
      live = false
    }
  }, [])
  const tiers: Array<{ id: 'fast' | 'standard' | 'best'; label: string }> = [
    { id: 'fast', label: 'Quick requests' },
    { id: 'standard', label: 'Most requests' },
    { id: 'best', label: 'Hardest requests' }
  ]
  return (
    <div className="mt-2 fb-card rounded-[var(--radius-field)] px-2.5 py-1.5 fb-t-caption" data-testid="openai-models">
      <div className="text-[var(--ink-90)] font-medium mb-1">OpenAI models</div>
      {err && <div className="text-[var(--ink-50)] leading-snug mb-1">{err} The saved choices below still apply.</div>}
      {tiers.map((t) => {
        const current = st.openaiModels[t.id]
        const options = models && !models.includes(current) ? [current, ...models] : (models ?? [current])
        return (
          <label key={t.id} className="flex items-center gap-2 mt-0.5">
            <span className="flex-1 text-[var(--ink-70)]">{t.label}</span>
            <select
              value={current}
              disabled={busy || models === null}
              data-testid={`openai-model-${t.id}`}
              onChange={(e) => void window.api.localAi.setOpenAIModels({ [t.id]: e.target.value })}
              className="fb-t-caption bg-transparent border border-[var(--edge-soft)] rounded px-1 py-0.5"
            >
              {options.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        )
      })}
    </div>
  )
}

// One "n of m" pair. An incomplete count is weighted so a shortfall is visible
// at a glance — a gap the user cannot see is a gap they cannot act on.
function Stat({ n, of }: { n: number; of: number }): JSX.Element {
  const complete = of === 0 || n >= of
  return (
    <span className={complete ? 'text-[var(--ink-90)]' : 'text-[var(--ink-100)] font-semibold'}>
      {n} of {of}
    </span>
  )
}
