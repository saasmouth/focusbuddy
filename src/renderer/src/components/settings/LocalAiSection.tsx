import { useEffect, useState } from 'react'
import {
  AI_FEATURES,
  AI_FEATURE_COPY,
  LOCAL_LABEL_COPY,
  type AiFeature,
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
    enriched: number
    memoryScanned: number
  }
  files: { total: number; indexed: number }
  conversations: { total: number; indexed: number }
  knowledge: { total: number }
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
                  {t.installed ? (
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
          {st?.engine.state === 'error' && st.engine.error && (
            <div className="fb-t-caption text-rose-600 dark:text-rose-400 mt-1 leading-snug">{st.engine.error}</div>
          )}
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
            {' · '}Ranked by meaning: <Stat n={coverage.documents.embedded} of={coverage.documents.withText} />
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

function FeatureRoutes({
  st,
  busy,
  onChange
}: {
  st: LocalAiStatus
  busy: boolean
  onChange: (f: AiFeature, route: 'local' | 'cloud' | null) => void
}): JSX.Element {
  const globalLocal = st.provider === 'local'
  return (
    <div className="mt-2" data-testid="local-ai-features">
      <div className="fb-t-caption uppercase tracking-wider text-[var(--ink-50)] mb-1">Feature by feature</div>
      <div className="fb-t-caption text-[var(--ink-50)] leading-snug mb-1.5">
        Pass rates are from our test of the app’s real prompts, on the on-device model and on cloud AI.
      </div>
      <div className="space-y-1">
        {AI_FEATURES.map((f) => {
          const g = st.gates[f]
          const route = st.featureRoutes[f] ?? null
          const effective = route ?? (globalLocal ? 'local' : 'cloud')
          return (
            <div key={f} className="fb-card rounded-[var(--radius-field)] px-2.5 py-1.5 fb-t-caption" data-testid={`local-ai-feature-${f}`}>
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-[var(--ink-90)] font-medium">{AI_FEATURE_COPY[f].label}</div>
                  <div className="text-[var(--ink-50)] leading-snug">{AI_FEATURE_COPY[f].covers}</div>
                </div>
                <select
                  aria-label={`Where ${AI_FEATURE_COPY[f].label} runs`}
                  value={route ?? 'default'}
                  disabled={busy}
                  onChange={(e) => onChange(f, e.target.value === 'default' ? null : (e.target.value as 'local' | 'cloud'))}
                  className="fb-t-caption bg-transparent border border-[var(--edge-soft)] rounded px-1 py-0.5"
                >
                  <option value="default">Follow AI source ({globalLocal ? 'local' : 'cloud'})</option>
                  <option value="local">On this device</option>
                  <option value="cloud">Cloud AI</option>
                </select>
              </div>
              <div className="text-[var(--ink-60)] mt-0.5 leading-snug">
                On this device: {pct(g.localPassRate)} · cloud: {pct(g.cloudPassRate)}
                {effective === 'local' && g.gate === 'labelled' && <> · {LOCAL_LABEL_COPY}</>}
                {effective === 'local' && g.gate === 'cloud-only' && (
                  <> · Not run on this device; you are asked before each request whether to use cloud AI instead.</>
                )}
              </div>
            </div>
          )
        })}
      </div>
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
