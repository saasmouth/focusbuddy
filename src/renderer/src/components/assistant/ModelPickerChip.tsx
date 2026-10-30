import { useEffect, useRef, useState } from 'react'
import { MODEL_OPTIONS, useModelMode } from '../../lib/modelPrefs'
import Icon from '../Icon'
import CreditsMeter from '../CreditsMeter'
import { useAiCreditsStore } from '../../stores/aiCredits'

// What Plexii's managed AI runs per plan (growth spec section 1). Your own key
// runs any model; on credits a model above the plan is sent as the best one the
// plan includes (main/ai/modelRouting.ts modelForPlan).
export function planModelNote(plan: string | null, mode: string | null): string | null {
  if (mode === 'byok' || mode === 'openai' || mode === 'local') return null
  if (plan === 'free') return 'On Plexii credits, Free runs Haiku. Your own key runs any model.'
  if (plan === 'pro' || plan === 'team') return 'On Plexii credits, Opus is on Pro+. Your own key runs any model.'
  return null
}

// The composer's model picker (P7), extracted so the assistant panel and the
// focus AI Chat render the identical control. Same MODEL_OPTIONS data and the
// same shared preference as the Settings picker — every instance is a door to
// ONE switch (modelPrefs' module-level subscriber keeps them in live sync),
// never a second switch. Opens upward: every composer sits at the bottom of
// its surface.
/** The four places AI can run. Mirrors Settings → AI exactly. */
type AiSourceMode = 'local' | 'byok' | 'openai' | 'credits'

// Named here rather than in Settings' own array because the two surfaces want
// different lengths of the same truth: Settings has room for a sentence, a
// composer chip has room for a few words. The ids are the contract and they
// are identical; only the wording differs.
const AI_SOURCES: Array<{ id: AiSourceMode; label: string; sub: string; icon: string }> = [
  {
    id: 'local',
    label: 'On this device',
    sub: 'Private — nothing is sent to an AI service',
    icon: 'memory'
  },
  { id: 'byok', label: 'Claude', sub: 'Your Anthropic key', icon: 'psychology' },
  { id: 'openai', label: 'ChatGPT', sub: 'Your OpenAI key', icon: 'smart_toy' },
  { id: 'credits', label: 'Plexii credits', sub: 'Your plan’s allowance', icon: 'toll' }
]

