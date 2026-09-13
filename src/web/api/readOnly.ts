// What a viewer of a shared desk may do.
//
// "Read-only" turned out to be the wrong word for what this needs to be. A desk
// you cannot pan, zoom, rearrange or open a widget on is not a desk you can
// read -- the first recipient was stuck at whatever zoom the sender left behind,
// unable to put two widgets side by side to compare them. Looking at a spatial
// canvas IS moving things around on it.
//
// So the line is not read versus write. It is:
//
//   LAYOUT   — where things sit, how big they are, what is in front, where the
//              camera is. Allowed. This is how you read a canvas.
//   CONTENT  — what things say, and which things exist. Refused. This is the
//              part that belongs to the sender.
//
// Both halves of that line run through one channel: moving a widget and editing
// its text are both widgets:update. So the decision cannot be made on the
// channel name alone, and this filters the patch itself, field by field.
//
// It still fails CLOSED. A channel is permitted only if it is recognisably a
// question or explicitly named below; anything unrecognised is refused, so a
// mutating channel added later is refused without anyone remembering that
// sharing exists.

/** Channel verbs that only ask. */
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
 * Writes a viewer is allowed outright, each because it changes only how the
 * desk is being LOOKED at, never what it says.
 */
const LAYOUT_WRITES = new Set<string>([
  // The camera: pan and zoom, remembered so a reload does not throw the viewer
  // back to wherever the sender happened to leave it.
  'deskLayout:save',
  // Raising a widget to compare it against another.
  'widgets:bringToFront',
  // Unpacking the bundle IS the share; refusing it would refuse the desk.
  'shares:importBundle'
])

/**
 * The fields of a widget patch that describe where a thing is rather than what
 * it says. Everything absent from this list is refused, so a field added to
 * WidgetPatch later is content until someone decides otherwise.
 */
export const LAYOUT_FIELDS: ReadonlySet<string> = new Set([
  'x', 'y', 'width', 'height', 'zIndex',
  'pinned', 'pinnedScreenX', 'pinnedScreenY', 'pinnedZone',
  'parentSectionId', 'layout'
])

export class ReadOnlyShareError extends Error {
  readonly channel: string
  constructor(channel: string, why = 'This desk was shared with you to read.') {
    super(`${why} Download Plexii to make it yours and edit it. (${channel})`)
    this.name = 'ReadOnlyShareError'
    this.channel = channel
  }
}

/** True when the channel is a question or an allowed layout change. */
export function isPermittedChannel(channel: string): boolean {
  if (LAYOUT_WRITES.has(channel)) return true
  const verb = channel.includes(':') ? channel.slice(channel.indexOf(':') + 1) : channel
  return ASKS.test(verb)
}

export interface CallDecision {
  allowed: boolean
  /** The arguments to send, which may be narrower than those offered. */
  args: unknown[]
  why?: string
}

/**
 * Decide one call.
 *
 * `widgets:update` is the interesting case and the reason this returns
 * arguments rather than a boolean: a drag sends geometry, a typed character
 * sends content, and the same channel carries both. The patch is narrowed to
 * its layout fields; if nothing survives, the call was an edit and is refused.
 */
export function decideCall(channel: string, args: unknown[]): CallDecision {
  if (channel === 'widgets:update') {
    const [id, patch, ...rest] = args
    if (!patch || typeof patch !== 'object') {
      return { allowed: false, args, why: 'That change is not part of a shared desk.' }
    }
    const kept: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      if (LAYOUT_FIELDS.has(k)) kept[k] = v
    }
    if (Object.keys(kept).length === 0) {
      return { allowed: false, args, why: 'You can move things around, but not change what they say.' }
    }
    return { allowed: true, args: [id, kept, ...rest] }
  }

  if (isPermittedChannel(channel)) return { allowed: true, args }
  return { allowed: false, args, why: 'That is not something a shared desk can do.' }
}
