import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ORG_SNIPPET_REACH_NOTE,
  snippetKindLabel,
  type Snippet,
  type SnippetBody,
  type SnippetKind
} from '@shared/snippets'
import Icon from '../Icon'

// Each kind's editor is loaded only when a snippet of that kind is opened. The
// host would otherwise pull every office app into its own bundle — and
// SnippetDocSurface reaches the document schema, which registers the snippet
// node, which renders the embed, so that one has to be lazy regardless.
const SnippetDocSurface = lazy(() => import('./SnippetDocSurface'))
const SnippetSheetSession = lazy(() => import('./SnippetSheetSession'))

function Loading(): JSX.Element {
  return <div className="p-4 text-[12px] text-[var(--ink-50)]">Opening the editor…</div>
}

// A saved snippet opened as a document.
//
// The owner's "Open original": a converted snippet placed elsewhere is live and
// read-only, and this is where its master is actually edited — in the app that
// owns its kind, as a real editor. Saving writes the master, and every live
// instance everywhere follows.
//
// ONE HOST FOR EVERY KIND, not one per app. The session logic is identical
// whatever is being edited — load, buffer, banner, save, conflict, close — and
// only the BODY WRAPPING differs per kind. Six hosts would have meant six copies
// of the conflict rule and six chances for one of them to be subtly wrong.
//
// NOTHING IS PERSISTED BUT THE SNIPPET. No document row is created, so there is
// nothing to leak into Files if the app dies mid-session — which is why this is
// not implemented as "make a document, copy it back, delete it".
//
// "TYPING DOES NOT WRITE" IS A PROPERTY OF THIS FILE. None of the office editors
// saves anything: they are controlled components whose only output is onChange,
// and their HOSTS persist, which is what makes them look like they autosave. So
// there is nothing in any app to suppress — a `sessionMode` prop on an editor
// would be a flag suppressing something the component does not do. Here, the
// body is buffered into a ref and written only by Save.

/** How a kind's body is edited: wrapped on the way in, unwrapped on the way out. */
export interface SnippetKindEditor {
  render: (args: {
    body: SnippetBody
    title: string
    /**
     * Hand back the snippet-shaped body, plus anything the snippet CANNOT HOLD.
     *
     * `lost` exists because a session editor is a full app and a snippet body is
     * narrower than the document it edits. A user can make something the snippet
     * has no field for — d1's examples in Draw are a paint layer or a second
     * artboard — and the choice is then between dropping it silently and saying
     * so. Silently is not a choice: the save reports success and the work is
     * gone.
     *
     * Entries should still PREVENT the loss where they can, which is strictly
     * better: 84 hid the page tabs in a diagram session so a second page cannot
     * be made, rather than reporting one that was. `lost` is for what cannot be
     * prevented. Each string is user-facing copy, in the destination's terms.
     */
    onChange: (next: SnippetBody, lost?: string[]) => void
  }) => ReactNode
}

/**
 * The editors, by kind. Each app's owner contributes its own entry, because the
 * wrapping is theirs to get right:
 *
 *   draw     direct — a DrawSnippetBody goes straight into DrawStudio's content
 *   diagram  trivial — {nodes, edges} IS MapBody's first page
 *   design   an in-memory wrapper; a DesignSnippetBody has no width/height/pages,
 *            and the snippet's carried swatches go on DesignBody.swatches so every
 *            fill resolves against the palette it was saved with
 *   slide    an in-memory one-slide deck with the rail hidden; SlidesEditor cannot
 *            edit a fragment without a container, and nothing is persisted
 *   sheet    mine, next: a SheetSnippetBody has rows but a SheetBody wraps SheetTabs
 *
 * A kind with no entry says so rather than opening something that cannot save.
 */
