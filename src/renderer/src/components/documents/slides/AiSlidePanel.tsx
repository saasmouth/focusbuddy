// AI slide generation panel. Three modes: build a new themed deck from a topic,
// append slides to the current deck, or redesign the current slide. The result
// is previewed as SlideFace thumbnails before it is applied.

import { useState } from 'react'
import type { DeckTheme, SlidesBody } from '@shared/types'
import SlideFace from './SlideFace'
import { resolveTheme } from '@shared/slideThemes'
import Icon from '../../Icon'
import { useAiBusyLabel } from '../../../lib/localAiEngine'
import AnsweredBy from '../../ai/AnsweredBy'

type Mode = 'deck' | 'append' | 'redesign'

interface Props {
  theme: DeckTheme
  // The current slide's text, so "Make this slide beautiful" can redesign the
  // real content rather than ask the user to retype it. Empty when the slide has
  // no text.
  slideSummary?: string
  onApply: (mode: Mode, body: SlidesBody) => void
  onClose: () => void
}

export default function AiSlidePanel({ theme, slideSummary, onApply, onClose }: Props): JSX.Element {
  const warmLabel = useAiBusyLabel()
  const [mode, setMode] = useState<Mode>('deck')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<SlidesBody | null>(null)

  async function run(override?: string): Promise<void> {
    const text = (override ?? prompt).trim()
    if (!text) return
    setBusy(true)
    setError(null)
    setPreview(null)
    try {
      const res = await window.api.documents.generateSlides({ mode, prompt: text })
      if (!res.ok || !res.body) {
        setError(res.error || (res.needsApiKey ? 'No Anthropic API key set.' : 'The AI returned nothing.'))
        return
      }
      setPreview(res.body)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const previewTheme = preview ? resolveTheme(preview.theme) : theme

  return (
    <div className="rounded-xl border border-accent/30 bg-accent/[0.04] p-3 mb-2" data-testid="slides-ai-panel">
      <div className="flex items-center gap-1.5 mb-2">
        <Icon name="auto_awesome" size={13} className="text-accent" />
        <span className="text-[11px] uppercase tracking-wider font-semibold text-accent">AI slides</span>
        <div className="ml-2 flex gap-1">
          {(['deck', 'append', 'redesign'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`text-[11px] px-2 py-0.5 rounded-full border capitalize ${
                mode === m ? 'border-accent bg-accent/15 text-accent' : 'border-[var(--edge-firm)]'
              }`}
            >
              {m === 'deck' ? 'New deck' : m}
            </button>
          ))}
        </div>
        <button onClick={onClose} className="ml-auto icon-btn"><Icon name="close" size={13} /></button>
      </div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void run()
        }}
        rows={2}
        autoFocus
        placeholder={
          mode === 'deck'
            ? 'Describe the deck… e.g. "a 6-slide pitch for an AI scheduling app"'
            : mode === 'append'
              ? 'What slides to add…'
              : 'How to redesign this slide…'
        }
        className="fb-field w-full bg-[var(--surface-raised)] px-3 py-2 text-[13px] resize-none"
      />
      {mode === 'redesign' && (slideSummary?.trim().length ?? 0) > 0 && (
        <button
          data-testid="slides-ai-beautify"
          onClick={() => {
            const p = `Redesign this slide with a polished, modern, well-spaced layout that fits the deck's theme. Keep the meaning of the content but improve the visual hierarchy. Content on the slide now:\n${slideSummary}`
            setPrompt(p)
            void run(p)
          }}
          disabled={busy}
          className="mt-2 inline-flex items-center gap-1 text-[12px] px-2.5 py-1.5 rounded-full border border-accent/40 bg-accent/[0.06] text-accent hover:bg-accent/[0.12] disabled:opacity-50"
        >
          <Icon name="auto_awesome" size={13} />
          Make this slide beautiful in the theme
        </button>
      )}
      {error && <div className="text-[12px] text-red-600 dark:text-red-400 mt-1">{error}</div>}

      {preview && (
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {preview.slides.slice(0, 12).map((s) => (
            <div key={s.id} className="shrink-0 rounded overflow-hidden border border-[var(--edge-soft)]">
              <SlideFace slide={s} theme={previewTheme} width={160} />
            </div>
          ))}
        </div>
      )}

      <AnsweredBy feature="office" className="mt-2" />
      <div className="flex items-center gap-2 mt-2">
        {preview == null ? (
          <button onClick={() => void run()} disabled={busy || !prompt.trim()} className="btn-primary text-[12px] px-3 py-1.5">
            {busy ? warmLabel('Generating…') : 'Generate'}
          </button>
        ) : (
          <>
            <button onClick={() => onApply(mode, preview)} data-testid="slides-ai-apply" className="btn-primary text-[12px] px-3 py-1.5">
              {mode === 'deck' ? 'Use deck' : mode === 'append' ? `Add ${preview.slides.length} slides` : 'Apply redesign'}
            </button>
            <button onClick={() => void run()} disabled={busy} className="fb-btn-surface text-[12px] px-3 py-1.5 hover:bg-[var(--surface-sunken)]">
              Regenerate
            </button>
          </>
        )}
        <span className="text-[11px] text-[var(--ink-40)]">Previewed before it changes your deck. Cmd+Enter</span>
      </div>
    </div>
  )
}
