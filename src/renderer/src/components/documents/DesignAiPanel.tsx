import { useState } from 'react'
import Icon from '../Icon'
import { sanitizeHtml } from '../../lib/htmlSanitize'
import WorkspaceAsk from './editor/WorkspaceAsk'

// The persistent right-side AI Assistant panel for PlexiDesign. It mirrors the
// PlexiDocs side panel and the PlexiSheets AI panel in structure, tokens and
// quality, but its actions are grounded in the active design canvas.
//
// Everything here runs on real infrastructure. Improve copy, Shorten text and the
// free prompt that has a selected text element all call window.api.ai.rewriteSelection
// over the real text of the selected element. Suggest a headline, Generate a caption
// and a free prompt with nothing selected call window.api.ai.suggestDocContent. The
// model returns HTML; the panel shows it as a sanitized preview and, on Apply or
// Insert, writes the plain text into the design (replacing the selected element's
// text, or adding a new text element). Nothing is hardcoded or fabricated.
//
// When an action needs a selected text element and there is none, the panel shows
// an honest inline message rather than inventing content. A missing Anthropic key
// surfaces as the real error string from the AI call.

// How the result lands back on the canvas once the user confirms it.
//   replace - overwrite the selected text element's text (Improve, Shorten)
//   insert  - add a new text element carrying the text (Headline, Caption, Ask)
type ApplyMode = 'replace' | 'insert'

interface Props {
  // The plain text of the currently selected text element, or null when the
  // selection is empty or is not a text element. The parent reads this from the
  // real design via elementText(), so the AI always works on real content.
  selectedText: string | null
  // Replace the selected text element's text with the AI result.
  onApplyText: (text: string) => void
  // Add a new text element to the canvas carrying the AI result.
  onInsertText: (text: string) => void
  // Greet by name when signed in; a neutral greeting otherwise (no fabricated name).
  userName?: string | null
  onCollapse: () => void
}

