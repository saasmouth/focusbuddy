// A shared desk is read-only, and this is where that is true.
//
// Hiding buttons is not read-only. It is read-only until someone finds a
// keyboard shortcut, a context menu, a drag handle or a paste target that was
// missed — and then a visitor silently edits a copy they were shown, which at
// best confuses them when it vanishes and at worst looks like the sender's desk
// changed. So the guarantee lives at the single point every call from the
// renderer passes through, and the UI suppression on top of it is a courtesy.
//
// It fails CLOSED. A channel is allowed only if its name reads like a question;
// anything else is refused. That direction matters: a mutating channel added
// later is refused automatically, while a new READ channel that gets refused is
// a visible, reported, one-line fix. The opposite arrangement trades a silent
// data change for a tidier list.

/**
 * Channel verbs that only ask. Matched against the part after the colon, which
 * is where this codebase consistently puts the verb.
 */
const ASKS = new RegExp(
  '^(' +
    [
      'get', 'list', 'read', 'load', 'search', 'find', 'preview', 'resolve',
      'count', 'status', 'has', 'is', 'can', 'fetch', 'describe', 'peek',
      'check', 'query', 'inspect', 'summarise', 'summarize', 'stat', 'all',
      'for', 'by', 'missing', 'thumbnail', 'blob', 'url', 'path', 'state',
      'info', 'meta', 'recent', 'current', 'active', 'available', 'enabled',
      'coverage', 'precision', 'badge', 'kindOf', 'semantic', 'export'
    ].join('|') +
    ')',
  'i'
)

/**
 * A handful of writes a viewer still needs, each for a stated reason.
 *
 * They are named individually rather than pattern-matched, because the whole
 * value of a default-deny list is that every exception is visible.
 */
const PERMITTED_WRITES = new Set<string>([
  // Unpacking the bundle IS the share. Refusing it would refuse the desk.
  'shares:importBundle'
])

/** Would this channel change something the viewer is not allowed to change? */
export function isWriteChannel(channel: string): boolean {
  if (PERMITTED_WRITES.has(channel)) return false
  const verb = channel.includes(':') ? channel.slice(channel.indexOf(':') + 1) : channel
  return !ASKS.test(verb)
}

export class ReadOnlyShareError extends Error {
  readonly channel: string
  constructor(channel: string) {
    super(`This desk was shared with you to read. Download Plexii to make it yours and edit it. (${channel})`)
    this.name = 'ReadOnlyShareError'
    this.channel = channel
  }
}
