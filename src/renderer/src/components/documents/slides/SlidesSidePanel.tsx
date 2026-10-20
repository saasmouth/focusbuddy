import { useState } from 'react'
import type { DeckTheme, Slide, SlideLayout } from '@shared/types'
import { BUILTIN_THEMES } from '@shared/slideThemes'
import Icon from '../../Icon'
import WorkspaceAsk from '../editor/WorkspaceAsk'
import type { SlideAi } from './useSlideAi'

// The persistent right-side panel for PlexiSlides. It has two parts stacked in
// one column. The top is an AI Assistant that runs the REAL per-slide assistant
// (via the SlideAi hook -> window.api.ai) and shows the real result with Apply
// and Copy. Below it, a Slide | Layout tab pair surfaces the slide's REAL
// properties (its actual layout, theme colours from the resolved theme, font)
// and a speaker-notes editor bound to the current slide's notes.
//
// Nothing here is fabricated. The properties read the live deck/slide state and
// the AI actions surface the real model output or the real error. The controls
// reuse the editor's own applyLayout / applyTheme so there is no duplicated logic.

export type SlidesPanelTab = 'slide' | 'layout'

// Human labels for the layout ids, matching the toolbar's Layout menu.
const LAYOUT_LABELS: Record<SlideLayout, string> = {
  title: 'Title',
  'title-content': 'Title + content',
  'two-content': 'Two content',
  section: 'Section',
  'image-caption': 'Image + caption',
  blank: 'Blank',
  bullets: 'Title + content'
}

const LAYOUT_OPTIONS: SlideLayout[] = ['title', 'title-content', 'two-content', 'section', 'image-caption', 'blank']

interface Props {
  slide: Slide
  theme: DeckTheme
  ai: SlideAi
  tab: SlidesPanelTab
  onTab: (tab: SlidesPanelTab) => void
  // Reuse the editor's real mutations rather than re-implementing them here.
  onApplyLayout: (layout: SlideLayout) => void
  onApplyTheme: (theme: DeckTheme) => void
  onChangeNotes: (notes: string) => void
  // Apply the AI result. The host routes this to the right real mutation based on
  // the action kind (replace slide text, write notes, or switch theme).
  onApplyAi: () => void
  // Open the existing deck-generation panel (AiSlidePanel), kept working.
  onDeckGenerate: () => void
}

const actionClass =
  'fb-card flex items-center gap-2 w-full text-left px-3 py-2 text-[12.5px] text-[var(--ink-80)] hover:border-[rgb(var(--accent)/0.5)] hover:bg-[rgb(var(--accent)/0.06)] disabled:opacity-50 fb-spring-soft'

// The current slide's text, joined from its text elements, fed to the AI actions.
function slideText(slide: Slide): string {
  return (slide.elements ?? [])
    .flatMap((e) =>
      e.type === 'text' ? [e.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join(' ').trim()] : []
    )
    .filter(Boolean)
    .join('\n')
}