const EDITORS: Partial<Record<SnippetKind, SnippetKindEditor>> = {
  doc: {
    render: ({ body, onChange }) =>
      body.kind === 'doc' ? (
        <Suspense fallback={<Loading />}>
          <SnippetDocSurface
            content={body.content}
            onChange={(content, text) => onChange({ kind: 'doc', content, text })}
          />
        </Suspense>
      ) : null
  },
  sheet: {
    render: ({ body, title, onChange }) => (
      <Suspense fallback={<Loading />}>
        <SnippetSheetSession body={body} title={title} onChange={onChange} />
      </Suspense>
    )
  }
  // NO `draw` ENTRY, and its absence is deliberate rather than pending.
  //
  // I had one, built on d1's first answer that a DrawSnippetBody could go
  // straight into DrawStudio's `content`. d1 then corrected that: a
  // DrawSnippetBody is {kind, objects, assets, swatches} and NOT a drawing body,
  // so it needs wrapping — objects onto a vector layer, the asset store, the
  // swatches, an artboard sized to the object bounds — and unwrapping again on
  // the way out. Passing it raw would have opened an editor on something
  // DrawStudio does not understand.
  //
  // Those helpers are Draw's model, so d1 is writing them in src/shared/draw.
  // Until they land, `draw` falls through to "cannot be opened for editing yet",
  // which is the honest state: a registry entry that opens a broken editor is
  // worse than one that is missing.
}

export interface SnippetEditSessionViewProps {
  snippetId: string
  onClose: () => void
  /**
   * Override the per-kind editors. Defaults to the registry above.
   *
   * Not a test-only seam: it is how an app owner unit-tests their own kind's
   * wrap/unwrap against this host without mounting their whole editor, and how
   * the host's own "typing does not write" test drives onChange directly.
   */
  editors?: Partial<Record<SnippetKind, SnippetKindEditor>>
}

type Load =
  | { phase: 'loading' }
  | { phase: 'gone' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; snippet: Snippet }

type SaveState =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | { phase: 'failed'; message: string }
  // The master moved while this session was open. Both ways out are explicit.
  | { phase: 'conflict'; message: string; theirs: Snippet }

