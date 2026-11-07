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

import type { CallContext } from './shareGate'

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
const LAYOUT_ONLY = new Set(['deskLayout:save', 'deskLayout:saveWorkcentre', 'widgets:bringToFront'])

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
  /**
   * Set when the call is refused because it needs Plexii itself: the visitor
   * did this, and the page answers with "Download this desk on Plexii". The
   * phrase says what they tried ("Creating a desk", "AI").
   */
  gate?: string
}

const verbOf = (channel: string): string =>
  channel.includes(':') ? channel.slice(channel.indexOf(':') + 1) : channel

/** Is this a question rather than a change? */
export function isReadOnlyCall(channel: string): boolean {
  return ASKS.test(verbOf(channel))
}

// ── What a visitor may do (owner, 2026-11-07) ───────────────────────────────
//
// "if someone goes to create a desk, or room, use ai assist, or do anything
// other than drag apps, widgets, files and tools to the desk, it says download
// this desk on plexii and initiates the download."
//
// Free: looking (every read), arranging (the furniture, below), and adding what
// was dragged onto the desk -- within the window a drop opens (shareGate.ts).
// The visitor may also take back a widget they added. Everything else the
// VISITOR does is the gate. What the app does on its own, with nobody behind
// it, is not the visitor doing anything: it is left as it was.

/**
 * Calls that finish a drop: a widget placed, a file stored, the document or
 * table a dragged tool makes, a work widget placed. Allowed only while a drop
 * is being completed (CallContext.adding).
 */
const ADD_CHANNELS = new Set([
  'widgets:create', 'widgets:createOptional',
  'files:ingestBuffer', 'files:ingestUrl', 'files:ingestPath',
  'widgetFiles:create', 'widgetFiles:createAndPlace', 'widgetFiles:place',
  'documents:create', 'tables:create', 'tables:createRow'
])

/** The calls that remove a widget: the visitor may undo their own drop. */
const REMOVE_WIDGET = new Set(['widgets:delete'])

/**
 * Reads whose names are not questions: "the path of", "the placements of",
 * "what is pending". The app makes them all the time -- as a desk opens, as a
 * panel opens, as something is clicked -- and a click followed by one of them
 * is the visitor LOOKING. Measured: fileManager:path and
 * widgetFiles:placements opened the gate on a plain click before they were
 * named here (shareGateWeb SG-1, 2026-11-07).
 */
const NOUN_READS = new Set([
  'shares:inbox', 'documents:metadata', 'documents:semanticActive',
  'fileManager:allTags', 'fileManager:entriesByTag', 'fileManager:locateDocument', 'fileManager:path',
  'fileManager:smartFolderEntries', 'fileManager:unfiledDocuments', 'fileManager:untaggedEntries',
  'files:extractText', 'files:thumbnail', 'nodes:staleDesks', 'widgetFiles:instances', 'widgetFiles:placements',
  'widgets:countsByTask', 'workItems:badgeCounts', 'workItems:kindOf',
  'context:health', 'context:related', 'context:resumeSummary', 'crdt:unsynced', 'crash:unforwarded',
  'decisions:forObject', 'decisions:withRisk', 'energy:recent', 'extcal:accounts', 'extcal:remoteCalendars',
  'focus:recent', 'history:recent', 'knowledge:semanticActive', 'mail:storedThread', 'media:micStatus',
  'meetings:audioInfo', 'meetings:segments', 'settings:encryptionAvailable', 'settings:hintAnthropic',
  'settings:hintOpenAI', 'settings:hintPexels', 'settings:hintRemoveBg', 'settings:hintTenor',
  'signals:matchState', 'trail:recent', 'workspace:pending', 'workspace:pendingOrg', 'workspace:pendingShared',
  'workspace:related', 'workspace:localSharedRoots', 'workspace:filesMissingBytes', 'agents:statsForSlug',
  'ai:localModelStatus', 'brain:coverage', 'contacts:desks', 'customWidget:inputs', 'metrics:webContents',
  'account:offlineSignInEmail', 'deskHandoff:pending'
])

/**
 * Writes that are the visitor moving around or looking, not doing anything:
 * where they have been (history, trail), what they looked at (context, a work
 * item marked read), opening a file to look at it, the app's zoom.
 * Navigating must never open a download prompt.
 */
const LOOKING = new Set([
  'history:record', 'trail:record', 'context:markReviewed', 'onboarding:record',
  'app:zoom', 'app:setZoomFactor', 'app:setBackgroundColor',
  'files:open', 'files:openExternal', 'fileManager:reveal', 'workItems:markRead'
])

