// Render the live browser/doc/pdf text the user has on the canvas into a context
// block the model can act on — e.g. read a booking page and emit schedule-event
// proposals. Each attachment is capped and the whole block is bounded so a big
// page can't blow the context. Pure + unit-tested; no fabrication, only real
// gathered text goes in.

import type { ChatAttachment } from '@shared/types'

const PER = 8000
const TOTAL = 24000

export function renderAttachments(
  attachments: ChatAttachment[] | undefined,
  // The widget the user pinned as the conversation's primary reference (Phase
  // 3a.1). The pin claim is made ONLY when the id resolves to an attachment
  // that genuinely renders below — a deleted, off-desk or empty widget must
  // produce zero pin language, or the prompt asserts context that isn't there.
  pinnedWidgetId?: string
): string {
  if (!attachments || attachments.length === 0) return ''
  let used = 0
  const blocks: string[] = []
  let pinnedTitle: string | null = null
  for (const a of attachments) {
    const text = (a.text || '').trim()
    if (!text) continue
    const room = Math.min(PER, TOTAL - used)
    if (room <= 0) break
    const slice = text.slice(0, room)
    used += slice.length
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
  if (blocks.length === 0) return ''
  const pinNote = pinnedTitle
    ? `The user pinned "${pinnedTitle}" as the primary reference for this conversation — read it first, and treat their messages as being about it unless they clearly point elsewhere. `
    : ''
  return (
    "\n\n## Content open on the user's canvas\n" +
    pinNote +
    'The user may be asking you to act on the following live content from browser, document, or PDF work widgets on their canvas. ' +
    'When they ask to create calendar events, schedule, or "add these to my calendar", extract the real dates, times, titles and durations from this content and emit schedule-event actions (absolute unix-ms startMs computed from the current-time fact; durationMinutes required; default 60 minutes when no end time is given). Do not invent details that are not present.\n\n' +
    blocks.join('\n\n')
  )
}