export default function SnippetEditSessionView({
  snippetId,
  onClose,
  editors = EDITORS
}: SnippetEditSessionViewProps): JSX.Element {
  const [load, setLoad] = useState<Load>({ phase: 'loading' })
  const [save, setSave] = useState<SaveState>({ phase: 'idle' })
  const [dirty, setDirty] = useState(false)
  // Bumped only when the body is REPLACED from outside the editor — which today
  // means Reload. Every office editor seeds its own store, undo stack and loaded
  // rasters from `content` on MOUNT and does not re-seed on a prop change, so
  // without a remount a Reload would leave the user looking at the body they
  // just chose to discard. d1 caught this for DrawStudio; it is true of all of
  // them, including my own sheet session, which seeds its wrapped workbook in a
  // useState initialiser.
  //
  // Deliberately NOT keyed on the revision: a successful Save bumps that, and
  // remounting then would throw away undo history and scroll position for no
  // reason, since the body on screen is already the body that was saved.
  const [seed, setSeed] = useState(0)
  // What the current body cannot keep, as reported by the editor entry.
  const [lost, setLost] = useState<string[]>([])

  // The latest body lives in a ref, not state: it is written by every keystroke
  // and read only by Save, so re-rendering the editor on each change would be
  // both pointless and a way to fight the editor for control of its own content.
  const latest = useRef<SnippetBody | null>(null)
  const baseRevision = useRef<number>(0)

  useEffect(() => {
    let live = true
    setLoad({ phase: 'loading' })
    window.api.snippets
      .get(snippetId)
      .then((s) => {
        if (!live) return
        if (!s) {
          setLoad({ phase: 'gone' })
          return
        }
        latest.current = s.body
        baseRevision.current = s.revision
        setLoad({ phase: 'ready', snippet: s })
      })
      .catch((e: Error) => {
        if (!live) return
        setLoad({ phase: 'error', message: e.message || 'The snippet could not be read.' })
      })
    return () => {
      live = false
    }
  }, [snippetId])

  const commit = useCallback(
    async (expected: number): Promise<void> => {
      const body = latest.current
      if (!body) return
      setSave({ phase: 'saving' })
      const res = await window.api.snippets.update(snippetId, { body, expectedRevision: expected })
      if (res.ok && res.snippet) {
        baseRevision.current = res.snippet.revision
        setDirty(false)
        setSave({ phase: 'idle' })
        return
      }
      if (res.conflictWith) {
        setSave({
          phase: 'conflict',
          message: res.error ?? 'This snippet was changed somewhere else.',
          theirs: res.conflictWith
        })
        return
      }
      setSave({ phase: 'failed', message: res.error ?? 'The snippet could not be saved.' })
    },
    [snippetId]
  )

  const close = useCallback(() => {
    // Unsaved work in a session is lost silently otherwise: there is no document
    // holding it, which is the whole point of the design.
    if (dirty && !window.confirm('Close without saving? Your changes to this snippet will be lost.')) {
      return
    }
    onClose()
  }, [dirty, onClose])

  if (load.phase === 'loading') {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-[var(--ink-50)]">
        <Icon name="autorenew" size={16} className="mr-2 animate-spin" /> Opening the snippet…
      </div>
    )
  }

  if (load.phase === 'gone') {
    return (
      <SessionShell onClose={onClose} title="Snippet not found">
        <p className="p-4 text-[13px] text-[var(--ink-60)]" data-testid="snippet-session-gone">
          This snippet has been deleted, so there is nothing to edit.
        </p>
      </SessionShell>
    )
  }

  if (load.phase === 'error') {
    return (
      <SessionShell onClose={onClose} title="Snippet could not be opened">
        <p className="p-4 text-[13px] text-red-600 dark:text-red-400" data-testid="snippet-session-error">
          {load.message}
        </p>
      </SessionShell>
    )
  }

  const { snippet } = load
  const editor = editors[snippet.kind]

  return (
    <SessionShell onClose={close} title={`Editing saved snippet “${snippet.name}”`}>
      <div
        className="flex items-start gap-2 border-b border-[var(--edge-soft)] bg-accent/[0.06] px-3 py-1.5 text-[11px] text-[var(--ink-60)]"
        data-testid="snippet-session-banner"
      >
        <Icon name="info" size={13} className="mt-0.5 shrink-0 text-accent" />
        <span>
          Editing saved snippet “{snippet.name}” — changes appear everywhere it is used.
          {/*
            Deliberately no count. There is a usage_count column, but it counts
            inserts over all time and is never decremented, so "used in 7 places"
            from it would be a precise-looking number that is simply wrong. The
            warning is true without it.
          */}
          {snippet.scope === 'org' && (
            <span className="block text-[var(--ink-50)]">{ORG_SNIPPET_REACH_NOTE}</span>
          )}
        </span>
      </div>

      {save.phase === 'conflict' && (
        <div
          className="flex flex-wrap items-center gap-2 border-b border-[var(--edge-soft)] bg-amber-500/10 px-3 py-1.5 text-[11px] text-[var(--ink-70)]"
          data-testid="snippet-session-conflict"
        >
          <Icon name="warning" size={13} className="text-amber-600" />
          <span>{save.message}</span>
          <button
            type="button"
            className="fb-btn !h-5 px-2 text-[10px]"
            data-testid="snippet-session-reload"
            onClick={() => {
              // Take theirs: their body becomes the session's, and the base
              // revision moves to theirs so the next save is clean.
              latest.current = save.theirs.body
              baseRevision.current = save.theirs.revision
              setDirty(false)
              setLost([])
              setSave({ phase: 'idle' })
              setLoad({ phase: 'ready', snippet: save.theirs })
              // Forces the editor to remount and re-seed from their body. The
              // editors do not re-seed on a prop change, so without this the
              // Reload would be invisible.
              setSeed((n) => n + 1)
            }}
          >
            Reload theirs
          </button>
          <button
            type="button"
            className="fb-btn !h-5 px-2 text-[10px]"
            data-testid="snippet-session-overwrite"
            onClick={() => void commit(save.theirs.revision)}
          >
            Overwrite with mine
          </button>
        </div>
      )}

      {save.phase === 'failed' && (
        <div
          className="border-b border-[var(--edge-soft)] bg-red-500/10 px-3 py-1.5 text-[11px] text-red-700 dark:text-red-300"
          data-testid="snippet-session-save-error"
        >
          {save.message}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {editor ? (
          <div key={`${snippetId}:${seed}`} className="h-full min-h-0">
            {editor.render({
              body: latest.current ?? snippet.body,
              title: snippet.name,
              onChange: (next, losing) => {
                latest.current = next
                setLost(losing ?? [])
                if (!dirty) setDirty(true)
              }
            })}
          </div>
        ) : (
          <p className="p-4 text-[13px] text-[var(--ink-60)]" data-testid="snippet-session-unsupported">
            A {snippetKindLabel(snippet.kind).toLowerCase()} cannot be opened for editing yet.
          </p>
        )}
      </div>

      {lost.length > 0 && (
        // Beside Save, not after it. The user is about to decide, and this is
        // the only moment the information is useful — afterwards the work is
        // already gone. Saving is still allowed: it is their call, not ours.
        <div
          className="flex items-start gap-2 border-t border-[var(--edge-soft)] bg-amber-500/10 px-3 py-1.5 text-[11px] text-[var(--ink-70)]"
          data-testid="snippet-session-lost"
        >
          <Icon name="warning" size={13} className="mt-0.5 shrink-0 text-amber-600" />
          <span>
            Saving will not keep:
            <ul className="list-disc pl-4">
              {lost.map((what) => (
                <li key={what}>{what}</li>
              ))}
            </ul>
          </span>
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-[var(--edge-soft)] px-3 py-1.5">
        <button
          type="button"
          onClick={() => void commit(baseRevision.current)}
          disabled={!dirty || save.phase === 'saving' || !editor}
          className="fb-btn fb-btn-primary !h-6 px-2.5 text-[11px]"
          data-testid="snippet-session-save"
        >
          {save.phase === 'saving' ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={close}
          className="fb-btn !h-6 px-2.5 text-[11px]"
          data-testid="snippet-session-close"
        >
          Done
        </button>
        {dirty && <span className="text-[10px] text-[var(--ink-40)]">Unsaved changes</span>}
      </div>
    </SessionShell>
  )
}

function SessionShell({
  title,
  onClose,
  children
}: {
  title: string
  onClose: () => void
  children: ReactNode
}): JSX.Element {
  // tabIndex so Escape still reaches the dialog when focus is on the shell
  // itself rather than inside one of the editors.
  return (
    <div
      className="flex h-full min-h-0 flex-col bg-[var(--surface-base)]"
      data-testid="snippet-session"
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        // `defaultPrevented` is the whole reason this is safe to put on the
        // shell. Escape means "cancel the nearest thing", and inside a session
        // that is usually not the session: PlexiiCells cancels a cell edit with
        // Escape and calls preventDefault without stopping propagation
        // (SheetGrid's cell input), so the keypress arrives here too. Closing
        // on it would abandon a sheet snippet because the user backed out of
        // one cell. Anything nearer the user that handled it wins.
        if (e.defaultPrevented) return
        e.stopPropagation()
        onClose()
      }}
    >
      <header className="flex items-center gap-2 border-b border-[var(--edge-soft)] px-3 py-1.5">
        <Icon name="bookmark" size={14} className="text-[var(--ink-40)]" />
        <span className="truncate text-[12px] font-semibold text-[var(--ink-90)]">{title}</span>
        <button
          type="button"
          onClick={onClose}
          className="icon-btn ml-auto !h-6 !w-6"
          aria-label="Close"
          data-testid="snippet-session-dismiss"
        >
          <Icon name="close" size={14} />
        </button>
      </header>
      {children}
    </div>
  )
}
