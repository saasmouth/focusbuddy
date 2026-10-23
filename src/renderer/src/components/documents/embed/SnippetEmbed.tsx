import { useCallback, useEffect, useState } from 'react'
import {
  instanceModeFor,
  primaryKindFor,
  snippetKindIcon,
  type Snippet,
  type SnippetBody,
  type SnippetHostKind,
  type SnippetInstanceMode
} from '@shared/snippets'
import { convertSnippetBody } from '@shared/snippetConvert'
import Icon from '../../Icon'
import SnippetContent from '../../snippets/SnippetContent'
import { onSnippetChanged } from '../../../stores/snippets'

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
  // `body` is what gets drawn: the master's own body for a native kind, or the
  // conversion of it for a kind this host cannot show as itself. `lossy` names
  // what the conversion dropped.
  | { phase: 'ready'; snippet: Snippet; body: SnippetBody; lossy: string[] }
  // The master exists but cannot be shown here at all, with the reason 2e's
  // matrix gives — a refusal is better than a flattening that loses the point.
  | { phase: 'refused'; snippet: Snippet; reason: string }

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
    if (!snippetId) {
      setState({ phase: 'missing' })
      return
    }
    let live = true
    const resolve = (): void => {
      window.api.snippets
        .get(snippetId)
        .then(async (s) => {
          if (!live) return
          if (!s) {
            setState({ phase: 'missing' })
            return
          }
          // Native kind: draw the master's own body.
          if (instanceModeFor(s.kind, host, 'live') !== 'readonly') {
            setState({ phase: 'ready', snippet: s, body: s.body, lossy: [] })
            return
          }
          // Converted kind: re-derive from the master EVERY time this resolves,
          // which is what makes a converted instance live. convertSnippetBody is
          // deterministic and re-runnable by contract, so repeating it cannot
          // churn the content.
          //
          // The deps are imported dynamically: they pull in the formula engine
          // and the Draw SVG writer, and a document should not carry those in
          // its static graph just because a snippet might be converted.
          const { snippetConvertDeps } = await import('../../../lib/snippetConvertDeps')
          if (!live) return
          const out = convertSnippetBody(s.body, primaryKindFor(host), snippetConvertDeps())
          setState(
            out.ok
              ? { phase: 'ready', snippet: s, body: out.body, lossy: out.lossy }
              : { phase: 'refused', snippet: s, reason: out.reason }
          )
        })
        .catch((e: Error) => {
          if (!live) return
          setState({ phase: 'error', message: e.message || 'The snippet could not be read.' })
        })
    }
    setState({ phase: 'loading' })
    resolve()
    // Resolve again whenever the master is edited, so an instance already on
    // screen follows. Mount-only resolution is what made "changes appear
    // everywhere it's used" true for hosts opened later and false for the one
    // the user is looking at — including a second copy in the same document.
    // Re-reading through the IPC rather than taking the edited body from the
    // notification keeps the database the single source of truth, so what shows
    // is what was actually stored.
    const stop = onSnippetChanged(snippetId, resolve)
    return () => {
      live = false
      stop()
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

  if (state.phase === 'refused') {
    return (
      <div
        className="flex items-start gap-2 rounded-[var(--radius-row)] border border-dashed border-[var(--edge-firm)] px-3 py-2 text-[12px] text-[var(--ink-60)]"
        data-testid="snippet-embed-refused"
      >
        <Icon name="block" size={14} className="mt-0.5 text-[var(--ink-40)]" />
        <span>{state.reason}</span>
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
      <SnippetContent body={state.body} />

      {state.lossy.length > 0 && (
        // What the conversion dropped, stated where the content is rather than
        // only in the picker it was chosen from. A converted instance is
        // read-only, so the user cannot see the difference by editing it — if
        // this were left to the insert moment alone, anyone meeting the document
        // later would have no way to know something was missing.
        <ul
          className="mt-1 list-none space-y-0.5 text-[11px] text-[var(--ink-50)]"
          data-testid="snippet-embed-lossy"
        >
          {state.lossy.map((note) => (
            <li key={note} className="flex items-start gap-1">
              <Icon name="info" size={11} className="mt-0.5 shrink-0 text-[var(--ink-40)]" />
              {note}
            </li>
          ))}
        </ul>
      )}

      {chromeOpen && (
        <div
          // Absolute within this embed, so it is correct at any container size
          // and cannot escape into the page.
          className="absolute right-0 top-0 z-10 inline-flex items-center gap-1 rounded-bl-[var(--radius-row)] border-b border-l border-[var(--edge-soft)] bg-[var(--surface-raised)] px-1.5 py-0.5 text-[11px] shadow-sm backdrop-blur-sm"
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
