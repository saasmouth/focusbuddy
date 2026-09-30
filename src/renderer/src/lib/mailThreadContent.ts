import type { MailThreadContent } from '@shared/types'

/**
 * Read a mail-thread widget's content out of its stored JSON.
 *
 * Kept out of the component and given its own tests for one reason: it is a
 * whitelist, and a whitelist silently drops anything it forgets. When the widget
 * parsed and rebuilt this object inline, adding `accountKey` to the type was not
 * enough -- the field was written at pin time and then quietly discarded on every
 * read, which is invisible in review and invisible at runtime until someone
 * switches mailbox. A whitelist is still right (widget content is persisted,
 * synced JSON and must not be trusted to be the shape it claims), so instead the
 * whitelist is the thing under test.
 *
 * Never throws. Unparseable content yields an empty single-message widget, which
 * renders the honest "not in the local copy" state rather than a broken tile.
 */
export function parseMailThreadContent(raw: string | null | undefined): MailThreadContent {
  let p: Partial<MailThreadContent>
  try {
    p = JSON.parse(raw || '{}') as Partial<MailThreadContent>
    if (p === null || typeof p !== 'object' || Array.isArray(p)) p = {}
  } catch {
    p = {}
  }
  return {
    mode: p.mode === 'thread' ? 'thread' : 'one',
    // Safe integers only: a uid is a SQLite key, and NaN or a float silently
    // matches nothing rather than erroring.
    uids: Array.isArray(p.uids) ? p.uids.filter((u) => Number.isSafeInteger(u)) : [],
    rootMessageId: typeof p.rootMessageId === 'string' ? p.rootMessageId : null,
    subject: typeof p.subject === 'string' ? p.subject : undefined,
    fromName: typeof p.fromName === 'string' ? p.fromName : undefined,
    collapsed: typeof p.collapsed === 'boolean' ? p.collapsed : undefined,
    // Absent on anything pinned before this field existed. The main process then
    // falls back to the connected mailbox, which is what it always did.
    accountKey: typeof p.accountKey === 'string' && p.accountKey.trim() ? p.accountKey : undefined
  }
}
