// The per-slide AI hook for the slides side panel. It runs the REAL assistant on
// the CURRENT slide's text and lands a previewed result the writer can apply or
// copy. Everything here calls the same window.api.ai infrastructure the docs
// editor uses (rewriteSelection for transforms, suggestDocContent for whole-text
// drafting), so nothing is fabricated. When the AI fails, the real error text
// (including a missing API key) surfaces instead of a fake suggestion.
//
// Result shapes differ by action:
//   transform - rewrite the slide's text; apply replaces the slide's text runs
//   notes     - draft speaker notes; apply writes them into the slide's notes
//   design    - recommend a deck theme by name; apply switches the theme
// The hook never mutates the deck itself. It returns the plain-text result and an
// `applyKind` so the panel's host (SlidesEditor) can route apply to the right
// real mutation (setElementText / notes / applyTheme).

import { useCallback, useState } from 'react'

export type SlideAiKind = 'transform' | 'notes' | 'design'

export interface SlideAiState {
  busy: boolean
  error: string | null
  // The plain-text result, ready to show and to apply. Null until a run lands.
  result: string | null
  kind: SlideAiKind | null
  // A short human label for the action that produced the current result, shown
  // above the result so the writer knows what they are looking at.
  label: string | null
}

// Strip the model's HTML down to plain text. The slide model stores plain text
// runs, not HTML, so we never inject markup into a slide. A textarea-backed
// element extracts textContent the same way the docs copy action does.
//
// Parsed with DOMParser, NOT by setting innerHTML on a div from this document.
// A detached div still belongs to the live page, so innerHTML on it starts
// loading images straight away -- `<img src=x onerror=…>` in the model's output
// (which can be steered by text in the slide it was asked about) ran in the
// app's origin. A DOMParser document is inert: no scripts, no loads, no events.
export function htmlToText(html: string): string {
  const tmp = new DOMParser().parseFromString(String(html ?? ''), 'text/html').body
  // Turn block boundaries into line breaks so a multi-paragraph result keeps its
  // shape as plain text rather than collapsing onto one line.
  tmp.querySelectorAll('p, li, br, h1, h2, h3, div').forEach((el) => {
    el.append('\n')
  })
  return (tmp.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

export interface SlideAi extends SlideAiState {
  // Transform the slide's text with an instruction (improve, rewrite, shorten).
  transform: (instruction: string, label: string) => Promise<void>
  // Draft speaker notes from the slide text.
  draftNotes: () => Promise<void>
  // Ask the AI to recommend one of the named deck themes for this content. The
  // result text is the recommendation; the panel matches it to a real theme.
  recommendDesign: (themeNames: string[]) => Promise<void>
  // A free-form instruction over the slide text (the "More ideas" prompt).
  freeform: (instruction: string) => Promise<void>
  reset: () => void
  clearResult: () => void
}

// One transform run over the slide text via the real rewriteSelection endpoint.
async function runRewrite(text: string, instruction: string): Promise<string> {
  if (!text.trim()) throw new Error('This slide has no text to work on yet. Add some text first.')
  const res = await window.api.ai.rewriteSelection({ text, instruction })
  if (!res.ok || !res.html) {
    throw new Error(res.error || (res.needsApiKey ? 'No Anthropic API key set.' : 'The AI returned nothing.'))
  }
  return htmlToText(res.html)
}

// One whole-text run via the real suggestDocContent endpoint (notes, design rec).
async function runSuggest(prompt: string): Promise<string> {
  const res = await window.api.ai.suggestDocContent({ prompt })
  if (!res.ok || !res.html) {
    throw new Error(res.error || (res.needsApiKey ? 'No Anthropic API key set.' : 'The AI returned nothing.'))
  }
  return htmlToText(res.html)
}

// `slideText` is read fresh on each call from the host, so the action always
// operates on the slide the writer is looking at right now.
export function useSlideAi(getSlideText: () => string): SlideAi {
  const [state, setState] = useState<SlideAiState>({
    busy: false,
    error: null,
    result: null,
    kind: null,
    label: null
  })

  const reset = useCallback(() => setState({ busy: false, error: null, result: null, kind: null, label: null }), [])
  const clearResult = useCallback(() => setState((s) => ({ ...s, result: null, error: null, kind: null, label: null })), [])

  // Drive one action: mark busy, run the real work, land the plain-text result.
  const drive = useCallback(
    async (kind: SlideAiKind, label: string, work: () => Promise<string>): Promise<void> => {
      setState({ busy: true, error: null, result: null, kind, label })
      try {
        const text = await work()
        setState({ busy: false, error: null, result: text, kind, label })
      } catch (e) {
        setState({ busy: false, error: (e as Error).message, result: null, kind, label })
      }
    },
    []
  )

  const transform = useCallback(
    (instruction: string, label: string) =>
      drive('transform', label, () => runRewrite(getSlideText(), instruction)),
    [drive, getSlideText]
  )

  const draftNotes = useCallback(
    () =>
      drive('notes', 'Speaker notes', () => {
        const text = getSlideText()
        if (!text.trim()) throw new Error('This slide has no text to draft notes from yet. Add some text first.')
        return runSuggest(
          `Write concise speaker notes for a presenter to say out loud while showing this slide. Return a short paragraph or two of plain prose, no slide title, no markdown headings. The slide content is:\n\n${text}`
        )
      }),
    [drive, getSlideText]
  )

  const recommendDesign = useCallback(
    (themeNames: string[]) =>
      drive('design', 'Design upgrade', () => {
        const text = getSlideText()
        const list = themeNames.join(', ')
        return runSuggest(
          `Recommend the single best visual theme for this slide's content from this exact list: ${list}. Reply with just the theme name on its own, then one short sentence explaining why it suits the content. The slide content is:\n\n${text || '(no text yet)'}`
        )
      }),
    [drive, getSlideText]
  )

  const freeform = useCallback(
    (instruction: string) => drive('transform', 'Your instruction', () => runRewrite(getSlideText(), instruction)),
    [drive, getSlideText]
  )

  return { ...state, transform, draftNotes, recommendDesign, freeform, reset, clearResult }
}