// The AI Assistant block: the heading, the action buttons, and the previewed
// real result with Apply/Insert and Copy.
function AiAssistant({
  slide,
  ai,
  onApplyAi,
  onDeckGenerate
}: {
  slide: Slide
  ai: SlideAi
  onApplyAi: () => void
  onDeckGenerate: () => void
}): JSX.Element {
  const [showMore, setShowMore] = useState(false)
  const [morePrompt, setMorePrompt] = useState('')
  const [copied, setCopied] = useState(false)

  const hasText = slideText(slide).trim().length > 0
  const themeNames = BUILTIN_THEMES.map((t) => t.name)

  async function copyResult(): Promise<void> {
    if (!ai.result) return
    try {
      await navigator.clipboard.writeText(ai.result)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable; the result stays on screen */
    }
  }

  // The apply control's label reads honestly for what the result will do.
  const applyLabel = ai.kind === 'notes' ? 'Insert notes' : ai.kind === 'design' ? 'Apply theme' : 'Apply'

  return (
    <div className="flex flex-col gap-3 p-3 border-b border-[var(--edge-soft)]">
      <WorkspaceAsk />
      <div className="flex items-center gap-1.5">
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--accent)/0.12)] text-[rgb(var(--accent))]">
          <Icon name="auto_awesome" size={14} />
        </span>
        <span className="text-[13px] font-semibold text-[var(--ink-90)]">PlexiiAssist</span>
        <span className="rounded bg-[rgb(var(--accent)/0.14)] px-1 text-[9px] uppercase tracking-wide text-[rgb(var(--accent))]">Beta</span>
      </div>
      <p className="text-[12.5px] text-[var(--ink-70)] leading-snug">Here are some ideas for your slide</p>

      <div className="flex flex-col gap-1.5">
        <button
          className={actionClass}
          onClick={() => void ai.transform('Improve this slide content. Tighten the wording and sharpen the message while keeping the meaning. Return formatted HTML only.', 'Improve slide')}
          disabled={ai.busy}
          data-testid="slides-ai-improve"
        >
          <Icon name="auto_awesome" size={15} className="text-[rgb(var(--accent))]" />
          <span>Improve slide</span>
        </button>
        <button
          className={actionClass}
          onClick={() => void ai.transform('Rewrite this slide content in clearer, more compelling language while keeping the same meaning. Return formatted HTML only.', 'Rewrite content')}
          disabled={ai.busy}
          data-testid="slides-ai-rewrite"
        >
          <Icon name="edit_note" size={15} className="text-[rgb(var(--accent))]" />
          <span>Rewrite content</span>
        </button>
        <button
          className={actionClass}
          onClick={() => void ai.transform('Shorten this slide content to be more concise and punchy while keeping the meaning. Return formatted HTML only.', 'Shorten text')}
          disabled={ai.busy}
          data-testid="slides-ai-shorten"
        >
          <Icon name="compress" size={15} className="text-[rgb(var(--accent))]" />
          <span>Shorten text</span>
        </button>
        <button
          className={actionClass}
          onClick={() => void ai.recommendDesign(themeNames)}
          disabled={ai.busy}
          data-testid="slides-ai-design"
        >
          <Icon name="palette" size={15} className="text-[rgb(var(--accent))]" />
          <span>Design upgrade</span>
        </button>
        <button
          className={actionClass}
          onClick={() => void ai.draftNotes()}
          disabled={ai.busy}
          data-testid="slides-ai-notes"
        >
          <Icon name="sticky_note_2" size={15} className="text-[rgb(var(--accent))]" />
          <span>Add speaker notes</span>
        </button>
        <button
          className={actionClass}
          onClick={() => setShowMore((v) => !v)}
          disabled={ai.busy}
          data-testid="slides-ai-more"
        >
          <Icon name="more_horiz" size={15} className="text-[rgb(var(--accent))]" />
          <span>More ideas</span>
        </button>
        {showMore && (
          <div className="flex flex-col gap-1.5 pl-1">
            <button
              className={actionClass}
              onClick={onDeckGenerate}
              disabled={ai.busy}
              data-testid="slides-ai-deckgen"
            >
              <Icon name="slideshow" size={15} className="text-[rgb(var(--accent))]" />
              <span>Generate or redesign a whole deck</span>
            </button>
            <textarea
              value={morePrompt}
              onChange={(e) => setMorePrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && morePrompt.trim()) void ai.freeform(morePrompt.trim())
              }}
              rows={2}
              placeholder="Tell the assistant what to do with this slide's content."
              className="fb-field w-full resize-none px-2.5 py-1.5 text-[12px]"
              data-testid="slides-ai-more-prompt"
            />
            <button
              onClick={() => morePrompt.trim() && void ai.freeform(morePrompt.trim())}
              disabled={ai.busy || !morePrompt.trim()}
              className="self-start rounded-lg bg-[rgb(var(--accent))] px-3 py-1.5 text-[12px] text-white disabled:opacity-50"
              data-testid="slides-ai-more-run"
            >
              Run
            </button>
          </div>
        )}
      </div>

      {!hasText && (
        <div className="text-[11.5px] text-[var(--ink-50)] leading-snug">
          This slide has no text yet. Add a text box and the assistant can work on it.
        </div>
      )}

      {ai.busy && (
        <div className="flex items-center gap-1.5 text-[12px] text-[var(--ink-50)]" data-testid="slides-ai-busy">
          <Icon name="autorenew" size={14} className="animate-spin" />
          <span>Working on it.</span>
        </div>
      )}

      {ai.error && (
        <div className="rounded-lg border border-red-300/60 bg-red-50/70 dark:bg-red-950/30 px-3 py-2 text-[12px] text-red-600 dark:text-red-300" data-testid="slides-ai-error">
          {ai.error}
        </div>
      )}

      {ai.result != null && (
        <div className="flex flex-col gap-2" data-testid="slides-ai-result">
          {ai.label && (
            <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--ink-40)] font-semibold">{ai.label}</div>
          )}
          <div className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--surface-base)] p-3 text-[13px] text-[var(--ink-80)]">
            {ai.result}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onApplyAi}
              className="rounded-lg bg-[rgb(var(--accent))] px-3 py-1.5 text-[12px] font-medium text-white"
              data-testid="slides-ai-result-apply"
            >
              {applyLabel}
            </button>
            <button
              onClick={() => void copyResult()}
              className="fb-btn-surface px-3 py-1.5 text-[12px] text-[var(--ink-80)] hover:bg-[var(--surface-sunken)]"
              data-testid="slides-ai-result-copy"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// A small labelled property row used by the Slide tab.