// Reduce a constrained HTML fragment to plain text, one line per block. The AI
// returns rich HTML for the preview, but a design text element holds plain text,
// so this is what Apply / Insert writes onto the canvas.
function htmlToPlainText(html: string): string {
  const tmp = document.createElement('div')
  tmp.innerHTML = sanitizeHtml(html)
  // Turn block boundaries into newlines so a multi-line result keeps its shape.
  tmp.querySelectorAll('p, h1, h2, h3, h4, li, br, blockquote, tr').forEach((el) => {
    el.append('\n')
  })
  const text = (tmp.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
  return text
}

export default function DesignAiPanel({
  selectedText,
  onApplyText,
  onInsertText,
  userName,
  onCollapse
}: Props): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsSelection, setNeedsSelection] = useState(false)
  const [resultHtml, setResultHtml] = useState<string | null>(null)
  const [applyMode, setApplyMode] = useState<ApplyMode>('insert')
  const [ask, setAsk] = useState('')
  const [copied, setCopied] = useState(false)

  const greeting =
    userName && userName.trim()
      ? `Hi ${userName.trim()}, I can help with copy and ideas for this design.`
      : 'I can help with copy and ideas for this design.'

  const hasSelection = !!selectedText && selectedText.trim().length > 0

  // Run a rewrite over the selected element's text. Needs a text selection; with
  // none it shows the honest needs-selection message instead of inventing text.
  async function rewrite(instruction: string): Promise<void> {
    if (busy) return
    setNeedsSelection(false)
    setError(null)
    if (!hasSelection) {
      setResultHtml(null)
      setNeedsSelection(true)
      return
    }
    setBusy(true)
    setResultHtml(null)
    try {
      const res = await window.api.ai.rewriteSelection({
        text: (selectedText ?? '').trim(),
        instruction
      })
      if (!res.ok || !res.html) {
        setError(res.error || (res.needsApiKey ? 'No Anthropic API key set.' : 'The AI returned nothing.'))
        return
      }
      setApplyMode('replace')
      setResultHtml(res.html)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Run a suggest-content prompt that produces a fresh idea (headline, caption or
  // a free design idea). The result is inserted as a new text element.
  async function suggest(prompt: string): Promise<void> {
    if (busy) return
    setNeedsSelection(false)
    setError(null)
    setBusy(true)
    setResultHtml(null)
    try {
      const res = await window.api.ai.suggestDocContent({ prompt })
      if (!res.ok || !res.html) {
        setError(res.error || (res.needsApiKey ? 'No Anthropic API key set.' : 'The AI returned nothing.'))
        return
      }
      setApplyMode('insert')
      setResultHtml(res.html)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // The free prompt routes to a rewrite when a text element is selected (so it
  // transforms the real text), otherwise to a suggestion that is inserted.
  async function runAsk(): Promise<void> {
    const q = ask.trim()
    if (!q || busy) return
    if (hasSelection) {
      await rewrite(`${q}. Return formatted HTML only.`)
    } else {
      await suggest(
        `${q}. This is for a graphic design canvas, so keep it short and punchy, a few words to a short sentence. Return formatted HTML only.`
      )
    }
  }

  function applyResult(): void {
    if (!resultHtml) return
    const text = htmlToPlainText(resultHtml)
    if (!text) {
      setError('Could not read text from the AI result.')
      return
    }
    if (applyMode === 'replace') onApplyText(text)
    else onInsertText(text)
    setResultHtml(null)
  }

  async function copyResult(): Promise<void> {
    if (!resultHtml) return
    const text = htmlToPlainText(resultHtml)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable; leave the result on screen */
    }
  }

  const actionClass =
    'fb-card flex items-center gap-2 w-full text-left px-3 py-2 text-[12.5px] text-[var(--ink-80)] hover:border-[rgb(var(--accent)/0.5)] hover:bg-[rgb(var(--accent)/0.06)] disabled:opacity-50 fb-spring-soft'

  return (
    <aside
      className="flex h-full w-80 shrink-0 flex-col border-l border-[var(--edge-soft)] bg-[var(--surface-raised)]"
      aria-label="Design assistant panel"
      data-testid="design-ai-panel"
    >
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--edge-soft)] px-3 py-2.5">
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--accent)/0.12)] text-[rgb(var(--accent))]">
          <Icon name="auto_awesome" size={14} />
        </span>
        <span className="text-[13px] font-semibold text-[var(--ink-90)]">PlexiiAssist</span>
        <span className="rounded bg-[rgb(var(--accent)/0.14)] px-1 text-[9px] uppercase tracking-wide text-[rgb(var(--accent))]">
          Beta
        </span>
        <button
          onClick={onCollapse}
          className="ml-auto icon-btn"
          aria-label="Collapse assistant"
          title="Collapse assistant"
          data-testid="design-ai-collapse"
        >
          <Icon name="chevron_right" size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex flex-col gap-3 p-3">
          <WorkspaceAsk />
          <div className="flex items-start gap-2">
            <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--accent)/0.12)] text-[rgb(var(--accent))]">
              <Icon name="auto_awesome" size={14} />
            </span>
            <p className="text-[13px] leading-snug text-[var(--ink-80)]">{greeting}</p>
          </div>

          {/* Quick actions. The first two need a selected text element; the others
              produce fresh ideas that are inserted as new text. */}
          <div className="flex flex-col gap-1.5">
            <button
              className={actionClass}
              onClick={() => void rewrite('Improve this copy while keeping the meaning. Make it clear and compelling for a design. Return formatted HTML only.')}
              disabled={busy}
              data-testid="design-ai-improve"
            >
              <Icon name="auto_awesome" size={15} className="text-[rgb(var(--accent))]" />
              <span>Improve copy</span>
            </button>
            <button
              className={actionClass}
              onClick={() => void rewrite('Make this text shorter and punchier while keeping the meaning, suitable for a design. Return formatted HTML only.')}
              disabled={busy}
              data-testid="design-ai-shorten"
            >
              <Icon name="compress" size={15} className="text-[rgb(var(--accent))]" />
              <span>Shorten text</span>
            </button>
            <button
              className={actionClass}
              onClick={() =>
                void suggest(
                  hasSelection
                    ? `Suggest one short, attention-grabbing headline for a design based on this text: "${(selectedText ?? '').trim()}". Return a single short headline as formatted HTML only.`
                    : 'Suggest one short, attention-grabbing headline for a graphic design. Return a single short headline as formatted HTML only.'
                )
              }
              disabled={busy}
              data-testid="design-ai-headline"
            >
              <Icon name="title" size={15} className="text-[rgb(var(--accent))]" />
              <span>Suggest a headline</span>
            </button>
            <button
              className={actionClass}
              onClick={() =>
                void suggest(
                  hasSelection
                    ? `Write one short social caption or description for a design based on this text: "${(selectedText ?? '').trim()}". Keep it to one or two sentences. Return formatted HTML only.`
                    : 'Write one short social caption or description for a graphic design. Keep it to one or two sentences. Return formatted HTML only.'
                )
              }
              disabled={busy}
              data-testid="design-ai-caption"
            >
              <Icon name="notes" size={15} className="text-[rgb(var(--accent))]" />
              <span>Generate a caption</span>
            </button>
          </div>

          {/* Free prompt. Transforms the selected text when there is one, otherwise
              asks for a fresh design idea that is inserted. */}
          <div className="flex flex-col gap-1.5">
            <div className="text-[11px] text-[var(--ink-50)]">
              {hasSelection
                ? 'Ask the assistant to change the selected text, or for a design idea.'
                : 'Ask the assistant for a design idea. Select a text element first to rewrite it.'}
            </div>
            <textarea
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void runAsk()
              }}
              rows={2}
              placeholder="e.g. a bold tagline for a summer sale"
              className="fb-field w-full resize-none px-2.5 py-1.5 text-[12px]"
              data-testid="design-ai-ask-input"
            />
            <button
              onClick={() => void runAsk()}
              disabled={busy || !ask.trim()}
              className="self-start rounded-lg bg-[rgb(var(--accent))] px-3 py-1.5 text-[12px] text-white disabled:opacity-50"
              data-testid="design-ai-ask-send"
            >
              Ask for a design idea
            </button>
          </div>

          {busy && (
            <div className="flex items-center gap-1.5 text-[12px] text-[var(--ink-50)]" data-testid="design-ai-busy">
              <Icon name="autorenew" size={14} className="animate-spin" />
              <span>Working on it.</span>
            </div>
          )}

          {needsSelection && (
            <div
              className="rounded-lg border border-dashed border-[var(--edge-soft)] px-3 py-2 text-[12px] leading-relaxed text-[var(--ink-50)]"
              data-testid="design-ai-needs-selection"
            >
              Select a text element first, then I can rewrite it.
            </div>
          )}

          {error && (
            <div
              className="rounded-lg border border-red-300/60 bg-red-50/70 px-3 py-2 text-[12px] text-red-600 dark:bg-red-950/30 dark:text-red-300"
              data-testid="design-ai-error"
            >
              {error}
            </div>
          )}

          {resultHtml != null && (
            <div className="flex flex-col gap-2" data-testid="design-ai-result">
              <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--ink-40)]">Result</div>
              <div
                className="prose prose-sm prose-stone dark:prose-invert max-h-72 max-w-none overflow-auto rounded-lg bg-[var(--surface-base)] p-3 text-[13px]"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(resultHtml) }}
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={applyResult}
                  className="rounded-lg bg-[rgb(var(--accent))] px-3 py-1.5 text-[12px] font-medium text-white"
                  data-testid="design-ai-result-apply"
                >
                  {applyMode === 'replace' ? 'Apply' : 'Insert'}
                </button>
                <button
                  onClick={() => void copyResult()}
                  className="fb-btn-surface px-3 py-1.5 text-[12px] text-[var(--ink-80)] hover:bg-[var(--surface-sunken)]"
                  data-testid="design-ai-result-copy"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}
