import { useEffect, useState } from 'react'
import Icon from './Icon'
import Modal from './plexi/Modal'
import { openAiSettings } from '../stores/aiCredits'
import type { CloudConsentRequest, GroundingReport } from '@shared/localAi'

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
  const [grounding, setGrounding] = useState<GroundingReport | null>(null)

  useEffect(() => {
    const api = window.api?.localAi
    if (!api?.onConsentRequest) return
    const offConsent = api.onConsentRequest((r) => setQueue((q) => [...q, r]))
    const offNotice = api.onNotice((n) => setNotice(n.message))
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

  const current = queue[0]

  function answer(allow: boolean): void {
    if (!current) return
    void window.api.localAi.consentReply(current.id, allow)
    setQueue((q) => q.slice(1))
  }

  return (
    <>
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
          <span className="flex-1">{notice}</span>
          <button type="button" aria-label="Dismiss" className="text-[var(--ink-50)] hover:text-[var(--ink-100)]" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}
    </>
  )
}
