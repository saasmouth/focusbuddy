import { dialog, nativeImage, shell } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { basename, extname, join } from 'path'
import { readFileSync, existsSync, rmSync } from 'fs'

// The rich integration (bundle-id, icon capture, running-state, focus/unminimise
// via AppleScript, the mirror-mode punch-through) is macOS-only. On other
// platforms the app launcher degrades to "launcher only": pick an executable and
// launch it via shell.openPath, with no icon/running enrichment. Guarded so the
// app never runs a missing macOS command on Windows/Linux.
const isMac = process.platform === 'darwin'

// execFile variant that CAPTURES stdout, with NO shell — arguments are passed
// as a discrete argv array so a path/value can never be interpreted as shell
// syntax (closes the `defaults`/`sips` command-injection vector). The osascript
const execFileP = promisify(execFile)

// Safely embed a string as an AppleScript string literal: wrap in double quotes
// and backslash-escape backslashes and quotes. Combined with execFile (no
// shell), this closes the single-quote-breakout injection the audit found.
function asAppleScriptString(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

// ── Picker ──────────────────────────────────────────────────────────────────
// Surfaces the macOS file picker filtered to .app bundles. Returns a structured
// summary the renderer can pass straight to connectedApps.create.

export interface PickedLocalApp {
  title: string
  appPath: string
  bundleId: string | null
  iconPngBase64: string | null
}

export async function pickLocalApp(): Promise<PickedLocalApp | null> {
  // macOS treats .app bundles as files by default. We do NOT pass
  // `treatPackageAsDirectory` — that would let the user navigate INTO the
  // bundle, which is exactly the opposite of "pick an app".
  //
  // We deliberately call `showOpenDialog` without a parent window: on a
  // transparent BrowserWindow, attaching a sheet dialog as a child of the
  // window can render the sheet at a confused position or skip showing it
  // entirely (the live-mirror punch-through feature requires `transparent:
  // true` on the main window). Without a parent, the dialog opens as a
  // modal panel above the active window, which works reliably regardless.
  const opts: Electron.OpenDialogOptions = isMac
    ? {
        title: 'Add local app',
        defaultPath: '/Applications',
        properties: ['openFile'],
        filters: [{ name: 'Applications', extensions: ['app'] }]
      }
    : {
        title: 'Add local app',
        properties: ['openFile'],
        filters: [{ name: 'Programs', extensions: ['exe', 'lnk', 'bat', 'cmd'] }]
      }
  try {
    const result = await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return null
    const appPath = result.filePaths[0]
    // Defensive: the picker filter is advisory on macOS — users can navigate
    // around it with shortcuts and pick a non-.app file. Reject anything that
    // isn't an actual .app bundle path (macOS only).
    if (isMac && extname(appPath) !== '.app') return null
    return buildPickedFromPath(appPath)
  } catch (err) {
    // Surface to main-process console so dev-server tail catches it. The
    // renderer-side IPC call will see this as a rejection and the dialog's
    // user just observes "nothing happened", which is exactly what we want
    // to diagnose here.
    console.error('[localApp:pick] dialog failed:', err)
    throw err
  }
}

async function buildPickedFromPath(appPath: string): Promise<PickedLocalApp> {
  // Off macOS: launcher-only. No bundle id, no icon capture (those are
  // AppleScript / macOS-specific). The title is the executable name.
  if (!isMac) {
    return {
      title: basename(appPath).replace(/\.(exe|lnk|bat|cmd)$/i, ''),
      appPath,
      bundleId: null,
      iconPngBase64: null
    }
  }
  const title = basename(appPath).replace(/\.app$/, '')
  const [bundleId, iconPngBase64] = await Promise.all([
    readBundleId(appPath),
    captureAppIcon(appPath)
  ])
  return { title, appPath, bundleId, iconPngBase64 }
}

// ── Bundle ID extraction ─────────────────────────────────────────────────────
// CFBundleIdentifier lives in Info.plist. We prefer `defaults read` which
// handles both XML and binary plists; if that fails (sandboxed app, missing
// plist), fall back to reading the file directly and grep-ing.

async function readBundleId(appPath: string): Promise<string | null> {
  const plist = join(appPath, 'Contents', 'Info')
  try {
    // 2s timeout guard. `defaults read` is usually <100ms but we never want
    // a stuck process to hang the entire describe pipeline. execFile (no shell)
    // means `plist` cannot inject commands even with metacharacters in the path.
    const { stdout } = await execFileP('defaults', ['read', plist, 'CFBundleIdentifier'], {
      timeout: 2000
    })
    const id = stdout.trim()
    return id || null
  } catch {
    // Fall through to filesystem fallback
  }
  try {
    const buf = readFileSync(join(appPath, 'Contents', 'Info.plist'))
    const text = buf.toString('utf8')
    const m = text.match(
      /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/
    )
    return m ? m[1] : null
  } catch {
    return null
  }
}

// ── Icon capture ─────────────────────────────────────────────────────────────
// Electron's app.getFileIcon is the safest path — it asks macOS for the icon
// the Finder would show. We capture once at create-time and cache the base64
// PNG so the renderer doesn't pay a per-render IPC cost.

async function captureAppIcon(appPath: string): Promise<string | null> {
  if (!isMac) return null // icon extraction is macOS-only (sips/iconutil)
  if (!existsSync(appPath)) return null
  // We deliberately do NOT use Electron's app.getFileIcon — Electron 33 on
  // macOS Sonoma+ crashes the main process with a fatal NOTREACHED CHECK when
  // it's called for .app bundles in certain contexts.
  //
  // The fallback chain:
  //   1. nativeImage.createThumbnailFromPath — uses QuickLook, supports .app
  //      bundles directly, no .icns parsing required. Safe in Electron 33+.
  //   2. sips command — converts the .icns inside Contents/Resources to PNG.
  //      Works when QuickLook isn't available (rare).
  //
  // Both run under a hard timeout because anything that touches macOS
  // sub-systems can hang under specific user-data states.
  try {
    const thumb = await Promise.race([
      nativeImage
        .createThumbnailFromPath(appPath, { width: 128, height: 128 })
        .catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000))
    ])
    if (thumb && typeof (thumb as { toPNG?: unknown }).toPNG === 'function') {
      const png = (thumb as { toPNG: () => Buffer }).toPNG()
      if (png.length > 0) return png.toString('base64')
    }
  } catch {
    // Fall through to sips fallback
  }
  try {
    const iconFile = await readIconFileName(appPath)
    if (!iconFile) return null
    const resources = join(appPath, 'Contents', 'Resources')
    const candidates = [
      join(resources, iconFile),
      join(resources, `${iconFile}.icns`)
    ]
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue
      // Use macOS's sips to convert .icns → PNG and read the result. This is
      // synchronous-ish (sub-100ms) and avoids needing native .icns parsing.
      const tmp = join('/tmp', `fb-icon-${Date.now()}.png`)
      try {
        await execFileP(
          'sips',
          ['-s', 'format', 'png', candidate, '--out', tmp, '-Z', '128'],
          { timeout: 4000 }
        )
        const buf = readFileSync(tmp)
        try {
          rmSync(tmp, { force: true })
        } catch {
          // best effort cleanup
        }
        if (buf.length > 0) return buf.toString('base64')
      } catch {
        // try next candidate
      }
    }
    return null
  } catch {
    return null
  }
}