/** Namespaces that are arranging the desk, whatever the verb. */
const NAVIGATION_NAMESPACES = new Set(['deskLayout'])

/**
 * The app's own background work in the desk's namespaces: indexing,
 * enrichment, sync bookkeeping, classification. Never the visitor, even when
 * it runs right after a click.
 */
const BACKGROUND = new Set([
  'documents:reindex', 'documents:enrichAll', 'documents:changed', 'files:suggestTags',
  'workItems:applySyncEvent', 'workItems:scanPeople', 'workItems:classify', 'workItems:reclassify',
  'workItems:clearDetached', 'workItems:proposeCleanup'
])

/**
 * What is the desk itself. A change the visitor makes to any of these needs
 * Plexii (except arranging, a drop, and taking back their own drop).
 */
const DESK_NAMESPACES = new Set([
  'widgets', 'nodes', 'documents', 'tables', 'files', 'fileManager', 'widgetLinks', 'widgetFiles',
  'workItems', 'projects', 'docComments'
])

/**
 * Plexii's features. A visitor USING one -- not looking at it -- is the gate.
 * Named rather than inferred, because the app also writes on its own account
 * in other namespaces (caches, cursors, its people directory) right after a
 * click, and a download prompt nobody asked for is the worst thing this page
 * could do.
 */
const FEATURE_NAMESPACES = new Set([
  'ai', 'aiChat', 'localAi', 'agents', 'agent', 'agentBrowser', 'browserAgent', 'assistant', 'knowledge',
  'memory', 'brain', 'voice', 'meetings', 'meet', 'bodyDouble', 'chat', 'mail', 'mailTags', 'extcal',
  'calendar', 'timeblocks', 'planner', 'focus', 'export', 'print', 'backup', 'fileImport', 'snapshots',
  'connectedApps', 'apps', 'localApp', 'liveDesk', 'share', 'shares', 'webNotifications', 'vault',
  'snippets', 'templates', 'customWidget', 'flows', 'wires', 'design', 'draw', 'forms', 'decisions',
  'reports', 'slides', 'sheet', 'mindmap', 'speeddeck', 'livingPage', 'dashboardWizard', 'smartStack',
  'marketplace', 'image', 'gif', 'mdext', 'office', 'browserExt', 'streamdeck', 'api', 'webhooks',
  'guestCapture', 'settings'
])

/** Outward namespaces a visitor reaches on purpose: refused, and the gate. */
const OUTWARD_ON_PURPOSE = new Set([
  'account', 'billing', 'org', 'orgs', 'admin', 'teams', 'scim', 'apiKeys', 'sso', 'invites', 'contacts',
  'messaging', 'sign'
])

/** Outward calls the app makes on its own (presence, sync, logs): refused quietly. */
const BACKGROUND_FEATURE_CALLS = new Set([
  'customWidget:markUsed', 'snippets:recordUse', 'wireRuns:record', 'signals:record', 'signals:markPrompted',
  'agents:recordOutcome', 'ai:setConversationSnapshot', 'aiChat:setMessageApplied', 'mail:markSeen',
  'voice:preloadLocal', 'localAi:consentReply', 'chat:proactiveWelcome', 'snapshots:create'
])

/** What the visitor tried, said as the gate says it. */
export function gateLabel(channel: string, args: unknown[]): string {
  const ns = namespaceOf(channel)
  const verb = verbOf(channel)
  if (channel === 'nodes:create') {
    const kind = (args[0] as { kind?: unknown } | undefined)?.kind
    return kind === 'folder' ? 'Creating a room' : 'Creating a desk'
  }
  if (ns === 'nodes' && /^(delete|deletePermanent)$/.test(verb)) return 'Deleting'
  if (ns === 'nodes' && verb === 'move') return 'Moving desks and rooms'
  // 'chat' is the assistant's conversation (people's messages are 'messaging').
  if (/^(ai|aiChat|chat|localAi|agents|agent|agentBrowser|browserAgent|assistant|knowledge|memory|brain|voice|voiceCommand)$/.test(ns)) return 'AI'
  if (ns === 'documents' && /^(generate|generateSlides|enrich|enrichAll)$/.test(verb)) return 'AI'
  if (ns === 'shares' || ns === 'liveDesk' || ns === 'share') return 'Sharing'
  if (OUTWARD.has(ns)) return 'Your Plexii account'
  if (/^(meetings|meet|bodyDouble|messaging|people|contacts|presence)$/.test(ns)) return 'Working with other people'
  if (/^(mail|mailTags|extcal|calendar|timeblocks|planner)$/.test(ns)) return 'Mail and calendar'
  if (ns === 'focus' || ns === 'energy') return 'Focus sessions'
  if (/^(export|print|backup|fileImport|snapshots)$/.test(ns)) return 'Saving and exporting'
  if (ns === 'connectedApps' || ns === 'apps' || ns === 'localApp') return 'Connecting apps'
  if (/delete|trash|purge|remove/i.test(verb)) return 'Removing things from the desk'
  if (ADD_CHANNELS.has(channel)) return 'Adding things this way'
  if (CONTENT_NAMESPACES.has(ns) || ns === 'widgetFiles' || ns === 'widgetLinks') return 'Editing this desk'
  return 'That'
}

