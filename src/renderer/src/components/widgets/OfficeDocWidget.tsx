import { useEffect, useRef, useState } from 'react'
import type { Widget } from '@shared/types'
import type { DocType, FbDocument } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import { useWidgetStore } from '../../stores/widgets'
import { DocEditor, SheetEditor, SlidesEditor, MapEditor, DesignEditor, DrawStudio } from '@office'
import { createDocumentOps } from '../documents/editor/documentOps'
import DocumentConflictBar from '../documents/DocumentConflictBar'
import { useViewStore } from '../../stores/view'
import type { MapBody, SheetBody, SlidesBody } from '@shared/types'

// A document / spreadsheet / slide deck living on the canvas as a native widget.
// widget.content holds the backing fb_documents id (the same store the full
// Documents view uses), so the same file can be opened in both places and edits
// stay in sync. A widget with no content yet lazily provisions a blank document
// of its type. Body edits persist straight to the document (debounced) via IPC.

interface Props {
  widget: Widget
  inline?: boolean
}

const KIND_TO_DOCTYPE: Record<string, DocType> = {
  doc: 'doc',
  sheet: 'sheet',
  slides: 'slides',
  map: 'map',
  design: 'design',
  draw: 'draw'
}
const TYPE_META: Record<DocType, { label: string; accent: string }> = {
  doc: { label: 'Document', accent: 'bg-sky-300/60 dark:bg-sky-400/25' },
  sheet: { label: 'Spreadsheet', accent: 'bg-emerald-300/60 dark:bg-emerald-400/25' },
  slides: { label: 'Slides', accent: 'bg-orange-300/60 dark:bg-orange-400/25' },
  map: { label: 'Diagram', accent: 'bg-violet-300/60 dark:bg-violet-400/25' },
  design: { label: 'Design', accent: 'bg-pink-300/60' },
  draw: { label: 'Artwork', accent: 'bg-fuchsia-300/60 dark:bg-fuchsia-400/25' },
  // Never rendered here: a widget file placed on a desk is a linked instance of
  // its own kind, not an office document embed. Present for exhaustiveness.
  widget: { label: 'Work widget', accent: 'bg-stone-200/70 dark:bg-white/[0.07]' }
}