async function readIconFileName(appPath: string): Promise<string | null> {
  const plistBase = join(appPath, 'Contents', 'Info')
  try {
    const { stdout } = await execFileP('defaults', ['read', plistBase, 'CFBundleIconFile'], {
      timeout: 2000
    })
    const name = stdout.trim()
    return name || null
  } catch {
    // Fall through to plist scrape
  }
  try {
    const buf = readFileSync(join(appPath, 'Contents', 'Info.plist'))
    const text = buf.toString('utf8')
    const m = text.match(
      /<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/
    )
    return m ? m[1] : null
  } catch {
    return null
  }
}

// ── Launch ───────────────────────────────────────────────────────────────────
//
// The launcher tile must always "bring the user back to the app", regardless
// of whether the app is:
//   - Not running       → launch it
//   - Running, focused  → no-op (visually a re-focus)
//   - Running, hidden   → unhide
//   - Running, minimised → unminimise the main window
//   - Running, in background → bring to front
//
// `open -a <path>` handles 1-3 but leaves minimised windows minimised. We
// follow it with AppleScript that unminimises window 1 if it's minimised and
// activates the app. Best-effort — failures don't surface to the user since
// the launch itself already succeeded.

export async function launchLocalApp(input: {
  appPath: string | null
  bundleId: string | null
  title?: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  // Off macOS: cross-platform launch via the OS shell. shell.openPath returns
  // an empty string on success or an error message.
  if (!isMac) {
    if (!input.appPath) return { ok: false, error: 'No app path on the connected app.' }
    const err = await shell.openPath(input.appPath)
    return err ? { ok: false, error: err } : { ok: true }
  }
  let opened = false
  if (input.bundleId) {
    try {
      await execFileAsync('open', ['-b', input.bundleId])
      opened = true
    } catch {
      // fall through to path-based launch
    }
  }
  if (!opened && input.appPath) {
    try {
      await execFileAsync('open', ['-a', input.appPath])
      opened = true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: msg }
    }
  }
  if (!opened) {
    return { ok: false, error: 'No appPath or bundleId on the connected app.' }
  }

  // Resolve the process name from bundle id when possible, otherwise fall
  // back to the basename of the app path or the user-supplied title.
  const procName = await resolveProcessName({
    appPath: input.appPath,
    bundleId: input.bundleId,
    fallbackTitle: input.title ?? ''
  })
  if (procName) {
    // Activate + unhide + unminimise. Each step is best-effort and wrapped in
    // its own try/catch so a single failure doesn't abort the rest. Errors
    // here are not user-visible — the `open` call above already succeeded.
    // execFile (no shell): the process name is an -e argument, so quotes or
    // shell metacharacters in an app name cannot inject a command.
    try {
      await execFileP('osascript', [
        '-e',
        `tell application "System Events" to tell process ${asAppleScriptString(procName)} to set visible to true`
      ])
    } catch {
      // app may not be Accessibility-allowed yet — fine
    }
    try {
      await execFileP('osascript', [
        '-e',
        `tell application "System Events" to tell process ${asAppleScriptString(procName)} to if (count of windows) > 0 then if value of attribute "AXMinimized" of window 1 is true then set value of attribute "AXMinimized" of window 1 to false`
      ])
    } catch {
      // window may not support AXMinimized — fine
    }
  }
  return { ok: true }
}

