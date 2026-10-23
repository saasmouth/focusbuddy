import { lazy, Suspense, useCallback, useContext, useEffect, useState } from 'react'
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
import { ORG_SNIPPET_REACH_NOTE } from '@shared/snippets'
import { onSnippetChanged, useSnippetsStore } from '../../../stores/snippets'
import { SnippetAncestry } from '../../snippets/snippetAncestry'

// Lazy: this reaches the document schema, which registers this very node.
const SnippetInlineEditor = lazy(() => import('../../snippets/SnippetInlineEditor'))

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
  /**
   * Replace this instance with the content it is showing, unlinked — the owner's
   * "Detach to edit only here". The host owns it because only the host can edit
   * its own document; absent means no detach is offered.
   */
  onDetach?: (content: unknown[]) => void
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

/** The editable node list of a body, empty for a kind with no doc content. */
function contentOf(body: SnippetBody): unknown[] {
  return body.kind === 'doc' ? body.content : []
}

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
  onOpenOriginal,
  onDetach
}: SnippetEmbedProps): JSX.Element {
  const ancestry = useContext(SnippetAncestry)
  const cyclic = Boolean(snippetId) && ancestry.includes(snippetId)
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!snippetId) {
      setState({ phase: 'missing' })
      return
    }
    // A snippet inside itself. Not fetched at all: resolving it would mount this
    // component inside itself without end.
    if (cyclic) return
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
  }, [snippetId, cyclic, host])

  const togglePin = useCallback(() => onShowChromeChange?.(!showChrome), [onShowChromeChange, showChrome])

  const saveToMaster = useCallback(
    async (content: unknown[], text: string): Promise<void> => {
      if (!snippetId) return
      setSaving(true)
      // Through the store rather than the IPC directly, so the error surfaces in
      // the same place every other snippet write surfaces it. The master write
      // broadcasts from main, so this instance and every other one re-resolve —
      // no local state update is needed and none is done, which is why what
      // appears after a save is what was actually stored.
      const saved = await useSnippetsStore.getState().update(snippetId, {
        body: { kind: 'doc', content: content as never, text }
      })
      setSaving(false)
      if (saved) setEditing(false)
    },
    [snippetId]
  )

  if (cyclic) {
    return (
      <div
        className="flex items-start gap-2 rounded-[var(--radius-row)] border border-dashed border-[var(--edge-firm)] px-3 py-2 text-[12px] text-[var(--ink-60)]"
        data-testid="snippet-embed-cycle"
      >
        <Icon name="loop" size={14} className="mt-0.5 text-[var(--ink-40)]" />
        <span>
          This snippet contains itself, so it cannot be shown here.
          <span className="block text-[11px] text-[var(--ink-40)]">
            Remove the inner copy from the saved snippet, or detach one of them.
          </span>
        </span>
      </div>
    )
  }

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
      <SnippetAncestry.Provider value={[...ancestry, snippet.id]}>
        {editing ? (
          <>
            {/*
              Persistent, not a toast. Editing here writes the MASTER, so this
              instance's blast radius is every other place the snippet is used —
              the user should be able to read that for as long as they are typing,
              not for three seconds after they started.
            */}
            <div
              className="mb-1 flex items-start gap-1.5 rounded-[var(--radius-row)] bg-accent/[0.08] px-2 py-1 text-[11px] text-[var(--ink-60)]"
              data-testid="snippet-edit-notice"
            >
              <Icon name="info" size={12} className="mt-0.5 shrink-0 text-accent" />
              <span>
                Editing the saved snippet. Changes appear everywhere it is used in this workspace.
                {snippet.scope === 'org' && (
                  <span className="block text-[var(--ink-50)]">{ORG_SNIPPET_REACH_NOTE}</span>
                )}
                {onDetach && (
                  <button
                    type="button"
                    onClick={() => onDetach(contentOf(state.body))}
                    className="ml-0 mt-0.5 block text-left text-accent underline decoration-dotted"
                    data-testid="snippet-detach"
                  >
                    Detach to edit only here
                  </button>
                )}
              </span>
            </div>
            <Suspense
              fallback={<span className="text-[12px] text-[var(--ink-50)]">Opening the editor…</span>}
            >
              <SnippetInlineEditor
                content={contentOf(state.body)}
                busy={saving}
                onCommit={saveToMaster}
                onCancel={() => setEditing(false)}
              />
            </Suspense>
          </>
        ) : (
          <SnippetContent body={state.body} />
        )}
      </SnippetAncestry.Provider>

      {!editing && state.lossy.length > 0 && (
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

      {chromeOpen && !editing && (
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

          {mode === 'editable' && state.body.kind === 'doc' && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="icon-btn !h-5 !w-5"
              aria-label="Edit the saved snippet here"
              title="Edit the saved snippet here — changes appear everywhere it is used"
              data-testid="snippet-embed-edit"
            >
              <Icon name="edit" size={12} />
            </button>
          )}

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
