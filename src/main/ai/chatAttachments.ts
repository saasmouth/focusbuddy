// Render the live browser/doc/pdf text the user has on the canvas into a context
// block the model can act on — e.g. read a booking page and emit schedule-event
// proposals. Each attachment is capped and the whole block is bounded so a big
// page can't blow the context. Pure + unit-tested; no fabrication, only real
// gathered text goes in.

import type { ChatAttachment } from '@shared/types'

const PER = 8000
const TOTAL = 24000
/** A cut smaller than this reads as noise, not content: the item is left out instead. */
const MIN_SLICE = 200

export function renderAttachments(
  attachments: ChatAttachment[] | undefined,
  // The widget the user pinned as the conversation's primary reference (Phase
  // 3a.1). The pin claim is made ONLY when the id resolves to an attachment
  // that genuinely renders below — a deleted, off-desk or empty widget must
  // produce zero pin language, or the prompt asserts context that isn't there.
  pinnedWidgetId?: string
): string {
  return renderAttachmentsFit(attachments, pinnedWidgetId).block
}

/**
 * renderAttachments with an explicit character budget for the text of the
 * items (default the cloud's 24,000), and a count of what the budget cost:
 * `shortened` items were cut part-way (each says so in the block), `omitted`
 * items with text did not fit at all (the block says how many). `total`
 * counts the items that had text to read.
 */
export function renderAttachmentsFit(
  attachments: ChatAttachment[] | undefined,
  pinnedWidgetId?: string,
  total = TOTAL
): { block: string; total: number; shortened: number; omitted: number } {
  const none = { block: '', total: 0, shortened: 0, omitted: 0 }
  if (!attachments || attachments.length === 0) return none
  const budget = Math.min(TOTAL, Math.max(0, total))
  let used = 0
  let withText = 0
  let shortened = 0
  let omitted = 0
  const blocks: string[] = []
  let pinnedTitle: string | null = null
  for (const a of attachments) {
    const text = (a.text || '').trim()
    if (!text) continue
    withText++
    const room = Math.min(PER, budget - used)
    // Out of room (or so little that a slice would say nothing): counted, and
    // named below, never silently dropped.
    if (room < Math.min(MIN_SLICE, text.length)) {
      omitted++
      continue
    }
    const slice = text.slice(0, room)
    used += slice.length
    if (slice.length < text.length) shortened++
    const src = a.source ? ` (${a.source})` : ''
    const isPinned = pinnedWidgetId !== undefined && a.widgetId === pinnedWidgetId
    const marker = isPinned ? '[PINNED · primary reference] ' : ''
    if (isPinned) pinnedTitle = a.title || 'Untitled'
    // The sibling module (chatMentions) states every cut; this one silently
    // dropped everything past the cap (defect #19) — the model then answered
    // about "the open page" from its first 8000 characters as if whole.
    const cut =
      slice.length < text.length
        ? `\n[Truncated — the first ${slice.length} characters are shown; the rest of this content was not read.]`
        : ''
    blocks.push(`--- ${marker}${a.kind}: "${a.title || 'Untitled'}"${src} ---\n${slice}${cut}`)
  }
  if (blocks.length === 0) return { block: '', total: withText, shortened, omitted }
  const pinNote = pinnedTitle
    ? `The user pinned "${pinnedTitle}" as the primary reference for this conversation — read it first, and treat their messages as being about it unless they clearly point elsewhere. `
    : ''
  const omittedNote =
    omitted > 0
      ? `\n\n[${omitted} more open item${omitted === 1 ? ' was' : 's were'} on the canvas but did not fit and ${omitted === 1 ? 'was' : 'were'} not read; say so if the answer may depend on ${omitted === 1 ? 'it' : 'them'}.]`
      : ''
  return {
    block:
      "\n\n## Content open on the user's canvas\n" +
      pinNote +
      'The user may be asking you to act on the following live content from browser, document, or PDF work widgets on their canvas. ' +
      'When they ask to create calendar events, schedule, or "add these to my calendar", extract the real dates, times, titles and durations from this content and emit schedule-event actions (absolute unix-ms startMs computed from the current-time fact; durationMinutes required; default 60 minutes when no end time is given). Do not invent details that are not present.\n\n' +
      blocks.join('\n\n') +
      omittedNote,
    total: withText,
    shortened,
    omitted
  }
}

/** Characters of the attachments block's own wording, around the items (for budgeting). */
export const ATTACHMENTS_FRAME_CHARS = 700
/** Characters of each item's header and cut notice (for budgeting). */
export const ATTACHMENT_ITEM_FRAME_CHARS = 200