export default function OfficeDocWidget({ widget, inline = false }: Props): JSX.Element {
  const docType = KIND_TO_DOCTYPE[widget.kind] ?? 'doc'
  const updateWidget = useWidgetStore((s) => s.update)
  const [doc, setDoc] = useState<FbDocument | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Trashed from this widget's own File menu. Its own state rather than `error`,
  // because it is something the user did on purpose, not a failure.
  const [trashed, setTrashed] = useState(false)
  /**
   * A save this widget was refused because the document changed elsewhere.
   *
   * The edit is NOT written and NOT discarded: it stays on screen and in
   * `pending`, and `theirs` is what is actually stored. This widget is the
   * common way to hit that — two linked-duplicate widgets share a document id,
   * so the same document really is open twice, and before this the slower save
   * silently overwrote the other.
   */
  const [conflict, setConflict] = useState<FbDocument | null>(null)
  /**
   * Bumped whenever the body is replaced from OUTSIDE this widget, to force the
   * editor to remount and re-seed.
   *
   * Not cosmetic, and the reason is the whole bug in miniature: every office
   * editor builds its content from `content`/`body` on MOUNT and never
   * re-seeds. Catching up by swapping `doc` alone moved this widget's base
   * revision forward while the editor still displayed its mount-time text — so
   * the next keystroke saved stale text against a current revision, the
   * compare-and-set passed, and the other editor's work was destroyed anyway.
   * The guard would have been defeated by its own catch-up.
   *
   * Remounting costs the undo stack and the cursor, which is the right trade
   * here: this only happens when there is nothing unsaved, so the user is not
   * typing.
   */
  const [bodyEpoch, setBodyEpoch] = useState(0)
  /** The body version this widget's copy is based on. */
  const baseRev = useRef(0)
  /** The latest edit, kept so a refusal can be resolved without re-typing. */
  const pending = useRef<FbDocument['body'] | null>(null)
  const goDocument = useViewStore((s) => s.goDocument)
  const provisioned = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load the backing document, or provision a blank one and repoint the widget.
  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      if (widget.content) {
        const fetched = await window.api.documents.get(widget.content)
        if (cancelled) return
        if (fetched) {
          setDoc(fetched)
          baseRev.current = fetched.bodyRev
          return
        }
        // Dangling id (e.g. document deleted) — heal by provisioning a new one.
      }
      if (provisioned.current) return
      provisioned.current = true
      const created = await window.api.documents.create({
        docType,
        title: widget.title || TYPE_META[docType].label
      })
      if (cancelled) return
      setDoc(created)
      baseRev.current = created.bodyRev
      await updateWidget(widget.id, { content: created.id })
    }
    void load().catch((e) => !cancelled && setError((e as Error).message))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget.content])

  // Catch up when another editor on this same document saves — and only when
  // there is nothing of this widget's own to lose. Two linked-duplicate widgets
  // share a document id, so this is the path that keeps them in step instead of
  // letting them drift until one save is refused.
  useEffect(() => {
    const id = widget.content
    if (!id || !window.api?.documents?.onChanged) return
    return window.api.documents.onChanged((changedId, bodyRev) => {
      if (changedId !== id) return
      if (bodyRev === baseRev.current) return // the echo of our own save
      // An unsaved edit outranks a refresh: replacing the body under someone
      // mid-sentence would destroy exactly the work the guard protects. Their
      // save will be refused when they stop, and the bar explains why.
      if (pending.current !== null) return
      void window.api.documents.get(id).then((fresh) => {
        if (!fresh || pending.current !== null) return
        setDoc(fresh)
        baseRev.current = fresh.bodyRev
        setBodyEpoch((e) => e + 1)
      })
    })
  }, [widget.content])

  // Debounced persist of the body to the document store, CONDITIONALLY: the
  // write replaces the stored body only if it is still the one this widget was
  // handed. The same document can be open in another widget, the Documents view
  // or another window, each holding the whole body in its own memory, and an
  // unconditional write destroyed whichever edit was slower — silently, with no
  // merge and no warning. See documents.body_rev.
  function saveBody(body: unknown): void {
    setDoc((d) => (d ? { ...d, body: body as FbDocument['body'] } : d))
    pending.current = body as FbDocument['body']
    if (!widget.content) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void (async () => {
        const id = widget.content
        const toSave = pending.current
        if (!id || toSave === null) return
        const res = await window.api.documents.updateBody(id, toSave, baseRev.current)
        if (res.ok) {
          baseRev.current = res.doc.bodyRev
          pending.current = null
          setConflict(null)
          return
        }
        // Keep the edit and say what is stored. Choosing a side here is exactly
        // the bug this replaced.
        if (res.reason === 'stale') setConflict(res.current)
        else setError('That document is no longer there.')
      })()
    }, 500)
  }

  /** Resolve a refused save. Only the branch the user picks loses anything. */
  async function resolveConflict(choice: 'theirs' | 'mine' | 'copy'): Promise<void> {
    const theirs = conflict
    const mine = pending.current
    if (!theirs) return
    if (saveTimer.current) clearTimeout(saveTimer.current)

    if (choice === 'theirs') {
      setDoc(theirs)
      baseRev.current = theirs.bodyRev
      pending.current = null
      setConflict(null)
      // Taking theirs is only real if the editor shows it: without the remount
      // the user keeps looking at the body they just chose to discard.
      setBodyEpoch((e) => e + 1)
      return
    }
    if (choice === 'mine') {
      if (mine === null) return setConflict(null)
      // Against the revision just shown: a deliberate replacement of a body the
      // user has been told about, not another blind race.
      const res = await window.api.documents.updateBody(theirs.id, mine, theirs.bodyRev)
      if (res.ok) {
        baseRev.current = res.doc.bodyRev
        pending.current = null
        setConflict(null)
      } else if (res.reason === 'stale') setConflict(res.current)
      else setConflict(null)
      return
    }
    // 'copy' — the stored document is left alone and this widget moves to a new
    // one holding the user's text, so their work stays where they were working.
    if (mine === null) return setConflict(null)
    const copy = await window.api.documents.create({
      docType,
      title: `${theirs.title || TYPE_META[docType].label} (my copy)`,
      body: mine
    })
    pending.current = null
    setConflict(null)
    setDoc(copy)
    baseRev.current = copy.bodyRev
    await updateWidget(widget.id, { content: copy.id })
  }

  // THE FIX THIS FILE EXISTS IN. The editors' File menus used to act on the
  // documents store's `active` document, and this widget never puts its document
  // there — it holds it in local state — so a widget's Move to trash trashed
  // whatever the Documents view last had open, and Make a copy produced a copy
  // titled from this widget and bodied from that other file. Both silently.
  // Bound here to the document this widget is actually showing.
  const documentOps = doc
    ? createDocumentOps({
        id: doc.id,
        docType,
        title: () => doc.title,
        // New and Make a copy open the new document in the Documents view. That
        // leaves the desk, which is the honest reading of the menu item: the
        // alternative — silently repointing this widget at the new document —
        // would replace what the user was looking at without being asked.
        onOpen: (id) => goDocument(id),
        onTrashed: () => setTrashed(true),
        // The header label and the editors read the title from this local copy,
        // so it has to be told; nothing else would update it.
        onRenamed: (title) => setDoc((d) => (d ? { ...d, title } : d))
      })
    : undefined

  const meta = TYPE_META[docType]
  let body: JSX.Element
  if (trashed) {
    body = (
      <div className="h-full w-full flex flex-col items-center justify-center gap-1 px-4 text-center">
        <span className="text-[11px] text-[var(--ink-70)]">
          Moved to the trash.
        </span>
        <span className="text-[10px] text-[var(--ink-50)]">
          Restore it from Documents to use this work widget again.
        </span>
      </div>
    )
  } else if (error) {
    body = <div className="h-full w-full flex items-center justify-center text-[11px] text-red-500">{error}</div>
  } else if (!doc) {
    body = (
      <div className="h-full w-full flex items-center justify-center text-[11px] text-[var(--ink-50)]">
        Loading {meta.label.toLowerCase()}…
      </div>
    )
  } else if (docType === 'doc') {
    body = (
      <DocEditor
        key={`${doc.id}:${bodyEpoch}`}
        content={doc.body}
        title={doc.title}
        onChange={saveBody}
        documentOps={documentOps}
      />
    )
  } else if (docType === 'sheet') {
    body = (
      <SheetEditor
        key={`${doc.id}:${bodyEpoch}`}
        body={doc.body as SheetBody}
        title={doc.title}
        onChange={saveBody}
        documentOps={documentOps}
      />
    )
  } else if (docType === 'slides') {
    body = <SlidesEditor key={`${doc.id}:${bodyEpoch}`} body={doc.body as SlidesBody} title={doc.title} onChange={saveBody} />
  } else if (docType === 'design') {
    body = <DesignEditor key={`${doc.id}:${bodyEpoch}`} content={doc.body} title={doc.title} onChange={saveBody} />
  } else if (docType === 'draw') {
    body = <DrawStudio key={`${doc.id}:${bodyEpoch}`} content={doc.body} title={doc.title} onChange={saveBody} />
  } else {
    body = <MapEditor key={`${doc.id}:${bodyEpoch}`} body={doc.body as MapBody} title={doc.title} onChange={saveBody} />
  }

  // Stop right-clicks (and the editors' own context menus, e.g. the sheet column
  // header menu) from bubbling to the canvas, so the canvas add/widget menu does
  // not hijack them when the document widget is focused.
  const wrapped = (
    <div
      className="flex h-full w-full flex-col bg-[var(--surface-raised)]"
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
      {/* Under the editor rather than over it: the text the user is deciding
          about has to stay visible while they decide. */}
      {conflict && (
        <DocumentConflictBar
          theirs={conflict}
          onTheirs={() => void resolveConflict('theirs')}
          onMine={() => void resolveConflict('mine')}
          onCopy={() => void resolveConflict('copy')}
        />
      )}
    </div>
  )
  if (inline) return wrapped
  return (
    <WidgetFrame widget={widget} headerLabel={doc?.title || meta.label} headerAccent={meta.accent}>
      {wrapped}
    </WidgetFrame>
  )
}
