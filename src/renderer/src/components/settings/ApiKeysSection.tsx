// API-key vault section of the Settings panel.
//
// Plaintext never lives in the renderer for longer than the moment after
// the user pastes it — we send the value to main via the per-provider
// save IPC, which encrypts via Electron's safeStorage and persists to
// disk. We then drop the input state and rerender from the
// `{ hasKey, last4 }` hint returned by main.
//
// Two providers as of June 2026: Anthropic (canvas AI + chat) and
// OpenAI (Whisper for voice-note transcription). Each gets a row
// rendered by the shared <ApiKeyRow> component. Adding a third = pass
// new props to a new <ApiKeyRow>; no further changes here.

import { useEffect, useState } from 'react'
import LocalAiSection from './LocalAiSection'
import { confirmDialog } from '../plexi/PromptDialog'
import CreditsMeter from '../CreditsMeter'
import { useAiCreditsStore } from '../../stores/aiCredits'
import { promptUpgrade } from '../../stores/upgradePrompt'
import { useVerifyEmailStore } from '../../stores/verifyEmail'
import { TOP_UP_PACKS, type AiCreditStatus } from '@shared/aiCredits'

type Status =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'testing' }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string }

interface Props {
  onKeySaved?: () => void
}

interface ProviderSurface {
  hint: () => Promise<{ hasKey: boolean; last4: string | null }>
  save: (
    plaintext: string
  ) => Promise<{ ok: boolean; hasKey?: boolean; last4?: string | null; error?: string }>
  clear: () => Promise<{ ok: boolean; error?: string }>
  test: () => Promise<{ ok: boolean; model?: string; error?: string }>
}

interface ProviderConfig {
  // Display name shown above the row.
  label: string
  // One-line description of what this key powers, shown directly under the
  // label so it's obvious which key voice transcription needs (the #1 thing
  // users hunt for — "where do I put the key for voice?").
  purpose: string
  // Placeholder hint inside the password field — helps users spot a
  // wrong-vendor paste before they hit Save.
  placeholder: string
  // External link to wherever the user gets the key.
  helpUrl: string
  helpLabel: string
  // Used inside the confirm() copy on Clear so the warning explains
  // exactly what stops working.
  removeWarning: string
  // The IPC surface specific to this provider.
  api: ProviderSurface
}

