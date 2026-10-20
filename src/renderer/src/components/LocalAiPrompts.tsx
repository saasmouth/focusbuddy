import { useEffect, useState } from 'react'
import Icon from './Icon'
import Modal from './plexi/Modal'
import { openAiSettings } from '../stores/aiCredits'
import { useLocalAiEngine, LOCAL_WARMING_COPY } from '../lib/localAiEngine'
import type { CloudConsentRequest, GroundingReport, LocalAiStatus, LocalDownloadProgress } from '@shared/localAi'

// The two things Local AI says on its own, mounted once in App:
//
//   - "Use cloud for this request?" — raised by main when a request reaches a
//     feature the on-device model is not trusted with (measured; see
//     src/shared/localAiGates.ts). Nothing has been sent when this appears, and
//     nothing is sent unless the person says yes, for this one request.
//   - A short notice the first time in a session that a feature which works,
//     but less well, ran on the device ("works best with cloud AI; local
//     results may be incomplete").

export default function LocalAiPrompts(): JSX.Element | null {
  const [queue, setQueue] = useState<CloudConsentRequest[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [noticeAction, setNoticeAction] = useState<'upgrade' | 'topup'>('upgrade')
  const [grounding, setGrounding] = useState<GroundingReport | null>(null)
  // The installed app came without the model (an update zip, or it could not
  // be kept): AI must say so and offer the one-time download, never just fail.
  const [missing, setMissing] = useState<{ tierId: string; bytes: number } | null>(null)
  const [dl, setDl] = useState<LocalDownloadProgress | null>(null)
  const [dlError, setDlError] = useState<string | null>(null)

  useEffect(() => {
    const api = window.api?.localAi
    if (!api?.getStatus) return
    const check = (): void => {
      void api
        .getStatus()
        .then((st: LocalAiStatus) => {
          const routesLocal = st.provider === 'local' || Object.values(st.featureRoutes).includes('local')
          const tier = st.tiers.find((t) => t.id === st.activeTier)
          if (routesLocal && tier && !tier.installed) {
            setMissing({ tierId: tier.id, bytes: tier.sizeBytes + (st.embeddings.installed ? 0 : 146_146_432) })
          } else setMissing(null)
        })
        .catch(() => undefined)
    }
    check()
    const offC = api.onChanged(() => check())
    const offP = api.onProgress((p) => setDl(p))
    return () => {
      offC()
      offP()
    }
  }, [])

  useEffect(() => {
    const api = window.api?.localAi
    if (!api?.onConsentRequest) return
    const offConsent = api.onConsentRequest((r) => setQueue((q) => [...q, r]))
    const offNotice = api.onNotice((n) => {
      setNoticeAction(n.action ?? 'upgrade')
      setNotice(n.message)
    })
    const offGrounding = api.onGrounding?.((r) => setGrounding(r)) ?? (() => undefined)
    return () => {
      offConsent()
      offNotice()
      offGrounding()
    }
  }, [])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 12_000)
    return () => clearTimeout(t)
  }, [notice])

  // The one-time "local AI is now built in" notice (settingsStore.migrateAiMode).
  type Mode = 'auto' | 'credits' | 'byok' | 'local' | 'openai'
  const [intro, setIntro] = useState<{ from: Mode | null; mode: Mode } | null>(null)
  useEffect(() => {
    const api = window.api?.localAi
    if (!api?.getIntro) return
    void api
      .getIntro()
      .then((r) => setIntro(r.pending ? { from: r.from, mode: r.mode } : null))
      .catch(() => undefined)
  }, [])
  const closeIntro = (): void => {
    setIntro(null)
    void window.api.localAi.dismissIntro()
  }
  const switchTo = async (m: Mode): Promise<void> => {
    await window.api.ai.setMode(m)
    closeIntro()
  }

  // Catch-all for any surface without its own warm-up wording: while a request
  // is waiting on a cold load, say so once, app-wide.
  const engine = useLocalAiEngine()

  const current = queue[0]

  function answer(allow: boolean): void {
    if (!current) return
    void window.api.localAi.consentReply(current.id, allow)
    setQueue((q) => q.slice(1))
  }

  const MODE_LABEL: Record<Mode, string> = {
    auto: 'Plexii AI credits',
    credits: 'Plexii AI credits',
    byok: 'your Anthropic key',
    openai: 'your OpenAI key',
    local: 'on-device AI'
  }

  return (
    <>
      {engine.state === 'loading' && engine.waiting > 0 && (
        <div
          role="status"
          data-testid="local-ai-warming-chip"
          className="fixed top-14 right-4 z-[9997] fb-card rounded-[var(--radius-field)] px-3 py-1.5 shadow fb-t-caption text-[var(--ink-80)] flex items-center gap-2"
        >
          <Icon name="memory" size={13} /> {LOCAL_WARMING_COPY}
        </div>
      )}
      {intro && (
        <div
          role="status"
          data-testid="local-ai-intro"
          className="fixed bottom-12 left-1/2 -translate-x-1/2 z-[225] w-[min(420px,calc(100vw-32px))] fb-card rounded-[var(--radius-field)] px-3 py-2.5 shadow-lg fb-t-caption text-[var(--ink-80)] leading-snug"
        >
          <div className="font-medium text-[var(--ink-100)] mb-1">Local AI is now built in</div>
          <div>
            PlexiiDesk now includes an AI model that runs on this computer: it works offline, costs nothing per use, and
            sends nothing to any AI service. It is good at PlexiiAssist answers, summaries, rewrites and tidying titles;
            longer drafts and Build with AI are better on cloud AI.
          </div>
          <div className="mt-1 text-[var(--ink-60)]">
            {intro.mode === 'local'
              ? intro.from === 'auto'
                ? 'Your AI now runs on this computer.'
                : 'AI runs on this computer.'
              : `You are using ${MODE_LABEL[intro.mode]}; that has not changed.`}
          </div>
          <div className="flex flex-wrap gap-2 mt-2">
            {intro.mode !== 'local' ? (
              <button type="button" className="fb-btn-surface px-2 py-0.5 rounded" data-testid="local-ai-intro-use-local" onClick={() => void switchTo('local')}>
                Use local AI
              </button>
            ) : intro.from && intro.from !== 'local' ? (
              <button type="button" className="fb-btn-surface px-2 py-0.5 rounded" data-testid="local-ai-intro-switch-back" onClick={() => void switchTo(intro.from as Mode)}>
                Switch back to {MODE_LABEL[intro.from]}
              </button>
            ) : (
              <button
                type="button"
                className="fb-btn-surface px-2 py-0.5 rounded"
                onClick={() => {
                  closeIntro()
                  openAiSettings()
                }}
              >
                AI settings
              </button>
            )}
            <button type="button" className="underline text-[var(--ink-60)]" data-testid="local-ai-intro-dismiss" onClick={closeIntro}>
              Got it
            </button>
          </div>
        </div>
      )}
      {current && (
        <Modal
          onClose={() => answer(false)}
          label="Use cloud AI for this request?"
          z={9998}
          className="fb-card max-w-md w-full p-6"
          testId="local-ai-consent"
        >
          <div className="flex items-center gap-2 mb-2">
            <span className="h-8 w-8 inline-flex items-center justify-center rounded-lg bg-accent/15 text-accent">
              <Icon name="memory" size={16} />
            </span>
            <h2 className="text-base font-semibold text-[var(--ink-100)]">Use cloud AI for this request?</h2>
          </div>
          <p className="text-[13px] text-[var(--ink-70)] leading-relaxed mb-2" data-testid="local-ai-consent-reason">
            {current.reason}
          </p>
          <p className="text-[13px] text-[var(--ink-70)] leading-relaxed mb-4">
            AI is set to run on this device, so nothing has been sent. If you choose cloud, only this one request goes
            to cloud AI; everything else stays on the device.
          </p>
          {!current.cloudAvailable && (
            <p className="fb-t-caption text-amber-700 dark:text-amber-300 mb-3 leading-snug">
              Cloud AI is not set up yet: add your own Anthropic API key or sign in for Plexii AI credits in Settings →
              AI.
            </p>
          )}
          <div className="flex flex-wrap gap-2 justify-end">
            <button
              type="button"
              className="fb-t-caption px-3 py-1.5 fb-btn-surface fb-press text-[var(--ink-80)]"
              onClick={() => {
                answer(false)
                openAiSettings()
              }}
            >
              Settings
            </button>
            <button
              type="button"
              className="fb-t-caption px-3 py-1.5 fb-btn-surface fb-press text-[var(--ink-80)]"
              onClick={() => answer(false)}
              data-testid="local-ai-consent-no"
            >
              Keep it on this device
            </button>
            <button
              type="button"
              className="fb-t-caption px-3 py-1.5 rounded-[var(--radius-field)] bg-accent text-white fb-press disabled:opacity-50"
              onClick={() => answer(true)}
              disabled={!current.cloudAvailable}
              data-testid="local-ai-consent-yes"
            >
              Use cloud for this request
            </button>
          </div>
        </Modal>
      )}
      {missing && (
        <div
          role="status"
          className="fixed top-14 left-1/2 -translate-x-1/2 z-[9997] max-w-md fb-card rounded-[var(--radius-field)] px-3 py-2 shadow-lg fb-t-caption leading-snug"
          data-testid="local-ai-missing"
        >
          <div className="font-medium text-[var(--ink-90)]">Local AI needs a one-time download ({(missing.bytes / 1e9).toFixed(1)} GB)</div>
          <div className="text-[var(--ink-60)] mt-0.5">
            AI runs on this computer, but the model is not here yet. Until it is, AI features cannot answer.
          </div>
          {dl && dl.tierId === missing.tierId && ['checking', 'downloading', 'verifying'].includes(dl.state) ? (
            <div className="mt-1.5">
              <div className="h-1.5 rounded bg-[var(--surface-sunken)] overflow-hidden">
                <div className="h-full bg-accent" style={{ width: `${Math.min(100, (dl.receivedBytes / Math.max(1, dl.totalBytes)) * 100)}%` }} />
              </div>
              <div className="text-[var(--ink-50)] mt-0.5">
                {dl.state === 'verifying' ? 'Checking the file…' : `${(dl.receivedBytes / 1e9).toFixed(1)} of ${(dl.totalBytes / 1e9).toFixed(1)} GB`}
              </div>
            </div>
          ) : (
            <div className="flex gap-2 mt-1.5">
              <button
                type="button"
                className="fb-t-caption px-3 py-1 rounded-[var(--radius-field)] bg-accent text-white fb-press"
                data-testid="local-ai-missing-download"
                onClick={() => {
                  setDlError(null)
                  void window.api.localAi.download(missing.tierId).then((r) => {
                    if (!r.ok) setDlError(r.error ?? 'The download did not finish.')
                  })
                }}
              >
                Download
              </button>
              <button type="button" className="fb-t-caption px-3 py-1 fb-btn-surface fb-press text-[var(--ink-80)]" onClick={() => openAiSettings()}>
                Settings
              </button>
            </div>
          )}
          {dlError && <div className="text-rose-600 dark:text-rose-400 mt-1">{dlError}</div>}
        </div>
      )}
      {grounding && (
        <div
          role="status"
          className="fixed bottom-4 left-4 z-[9997] max-w-sm fb-card rounded-[var(--radius-field)] px-3 py-2 shadow-lg fb-t-caption leading-snug"
          data-testid="local-ai-grounding"
        >
          <div className="flex items-start gap-2 mb-1">
            <span className="flex-1 font-medium text-[var(--ink-90)]">Check these details</span>
            <button type="button" aria-label="Dismiss" className="text-[var(--ink-50)] hover:text-[var(--ink-100)]" onClick={() => setGrounding(null)}>
              ×
            </button>
          </div>
          <div className="text-[var(--ink-60)] mb-1">
            The {grounding.path === 'local' ? 'on-device model' : 'AI'} wrote specifics your request did not give it.
          </div>
          {grounding.repaired.length > 0 && (
            <div className="mb-1" data-testid="local-ai-grounding-repaired">
              <div className="text-[var(--ink-70)]">Replaced with a placeholder for you to fill in:</div>
              {grounding.repaired.map((f, i) => (
                <div key={`r${i}`} className="text-rose-700 dark:text-rose-300">
                  <span className="line-through">{f.span}</span> <span className="text-[var(--ink-50)]">({f.kind})</span>
                </div>
              ))}
            </div>
          )}
          {grounding.flagged.length > 0 && (
            <div data-testid="local-ai-grounding-flagged">
              <div className="text-[var(--ink-70)]">Check these before you use them:</div>
              {grounding.flagged.map((f, i) => (
                <div
                  key={`f${i}`}
                  title={f.reason}
                  data-confidence={f.confidence}
                  className={
                    f.confidence === 'high'
                      ? 'text-rose-700 dark:text-rose-300 font-medium'
                      : f.confidence === 'medium'
                        ? 'text-amber-700 dark:text-amber-300'
                        : 'text-[var(--ink-50)]'
                  }
                >
                  {f.span}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="fixed bottom-4 right-4 z-[9997] max-w-xs fb-card rounded-[var(--radius-field)] px-3 py-2 shadow-lg fb-t-caption text-[var(--ink-80)] leading-snug flex gap-2 items-start"
          data-testid="local-ai-notice"
        >
          <span className="flex-1">
            {notice}{' '}
            <button
              type="button"
              className="underline text-[var(--ink-100)]"
              data-testid="local-ai-notice-upgrade"
              onClick={() => {
                setNotice(null)
                openAiSettings()
              }}
            >
              {noticeAction === 'topup' ? 'Top up credits' : 'Upgrade with your own Anthropic or OpenAI key'}
            </button>
          </span>
          <button type="button" aria-label="Dismiss" className="text-[var(--ink-50)] hover:text-[var(--ink-100)]" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}
    </>
  )
}
