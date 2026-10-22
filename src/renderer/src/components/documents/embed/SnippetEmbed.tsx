import { useCallback, useEffect, useState } from 'react'
import {
  instanceModeFor,
  snippetKindIcon,
  type Snippet,
  type SnippetHostKind,
  type SnippetInstanceMode
} from '@shared/snippets'
import Icon from '../../Icon'
import SnippetContent from '../../snippets/SnippetContent'

// A LIVE saved snippet inside a host. The host stores only the snippet's id;
// this resolves it, so the master's current content is what shows and the host
// never carries a stale copy. Editing the master changes every live instance at
// once — the whole difference between a live instance and a duplicate.
//
// IT RENDERS AS ITS CONTENT, NOT AS A WIDGET. There is no border, no title and
// no "Live" pill in the resting state: a doc fragment sits in the page looking
// like the paragraphs around it. That chrome existed here before and was
// exactly what the owner objected to — "snippets should appear as their natural
// form … not bound within widget structure with title etc." The chrome now
// appears on hover, and a pin keeps it shown for this instance.
//
// REVEALED ON HOVER *AND* FOCUS. Hover alone would make every action here
// unreachable by keyboard, and this codebase has already been bitten by
// hover-only chrome reading as a broken feature. The wrapper is focusable so
// focus can land on it at all.
//
// ANCHORED INSIDE ITS OWN BOX, never viewport-fixed. The same embed renders
// inside a Workcentre tile and inside a desk widget, where a floating overlay
// lands in the wrong place or escapes its container — and overlays that escape
// their container have form here for eating clicks elsewhere on the page.
//
// IT NEVER PRETENDS. A deleted master renders an explicit missing state, and
// that state keeps its own ALWAYS-VISIBLE chrome: if it were hover-only, a
// deleted snippet would silently vanish from a document, which is the exact
// failure the state exists to prevent.

export interface SnippetEmbedProps {
  snippetId: string
  /** Which surface this is in; decides whether the instance is editable here. */
  host?: SnippetHostKind
  /** Pinned open for this instance. Persisted by the host (node attribute). */
  showChrome?: boolean
  /** Toggle the pin. Absent means the host cannot persist it, so no pin shows. */
  onShowChromeChange?: (next: boolean) => void
  /** Open the master in the app that owns it, for a read-only converted instance. */
  onOpenOriginal?: (snippet: Snippet) => void
}

type State =
  | { phase: 'loading' }
  | { phase: 'missing' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; snippet: Snippet }

const MODE_LABEL: Record<SnippetInstanceMode, string> = {
  editable: 'Live',
  readonly: 'Live · read-only',
  detached: 'Copy'
}

const MODE_TITLE: Record<SnippetInstanceMode, string> = {
  editable: 'Live: edits here change the saved snippet, everywhere it is used',
  readonly: 'Live, but converted to fit here, so it cannot be edited in place. Open the original to change it.',
  detached: 'An independent copy. Changes to the saved snippet never reach it.'
}

export default function SnippetEmbed({
  snippetId,
  host = 'doc',
  showChrome = false,
  onShowChromeChange,
  onOpenOriginal
}: SnippetEmbedProps): JSX.Element {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    let live = true
    if (!snippetId) {
      setState({ phase: 'missing' })
      return
    }
    setState({ phase: 'loading' })
    window.api.snippets
      .get(snippetId)
      .then((s) => {
        if (!live) return
        setState(s ? { phase: 'ready', snippet: s } : { phase: 'missing' })
      })
      .catch((e: Error) => {
        if (!live) return
        setState({ phase: 'error', message: e.message || 'The snippet could not be read.' })
      })
    return () => {
      live = false
    }
  }, [snippetId])

  const togglePin = useCallback(() => onShowChromeChange?.(!showChrome), [onShowChromeChange, showChrome])

  if (state.phase === 'loading') {
    return (
      <span
        className="inline-flex items-center gap-2 text-[12px] text-[var(--ink-50)]"
        data-testid="snippet-embed-loading"
      >
        <Icon name="autorenew" size={14} className="animate-spin" />
        Loading snippet…
      </span>
    )
  }

  // The two failure states keep their frames. They are the cases where the user
  // must see that something is wrong, so they are never hover-gated.
  if (state.phase === 'missing') {
    return (
      <div
        className="flex items-start gap-2 rounded-[var(--radius-row)] border border-dashed border-[var(--edge-firm)] px-3 py-2 text-[12px] text-[var(--ink-60)]"
        data-testid="snippet-embed-missing"
      >
        <Icon name="link_off" size={14} className="mt-0.5 text-[var(--ink-40)]" />
        <span>
          This live snippet no longer exists.
          <span className="block text-[11px] text-[var(--ink-40)]">
            It was deleted from the library. Remove this block, or save a replacement under the same name.
          </span>
        </span>
      </div>
    )
  }

  if (state.phase === 'error') {
    return (
      <div
        className="flex items-start gap-2 rounded-[var(--radius-row)] border border-dashed border-red-400/60 px-3 py-2 text-[12px] text-red-600 dark:text-red-400"
        data-testid="snippet-embed-error"
      >
        <Icon name="error_outline" size={14} className="mt-0.5" />
        <span>{state.message}</span>
      </div>
    )
  }

  const { snippet } = state
  const mode = instanceModeFor(snippet.kind, host, 'live')
  const chromeOpen = hovered || focused || showChrome

  return (
    <div
      className="relative"
      data-testid="snippet-embed"
      data-snippet-id={snippet.id}
      data-snippet-revision={snippet.revision}
      data-snippet-mode={mode}
      data-chrome-open={chromeOpen ? 'true' : 'false'}
      tabIndex={0}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <SnippetContent body={snippet.body} />

      {chromeOpen && (
        <div
          // Absolute within this embed, so it is correct at any container size
          // and cannot escape into the page.
          className="absolute right-0 top-0 z-10 inline-flex items-center gap-1 rounded-bl-[var(--radius-row)] border-b border-l border-[var(--edge-soft)] bg-[var(--surface-raised)]/95 px-1.5 py-0.5 text-[11px] shadow-sm backdrop-blur-sm"
          data-testid="snippet-embed-chrome"
        >
          <Icon name={snippetKindIcon(snippet.kind)} size={12} className="text-[var(--ink-40)]" />
          <span className="max-w-[14rem] truncate font-medium text-[var(--ink-70)]">{snippet.name}</span>
          <span
            className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-1.5 text-[10px] text-accent"
            title={MODE_TITLE[mode]}
            data-testid="snippet-embed-mode"
          >
            <Icon name="sync" size={10} /> {MODE_LABEL[mode]}
          </span>

          {mode === 'readonly' && onOpenOriginal && (
            <button
              type="button"
              onClick={() => onOpenOriginal(snippet)}
              className="icon-btn !h-5 !w-5"
              aria-label="Open the original to edit it"
              title="Open the original to edit it"
              data-testid="snippet-embed-open-original"
            >
              <Icon name="open_in_new" size={12} />
            </button>
          )}

          {onShowChromeChange && (
            <button
              type="button"
              onClick={togglePin}
              aria-pressed={showChrome}
              className={`icon-btn !h-5 !w-5 ${showChrome ? 'text-accent' : ''}`}
              aria-label={showChrome ? 'Stop showing this snippet’s frame' : 'Keep this snippet’s frame shown'}
              title={showChrome ? 'Stop showing the frame' : 'Keep the frame shown'}
              data-testid="snippet-embed-pin"
            >
              <Icon name={showChrome ? 'push_pin' : 'push_pin'} size={12} />
            </button>
          )}
        </div>
      )}
    </div>
  )
}
