// Chrome extensions in Plexii's browser.
//
// The browser surfaces are Electron <webview>s, and Electron loads extensions
// PER SESSION — so an extension has to be loaded into every session a browser
// surface might use, not once globally. There are two families:
//
//   persist:webview-default        the freeform widget, the panel and the
//                                  fullscreen browser — one shared cookie jar
//   persist:connectedapp-<id>      one per connected app, so an embedded Gmail
//                                  keeps its own login
//
// Both get the extensions, because "block ads everywhere except the embedded
// sites" would be a strange rule to explain.
//
// ── What Electron can and cannot do here ────────────────────────────────────
//
// These limits are the feature, not a to-do list, and the UI states them rather
// than letting someone discover them one broken extension at a time:
//
//   * UNPACKED ONLY. loadExtension() takes a directory. There is no .crx
//     support and no Chrome Web Store install — the store's flow is a Chrome
//     binary handshake, not something an Electron app can perform.
//   * A SUBSET OF THE APIS. storage, runtime, i18n, webRequest, scripting and
//     declarativeNetRequest work to varying degrees; identity, bookmarks,
//     history and the rest of the browser-management surface do not. An
//     extension that reaches for a missing API does not fail at install, it
//     fails when that code path runs.
//   * NO AUTOMATIC BROWSER-ACTION UI. Electron does not draw toolbar buttons or
//     render popup pages; a host that wants them has to build them. See
//     `browserAction` below, which is what the toolbar reads.
//   * NOTHING PERSISTS IN THE SESSION. Electron forgets loaded extensions on
//     exit, so this module keeps its own registry and reloads on every boot.
//     That registry is the source of truth, not the session.
//
// MV3 support is partial in Electron 37: a background service worker runs, but
// declarativeNetRequest rule handling is incomplete. MV2 extensions are the
// surer bet TODAY and most content blockers still ship one — but Chromium warns
// on load that it is removing MV2, so this is a closing window, not a stable
// answer. The thing to watch is Electron's declarativeNetRequest completeness:
// until that lands, a content blocker is better served by MV2, and after MV2
// goes it will need MV3 to work properly. Worth re-checking on each Electron
// major rather than assuming either half still holds.

import { app, session, type Extension, type Session } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { listConnectedApps } from './db/connectedApps'

export const DEFAULT_BROWSER_PARTITION = 'persist:webview-default'

/** One row of the registry — the thing we remember across launches. */
interface RegistryEntry {
  /** The unpacked directory. The only durable identifier: Electron mints a new
   *  extension id per load, so the path is what we can key on. */
  path: string
  enabled: boolean
}

/** What the renderer is told about an extension. */
export interface BrowserExtension {
  path: string
  enabled: boolean
  /** Present once loaded; absent for a disabled or broken one. */
  id?: string
  name: string
  version?: string
  /** Why it is not running, when it is not. */
  error?: string
  /** Does it declare a toolbar button we would have to draw ourselves? */
  browserAction?: { title?: string; popup?: string; icons?: Record<string, string> }
}

const registryFile = (): string => join(app.getPath('userData'), 'browser-extensions.json')

function readRegistry(): RegistryEntry[] {
  try {
    if (!existsSync(registryFile())) return []
    const raw = JSON.parse(readFileSync(registryFile(), 'utf8')) as { entries?: RegistryEntry[] }
    return Array.isArray(raw?.entries) ? raw.entries.filter((e) => typeof e?.path === 'string') : []
  } catch {
    // A corrupt registry must not stop the app booting; an empty list is the
    // honest degraded state and the UI shows nothing installed.
    return []
  }
}

function writeRegistry(entries: RegistryEntry[]): void {
  writeFileSync(registryFile(), JSON.stringify({ entries }, null, 2), 'utf8')
}

/**
 * Every session a browser surface can use.
 *
 * Electron's Session carries no partition name, so `app.on('session-created')`
 * cannot tell us which session it just handed us. We therefore ask for the
 * partitions we know by name instead — deterministic, and it means a connected
 * app added after boot simply picks the extensions up on the next launch rather
 * than silently missing them forever.
 */
function browserSessions(): Session[] {
  const names = [DEFAULT_BROWSER_PARTITION]
  try {
    for (const a of listConnectedApps()) names.push(`persist:connectedapp-${a.id}`)
  } catch {
    // No database yet (first boot, or a cloud runtime): the default partition
    // is still worth serving.
  }
  return names.map((n) => session.fromPartition(n))
}