export default function ModelPickerChip(): JSX.Element {
  const [modelMode, setModelMode] = useModelMode()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const syncCredits = useAiCreditsStore((s) => s.sync)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent): void {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open])
  const active = MODEL_OPTIONS.find((o) => o.value === modelMode) ?? MODEL_OPTIONS[0]
  const creditPlan = useAiCreditsStore((s) => s.status?.plan ?? null)
  const aiMode = useAiCreditsStore((s) => s.status?.mode ?? null)
  const note = planModelNote(creditPlan, aiMode)

  // Where the AI runs is part of THIS control now (2026-10-30). "On this
  // device" used to be a dead label: once AI was local the composer showed
  // where it ran and offered no way back, so switching to Claude or ChatGPT
  // meant going to Settings and knowing to look there. The source and the
  // model are one question asked in two halves, and this is where it is asked.
  //
  // It drives the same window.api.ai.setMode the Settings picker does, so the
  // two are one switch with two doors, never two switches.
  const isLocal = aiMode === 'local'
  const isOpenAi = aiMode === 'openai'
  // Claude's model list only means something when Claude is answering.
  const showModels = !isLocal && !isOpenAi

  async function pickSource(mode: AiSourceMode): Promise<void> {
    setOpen(false)
    if (busy) return
    setBusy(true)
    try {
      await window.api.ai.setMode(mode)
      await syncCredits()
    } catch {
      // The status is left as it was rather than showing a source that was
      // not actually selected. Settings carries the detailed error path.
    } finally {
      setBusy(false)
    }
  }

  const faceIcon = isLocal ? 'memory' : isOpenAi ? 'smart_toy' : 'psychology'
  const faceLabel = isLocal ? 'On this device' : isOpenAi ? 'ChatGPT' : active.label
  const faceTitle = isLocal
    ? 'AI runs on this device. Nothing is sent to an AI service. Click to switch to Claude or ChatGPT.'
    : isOpenAi
      ? 'AI runs on your OpenAI key. Click to switch where it runs.'
      : `Model — ${active.label}. ${active.blurb}`

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="composer-model-toggle"
        aria-label="Choose where AI runs, and the model"
        aria-expanded={open}
        title={faceTitle}
        className="inline-flex items-center gap-1 rounded-full border border-[var(--edge-soft)] px-2 py-0.5 text-[10px] font-mono text-[var(--ink-60)] hover:border-[rgb(var(--accent)/0.5)] hover:text-[var(--ink-90)] transition-colors"
      >
        <Icon name={faceIcon} size={11} className="shrink-0" />
        <span className="truncate max-w-[110px]" data-testid="composer-model-face">
          {faceLabel}
        </span>
        <Icon name="unfold_more" size={10} className="shrink-0" />
      </button>
      {open && (
        <div
          data-testid="composer-model-menu"
          className="absolute left-0 bottom-full mb-1.5 z-30 w-[300px] rounded-[var(--radius-row)] border border-[var(--edge-soft)] bg-[var(--surface-raised)] p-1"
          style={{ boxShadow: 'var(--shadow-cast)' }}
        >
          {/* Where it runs. First, because it decides whether the list under
              it means anything at all. */}
          <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-[var(--ink-40)]">
            Where it runs
          </div>
          {AI_SOURCES.map((src) => {
            // 'auto' is credits-then-own-key; both read as "Plexii credits".
            const on = src.id === 'credits' ? aiMode === 'credits' || aiMode === 'auto' : aiMode === src.id
            return (
              <button
                key={src.id}
                type="button"
                disabled={busy}
                data-testid={`composer-source-${src.id}`}
                aria-pressed={on}
                onClick={() => void pickSource(src.id)}
                className="w-full flex items-start gap-2 rounded-[var(--radius-chip)] px-2 py-1.5 text-left hover:bg-[var(--surface-sunken)] transition-colors disabled:opacity-50"
              >
                <Icon
                  name={src.icon}
                  size={13}
                  className={`shrink-0 mt-0.5 ${on ? 'text-accent' : 'text-[var(--ink-40)]'}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] text-[var(--ink-90)]">{src.label}</span>
                  <span className="block text-[10.5px] text-[var(--ink-50)] leading-snug">
                    {src.sub}
                  </span>
                </span>
                {on && <Icon name="check" size={14} className="text-accent shrink-0 mt-0.5" />}
              </button>
            )
          })}

          {/* Claude's models. Hidden on this device and on ChatGPT, where
              none of them is what answers — offering them there would be a
              menu of things that do not happen. */}
          {showModels && (
            <div className="mt-1 pt-1 border-t border-[var(--edge-soft)] px-2 pb-1 text-[10px] uppercase tracking-wider text-[var(--ink-40)]">
              Claude model
            </div>
          )}
          {showModels &&
            MODEL_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              data-testid={`composer-model-${opt.value}`}
              onClick={() => {
                setModelMode(opt.value)
                setOpen(false)
              }}
              className="w-full flex items-start gap-2 rounded-[var(--radius-chip)] px-2 py-1.5 text-left hover:bg-[var(--surface-sunken)] transition-colors"
            >
              <span className="w-8 shrink-0 pt-0.5 text-[10px] font-mono text-[var(--ink-40)]">
                {opt.costTier}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] text-[var(--ink-90)]">{opt.label}</span>
                <span className="block text-[10.5px] text-[var(--ink-50)] leading-snug">
                  {opt.blurb}
                </span>
              </span>
              {opt.value === modelMode && (
                <Icon name="check" size={14} className="text-accent shrink-0 mt-0.5" />
              )}
            </button>
          ))}
          <div className="mt-1 pt-1.5 px-2 pb-1 border-t border-[var(--edge-soft)] space-y-0.5">
            <CreditsMeter />
            {note && (
              <div className="text-[10.5px] text-[var(--ink-50)] leading-snug" data-testid="composer-plan-model-note">
                {note}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
