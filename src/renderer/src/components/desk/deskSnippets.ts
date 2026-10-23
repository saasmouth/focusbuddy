import { useEffect, useMemo } from 'react'
import type { Widget, WidgetKind } from '@shared/types'
import type { Snippet, SnippetInsertResult, SnippetKind, SnippetTarget, WidgetSnippetBody } from '@shared/snippets'
import { acceptsFor } from '@shared/snippetConvert/accepts'
import { registerSnippetTarget } from '../../stores/snippets'
import { useWidgetStore } from '../../stores/widgets'
import { snippetConvertDeps } from '../../lib/snippetConvertDeps'
import { spawnPositionFor } from '../../lib/spawnPosition'
import {
  announcePaste,
  bodyForms,
  placeOnDesk,
  readPasteForms,
  snapshotPaste,
  tookIt,
  type DeskPlacement
} from '../../lib/widgetSnippetInsert'

// A desk as a snippet surface: save a work widget as a reusable one, and place
// a saved one on any desk.
//
// DUPLICATE ONLY, on purpose. A work widget already has a live mechanism of its
// own: it is a file, and a file can be placed on any number of desks as a
// linked instance whose edits flow both ways (docs/widget-files.md). A "live
// widget snippet" would be a second way to do the same thing, competing with
// the first, so the desk target declares `supports: ['duplicate']` and the
// library offers Duplicate alone rather than a Live option that would either
// duplicate the widget-file mechanism or quietly degrade.
//
// So the division is: a widget SNIPPET is a template for making new widgets of
// a shape you use often; a widget FILE is one widget that appears in several
// places at once. Both are real, and they are not the same want.

/** Turn a widget on a desk into a reusable snippet body. */
export function widgetBodyFromWidget(w: Widget): WidgetSnippetBody {
  return {
    kind: 'widget',
    widgetKind: w.kind,
    title: w.title ?? '',
    content: w.content ?? '',
    // Size travels with the snippet because a widget's shape is part of what
    // makes it reusable; its POSITION does not, since the destination desk
    // decides where a new widget lands.
    width: w.width ?? 2,
    height: w.height ?? 2,
    color: w.color ?? null
  }
}

/**
 * Place a widget snippet on a desk as a new widget.
 *
 * Returns false when it declined — no desk, or a body that is not a widget — so
 * the store reports a refusal instead of counting a use that did not happen.
 */
export async function insertWidgetSnippetOnDesk(taskId: string, snippet: Snippet): Promise<boolean> {
  if (!taskId) return false
  if (snippet.body.kind !== 'widget') return false
  const b = snippet.body
  if (!b.widgetKind) return false
  const created = await useWidgetStore.getState().createOptional({
    taskId,
    kind: b.widgetKind as WidgetKind,
    // The snippet's own name is the better default title: it is what the user
    // called this reusable thing, and it is what they will look for on the desk.
    title: b.title || snippet.name,
    content: b.content,
    width: b.width,
    height: b.height,
    color: b.color
  })
  return created !== null
}

/**
 * Place ANY snippet on a desk. A work widget snippet lands as itself; every
 * other kind becomes the work widget that holds it natively
 * (shared/snippetWidgets.ts planDesk): a document a page, a sheet block a real
 * table work widget with its own table, a drawing, diagram, design or slide an
 * image work widget whose picture is stored in the file store, text a sticky.
 * A converted insert returns its lossy line as the notice; a refusal its reason.
 */
export async function insertSnippetOnDesk(taskId: string, snippet: Snippet, at?: DeskPlacement['at']): Promise<SnippetInsertResult> {
  if (!taskId) return { ok: false, reason: 'There is no desk open.' }
  if (snippet.body.kind === 'widget') return insertWidgetSnippetOnDesk(taskId, snippet)
  const placed = await placeOnDesk(bodyForms(snippet.body), { body: snippet.body, verb: 'insert' }, {
    taskId,
    title: snippet.name,
    at: at ?? ((w, h) => spawnPositionFor(w, h))
  })
  if (!placed.ok) return placed
  return tookIt(placed.lossy)
}

