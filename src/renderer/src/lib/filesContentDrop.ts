// Dropping things from Files INTO content: the six office apps and the work
// widgets that take content. Each target supplies only its own landing (the
// app's existing paste with our read, or the widget hook's dropForms); this
// runs every dropped item through it in order and says ONE line for the whole
// drop: what landed, what could not and why, and what a conversion lost.

import type { SnippetInsertResult } from '@shared/snippets'
import type { FileDragRef } from '@shared/filesDragPayload'
import type { PasteOutcome } from './clipboardPaste'
import { collectNotices } from './convertedNotice'
import { readFilesDrag } from './filesDrag'
import { readFilesDragForms } from './filesDragForms'
import type { FormsRead } from './clipboardForms'
import type { TargetOptions } from '@shared/fileForms'
import { composeDropNotice } from './filesDrop'
import { useNoticeStore } from '../stores/notice'
import { tidyNotes } from '@shared/snippetForms/lossy'

/** How long the drop's line stays (the conversion notice's own duration). */
const DROP_NOTICE_MS = 9000

export interface ItemOutcome {
  ref: FileDragRef
  landed: boolean
  /** Why it did not land (verbatim). */
  reason?: string
  /** What the conversion lost, or a fallback said aloud ("added as a link"). */
  lines: string[]
}

export interface DropReport {
  outcomes: ItemOutcome[]
  /** The one line shown (null when nothing needed saying). */
  notice: string | null
}

/**
 * Land each ref through `land`, reading it for `opts` first, and show one line.
 * `land` returns the app's own outcome; announcements it makes along the way
 * are gathered, not shown, so the drop speaks once.
 */
export async function runContentDrop(
  refs: FileDragRef[],
  opts: TargetOptions,
  land: (read: FormsRead, ref: FileDragRef) => Promise<PasteOutcome | SnippetInsertResult>
): Promise<DropReport> {
  const outcomes: ItemOutcome[] = []
  for (const ref of refs) {
    let read: FormsRead
    try {
      read = await readFilesDragForms(ref, opts)
    } catch (e) {
      outcomes.push({ ref, landed: false, reason: couldNot(ref, e), lines: [] })
      continue
    }
    if (read.refused) {
      outcomes.push({ ref, landed: false, reason: read.refused, lines: [] })
      continue
    }
    let landed: { result: PasteOutcome | SnippetInsertResult; notices: Awaited<ReturnType<typeof collectNotices>>['notices'] }
    try {
      landed = await collectNotices(() => land(read, ref))
    } catch (e) {
      outcomes.push({ ref, landed: false, reason: couldNot(ref, e), lines: [] })
      continue
    }
    const { result, notices } = landed
    const refused = notices.find((n) => n.kind === 'refused')?.text
    const converted = notices.filter((n) => n.kind === 'converted').map((n) => n.text)
    const r = interpret(result)
    if (r.landed) {
      outcomes.push({ ref, landed: true, lines: [...converted, ...r.lines] })
    } else {
      outcomes.push({ ref, landed: false, reason: r.reason ?? refused ?? 'Nothing that was dropped can go here.', lines: [] })
    }
  }
  const notice = dropLine(outcomes)
  if (notice) useNoticeStore.getState().show({ text: notice, icon: outcomes.some((o) => !o.landed) ? 'warning' : 'info' }, DROP_NOTICE_MS)
  return { outcomes, notice }
}

/** An item that failed for a reason no one planned: said plainly, with what went wrong. */
function couldNot(ref: FileDragRef, e: unknown): string {
  const why = e instanceof Error && e.message ? ` ${e.message.replace(/\.?$/, '.')}` : ''
  return `${ref.name || 'This item'} could not be added.${why}`
}

function interpret(r: PasteOutcome | SnippetInsertResult): { landed: boolean; reason?: string; lines: string[] } {
  if (r === 'pasted') return { landed: true, lines: [] }
  if (r === 'refused' || r === 'nothing') return { landed: false, lines: [] }
  if (r === true) return { landed: true, lines: [] }
  if (r === false) return { landed: false, lines: [] }
  if (typeof r === 'object' && r) {
    if ('ok' in r && r.ok === false) return { landed: false, reason: (r as { reason?: string }).reason, lines: [] }
    const lines: string[] = []
    const o = r as { notice?: string | null; lossy?: string[] }
    if (o.notice) lines.push(o.notice)
    if (Array.isArray(o.lossy)) lines.push(...o.lossy)
    return { landed: true, lines }
  }
  return { landed: false, lines: [] }
}

/** The drop's one line, from every item's outcome. */
export function dropLine(outcomes: ItemOutcome[]): string | null {
  const placed = outcomes.filter((o) => o.landed).length
  const refused = outcomes.filter((o) => !o.landed).map((o) => ({ name: o.ref.name, reason: o.reason ?? '' }))
  const lines = tidyNotes(outcomes.flatMap((o) => o.lines))
  if (outcomes.length === 1) {
    const o = outcomes[0]!
    return o.landed ? (lines.length ? lines.join(' ') : null) : o.reason || null
  }
  return composeDropNotice(placed, refused, lines)
}

/** The Files refs in a drop event (null when it is not a Files drag). A newer app's payload is refused aloud. */
export function filesDropRefs(dt: DataTransfer | null): FileDragRef[] | null {
  const r = readFilesDrag(dt)
  if (r.ok) return r.payload.refs
  if (r.reason) useNoticeStore.getState().show({ text: r.reason, icon: 'warning' }, DROP_NOTICE_MS)
  return null
}

/** A drop point in a page's own coordinates, from the page's drawn box (`[data-testid="slide-canvas"]`). Null when off the page. */
export function pagePointFromDrop(root: Element, clientX: number, clientY: number, logical: { w: number; h: number }): { x: number; y: number } | null {
  const page = root.querySelector('[data-testid="slide-canvas"]')
  if (!page) return null
  const r = page.getBoundingClientRect()
  if (!r.width || !r.height) return null
  if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null
  return { x: ((clientX - r.left) * logical.w) / r.width, y: ((clientY - r.top) * logical.h) / r.height }
}
