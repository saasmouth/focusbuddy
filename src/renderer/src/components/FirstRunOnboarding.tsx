import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useOnboarding, CORE_MODULE_ID } from '../stores/onboarding'
import { useNodeStore } from '../stores/nodes'
import { useViewStore } from '../stores/view'
import Icon from './Icon'
import PlexiiMark from './brand/PlexiiMark'

// First-run onboarding — shown once to a genuinely fresh install (see the
// onboarding store, which grandfathers existing users). Three steps: a short
// welcome, a guided API-key paste that actually tests the key, and an optional
// starter workspace so the canvas isn't a blank void. Every step is skippable;
// the goal is to get a new person to "I can see it working" fast.

const ANTHROPIC_KEYS_URL = 'https://console.anthropic.com/settings/keys'

type KeyStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'testing' }
  | { kind: 'ok'; model?: string }
  | { kind: 'error'; message: string }

export default function FirstRunOnboarding(): JSX.Element | null {
  // The core flow is now one module of the modular onboarding system, so it can
  // be replayed at any time (the tour hub / command palette call start('core')).
  const activeModuleId = useOnboarding((s) => s.activeModuleId)
  const complete = useOnboarding((s) => s.complete)
  const skip = useOnboarding((s) => s.skip)
  const refreshNodes = useNodeStore((s) => s.refresh)
  const goTask = useViewStore((s) => s.goTask)

  const [step, setStep] = useState(0)
  const [key, setKey] = useState('')
  const [keyStatus, setKeyStatus] = useState<KeyStatus>({ kind: 'idle' })
  const [seeding, setSeeding] = useState(false)
  const [seedError, setSeedError] = useState<string | null>(null)

  const isActive = activeModuleId === CORE_MODULE_ID
  // Reset to the first step each time the core module (re)opens, so a replay
  // starts from the top rather than wherever the last run left off.
  useEffect(() => {
    if (isActive) {
      setStep(0)
      setKey('')
      setKeyStatus({ kind: 'idle' })
      setSeedError(null)
    }
  }, [isActive])

  // Every step is skippable, so Escape always is too — no state can strand a
  // new user inside their very first dialog. Ignored only mid-seed.
  useEffect(() => {
    if (!isActive || seeding) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      skip()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, seeding])

  if (!isActive) return null

  async function testAndSaveKey(): Promise<void> {
    const pasted = key.trim()
    if (!pasted) return
    setKeyStatus({ kind: 'saving' })
    const saved = await window.api.settings.saveAnthropicKey(pasted)
    if (!saved.ok) {
      setKeyStatus({ kind: 'error', message: saved.error ?? 'Could not save that key.' })
      return
    }
    setKeyStatus({ kind: 'testing' })
    const test = await window.api.settings.testAnthropicKey()
    if (test.ok) {
      setKeyStatus({ kind: 'ok', model: test.model })
    } else {
      setKeyStatus({
        kind: 'error',
        message: test.error ?? 'That key was saved but a test call failed.'
      })
    }
  }

  // Seed a small, real starter so the sidebar and canvas aren't empty. Not fake
  // data — a genuinely useful first task with an orientation note on its canvas.
  async function createStarter(): Promise<void> {
    setSeeding(true)
    setSeedError(null)
    try {
      const folder = await window.api.nodes.create({
        parentId: null,
        kind: 'folder',
        title: 'Getting started'
      })
      const firstTask = await window.api.nodes.create({
        parentId: folder.id,
        kind: 'task',
        title: 'Your first focus session'
      })
      await window.api.nodes.create({
        parentId: folder.id,
        kind: 'task',
        title: 'Try Plexii — describe a workspace and let it build'
      })
      await window.api.widgets.create({
        taskId: firstTask.id,
        kind: 'sticky',
        title: '',
        content:
          'Welcome.\n\nThis is your desk. Add tools with + Widget, or ask Plexii (⌘⇧K) — describe what you want and it builds the widgets for you. Plexii is also the pill at the bottom right whenever you need help thinking through a task.\n\nPress the play button on a task to start a 5-minute focus session.',
        x: 160,
        y: 160,
        width: 280,
        height: 200
      })
      await refreshNodes()
      finish(() => goTask(firstTask.id))
    } catch {
      // Never strand the user on the last step: surface the failure and leave
      // both Start blank and a retry available.
      setSeedError('Could not create the starter workspace. Try again, or start blank.')
    } finally {
      setSeeding(false)
    }
  }

  function finish(after?: () => void): void {
    complete()
    after?.()
  }

  return createPortal(
    <div
      className="fb-scrim fixed inset-0 z-[240] flex items-center justify-center"
      role="dialog"
      aria-label="Welcome to PlexiDesk"
      aria-modal="true"
    >
      {/* Onboarding stage: forced-dark card in every theme; hairlines are relative to the stage. */}
      <div className="w-[560px] max-w-[92vw] rounded-2xl bg-[rgba(16,24,39,0.96)] border border-white/10 shadow-2xl overflow-hidden text-stone-100">
        {/* Progress dots */}
        <div className="flex items-center gap-1.5 px-6 pt-5">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={`h-1 rounded-full transition-all ${
                i === step ? 'w-6 bg-accent' : i < step ? 'w-3 bg-accent/50' : 'w-3 bg-white/15'
              }`}
            />
          ))}
        </div>

        {step === 0 && (
          <div className="px-6 py-6">
            {/* Hero surface: the wordmark with the master artwork's gradient ii,
                allowed to live-loop here — onboarding is the one celebratory door. */}
            <PlexiiMark wordmark gradient height={40} letterColor="#FFFFFF" motion="loop" className="mb-4" />
            <h1 className="text-2xl font-semibold mb-2">Welcome to PlexiDesk</h1>
            <p className="text-[14px] text-stone-300 leading-relaxed mb-1">
              A glass-canvas workspace where notes, pages, tables, browsers and timers live side by
              side. Describe what you need and the AI builds it onto your desk.
            </p>
            <p className="text-[13px] text-stone-400 leading-relaxed">
              A key, a quick tour, and you are working. About a minute, and you can skip any step.
            </p>
            <div className="flex items-center justify-between mt-6">
              <button onClick={() => skip()} className="text-[13px] text-stone-400 hover:text-stone-200" data-testid="onboarding-skip-all">
                Skip for now
              </button>
              <button onClick={() => setStep(1)} className="btn-primary">
                <span>Get started</span>
                <Icon name="arrow_forward" size={14} />
              </button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="px-6 py-6">
            <h2 className="text-xl font-semibold mb-2">Turn on the AI helper (optional)</h2>
            <p className="text-[13px] text-stone-300 leading-relaxed mb-3">
              Everything in PlexiDesk works without this step, so feel free to skip it. The AI
              features run on a personal access key from Anthropic, which keeps you in control of
              cost and data. If someone set PlexiDesk up for you, ask them for the key; otherwise the
              link below walks you through getting one. You can always add it later in Settings.
            </p>
            <button
              onClick={() => void window.api.files.openExternal(ANTHROPIC_KEYS_URL)}
              className="text-[12px] text-accent hover:underline underline-offset-2 mb-3 inline-flex items-center gap-1"
            >
              <Icon name="open_in_new" size={12} />
              <span>Get a key from the Anthropic console</span>
            </button>
            <input
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              type="password"
              value={key}
              onChange={(e) => {
                setKey(e.target.value)
                if (keyStatus.kind !== 'idle') setKeyStatus({ kind: 'idle' })
              }}
              placeholder="sk-ant-api03-…"
              data-testid="onboarding-key-input"
              className="w-full bg-stone-800 border border-stone-600 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
            />
            {keyStatus.kind === 'ok' && (
              <div className="mt-2 text-[12px] text-emerald-400 inline-flex items-center gap-1.5">
                <Icon name="check_circle" size={13} />
                <span>Key works{keyStatus.model ? ` · ${keyStatus.model}` : ''}. AI is on.</span>
              </div>
            )}
            {keyStatus.kind === 'error' && (
              <div className="mt-2 text-[12px] text-red-400 inline-flex items-center gap-1.5">
                <Icon name="error_outline" size={13} />
                <span>{keyStatus.message}</span>
              </div>
            )}

            <div className="flex items-center justify-between mt-6">
              <button
                onClick={() => setStep(2)}
                className="btn-ghost !text-[13px]"
                data-testid="onboarding-key-skip"
              >
                <span>Skip, set up AI later</span>
              </button>
              <div className="flex items-center gap-2">
                {keyStatus.kind === 'ok' ? (
                  <button onClick={() => setStep(2)} className="btn-primary">
                    <span>Continue</span>
                    <Icon name="arrow_forward" size={14} />
                  </button>
                ) : (
                  <button
                    onClick={() => void testAndSaveKey()}
                    disabled={!key.trim() || keyStatus.kind === 'saving' || keyStatus.kind === 'testing'}
                    className="btn-primary"
                    data-testid="onboarding-key-test"
                  >
                    <Icon name="bolt" size={14} />
                    <span>
                      {keyStatus.kind === 'saving'
                        ? 'Saving…'
                        : keyStatus.kind === 'testing'
                          ? 'Testing…'
                          : 'Test & save'}
                    </span>
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="px-6 py-6">
            <h2 className="text-xl font-semibold mb-2">What is inside</h2>
            <p className="text-[13px] text-stone-300 leading-relaxed mb-4">
              Everything lives in the left sidebar. Here is the quick map so you know where to reach
              for each thing. If you belong to more than one organisation, the switcher at the top of
              the sidebar swaps the whole workspace between them.
            </p>
            <div className="grid grid-cols-2 gap-2.5" data-testid="onboarding-tour">
              {[
                // Keep this map in step with the live 3-segment IA (PlexiDesk /
                // PlexiOffice / PlexiBrain); the review flagged that it had
                // fallen behind the suite and newer surfaces were undiscoverable.
                { icon: 'dashboard', name: 'Home & Tasks', blurb: 'Your desks and to-dos, each with its own glass canvas.' },
                { icon: 'description', name: 'Documents', blurb: 'Word, Excel and PowerPoint-class docs, sheets and slides.' },
                { icon: 'folder', name: 'Files', blurb: 'A folder library for any file, with views and sorting.' },
                { icon: 'calendar_month', name: 'Calendar', blurb: 'Time-block your day and plan focus sessions.' },
                { icon: 'mail', name: 'Mail', blurb: 'Read and reply to email, and turn any message into a task.' },
                { icon: 'forum', name: 'Chat, calls & meetings', blurb: 'Message teammates, jump on a call, meet from any document.' },
                { icon: 'public', name: 'People Map', blurb: 'See who is online across your organisation, and where.' },
                { icon: 'lock', name: 'Vault & Sign', blurb: 'Encrypted passwords, plus documents sent for signature.' }
              ].map((s) => (
                <div key={s.name} className="flex gap-2.5 rounded-lg bg-white/5 border border-white/10 px-3 py-2.5">
                  <Icon name={s.icon} size={18} className="text-accent shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-stone-100">{s.name}</div>
                    <div className="text-[11px] text-stone-400 leading-snug">{s.blurb}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between mt-6">
              <button onClick={() => setStep(3)} className="text-[13px] text-stone-400 hover:text-stone-200">
                Skip
              </button>
              <button onClick={() => setStep(3)} className="btn-primary" data-testid="onboarding-tour-continue">
                <span>Continue</span>
                <Icon name="arrow_forward" size={14} />
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="px-6 py-6">
            <h2 className="text-xl font-semibold mb-2">A place to start</h2>
            <p className="text-[13px] text-stone-300 leading-relaxed mb-4">
              Want a small starter workspace so your desk isn&apos;t empty? It adds a “Getting
              started” folder with a first task and a short note on its canvas. You can delete it any
              time.
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => void createStarter()}
                disabled={seeding}
                className="btn-primary justify-center"
                data-testid="onboarding-create-starter"
              >
                <Icon name="auto_awesome" size={14} />
                <span>{seeding ? 'Setting up…' : 'Create a starter workspace'}</span>
              </button>
              <button
                onClick={() => finish()}
                disabled={seeding}
                className="btn-ghost justify-center"
                data-testid="onboarding-start-blank"
              >
                <span>Start blank</span>
              </button>
            </div>
            {seedError && (
              <div className="mt-3 text-[12px] text-red-400 inline-flex items-center gap-1.5" data-testid="onboarding-seed-error">
                <Icon name="error_outline" size={13} />
                <span>{seedError}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
