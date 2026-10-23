import { useEffect, useState, useRef } from 'react'
import { CORNER_PRIORITY, useCornerSlot } from '../lib/cornerStack'
import Icon from './Icon'
import Modal from './plexi/Modal'
import { openAiSettings, useAiCreditsStore } from '../stores/aiCredits'
import { useLocalAiEngine, LOCAL_WARMING_COPY, startAnsweredTracking } from '../lib/localAiEngine'
import { introView, missingBanner, MODE_LABEL, gb, type AiModeName, type IntroInfo, type IntroView, type MissingBanner } from '../lib/localAiOffer'
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
//   - The one-time local-AI card: "now built in" with a verified model, or an
//     opt-in download offer without one (lib/localAiOffer.introView).
//   - "Local AI needs a one-time download", only while a feature really routes
//     to a model that is not here (lib/localAiOffer.missingBanner).
// The last two are dismissible and never shown over AI that works on another
// engine.

// The banner's dismissal lasts for the session (it returns next launch while
// the model is still missing, because AI set to run here still cannot answer).
let missingDismissedThisSession = false

export default function LocalAiPrompts(): JSX.Element | null {
  const [queue, setQueue] = useState<CloudConsentRequest[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  // The notice docks bottom-right, so it takes a slot in the corner stack
  // (lib/cornerStack) instead of landing on the minimap and on whatever else
  // is already there. Quieter than a call or an invite, louder than a toast.
  const noticeRef = useRef<HTMLDivElement>(null)
  const noticeCorner = useCornerSlot('local-ai-notice', CORNER_PRIORITY.notice, !!notice, noticeRef)
  const [noticeAction, setNoticeAction] = useState<'upgrade' | 'topup' | 'keys'>('upgrade')
  const [grounding, setGrounding] = useState<GroundingReport | null>(null)
  // AI set to run on this computer, with the model not here (it was chosen by
  // hand, or the model was deleted): say so and offer the one-time download,
  // never just fail. Dismissible.
  const [missing, setMissing] = useState<MissingBanner | null>(null)
  const [missingDismissed, setMissingDismissed] = useState(missingDismissedThisSession)
  const [dl, setDl] = useState<LocalDownloadProgress | null>(null)
  const [dlError, setDlError] = useState<string | null>(null)

  // The one-time card (settingsStore.migrateAiMode): re-read whenever local-AI
  // state changes, because a fresh install's bundled model finishes its check,
  // or a download completes, after the window is up.
  const [intro, setIntro] = useState<IntroInfo | null>(null)
  // The variant the person closed; a different one (the offer, then "now
  // built in" once the download completes) still shows.
  const [closedView, setClosedView] = useState<IntroView | null>(null)

  useEffect(() => {
    const api = window.api?.localAi
    if (!api?.getStatus) return
    const check = (): void => {
      void api
        .getStatus()
        .then((st: LocalAiStatus) => setMissing(missingBanner(st)))
        .catch(() => undefined)
    }
    const readIntro = (): void => {
      if (!api.getIntro) return
      void api
        .getIntro()
        .then((r) => setIntro({ pending: r.pending, from: r.from, mode: r.mode, contentKey: r.contentKey ?? null, model: r.model }))
        .catch(() => undefined)
    }
    check()
    readIntro()
    const offC = api.onChanged(() => {
      check()
      readIntro()
      // The source may have changed under the Settings view (a deferred switch
      // to Local completing): refresh what the AI source chooser shows.
      void useAiCreditsStore.getState().sync?.()
    })
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

  type Mode = AiModeName
  const rawView = introView(intro)
  const view: IntroView = rawView === closedView ? 'none' : rawView
  const closeIntro = (): void => {
    setClosedView(rawView)
    void window.api.localAi.dismissIntro()
  }
  const switchTo = async (m: Mode): Promise<void> => {
    await window.api.ai.setMode(m)
    closeIntro()
  }
  const startDownload = (tierId: string): void => {
    setDlError(null)
    void window.api.localAi
      .download(tierId)
      .then((r) => {
        if (!r.ok) setDlError(r.error ?? 'The download did not finish.')
      })
      .catch((e: Error) => setDlError(e.message || 'The download did not finish.'))
  }
  const downloadingTier = (tierId: string | null | undefined): boolean =>
    !!dl && !!tierId && dl.tierId === tierId && ['checking', 'downloading', 'verifying'].includes(dl.state)

  // Catch-all for any surface without its own warm-up wording: while a request
  // is waiting on a cold load, say so once, app-wide.
  const engine = useLocalAiEngine()
  useEffect(() => startAnsweredTracking(), [])

  const current = queue[0]

  function answer(allow: boolean): void {
    if (!current) return
    void window.api.localAi.consentReply(current.id, allow)
    setQueue((q) => q.slice(1))
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
      {/* Both intro cards sit UNDER modals (Modal's default z is 200, the release
          modal's scrim too) and over the assistant's takeover (190): at z-225 the
          card covered the release modal's Got it, the one way out of it after an
          update (releaseAndTooltip RM-1). */}
      {intro && view === 'offer' && intro.model && (
        <div
          role="status"
          data-testid="local-ai-intro"
          data-variant="offer"
          className="fixed bottom-12 left-1/2 -translate-x-1/2 z-[198] w-[min(420px,calc(100vw-32px))] fb-card rounded-[var(--radius-field)] px-3 py-2.5 shadow-lg fb-t-caption text-[var(--ink-80)] leading-snug"
        >
          <div className="font-medium text-[var(--ink-100)] mb-1">Local AI is available as a download</div>
          <div>
            PlexiiDesk can run AI on this computer: it works offline, costs nothing per use, and sends nothing to any AI
            service. It needs a one-time download of {gb(intro.model.bytes)}.
          </div>
          <div className="mt-1 text-[var(--ink-60)]" data-testid="local-ai-intro-unchanged">
            You are using {MODE_LABEL[intro.mode]}; that has not changed. You can download it later in Settings › AI ›
            Local on this device.
          </div>
          {downloadingTier(intro.model.tierId) && dl ? (
            <div className="mt-1.5" data-testid="local-ai-intro-progress">
              <div className="h-1.5 rounded bg-[var(--surface-sunken)] overflow-hidden">
                <div className="h-full bg-accent" style={{ width: `${Math.min(100, (dl.receivedBytes / Math.max(1, dl.totalBytes)) * 100)}%` }} />
              </div>
              <div className="flex items-center gap-2 text-[var(--ink-50)] mt-0.5">
                <span className="flex-1">
                  {dl.state === 'verifying' ? 'Checking the file…' : `${gb(dl.receivedBytes)} of ${gb(dl.totalBytes)}`}
                </span>
                <button type="button" className="underline" data-testid="local-ai-intro-cancel" onClick={() => void window.api.localAi.cancelDownload()}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2 mt-2">
              <button
                type="button"
                className="fb-t-caption px-3 py-1 rounded-[var(--radius-field)] bg-accent text-white fb-press"
                data-testid="local-ai-intro-download"
                onClick={() => startDownload(intro.model!.tierId!)}
              >
                Download ({gb(intro.model.bytes)})
              </button>
              {/* Not "Not now": tests/e2e/_helpers.waitForReady dismisses the launch
                  sign-in modal by a button named /continue without account|skip|not now/,
                  and a second match makes that locator ambiguous, leaving the modal up. */}
              <button type="button" className="underline text-[var(--ink-60)]" data-testid="local-ai-intro-dismiss" onClick={closeIntro}>
                Maybe later
              </button>
            </div>
          )}
          {dlError && (
            <div className="text-rose-600 dark:text-rose-400 mt-1" data-testid="local-ai-intro-error">
              {dlError}
            </div>
          )}
        </div>
      )}
      {intro && view === 'built-in' && (
        <div
          role="status"
          data-testid="local-ai-intro"
          className="fixed bottom-12 left-1/2 -translate-x-1/2 z-[198] w-[min(420px,calc(100vw-32px))] fb-card rounded-[var(--radius-field)] px-3 py-2.5 shadow-lg fb-t-caption text-[var(--ink-80)] leading-snug"
        >
          <div className="font-medium text-[var(--ink-100)] mb-1">Local AI is now built in</div>
          <div>
            PlexiiDesk now includes an AI model that runs on this computer: it works offline, costs nothing per use, and
            sends nothing to any AI service. It is good at PlexiiAssist answers, summaries and tidying titles; writing,
            documents and Build with AI are better on cloud AI.
          </div>
          {intro.mode === 'local' && (
            <div className="mt-1" data-testid="local-ai-intro-content">
              {intro.contentKey
                ? `Writing, documents and Build with AI use your own ${intro.contentKey === 'anthropic' ? 'Anthropic' : 'OpenAI'} key, because you have one saved; everything else stays on this computer.`
                : 'Writing, documents and Build with AI run here too, with a note that cloud AI does them better. Save your own Anthropic or OpenAI key and they will use it.'}
            </div>
          )}
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
      {missing && !missingDismissed && view !== 'offer' && (
        <div
          role="status"
          className="fixed top-14 left-1/2 -translate-x-1/2 z-[9997] max-w-md fb-card rounded-[var(--radius-field)] px-3 py-2 shadow-lg fb-t-caption leading-snug"
          data-testid="local-ai-missing"
        >
          <div className="flex items-start gap-2">
            <div className="flex-1 font-medium text-[var(--ink-90)]">Local AI needs a one-time download ({gb(missing.bytes)})</div>
            <button
              type="button"
              aria-label="Dismiss"
              data-testid="local-ai-missing-dismiss"
              className="text-[var(--ink-50)] hover:text-[var(--ink-100)]"
              onClick={() => {
                missingDismissedThisSession = true
                setMissingDismissed(true)
              }}
            >
              ×
            </button>
          </div>
          <div className="text-[var(--ink-60)] mt-0.5" data-testid="local-ai-missing-scope">
            {missing.all
              ? 'AI is set to run on this computer, but the model is not here yet. Until it is downloaded, AI features cannot answer; or choose another AI source in Settings › AI.'
              : `${missing.features.join(', ')} ${missing.features.length === 1 ? 'is' : 'are'} set to run on this computer, but the model is not here yet. Until it is downloaded, ${missing.features.length === 1 ? 'that feature cannot' : 'those features cannot'} answer; everything else is unaffected.`}
          </div>
          {downloadingTier(missing.tierId) && dl ? (
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
                onClick={() => startDownload(missing.tierId)}
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
      {notice && noticeCorner.visible && (
        <div
          ref={noticeRef}
          style={{ bottom: noticeCorner.bottom, right: noticeCorner.right }}
          role="status"
          className="fixed z-[9997] max-w-xs fb-card rounded-[var(--radius-field)] px-3 py-2 shadow-lg fb-t-caption text-[var(--ink-80)] leading-snug flex gap-2 items-start"
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
              {noticeAction === 'topup' ? 'Top up credits' : noticeAction === 'keys' ? 'Check your API keys' : 'Upgrade with your own Anthropic or OpenAI key'}
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
