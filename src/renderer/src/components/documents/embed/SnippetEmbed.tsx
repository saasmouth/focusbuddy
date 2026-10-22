import { lazy, Suspense, useEffect, useState } from 'react'
import type { Snippet } from '@shared/snippets'
import { snippetKindIcon } from '@shared/snippets'
import Icon from '../../Icon'

// Lazy, to break the document <-> snippet import cycle. See SnippetDocBody.
const SnippetDocBody = lazy(() => import('./SnippetDocBody'))

// A LIVE saved snippet inside a host. The host stores only the snippet's id;
// this resolves it on every mount, so the master's current content is what
// shows and the host never carries a stale copy. Editing the snippet in the
// library changes every live instance of it at once — which is the whole
// difference between a live instance and a duplicate.
//
// It never pretends. A snippet that has been deleted renders an explicit
// missing state naming the id, not an empty space and not a cached copy of
// what it used to say: a live instance is a reference, so a dangling reference
// should look dangling and be fixable. Likewise a snippet whose body is a kind
// this host cannot draw says so rather than rendering nothing.

export interface SnippetEmbedProps {
  snippetId: string
  /** Shown while resolving, and in the header once resolved. */
  compact?: boolean
}

type State =
  | { phase: 'loading' }
  | { phase: 'missing' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; snippet: Snippet }

export default function SnippetEmbed({ snippetId, compact }: SnippetEmbedProps): JSX.Element {
  const [state, setState] = useState<State>({ phase: 'loading' })

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

  if (state.phase === 'loading') {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-[var(--ink-50)]" data-testid="snippet-embed-loading">
        <Icon name="autorenew" size={14} className="animate-spin" />
        Loading snippet…
      </div>
    )
  }

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
  return (
    <div
      className="rounded-[var(--radius-row)] border border-[var(--edge-soft)] bg-[var(--surface-raised)]"
      data-testid="snippet-embed"
      data-snippet-id={snippet.id}
      data-snippet-revision={snippet.revision}
    >
      {!compact && (
        <div className="flex items-center gap-1.5 border-b border-[var(--edge-soft)] px-2.5 py-1 text-[11px] text-[var(--ink-50)]">
          <Icon name={snippetKindIcon(snippet.kind)} size={13} className="text-[var(--ink-40)]" />
          <span className="truncate font-medium text-[var(--ink-70)]">{snippet.name}</span>
          <span
            className="ml-auto inline-flex items-center gap-1 rounded-full bg-accent/10 px-1.5 text-[10px] text-accent"
            title="Live: this updates when the saved snippet changes"
          >
            <Icon name="sync" size={11} /> Live
          </span>
        </div>
      )}
      <SnippetEmbedBody snippet={snippet} />
    </div>
  )
}

/**
 * Draw the body for the kinds a document host can render. A kind this host
 * cannot draw is named rather than silently skipped, so the user can see that
 * the snippet is there and why it is not showing.
 */
function SnippetEmbedBody({ snippet }: { snippet: Snippet }): JSX.Element {
  if (snippet.body.kind === 'doc') {
    return (
      <Suspense
        fallback={<div className="px-3 py-2 text-[12px] text-[var(--ink-50)]">Rendering…</div>}
      >
        <SnippetDocBody content={snippet.body.content} />
      </Suspense>
    )
  }
  return (
    <div className="px-3 py-2 text-[12px] text-[var(--ink-50)]" data-testid="snippet-embed-unsupported">
      A {snippet.body.kind} snippet cannot be shown inside a document. Open it from the snippet library.
    </div>
  )
}