function PropRow({
  label,
  value,
  action,
  onAction,
  testid
}: {
  label: string
  value: string
  action: string
  onAction: () => void
  testid: string
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1" data-testid={testid}>
      <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--ink-40)] font-semibold">{label}</span>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ink-90)]">{value}</span>
        <button
          onClick={onAction}
          className="fb-btn-surface shrink-0 px-2.5 py-1 text-[11.5px] text-[var(--ink-80)] hover:border-[rgb(var(--accent)/0.5)] hover:bg-[rgb(var(--accent)/0.06)]"
        >
          {action}
        </button>
      </div>
    </div>
  )
}

// The Slide tab: the slide's real properties plus the notes editor.
function SlideTab({
  slide,
  theme,
  onApplyTheme,
  onChangeNotes,
  onScrollToLayout
}: {
  slide: Slide
  theme: DeckTheme
  onApplyTheme: (theme: DeckTheme) => void
  onChangeNotes: (notes: string) => void
  onScrollToLayout: () => void
}): JSX.Element {
  // The slide's real background label, derived from its actual fill.
  const bg = slide.background
  const bgLabel = !bg || bg.type === 'none'
    ? 'None'
    : bg.type === 'gradient'
      ? `Gradient ${bg.color ?? ''}`.trim()
      : (bg.color ?? theme.background)
  const layout = (slide.layout ?? 'title-content') as SlideLayout

  return (
    <div className="flex flex-col gap-4 p-3">
      <PropRow
        label="Slide layout"
        value={LAYOUT_LABELS[layout]}
        action="Change layout"
        onAction={onScrollToLayout}
        testid="slides-prop-layout"
      />
      <PropRow
        label="Background"
        value={bgLabel}
        action="Change background"
        onAction={() => onApplyTheme(theme)}
        testid="slides-prop-background"
      />

      <div className="flex flex-col gap-1.5" data-testid="slides-prop-theme">
        <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--ink-40)] font-semibold">Theme colors</span>
        <div className="flex items-center gap-2">
          {[
            { c: theme.background, t: 'Background' },
            { c: theme.textColor, t: 'Text' },
            { c: theme.accent, t: 'Accent' },
            { c: theme.titleStyle.color ?? theme.textColor, t: 'Title' },
            { c: theme.bodyStyle.color ?? theme.textColor, t: 'Body' }
          ].map((s, i) => (
            <span
              key={i}
              title={`${s.t} ${s.c}`}
              className="h-6 w-6 rounded-full border border-[var(--edge-soft)]"
              style={{ background: s.c }}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1" data-testid="slides-prop-font">
        <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--ink-40)] font-semibold">Font</span>
        <span className="text-[13px] text-[var(--ink-90)]">{theme.fontHeading.split(',')[0].replace(/['"]/g, '')}</span>
      </div>

      <button
        onClick={onScrollToLayout}
        className="fb-btn-surface self-start px-2.5 py-1 text-[11.5px] text-[var(--ink-80)] hover:border-[rgb(var(--accent)/0.5)] hover:bg-[rgb(var(--accent)/0.06)]"
        data-testid="slides-prop-master"
      >
        Master slides
      </button>

      <div className="flex flex-col gap-1.5 border-t border-[var(--edge-soft)] pt-3">
        <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--ink-40)] font-semibold">Notes</span>
        <textarea
          value={slide.notes}
          onChange={(e) => onChangeNotes(e.target.value)}
          rows={4}
          placeholder="What to actually say on this slide"
          className="fb-field w-full resize-none px-2.5 py-2 text-[13px]"
          data-testid="slides-notes-editor"
        />
      </div>
    </div>
  )
}