/** The kinds a desk takes: derived from the builders, never listed (shared/snippetConvert/accepts.ts). */
let deskAccepts: SnippetKind[] | null = null
export function deskAcceptedKinds(): SnippetKind[] {
  if (!deskAccepts) deskAccepts = acceptsFor('desk', snippetConvertDeps())
  return deskAccepts
}

/**
 * Register the open desk as an insertion target while it is mounted.
 *
 * `taskId` is the desk. A desk that is not open is not a destination, which is
 * why this is a registration tied to the mount rather than a list of all desks.
 */
export function useDeskSnippetTarget(taskId: string | null, deskTitle: string): void {
  useEffect(() => {
    if (!taskId) return
    const target: SnippetTarget = {
      id: `desk:${taskId}`,
      label: deskTitle?.trim() ? `“${deskTitle.trim()}” desk` : 'This desk',
      // A desk's own content is work widgets; every other kind is placed as
      // the work widget that holds it (insertSnippetOnDesk).
      accepts: deskAcceptedKinds(),
      host: 'desk',
      // See the note at the top: a widget file already provides live, so the
      // desk honours Duplicate and says so rather than offering both.
      supports: ['duplicate'],
      insert: (snippet, link) =>
        link === 'duplicate' ? insertSnippetOnDesk(taskId, snippet) : { ok: false, reason: 'A desk takes a copy of a snippet, not a live one.' }
    }
    return registerSnippetTarget(target)
  }, [taskId, deskTitle])
}

/** The registry id for a desk surface. One place, so host and picker agree. */
export function deskSnippetTargetId(taskId: string): string {
  return `desk:${taskId}`
}

// ── Paste onto the desk ──────────────────────────────────────────────────────

/** Is this element somewhere a paste belongs to something else (a field, a widget, a dialog)? */
export function pasteBelongsElsewhere(el: Element | null): boolean {
  if (!el || el === document.body || el === document.documentElement) return false
  const h = el as HTMLElement
  if (h.tagName === 'INPUT' || h.tagName === 'TEXTAREA' || h.tagName === 'SELECT' || h.isContentEditable) return true
  return !!h.closest('[data-widget-id], [role="dialog"], .fb-scrim, input, textarea, [contenteditable="true"]')
}

/** Paste the clipboard onto a desk as the work widget that holds it, and say what happened. */
export async function pasteOntoDesk(taskId: string, snap: ReturnType<typeof snapshotPaste>, at?: DeskPlacement['at']): Promise<boolean> {
  const read = await readPasteForms(snap)
  if (read.refused) {
    announcePaste({ ok: false, reason: read.refused })
    return false
  }
  const placed = await placeOnDesk(read.forms, read.ctx, { taskId, at: at ?? ((w, h) => spawnPositionFor(w, h)) })
  if (!placed.ok) {
    announcePaste(placed)
    return false
  }
  announcePaste({ ok: true, lossy: placed.lossy })
  return true
}

/**
 * ⌘V on the desk with nothing focused creates the work widget that holds what
 * is on the clipboard, beside the last-touched widget or at the viewport centre
 * (spawnPositionFor). The desk had no paste at all before this.
 *
 * Edit › Paste fires a DOM paste at whatever has focus (main/index.ts
 * editAction). With nothing focused that is the body; a field, a widget, a
 * dialog or an open document keeps its own paste. `surface` is the canvas
 * element: a desk hidden behind a full-pane document is not pasted into.
 */
export function useDeskPaste(taskId: string | null, surface: () => HTMLElement | null): void {
  const getSurface = useMemo(() => surface, [surface])
  useEffect(() => {
    if (!taskId) return
    const onPaste = (e: ClipboardEvent): void => {
      if (e.defaultPrevented) return
      const el = getSurface()
      if (!el || !el.isConnected || el.getClientRects().length === 0) return
      const target = e.target instanceof Element ? e.target : null
      if (pasteBelongsElsewhere(target) || pasteBelongsElsewhere(document.activeElement)) return
      // Something other than the desk surface itself (a panel, a document) has the paste.
      if (target && target !== document.body && !el.contains(target)) return
      e.preventDefault()
      void pasteOntoDesk(taskId, snapshotPaste(e.clipboardData))
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [taskId, getSurface])
}