/** The refusal a gated call carries, for code that shows a rejected call's message. */
export const GATE_WHY = 'Download this desk on Plexii to do that.'
/** The same, on a link to look at, where the gate offers Plexii itself. */
export const GATE_WHY_VIEW = 'Get Plexii to do that.'
const gateWhy = (ctx: CallContext): string => (ctx.mode === 'view' ? GATE_WHY_VIEW : GATE_WHY)

/** No moment given: a call the app made on its own. */
const AUTOMATIC: CallContext = { userActed: false, adding: false, ownWidget: () => false }

/** Decide one call from a share window, made at the moment `ctx` describes. */
export function decideCall(channel: string, args: unknown[], ctx: CallContext = AUTOMATIC): CallDecision {
  const ns = namespaceOf(channel)

  // The share page's own work: unpacking the desk ('shares:importBundle') and
  // replacing, removing or exporting one link's copy ('shareCopy:*',
  // worker/shareCopy.ts). Never the visitor's edit: 'shareCopy' is not one of
  // CONTENT_NAMESPACES.
  if (ns === 'shareCopy' || channel === 'shares:importBundle') return { allowed: true, args, edits: false }

  // Asking is always fine.
  if (isReadOnlyCall(channel) || NOUN_READS.has(channel)) return { allowed: true, args, edits: false }

  // The app's own work, whoever clicked what just before.
  if (BACKGROUND.has(channel) || BACKGROUND_FEATURE_CALLS.has(channel)) {
    return ns === 'shares' || OUTWARD.has(ns)
      ? { allowed: false, args, why: 'That is not something a shared desk can do.' }
      : { allowed: true, args, edits: false }
  }

  // Re-sharing is the sender's decision, not the recipient's.
  if (ns === 'shares') {
    return { allowed: false, args, why: 'A shared desk cannot be shared onward from here.', gate: ctx.userActed ? gateLabel(channel, args) : undefined }
  }

  // An account, a subscription, an organisation, somebody else's data: a share
  // token is never a credential. Only what a visitor reaches on purpose opens
  // the gate; presence, sync and logs are refused quietly.
  if (OUTWARD.has(ns)) {
    const gate = ctx.userActed && OUTWARD_ON_PURPOSE.has(ns) ? gateLabel(channel, args) : undefined
    return { allowed: false, args, why: 'That is not something a shared desk can do.', gate }
  }

  // Arranging the furniture, and moving around.
  const edits = changesContent(channel, args)
  if (LAYOUT_ONLY.has(channel) || NAVIGATION_NAMESPACES.has(ns) || LOOKING.has(channel)) return { allowed: true, args, edits: false }
  if (channel === 'widgets:update' && !edits) return { allowed: true, args, edits: false }

  // Finishing a drop onto the desk -- on a link to use. A link to look at
  // (VisitorMode 'view') adds nothing.
  if (ctx.adding && ADD_CHANNELS.has(channel)) {
    if (ctx.mode === 'view' && ctx.userActed) {
      return { allowed: false, args, why: gateWhy(ctx), gate: 'Adding things to this desk' }
    }
    if (ctx.mode !== 'view') return { allowed: true, args, edits: true }
  }

  // Taking back a widget the visitor dropped.
  if (REMOVE_WIDGET.has(channel) && typeof args[0] === 'string' && ctx.ownWidget(args[0])) {
    return { allowed: true, args, edits: true }
  }

  // The app keeping itself in order, with nobody behind it: as it always was.
  if (!ctx.userActed) return { allowed: true, args, edits }

  // The visitor changing the desk, or using one of Plexii's features: that
  // needs Plexii itself.
  if (DESK_NAMESPACES.has(ns) || FEATURE_NAMESPACES.has(ns)) {
    return { allowed: false, args, why: gateWhy(ctx), gate: gateLabel(channel, args) }
  }

  // Anything else is the app's own bookkeeping (a cache, a preference, a
  // cursor), not a feature: left alone.
  return { allowed: true, args, edits }
}
