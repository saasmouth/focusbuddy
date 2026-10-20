import { useEffect } from 'react'
import Icon from './Icon'

interface Props {
  onClose: () => void
}

export default function TermsModal({ onClose }: Props): JSX.Element {
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fb-scrim fixed inset-0 z-[180] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="fb-card fb-press w-full max-w-lg mx-4 overflow-hidden flex flex-col max-h-[85vh]"
      >
        <div className="px-5 py-4 border-b border-[var(--edge-soft)] flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2">
            <Icon name="gavel" size={18} className="text-[var(--ink-70)]" />
            <h3 className="text-base font-semibold text-[var(--ink-100)]">
              Terms of Use
            </h3>
          </div>
          <button onClick={onClose} className="icon-btn" aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-4 text-sm text-[var(--ink-70)] leading-relaxed">
          <section>
            <h4 className="text-[var(--ink-100)] font-semibold mb-1.5">1. Local-first, with sync when you sign in</h4>
            <p>
              PlexiiDesk is local-first. Your tasks, work widgets, documents, browsing history and
              preferences are saved on your device first. While you are signed in, cloud sync keeps
              your workspace in step across your devices through PlexiiDesk's servers, and sharing,
              chat and meetings exchange content with the people you include. Mail and calendars you
              connect talk straight to your provider. Even signed out, the app checks for updates and
              fetches link icons and map tiles; Settings › Data › Privacy lists everything that
              leaves your computer. Usage data and crash reports are sent only if you turn them on. You can export your data at any time, and keeping your own backups of work that
              matters is still wise.
            </p>
          </section>

          <section>
            <h4 className="text-[var(--ink-100)] font-semibold mb-1.5">2. AI features and where requests go</h4>
            <p>
              AI runs one of two ways. With your own Anthropic key, pasted under{' '}
              <strong>Settings → AI · API keys</strong>, the assistant, AI Setup and resume features
              call Anthropic's API directly from the app. The key is encrypted with your system
              keychain and is sent only as part of those outbound requests. On a managed plan,
              PlexiiBrain requests are relayed through PlexiiDesk's server to Anthropic instead. Either
              way, AI requests include the workspace content needed to answer them, and you are
              responsible for the usage on your own key.
            </p>
          </section>

          <section>
            <h4 className="text-[var(--ink-100)] font-semibold mb-1.5">3. AI output is best-effort</h4>
            <p>
              The assistant can be wrong, miss context, or hallucinate. Treat its suggestions as a
              starting point — not as advice or instruction. Verify anything important before
              acting on it.
            </p>
          </section>

          <section>
            <h4 className="text-[var(--ink-100)] font-semibold mb-1.5">4. Embedded browsers and third-party sites</h4>
            <p>
              Pages you open in browser work widgets are loaded directly from the source. Their terms,
              cookies, and tracking are governed by those sites, not PlexiiDesk. Avoid logging in
              to anything you wouldn't want stored in this Electron app's profile.
            </p>
          </section>

          <section>
            <h4 className="text-[var(--ink-100)] font-semibold mb-1.5">5. No warranty</h4>
            <p>
              The software is provided "as is," without warranty of any kind. The author is not
              liable for lost work, missed deadlines, or any indirect damages. Keep your own
              backups of work that matters.
            </p>
          </section>

          <section>
            <h4 className="text-[var(--ink-100)] font-semibold mb-1.5">6. ADHD-friendly disclaimer</h4>
            <p>
              PlexiiDesk is a productivity tool, not a medical or therapeutic device. It is not a
              replacement for medication, therapy, or professional support for ADHD or executive
              dysfunction. If something here helps — great. If it doesn't — your brain isn't
              broken, this tool just isn't the right fit.
            </p>
          </section>

          <section className="text-[11px] text-[var(--ink-50)] pt-2 border-t border-[var(--edge-soft)]">
            Last updated 20 August 2026.
          </section>
        </div>

        <div className="px-5 py-3 border-t border-[var(--edge-soft)] bg-[var(--surface-sunken)] shrink-0 flex justify-end">
          <button onClick={onClose} className="btn-ghost">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