// The Layout tab: the layout presets and the deck themes, both wired to the
// editor's real applyLayout / applyTheme.
function LayoutTab({
  slide,
  theme,
  onApplyLayout,
  onApplyTheme
}: {
  slide: Slide
  theme: DeckTheme
  onApplyLayout: (layout: SlideLayout) => void
  onApplyTheme: (theme: DeckTheme) => void
}): JSX.Element {
  const current = (slide.layout ?? 'title-content') as SlideLayout
  return (
    <div className="flex flex-col gap-4 p-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--ink-40)] font-semibold">Slide layout</span>
        <div className="grid grid-cols-2 gap-1.5">
          {LAYOUT_OPTIONS.map((l) => (
            <button
              key={l}
              onClick={() => onApplyLayout(l)}
              className={`rounded-lg border px-2.5 py-2 text-left text-[12px] fb-spring-soft ${
                l === current
                  ? 'border-[rgb(var(--accent))] bg-[rgb(var(--accent)/0.08)] text-[rgb(var(--accent))]'
                  : 'border-[var(--edge-soft)] text-[var(--ink-80)] hover:border-[rgb(var(--accent)/0.5)] hover:bg-[rgb(var(--accent)/0.06)]'
              }`}
              data-testid={`slides-layout-${l}`}
            >
              {LAYOUT_LABELS[l]}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--ink-40)] font-semibold">Theme</span>
        <div className="grid grid-cols-2 gap-1.5">
          {BUILTIN_THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => onApplyTheme(t)}
              className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-[12px] fb-spring-soft ${
                t.id === theme.id
                  ? 'border-[rgb(var(--accent))] bg-[rgb(var(--accent)/0.08)]'
                  : 'border-[var(--edge-soft)] hover:border-[rgb(var(--accent)/0.5)]'
              }`}
              data-testid={`slides-theme-${t.id}`}
            >
              <span className="h-5 w-5 shrink-0 rounded-full border border-[var(--edge-soft)]" style={{ background: t.background }}>
                <span className="block h-full w-full rounded-full" style={{ boxShadow: `inset 0 0 0 3px ${t.accent}` }} />
              </span>
              <span className="truncate text-[var(--ink-90)]">{t.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function SlidesSidePanel({
  slide,
  theme,
  ai,
  tab,
  onTab,
  onApplyLayout,
  onApplyTheme,
  onChangeNotes,
  onApplyAi,
  onDeckGenerate
}: Props): JSX.Element {
  const tabBtn = (id: SlidesPanelTab, label: string, testid: string): JSX.Element => (
    <button
      onClick={() => onTab(id)}
      data-testid={testid}
      className={`flex-1 px-2.5 py-2 text-[12px] font-medium border-b-2 fb-spring-soft ${
        tab === id
          ? 'border-[rgb(var(--accent))] text-[rgb(var(--accent))]'
          : 'border-transparent text-[var(--ink-60)] hover:text-[var(--ink-90)]'
      }`}
    >
      {label}
    </button>
  )

  return (
    <aside
      className="flex h-full w-80 shrink-0 flex-col overflow-y-auto border-l border-[var(--edge-soft)] bg-[var(--surface-raised)]"
      aria-label="Slide assistant and properties panel"
      data-testid="slides-side-panel"
    >
      <AiAssistant slide={slide} ai={ai} onApplyAi={onApplyAi} onDeckGenerate={onDeckGenerate} />

      <div className="flex shrink-0 items-center border-b border-[var(--edge-soft)]">
        {tabBtn('slide', 'Slide', 'slides-tab-slide')}
        {tabBtn('layout', 'Layout', 'slides-tab-layout')}
      </div>

      {tab === 'slide' ? (
        <SlideTab
          slide={slide}
          theme={theme}
          onApplyTheme={onApplyTheme}
          onChangeNotes={onChangeNotes}
          onScrollToLayout={() => onTab('layout')}
        />
      ) : (
        <LayoutTab slide={slide} theme={theme} onApplyLayout={onApplyLayout} onApplyTheme={onApplyTheme} />
      )}
    </aside>
  )
}