/** Read a manifest without loading it — so a broken one reports a reason. */
function readManifest(dir: string): { name?: string; version?: string; manifest_version?: number; action?: Record<string, unknown>; browser_action?: Record<string, unknown> } | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  } catch {
    return null
  }
}

/** The directory's last segment, as a last-resort display name. */
const basename = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p

export function manifestProblem(dir: string): string | null {
  if (!existsSync(dir)) return 'That folder does not exist.'
  if (!existsSync(join(dir, 'manifest.json'))) {
    return 'No manifest.json in that folder. Point at the extension’s own directory — the unpacked folder, not a .crx or a zip.'
  }
  const m = readManifest(dir)
  if (!m) return 'That manifest.json is not valid JSON.'
  if (!m.name) return 'That manifest has no name.'
  return null
}

/** Live handles, by path, so unload can find them in every session. */
const loaded = new Map<string, Extension[]>()

async function loadInto(dir: string): Promise<{ ok: true; ext: Extension } | { ok: false; error: string }> {
  const problem = manifestProblem(dir)
  if (problem) return { ok: false, error: problem }
  const handles: Extension[] = []
  let first: Extension | null = null
  for (const s of browserSessions()) {
    try {
      // allowFileAccess mirrors Chrome's "Allow access to file URLs" — off by
      // default there and off here, so a content script cannot read local files
      // just because it was installed.
      // ses.extensions.*, not the deprecated ses.loadExtension/removeExtension
      // — Electron warns on the old pair and says it will remove them.
      const ext = await s.extensions.loadExtension(dir, { allowFileAccess: false })
      handles.push(ext)
      first ??= ext
    } catch (e) {
      // One session refusing it is worth reporting, but the others may well
      // have taken it — so keep what loaded and surface the reason.
      if (!first) return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
  if (!first) return { ok: false, error: 'No browser session accepted that extension.' }
  loaded.set(dir, handles)
  return { ok: true, ext: first }
}

function unloadFrom(dir: string): void {
  const handles = loaded.get(dir) ?? []
  const sessions = browserSessions()
  for (const s of sessions) {
    for (const h of handles) {
      try {
        s.extensions.removeExtension(h.id)
      } catch {
        // Already gone, or never in this session — nothing to undo.
      }
    }
  }
  loaded.delete(dir)
}

/** Load every enabled extension. Called once, after the app is ready. */
export async function restoreExtensions(): Promise<void> {
  for (const entry of readRegistry()) {
    if (!entry.enabled) continue
    await loadInto(entry.path)
  }
}

export async function listExtensions(): Promise<BrowserExtension[]> {
  return readRegistry().map((entry) => {
    const m = readManifest(entry.path)
    const action = (m?.action ?? m?.browser_action) as Record<string, string> | undefined
    const handle = loaded.get(entry.path)?.[0]
    return {
      path: entry.path,
      enabled: entry.enabled,
      id: handle?.id,
      name: m?.name ?? basename(entry.path),
      version: m?.version,
      error: entry.enabled && !handle ? (manifestProblem(entry.path) ?? 'Not loaded.') : undefined,
      browserAction: action
        ? {
            title: typeof action.default_title === 'string' ? action.default_title : undefined,
            popup: typeof action.default_popup === 'string' ? action.default_popup : undefined
          }
        : undefined
    }
  })
}

export async function addExtension(dir: string): Promise<{ ok: boolean; error?: string }> {
  const problem = manifestProblem(dir)
  if (problem) return { ok: false, error: problem }
  const entries = readRegistry()
  if (entries.some((e) => e.path === dir)) return { ok: false, error: 'That extension is already installed.' }
  const res = await loadInto(dir)
  if (!res.ok) return { ok: false, error: res.error }
  entries.push({ path: dir, enabled: true })
  writeRegistry(entries)
  return { ok: true }
}

export async function setExtensionEnabled(dir: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  const entries = readRegistry()
  const entry = entries.find((e) => e.path === dir)
  if (!entry) return { ok: false, error: 'That extension is not installed.' }
  if (enabled) {
    const res = await loadInto(dir)
    if (!res.ok) return { ok: false, error: res.error }
  } else {
    unloadFrom(dir)
  }
  entry.enabled = enabled
  writeRegistry(entries)
  return { ok: true }
}

export function removeExtension(dir: string): { ok: boolean } {
  unloadFrom(dir)
  writeRegistry(readRegistry().filter((e) => e.path !== dir))
  // The folder itself is the person's own file and is never deleted — they
  // pointed us at it, they may well be developing it.
  return { ok: true }
}