// Resolve a macOS process name from a bundle id by asking System Events. Used
// by the launcher to unminimise/unhide the right process. Returns null if the
// process isn't currently running.
async function resolveProcessName(input: {
  appPath: string | null
  bundleId: string | null
  fallbackTitle: string
}): Promise<string | null> {
  if (input.bundleId) {
    try {
      const { stdout } = await execFileP('osascript', [
        '-e',
        `tell application "System Events" to return name of (first process whose bundle identifier is ${asAppleScriptString(input.bundleId)})`
      ])
      const name = stdout.trim()
      if (name) return name
    } catch {
      // process not running yet, fall through
    }
  }
  if (input.appPath) {
    return require('path').basename(input.appPath).replace(/\.app$/, '')
  }
  if (input.fallbackTitle) return input.fallbackTitle
  return null
}

function execFileAsync(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (err) => (err ? reject(err) : resolve()))
  })
}

// ── Running state ────────────────────────────────────────────────────────────
// Check whether an app is currently running. macOS-native via AppleScript:
// "tell System Events to (count of (processes where name is X)) > 0".
// Fast (under 50ms typically) and doesn't need elevated perms.

export async function isLocalAppRunning(input: {
  appPath: string | null
  title: string
}): Promise<boolean> {
  if (!isMac) return false // running-state detection uses AppleScript (macOS)
  const name = input.appPath ? basename(input.appPath).replace(/\.app$/, '') : input.title
  if (!name) return false
  try {
    const { stdout } = await execFileP('osascript', [
      '-e',
      `tell application "System Events" to return (count of (processes whose name is ${asAppleScriptString(name)})) > 0`
    ])
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

// Convenience: build a draft from a path the renderer already knows (e.g.
// from a drag-and-drop of a .app onto the canvas). Returns null if the path
// isn't a .app bundle or doesn't exist.
export async function describeLocalApp(appPath: string): Promise<PickedLocalApp | null> {
  if (!existsSync(appPath)) return null
  if (isMac && extname(appPath) !== '.app') return null
  return buildPickedFromPath(appPath)
}

// Expose nativeImage so the renderer-side helper can also build a thumbnail
// from a base64 string if needed (not used by callers yet, kept for parity).
export { nativeImage }
