import { useEffect, useRef, useState } from 'react'
import type { AiBuildSuggestion, WidgetKind } from '@shared/types'
import { catalogFor } from '../lib/widgetCatalog'
import { useMagneticHover } from '../lib/useMagneticHover'
import Icon from './Icon'
import SuggestionPreview from './ai/SuggestionPreview'
import CreditsMeter from './CreditsMeter'
import { useAiBusyLabel } from '../lib/localAiEngine'
import AnsweredBy from './ai/AnsweredBy'

interface Props {
  taskId: string | null
  onClose: () => void
  // Called when the user clicks "Add selected" — the picked subset is
  // returned. Caller spawns the widgets on the canvas (Canvas owns layout).
  onAccept: (selected: AiBuildSuggestion[]) => Promise<void>
  // Text to start the prompt with (the demo → app handoff). The user still
  // reads it and presses Generate: nothing runs, and nothing is spent, unasked.
  initialPrompt?: string
}

type State =
  | { stage: 'prompt' }
  | { stage: 'thinking' }
  | { stage: 'ready'; intent: string; suggestions: AiBuildSuggestion[]; selected: Set<string> }
  | { stage: 'error'; message: string; needsApiKey?: boolean }
  | { stage: 'spawning' }

// Free-form "build me a workspace" dialog. The user types what they want,
// Claude returns suggested widgets with full configs (table schemas, page
// content, field defs), and the user picks which to materialize on the canvas.
//
// Layout: split. Left side = the prompt input (top) + intent summary; right
// side = scrollable suggestion cards with checkboxes. Bottom action bar with
// "Generate again" and "Add selected".
export default function AiBuilderDialog({ taskId, onClose, onAccept, initialPrompt }: Props): JSX.Element {
  const warmLabel = useAiBusyLabel()
  const [prompt, setPrompt] = useState(initialPrompt ?? '')
  const [state, setState] = useState<State>({ stage: 'prompt' })
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  // Magnetic refs for primary actions — the generate + apply buttons feel
  // like they're pulled toward your cursor as you approach them.
  const generateBtnRef = useMagneticHover<HTMLButtonElement>(4, 18)
  const applyBtnRef = useMagneticHover<HTMLButtonElement>(4, 18)

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    inputRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function runGenerate(): Promise<void> {
    if (!prompt.trim() || state.stage === 'thinking') return
    setState({ stage: 'thinking' })
    const result = await window.api.setup.buildFromPrompt({
      prompt: prompt.trim(),
      taskId
    })
    if (result.ok && result.suggestions && result.suggestions.length > 0) {
      setState({
        stage: 'ready',
        intent: result.intent ?? '',
        suggestions: result.suggestions,
        // Default: select all — most users will refine the prompt before
        // selecting, but if they like everything they're one click away.
        selected: new Set(result.suggestions.map((s) => s.id))
      })
    } else {
      setState({
        stage: 'error',
        message: result.error ?? 'No suggestions returned',
        needsApiKey: result.needsApiKey
      })
    }
  }

  function toggle(id: string): void {
    if (state.stage !== 'ready') return
    const next = new Set(state.selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setState({ ...state, selected: next })
  }

  async function applySelected(): Promise<void> {
    if (state.stage !== 'ready') return
    const picked = state.suggestions.filter((s) => state.selected.has(s.id))
    if (picked.length === 0) return
    setState({ stage: 'spawning' })
    try {
      await onAccept(picked)
      onClose()
    } catch (err) {
      setState({
        stage: 'error',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }

  return (
    <div
      className="fb-scrim fixed inset-0 z-[180] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="fb-glass-pillow w-full max-w-3xl mx-4 rounded-[20px] overflow-hidden flex flex-col max-h-[90vh] fb-spring-soft"
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-[var(--edge-soft)] flex items-center gap-2 shrink-0">
          <Icon name="auto_awesome" size={18} className="text-accent" />
          <h3 className="text-base font-semibold text-[var(--ink-100)] flex-1">
            Build with AI
          </h3>
          <CreditsMeter />
          <button onClick={onClose} className="icon-btn" aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>

        {/* Prompt input */}
        <div className="px-5 py-3 border-b border-[var(--edge-soft)] shrink-0">
          <label className="block text-[11px] uppercase tracking-wider text-[var(--ink-50)] mb-1.5">
            Describe what you want to achieve
          </label>
          <textarea
            ref={inputRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void runGenerate()
              }
            }}
            placeholder="e.g. Track my freelance clients with status and contact info, plus a notes page for each project"
            rows={3}
            className="fb-field w-full px-3 py-2 text-sm text-[var(--ink-100)] resize-none"
          />
          <div className="flex items-center justify-between mt-2">
            <span className="text-[10px] text-[var(--ink-40)]">
              Cmd+Enter to generate · Esc to close
            </span>
            <button
              ref={generateBtnRef}
              onClick={() => void runGenerate()}
              disabled={!prompt.trim() || state.stage === 'thinking'}
              className="btn-primary !text-[12px]"
            >
              <Icon name="auto_awesome" size={12} />
              <span>
                {state.stage === 'thinking'
                  ? warmLabel('Thinking…')
                  : state.stage === 'ready'
                    ? 'Regenerate'
                    : 'Generate'}
              </span>
            </button>
            <AnsweredBy feature="build" className="mt-1" />
          </div>
        </div>

        {/* Result area */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {state.stage === 'prompt' && (
            <div className="text-center py-8">
              <Icon
                name="auto_awesome"
                size={28}
                className="text-[var(--ink-30)] mx-auto mb-2"
              />
              <p className="text-[12px] text-[var(--ink-50)] max-w-md mx-auto leading-relaxed">
                Describe what you're trying to do. The AI will suggest pages, tables,
                fields, and other work widgets — pre-configured with the right columns,
                sections, and starter content. Pick what you want and it lands on
                the canvas live.
              </p>
              <div className="mt-4 flex flex-wrap gap-1.5 justify-center max-w-md mx-auto">
                {[
                  'Plan a trip to Tokyo',
                  'Track job applications',
                  'Daily standup notes',
                  'Build a CRM for clients',
                  'Run a book club'
                ].map((example) => (
                  <button
                    key={example}
                    onClick={() => setPrompt(example)}
                    className="fb-btn-surface text-[10px] px-2 py-1 text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          )}

          {state.stage === 'thinking' && (
            <div className="flex flex-col items-center justify-center py-12 gap-2">
              <Icon name="auto_awesome" size={24} className="text-accent animate-pulse" />
              <span className="text-[12px] text-[var(--ink-50)]">Designing your workspace…</span>
            </div>
          )}

          {state.stage === 'error' && (
            <div className="flex flex-col items-center justify-center py-8 gap-2 text-center">
              <Icon name="error_outline" size={24} className="text-amber-500" />
              <p className="text-[13px] text-[var(--ink-70)]">
                {state.message}
              </p>
              {state.needsApiKey && (
                <p className="text-[11px] text-[var(--ink-50)] max-w-md">
                  Open <strong>Settings → AI · API keys</strong> and paste your Anthropic API key. No restart needed.
                </p>
              )}
            </div>
          )}

          {state.stage === 'ready' && (
            <>
              {state.intent && (
                <div className="mb-3 px-3 py-2 rounded-md bg-accent/5 border border-accent/20">
                  <div className="text-[10px] uppercase tracking-wider text-accent mb-0.5">
                    What I heard
                  </div>
                  <div className="text-[12px] text-[var(--ink-70)]">
                    {state.intent}
                  </div>
                </div>
              )}
              <div className="space-y-2">
                {state.suggestions.map((s) => (
                  <SuggestionCard
                    key={s.id}
                    suggestion={s}
                    selected={state.selected.has(s.id)}
                    onToggle={() => toggle(s.id)}
                  />
                ))}
              </div>
            </>
          )}

          {state.stage === 'spawning' && (
            <div className="flex flex-col items-center justify-center py-12 gap-2">
              <Icon name="auto_awesome" size={24} className="text-accent animate-pulse" />
              <span className="text-[12px] text-[var(--ink-50)]">Placing work widgets…</span>
            </div>
          )}
        </div>

        {/* Footer */}
        {state.stage === 'ready' && (
          <div className="px-5 py-3 border-t border-[var(--edge-soft)] flex items-center justify-between shrink-0">
            <span className="text-[11px] text-[var(--ink-50)]">
              {state.selected.size} of {state.suggestions.length} selected
            </span>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="fb-btn-surface text-[12px] px-3 py-1.5 text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
              >
                Cancel
              </button>
              <button
                ref={applyBtnRef}
                onClick={() => void applySelected()}
                disabled={state.selected.size === 0}
                className="btn-primary !text-[12px] disabled:opacity-50"
              >
                <Icon name="add" size={12} />
                <span>Add {state.selected.size} to canvas</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Suggestion card — one per AI-suggested widget ────────────────────────────
function SuggestionCard({
  suggestion,
  selected,
  onToggle
}: {
  suggestion: AiBuildSuggestion
  selected: boolean
  onToggle: () => void
}): JSX.Element {
  const catalog = catalogFor(suggestion.kind)
  // Same visual language as the shared ProposalCards (rounded-md, edge-soft
  // border on a raised surface, accent-tinted icon chip, 10/12/10 verb-subject-
  // reason type scale). The checkbox + per-kind preview stay — they are this
  // dialog's multi-select-and-preview job, which the standard card doesn't do.
  // The preview itself is now shared with the new-desk setup dialog, which had
  // none: ai/SuggestionPreview.
  return (
    <button
      onClick={onToggle}
      className={`w-full text-left rounded-md border px-2.5 py-1.5 transition-colors ${
        selected
          ? 'border-accent bg-accent/5 ring-1 ring-accent/30'
          : 'border-[var(--edge-soft)] bg-[var(--surface-raised)] hover:border-accent hover:bg-accent/5'
      }`}
    >
      <div className="flex items-start gap-2">
        <span
          className={`h-6 w-6 rounded-md inline-flex items-center justify-center shrink-0 ${
            selected ? 'bg-accent text-white' : 'bg-accent/10 text-accent'
          }`}
        >
          <Icon name={catalog?.icon ?? 'widgets'} size={13} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-[var(--ink-50)]">
            {catalog?.label ?? suggestion.kind}
          </div>
          <div className="text-[12px] font-medium text-[var(--ink-100)] truncate mt-0.5">
            {suggestion.title}
          </div>
          <div className="text-[10px] text-[var(--ink-50)] mt-0.5 leading-snug">
            {suggestion.reason}
          </div>
          <SuggestionPreview s={suggestion} />
        </div>
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          className="h-4 w-4 mt-0.5 accent-accent cursor-pointer shrink-0"
        />
      </div>
    </button>
  )
}


// Currently-unused but exported in case future callers need to render the
// kind icon outside this dialog.
export type { WidgetKind }
