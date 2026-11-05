// Web notifications: a site shows notifications only once the person allowed
// it (owner, 2026-11-05: "do it", for "make sites ask before sending
// notifications, like Chrome does").
//
// Electron auto-grants every permission unless a handler says otherwise, and
// the app's policy (index.ts applyPermissionPolicy) granted notifications to
// every page: any site in a desk browser could put macOS notifications on
// the screen without asking. Real Chrome never does that (measured
// 2026-11-05: Notification.permission "granted" on a fresh profile in the
// widget, "default" in Chrome). It is also a tell to bot checks.
//
// Electron's permission handlers are boolean: a page sees "granted" or
// "denied", never Chrome's "default" (ask) state, and a site that sees
// "denied" does not ask. So:
//   - pages in the desk browser (persist:webview-default and any other
//     non-app partition): BLOCKED until the person turns on "Notifications
//     from this site" in that browser's menu; remembered per origin;
//   - connected apps (persist:connectedapp-<id>), apps the person added on
//     purpose: allowed, as before;
//   - the app's own windows: allowed, as before.
import { app, session as electronSession } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type SessionKind = 'web' | 'app'

const kinds = new WeakMap<Electron.Session, SessionKind>()
let allowed: Set<string> | null = null

/** A connected app's partition: notifications allowed, it was added on purpose. */
export function isConnectedAppPartition(partition: string): boolean {
  return /^persist:connectedapp-/.test(partition)
}

/**
 * Record what a webview's partition is, at attach (the only moment the name is
 * known: Electron's Session carries none). Sessions never seen here are the
 * app's own (the default session) and keep their notifications.
 */
export function noteWebviewPartition(partition: string | undefined): void {
  const p = partition ?? ''
  try {
    const ses = p ? electronSession.fromPartition(p) : electronSession.defaultSession
    // The default session also hosts the app window: only a real partition is a web session.
    if (!p) return
    kinds.set(ses, isConnectedAppPartition(p) ? 'app' : 'web')
  } catch {
    // before ready, or an invalid partition: nothing to record
  }
}

function file(): string {
  return join(app.getPath('userData'), 'web-notification-sites.json')
}

function load(): Set<string> {
  if (allowed) return allowed
  allowed = new Set()
  try {
    if (existsSync(file())) {
      const raw = JSON.parse(readFileSync(file(), 'utf8')) as { allowed?: unknown }
      if (Array.isArray(raw.allowed)) for (const o of raw.allowed) if (typeof o === 'string') allowed.add(o)
    }
  } catch {
    // unreadable: start empty (every web page blocked), the safe side
  }
  return allowed
}

/** The origin a permission is asked for: "https://finviz.com" from a URL or an origin. */
export function originOf(urlOrOrigin: string): string | null {
  try {
    const u = new URL(urlOrOrigin)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return u.origin
  } catch {
    return null
  }
}

/** May this session's page at `urlOrOrigin` show notifications? */
export function notificationsAllowed(ses: Electron.Session, urlOrOrigin: string): boolean {
  if (kinds.get(ses) !== 'web') return true
  const o = originOf(urlOrOrigin)
  return o !== null && load().has(o)
}

/** For the browser's menu: is this site allowed? */
export function siteNotificationsAllowed(urlOrOrigin: string): boolean {
  const o = originOf(urlOrOrigin)
  return o !== null && load().has(o)
}

/** Turn a site's notifications on or off. Returns the stored answer. */
export function setSiteNotifications(urlOrOrigin: string, on: boolean): boolean {
  const o = originOf(urlOrOrigin)
  if (!o) return false
  const set = load()
  if (on) set.add(o)
  else set.delete(o)
  try {
    writeFileSync(file(), JSON.stringify({ allowed: [...set].sort() }, null, 1))
  } catch {
    // disk full / read-only: the choice still holds for this run
  }
  return set.has(o)
}

/** Tests: forget the cached file (another profile, a reset). */
export function resetWebNotificationsForTests(): void {
  allowed = null
}
