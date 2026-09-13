// What a viewer of a shared desk may do — and what happens to it afterwards.
//
// This started as read-only and is not any more. The copy is theirs: it lives in
// their browser, it reaches no one, and in 48 hours it is deleted. There is no
// one to protect it from, so letting them work on the desk they were sent costs
// nothing and is the whole point of showing it to them.
//
// What matters instead is that they are TOLD. An edit that quietly evaporates is
// worse than an edit that was refused, so the moment a change is made the window
// says where it stands: this is temporary, and Plexii is free.
//
// Two things are still refused, and neither is about the desk:
//
//   OUTWARD  — anything that acts on an account, a subscription, an
//              organisation or somebody else's data. A share token is not a
//              credential and must never be treated as one. Most of these would
//              fail anyway for want of a session; refusing here means they fail
//              for the right reason, in one place.
//   SHARING  — a viewer cannot re-share what they were shown. Onward
//              distribution is the sender's to decide, not the recipient's.
//
// It fails CLOSED for those namespaces: an unrecognised channel in one of them
// is refused, so a route added later is refused without anyone remembering.

/** Namespaces a share window has no business touching. */
const OUTWARD = new Set<string>([
  'account', 'billing', 'org', 'orgs', 'admin', 'teams', 'scim', 'apiKeys',
  'sso', 'invites', 'contacts', 'messaging', 'presence', 'crdt', 'workspace',
  'sign', 'crash', 'telemetry', 'activity'
])

/** Read-only exceptions inside those namespaces: asking is fine, acting is not. */
// The (?![a-z]) is load-bearing: without it these are prefixes, not words, and
// `check` matches checkout, `can` matches cancel, `is` matches issue. A payment
// route reading as a question is exactly the kind of quiet mistake a default
// -deny list exists to prevent. The guard allows `check` and `checkStatus` and
// refuses `checkout`.
const ASKS =
  /^(get|list|read|load|search|find|preview|resolve|count|status|has|is|can|fetch|describe|check|query|state|info|meta|current|active|available|enabled)(?![a-z])/

const namespaceOf = (channel: string): string =>
  channel.includes(':') ? channel.slice(0, channel.indexOf(':')) : channel

export class ShareBlockedError extends Error {
  readonly channel: string
  constructor(channel: string, why: string) {
    super(`${why} (${channel})`)
    this.name = 'ShareBlockedError'
    this.channel = channel
  }
}

/** Kept under the old name so existing callers and tests read unchanged. */
export const ReadOnlyShareError = ShareBlockedError

/**
 * Widget fields that describe where a thing is, not what it says.
 *
 * Used to decide whether a change is worth warning about. Panning the camera
 * and nudging a widget are not the moment to tell somebody their work will not
 * be kept -- and the app writes both on its own, before the visitor has touched
 * anything, which is how the first version of this warning was spent on a
 * startup write and never seen.
 */
const LAYOUT_FIELDS: ReadonlySet<string> = new Set([
  'x', 'y', 'width', 'height', 'zIndex',
  'pinned', 'pinnedScreenX', 'pinnedScreenY', 'pinnedZone',
  'parentSectionId', 'layout'
])

/** Channels that only ever move the furniture. */
const LAYOUT_ONLY = new Set(['deskLayout:save', 'widgets:bringToFront'])

/**
 * The namespaces that hold what the desk SAYS.
 *
 * An allowlist rather than a list of things to ignore, because the app writes
 * constantly on its own account -- trails, context, activity, models -- and
 * every one of those was counting as the visitor's first edit and spending the
 * warning before they had touched anything. Naming the handful that are
 * genuinely the desk cannot be fooled by a telemetry channel added later.
 */
const CONTENT_NAMESPACES = new Set([
  'widgets', 'nodes', 'documents', 'tables', 'files', 'fileManager', 'widgetLinks'
])

/** Does this call change what the desk SAYS, as opposed to how it is arranged? */
export function changesContent(channel: string, args: unknown[]): boolean {
  if (isReadOnlyCall(channel)) return false
  if (LAYOUT_ONLY.has(channel)) return false
  if (!CONTENT_NAMESPACES.has(namespaceOf(channel))) return false
  if (channel === 'widgets:update') {
    const patch = args[1]
    if (!patch || typeof patch !== 'object') return false
    return Object.keys(patch as Record<string, unknown>).some((k) => !LAYOUT_FIELDS.has(k))
  }
  return true
}

export interface CallDecision {
  allowed: boolean
  args: unknown[]
  why?: string
  /** True when this call changes the visitor's copy of the desk. */
  edits?: boolean
}

const verbOf = (channel: string): string =>
  channel.includes(':') ? channel.slice(channel.indexOf(':') + 1) : channel

/** Is this a question rather than a change? */
export function isReadOnlyCall(channel: string): boolean {
  return ASKS.test(verbOf(channel))
}

/** Decide one call from a share window. */
export function decideCall(channel: string, args: unknown[]): CallDecision {
  const ns = namespaceOf(channel)

  // Re-sharing is the sender's decision, not the recipient's.
  if (ns === 'shares' && channel !== 'shares:importBundle') {
    return { allowed: false, args, why: 'A shared desk cannot be shared onward from here.' }
  }

  if (OUTWARD.has(ns) && !isReadOnlyCall(channel)) {
    return { allowed: false, args, why: 'That is not something a shared desk can do.' }
  }

  // Everything else is the desk itself, and the desk is theirs to work on.
  return { allowed: true, args, edits: changesContent(channel, args) }
}