export default function ApiKeysSection({ onKeySaved }: Props): JSX.Element {
  const [encryption, setEncryption] = useState<boolean | null>(null)
  const [usage, setUsage] = useState<{ calls: number; inTok: number; outTok: number; costUsd: number } | null>(null)

  useEffect(() => {
    void window.api.settings.encryptionAvailable().then(setEncryption)
    void window.api.ai
      .collectTelemetry()
      .then((t) =>
        setUsage({ calls: t.aiCalls, inTok: t.aiInputTokens, outTok: t.aiOutputTokens, costUsd: t.aiEstCostUsd })
      )
      .catch(() => setUsage(null))
  }, [])

  const fmt = (n: number): string => (n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1e3).toFixed(1)}k` : String(n))

  return (
    <div className="px-3 py-3 border-t border-[var(--edge-soft)] space-y-3">
      <div className="fb-t-caption uppercase tracking-[0.12em] font-medium">
        AI · source
      </div>

      <AiSourceSection />

      {usage && usage.calls > 0 && (
        <div className="rounded-[var(--radius-field)] bg-[var(--surface-sunken)] px-3 py-2 text-[11.5px] text-[var(--ink-70)]" data-testid="ai-usage-summary">
          <div className="flex items-center justify-between">
            <span>AI usage on this device</span>
            <span className="text-[var(--ink-90)] font-medium">~${usage.costUsd.toFixed(2)} est.</span>
          </div>
          <div className="text-[10.5px] text-[var(--ink-50)] mt-0.5">
            {usage.calls} calls · {fmt(usage.inTok)} in / {fmt(usage.outTok)} out tokens · estimate at default rates, tokens are exact
          </div>
        </div>
      )}

      <div className="fb-t-caption uppercase tracking-[0.12em] font-medium pt-1">
        AI · API keys
      </div>

      <ApiKeyRow
        config={{
          label: 'Anthropic API key',
          purpose: 'Canvas AI, chat, and voice commands',
          placeholder: 'sk-ant-api03-…',
          helpUrl: 'https://console.anthropic.com/settings/keys',
          helpLabel: 'Get a key from console.anthropic.com →',
          removeWarning:
            'Remove the Anthropic API key from PlexiDesk? AI features will stop working until you add it back.',
          api: {
            hint: () => window.api.settings.hintAnthropic(),
            save: (p) => window.api.settings.saveAnthropicKey(p),
            clear: () => window.api.settings.clearAnthropicKey(),
            test: () => window.api.settings.testAnthropicKey()
          }
        }}
        encryption={encryption}
        onKeySaved={onKeySaved}
      />

      <ApiKeyRow
        config={{
          label: 'OpenAI API key',
          purpose: 'Voice transcription — voice notes & push-to-talk (Whisper). Or use Local below, no key needed.',
          placeholder: 'sk-proj-…',
          helpUrl: 'https://platform.openai.com/api-keys',
          helpLabel: 'Get a key from platform.openai.com →',
          removeWarning:
            'Remove the OpenAI API key from PlexiDesk? Voice-note transcription will stop working until you add it back.',
          api: {
            hint: () => window.api.settings.hintOpenAI(),
            save: (p) => window.api.settings.saveOpenAIKey(p),
            clear: () => window.api.settings.clearOpenAIKey(),
            test: () => window.api.settings.testOpenAIKey()
          }
        }}
        encryption={encryption}
        onKeySaved={onKeySaved}
      />

      <ApiKeyRow
        config={{
          label: 'Tenor API key',
          purpose: 'GIF search in chat. Optional — without it the GIF picker shows a prompt to add a key.',
          placeholder: 'AIza…',
          helpUrl: 'https://developers.google.com/tenor/guides/quickstart',
          helpLabel: 'Get a free key from Google Tenor →',
          removeWarning: 'Remove the Tenor API key? GIF search will stop working until you add it back.',
          api: {
            hint: () => window.api.settings.hintTenor(),
            save: (p) => window.api.settings.saveTenorKey(p),
            clear: () => window.api.settings.clearTenorKey(),
            // No dedicated test endpoint; a search confirms the key end to end.
            test: async () => {
              const r = await window.api.gif.search('hello')
              if (r.ok) return { ok: true }
              return { ok: false, error: 'needsKey' in r ? 'No key set yet.' : r.error }
            }
          }
        }}
        encryption={encryption}
        onKeySaved={onKeySaved}
      />

      <ApiKeyRow
        config={{
          label: 'Pexels API key',
          purpose: 'Stock photo search in PlexiDesign. Optional — without it the stock picker prompts to add a key.',
          placeholder: '563492…',
          helpUrl: 'https://www.pexels.com/api/',
          helpLabel: 'Get a free key from Pexels →',
          removeWarning: 'Remove the Pexels API key? Stock photo search will stop working until you add it back.',
          api: {
            hint: () => window.api.settings.hintPexels(),
            save: (p) => window.api.settings.savePexelsKey(p),
            clear: () => window.api.settings.clearPexelsKey(),
            test: async () => {
              const r = await window.api.design.searchPhotos({ query: 'sky', perPage: 1 })
              if (r.ok) return { ok: true }
              return { ok: false, error: r.needsKey ? 'No key set yet.' : r.error }
            }
          }
        }}
        encryption={encryption}
        onKeySaved={onKeySaved}
      />

      <ApiKeyRow
        config={{
          label: 'remove.bg API key',
          purpose: 'One-click background removal on images in PlexiDesign. Optional.',
          placeholder: 'abc123…',
          helpUrl: 'https://www.remove.bg/api',
          helpLabel: 'Get a key from remove.bg →',
          removeWarning: 'Remove the remove.bg API key? Background removal will stop working until you add it back.',
          api: {
            hint: () => window.api.settings.hintRemoveBg(),
            save: (p) => window.api.settings.saveRemoveBgKey(p),
            clear: () => window.api.settings.clearRemoveBgKey(),
            // remove.bg charges per call, so "test" confirms a key is stored
            // rather than spending a credit; the first real use validates it.
            test: async () => {
              const h = await window.api.settings.hintRemoveBg()
              return h.hasKey ? { ok: true } : { ok: false, error: 'No key set yet.' }
            }
          }
        }}
        encryption={encryption}
        onKeySaved={onKeySaved}
      />

      <div className="fb-t-caption text-[var(--ink-50)] leading-relaxed">
        Each key is encrypted with the macOS Keychain and stored locally only.
        When you use your own key, prompts go direct from this Mac to Anthropic /
        OpenAI. On Plexii credits, AI prompts route through Plexii's server so
        usage can be counted against your balance.
        {encryption === false && (
          <div className="text-rose-600 dark:text-rose-400 mt-1">
            ⚠ System encryption isn't available — saving is disabled.
          </div>
        )}
      </div>

      <VoiceProviderToggle />
    </div>
  )
}

type AiStatusView = AiCreditStatus

// AI-source chooser + credit balance. New users default to 'auto', which
// spends Plexii's managed AI credits first and falls back to a personal key
// once the balance is gone. When credits run out the user tops up here
// (US$10 / US$25 / US$50 packs), upgrades for a bigger monthly allowance, or
// switches to 'byok'. The balance shown is the renderer credits store's, so it
// is the same number as the meter on the AI surfaces.
function AiSourceSection(): JSX.Element {
  const status = useAiCreditsStore((s) => s.status) as AiStatusView | null
  const refreshCredits = useAiCreditsStore((s) => s.refresh)
  const syncCredits = useAiCreditsStore((s) => s.sync)
  const openVerify = useVerifyEmailStore((s) => s.open)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    // Pull the live balance once on open.
    void refreshCredits()
  }, [refreshCredits])

  async function pick(mode: 'auto' | 'credits' | 'byok'): Promise<void> {
    if (busy) return
    setBusy(true)
    setNote(null)
    try {
      await window.api.ai.setMode(mode)
      await syncCredits()
    } catch {
      setNote('Could not change AI source. Restart PlexiDesk and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function topUp(amountUsd: number): Promise<void> {
    if (busy) return
    setBusy(true)
    setNote(null)
    try {
      const r = await window.api.ai.topUpCredits(amountUsd)
      if (!r.ok) {
        setNote(r.error ?? 'Could not start checkout.')
      } else if (r.action === 'pending') {
        setNote('Credit purchases are not switched on for this server yet.')
      } else {
        setNote('Opened the checkout page in your browser. The balance updates once payment completes.')
      }
    } finally {
      setBusy(false)
    }
  }

  const modes: Array<{ id: 'auto' | 'credits' | 'byok'; label: string; sub: string }> = [
    { id: 'auto', label: 'Automatic', sub: 'Credits first, then your key' },
    { id: 'credits', label: 'Plexii credits', sub: 'Your plan’s allowance and packs' },
    { id: 'byok', label: 'Your own key', sub: 'Direct to Anthropic' }
  ]

  return (
    <div data-testid="ai-source-section">
      <div className="grid grid-cols-3 gap-1.5 mb-2">
        {modes.map((m) => (
          <button
            key={m.id}
            onClick={() => void pick(m.id)}
            disabled={busy || status === null}
            data-testid={`ai-mode-${m.id}`}
            className={`fb-t-caption px-2 py-1.5 rounded-[var(--radius-field)] border text-left ${
              status?.mode === m.id
                ? 'border-accent bg-accent/10 text-[var(--ink-100)] fb-press'
                : 'border-[var(--edge-soft)] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'
            } disabled:opacity-50`}
          >
            <div className="font-medium">{m.label}</div>
            <div className="fb-t-caption text-[var(--ink-50)] mt-0.5 leading-snug">
              {m.sub}
            </div>
          </button>
        ))}
      </div>

      {status && status.mode !== 'byok' && (
        <div className="fb-card rounded-[var(--radius-field)] px-2.5 py-2 mb-2">
          {!status.signedIn ? (
            <div className="fb-t-caption text-[var(--ink-50)] leading-snug">
              Sign in to your Plexii account to use AI credits. Free includes 100 a
              month on Haiku, and verifying your email starts a 14-day trial with 300
              bonus credits.
            </div>
          ) : (
            <>
              <CreditsMeter variant="full" />
              {status.verificationRequired && (
                <div className="fb-t-caption text-amber-700 dark:text-amber-300 mt-1 leading-snug" data-testid="ai-credits-verify">
                  Verify your email to use Plexii AI credits.{' '}
                  <button type="button" onClick={openVerify} className="underline">
                    Enter code
                  </button>
                </div>
              )}
              {status.outOfCredits && (
                <div className="fb-t-caption text-rose-600 dark:text-rose-400 mt-1 leading-snug">
                  Credits used up.{' '}
                  {status.hasOwnKey
                    ? 'Add a pack below, or switch to your own key to keep going.'
                    : 'Add a pack below, upgrade, or add your own Anthropic key under API keys.'}
                </div>
              )}
              <div className="flex gap-1.5 mt-2">
                {TOP_UP_PACKS.map((p) => (
                  <button
                    key={p.usd}
                    onClick={() => void topUp(p.usd)}
                    disabled={busy}
                    data-testid={`ai-topup-${p.usd}`}
                    title={`${p.credits.toLocaleString('en-US')} credits, valid 12 months`}
                    className="fb-btn-surface flex-1 fb-t-caption rounded-[var(--radius-field)] py-1 text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] disabled:opacity-50 leading-tight"
                  >
                    <div>Add US${p.usd}</div>
                    <div className="text-[var(--ink-50)]">{p.credits.toLocaleString('en-US')} credits</div>
                  </button>
                ))}
              </div>
              {(status.plan === null || status.plan === 'free' || status.plan === 'pro' || status.plan === 'team') && (
                <button
                  type="button"
                  onClick={() =>
                    promptUpgrade(
                      'A bigger plan means a bigger monthly AI allowance.',
                      status.plan === 'pro' || status.plan === 'team' ? 'proplus' : 'pro'
                    )
                  }
                  className="fb-t-caption text-accent hover:underline mt-1.5"
                  data-testid="ai-credits-upgrade"
                >
                  {status.plan === 'pro' || status.plan === 'team'
                    ? 'Pro+ includes 2,500 credits a month and Opus'
                    : 'Pro includes 800 credits a month on Haiku and Sonnet'}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {note && (
        <div className="fb-t-caption text-[var(--ink-50)] mb-2 leading-snug">
          {note}
        </div>
      )}

      <LocalAiSection />
    </div>
  )
}

function VoiceProviderToggle(): JSX.Element {
  // `null` = haven't heard from main yet. `'unavailable'` = the IPC
  // handler is missing (typically because the main process is running
  // older code than the renderer — restart PlexiDesk to pick up the new
  // handlers). Without this state we silently leave the buttons
  // disabled forever and the user has no idea why.
  const [provider, setProvider] = useState<'cloud' | 'local' | 'unavailable' | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    void window.api.voiceNote
      .getProvider()
      .then((p) => setProvider(p))
      .catch((err: Error) => {
        // eslint-disable-next-line no-console
        console.error('voiceNote.getProvider failed:', err)
        setProvider('unavailable')
        setStatus(
          'Transcription provider preference is unavailable. ' +
            'This usually means PlexiDesk needs a full restart to pick up ' +
            'new IPC handlers (renderer was updated but main process wasn\'t). ' +
            'Quit PlexiDesk (⌘Q) and reopen.'
        )
      })
  }, [])

  async function pick(next: 'cloud' | 'local'): Promise<void> {
    if (provider === next || busy) return
    setBusy(true)
    setStatus(null)
    if (next === 'local') {
      setStatus('Loading local Whisper model (one-time download, ~80MB)…')
    }
    try {
      const result = await window.api.voiceNote.setProvider(next)
      if (!result.ok) {
        setStatus(`Couldn't switch: ${result.error ?? 'unknown error'}`)
        return
      }
      setProvider(next)
      setStatus(
        next === 'local'
          ? 'Switched to Local Whisper. Future recordings transcribe on this Mac.'
          : 'Switched to Cloud Whisper (OpenAI).'
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setStatus(`Couldn\'t switch: ${msg}. Try restarting PlexiDesk.`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pt-3 border-t border-[var(--edge-soft)]">
      <div className="fb-t-caption uppercase tracking-[0.12em] font-medium mb-2">
        Voice · transcription provider
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <button
          onClick={() => void pick('cloud')}
          disabled={busy || provider === null || provider === 'unavailable'}
          className={`fb-t-caption px-2.5 py-1.5 rounded-[var(--radius-field)] border ${
            provider === 'cloud'
              ? 'border-accent bg-accent/10 text-[var(--ink-100)] fb-press'
              : 'border-[var(--edge-soft)] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'
          } disabled:opacity-50`}
          data-testid="voice-provider-cloud"
        >
          <div className="font-medium">Cloud</div>
          <div className="fb-t-caption text-[var(--ink-50)] mt-0.5">
            OpenAI Whisper · fastest · paid per minute
          </div>
        </button>
        <button
          onClick={() => void pick('local')}
          disabled={busy || provider === null || provider === 'unavailable'}
          className={`fb-t-caption px-2.5 py-1.5 rounded-[var(--radius-field)] border ${
            provider === 'local'
              ? 'border-accent bg-accent/10 text-[var(--ink-100)] fb-press'
              : 'border-[var(--edge-soft)] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'
          } disabled:opacity-50`}
          data-testid="voice-provider-local"
        >
          <div className="font-medium">Local</div>
          <div className="fb-t-caption text-[var(--ink-50)] mt-0.5">
            Whisper tiny · offline · free · ~80MB
          </div>
        </button>
      </div>
      {status && (
        <div className="fb-t-caption text-[var(--ink-50)] mt-2 leading-snug">
          {status}
        </div>
      )}
    </div>
  )
}

function ApiKeyRow({
  config,
  encryption,
  onKeySaved
}: {
  config: ProviderConfig
  encryption: boolean | null
  onKeySaved?: () => void
}): JSX.Element {
  const [hint, setHint] = useState<{ hasKey: boolean; last4: string | null }>({
    hasKey: false,
    last4: null
  })
  // Track whether the hint IPC even responded. If main is running older
  // code (no handler for this provider's hint endpoint), the promise
  // rejects and `unavailable` becomes true — we surface a clear "restart
  // PlexiDesk" affordance instead of letting the row look operational while
  // every subsequent save / test / clear silently fails.
  const [unavailable, setUnavailable] = useState(false)
  const [editing, setEditing] = useState(false)
  const [pasted, setPasted] = useState('')
  const [show, setShow] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  useEffect(() => {
    config.api
      .hint()
      .then((h) => {
        setHint(h)
        setUnavailable(false)
      })
      .catch((err: Error) => {
        // eslint-disable-next-line no-console
        console.error(`${config.label} hint IPC unavailable:`, err)
        setUnavailable(true)
      })
  }, [config])

  const isBusy = status.kind === 'saving' || status.kind === 'testing'

  async function onSave(): Promise<void> {
    if (!pasted.trim()) return
    setStatus({ kind: 'saving' })
    try {
      const result = await config.api.save(pasted)
      if (!result.ok) {
        setStatus({ kind: 'error', message: result.error ?? 'Save failed.' })
        return
      }
      setHint({ hasKey: result.hasKey ?? true, last4: result.last4 ?? null })
      setPasted('')
      setEditing(false)
      setStatus({
        kind: 'success',
        message: 'Key saved. Encrypted with the system keychain.'
      })
      onKeySaved?.()
    } catch (err) {
      // Reaches here when the IPC handler doesn't exist on the main
      // side — e.g. renderer was hot-reloaded but main wasn't restarted.
      const msg = err instanceof Error ? err.message : String(err)
      setStatus({
        kind: 'error',
        message: `Save failed: ${msg}. If this just appeared, quit PlexiDesk (⌘Q) and reopen — the renderer has new code that the main process hasn't loaded yet.`
      })
    }
  }

  async function onTest(): Promise<void> {
    setStatus({ kind: 'testing' })
    const result = await config.api.test()
    if (result.ok) {
      setStatus({
        kind: 'success',
        message: `Key works · ${result.model ?? 'connected'}.`
      })
    } else {
      setStatus({ kind: 'error', message: result.error ?? 'Test failed.' })
    }
  }

  async function onClear(): Promise<void> {
    const confirmed = await confirmDialog({
      title: 'Clear this API key?',
      body: config.removeWarning,
      confirmLabel: 'Clear key',
      danger: true
    })
    if (!confirmed) return
    const result = await config.api.clear()
    if (!result.ok) {
      setStatus({ kind: 'error', message: result.error ?? 'Clear failed.' })
      return
    }
    setHint({ hasKey: false, last4: null })
    setEditing(false)
    setPasted('')
    setStatus({ kind: 'success', message: 'Key removed.' })
  }

  return (
    <div>
      <div className="flex items-start justify-between mb-1.5 gap-2">
        <div className="flex flex-col min-w-0">
          <span className="text-xs text-[var(--ink-70)]">
            {config.label}
          </span>
          <span className="fb-t-caption text-[var(--ink-50)] leading-snug">
            {config.purpose}
          </span>
        </div>
        {hint.hasKey && !editing && !unavailable && (
          <span className="fb-t-caption uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
            Set
          </span>
        )}
        {unavailable && (
          <span className="fb-t-caption uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300">
            Restart needed
          </span>
        )}
      </div>
      {unavailable && (
        <div className="fb-t-caption text-amber-700 dark:text-amber-300 mb-2 leading-snug bg-amber-500/10 border border-amber-500/20 rounded-[var(--radius-chip)] px-2 py-1.5">
          Main process is missing this provider's IPC handler. Quit PlexiDesk (⌘Q) and reopen so it picks up the new code. Saving / testing this key won't work until you do.
        </div>
      )}

      {hint.hasKey && !editing && (
        <div className="fb-card flex items-center justify-between rounded-[var(--radius-field)] px-2.5 py-1.5 mb-2">
          <code className="text-xs font-mono text-[var(--ink-70)]">
            ••••••••{hint.last4 ?? '????'}
          </code>
          <div className="flex gap-1">
            <button
              onClick={() => {
                setEditing(true)
                setStatus({ kind: 'idle' })
              }}
              className="fb-t-caption text-[var(--ink-70)] hover:text-[var(--ink-100)] px-1.5"
            >
              Replace
            </button>
            <button
              onClick={onTest}
              disabled={isBusy}
              className="fb-t-caption text-[var(--ink-70)] hover:text-[var(--ink-100)] px-1.5 disabled:opacity-50"
            >
              {status.kind === 'testing' ? 'Testing…' : 'Test'}
            </button>
            <button
              onClick={onClear}
              className="fb-t-caption text-rose-600 dark:text-rose-400 hover:text-rose-700 dark:hover:text-rose-300 px-1.5"
            >
              Remove
            </button>
          </div>
        </div>
      )}

      {(!hint.hasKey || editing) && (
        <div className="space-y-2">
          <div className="relative">
            <input
              type={show ? 'text' : 'password'}
              value={pasted}
              onChange={(e) => {
                setPasted(e.target.value)
                setStatus({ kind: 'idle' })
              }}
              placeholder={config.placeholder}
              autoComplete="off"
              spellCheck={false}
              className="fb-field text-xs font-mono pr-12"
            />
            <button
              type="button"
              onClick={() => setShow(!show)}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 fb-t-caption uppercase tracking-wider text-[var(--ink-50)] hover:text-[var(--ink-70)] px-1.5 py-0.5"
            >
              {show ? 'Hide' : 'Show'}
            </button>
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={onSave}
              disabled={!pasted.trim() || isBusy || encryption === false}
              className="flex-1 fb-t-caption bg-accent text-white rounded-[var(--radius-field)] py-1.5 hover:opacity-90 disabled:opacity-50"
            >
              {status.kind === 'saving' ? 'Saving…' : 'Save key'}
            </button>
            {editing && (
              <button
                onClick={() => {
                  setEditing(false)
                  setPasted('')
                  setStatus({ kind: 'idle' })
                }}
                className="fb-t-caption text-[var(--ink-70)] hover:text-[var(--ink-100)] px-2"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {status.kind === 'success' && (
        <div className="fb-t-caption text-emerald-700 dark:text-emerald-300 mt-2">
          {status.message}
        </div>
      )}
      {status.kind === 'error' && (
        <div className="fb-t-caption text-rose-600 dark:text-rose-400 mt-2 break-words">
          {status.message}
        </div>
      )}

      <a
        href={config.helpUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="fb-t-caption text-accent hover:underline inline-flex items-center gap-1 mt-1"
      >
        {config.helpLabel}
      </a>
    </div>
  )
}
