// Auto-update plumbing — wraps electron-updater so the renderer doesn't
// import an Electron-only module directly. State flows out via an
// `update:state` IPC event; the renderer subscribes and shows a small
// banner when an update has been downloaded.
//
// Distribution channel: GitHub Releases. electron-builder generates
// the `latest-mac.yml` metadata file alongside the .zip when we run
// `npm run dist:release`, then publishes both to a draft release.
// Installed copies poll for updates on boot + every 4h.

import { app, autoUpdater as nativeAutoUpdater, BrowserWindow, shell } from 'electron'
import { detectPreviewBuild } from './appMode'
import { autoUpdater, type UpdateInfo, type ProgressInfo } from 'electron-updater'
import { spawn } from 'node:child_process'
import {
  createWriteStream,
  mkdtempSync,
  readdirSync,
  writeFileSync,
  chmodSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import https from 'node:https'
import {
  macAssetUrl,
  appBundlePath,
  isTranslocated,
  MAC_INSTALL_SCRIPT,
  MAC_UPDATE_ARCH
} from './updaterInstall'

// macOS builds are ad-hoc signed (no Apple Developer ID), and Squirrel.Mac
// refuses to apply an update unless it is signed by the same Developer ID. So
// on macOS we do NOT auto-download or auto-install (that path always fails and
// surfaces as a scary "update check failed" error after the download stages);
// instead we detect the new version and offer a one-click download of the
// release. Windows installs in place as normal.
const IS_MAC = process.platform === 'darwin'
const RELEASES_URL = 'https://github.com/saasmouth/focusbuddy/releases/latest'

export function openDownloadPage(): void {
  void shell.openExternal(RELEASES_URL)
}

// Stream a URL to a file, following GitHub's redirect to its asset CDN and
// reporting download progress as a percent.
function downloadFile(url: string, dest: string, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Haptyx-Updater' } }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        downloadFile(res.headers.location, dest, onProgress).then(resolve, reject)
        return
      }
      if (status !== 200) {
        res.resume()
        reject(new Error(`Download failed with HTTP ${status}.`))
        return
      }
      const total = Number(res.headers['content-length'] || 0)
      let got = 0
      const file = createWriteStream(dest)
      res.on('data', (chunk: Buffer) => {
        got += chunk.length
        if (total) onProgress(Math.min(99, Math.round((got / total) * 100)))
      })
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
      file.on('error', reject)
    })
    req.on('error', reject)
  })
}

// One-click download and self-replace for macOS, since the ad-hoc signature
// blocks Squirrel's silent install. Downloads the release zip itself, unpacks
// it, and hands off to a detached helper that swaps the app and relaunches.
// Falls back to opening the releases page if anything is not as expected.
export async function downloadAndInstallMacUpdate(): Promise<void> {
  if (!IS_MAC) {
    openDownloadPage()
    return
  }
  const version =
    current.kind === 'available' || current.kind === 'ready' ? current.version : null
  if (!version) {
    openDownloadPage()
    return
  }
  // Only attempt an in-place swap when we are a real .app bundle.
  const targetApp = appBundlePath(process.execPath)
  if (!targetApp) {
    openDownloadPage()
    return
  }
  // A translocated (quarantined) app runs from a read-only path, so an in-place
  // swap can never succeed — it would just relaunch the same old build and loop.
  // Tell the user to move PlexiDesk to Applications and open the download page,
  // rather than attempting a doomed swap.
  if (isTranslocated(process.execPath)) {
    broadcast({
      kind: 'error',
      message:
        'Move PlexiDesk into your Applications folder, then update again — macOS is running it from a read-only location, which blocks in-place updates.'
    })
    openDownloadPage()
    return
  }

  // The mac build is one universal artifact — see MAC_UPDATE_ARCH. Using
  // process.arch here would ask for a per-arch asset that no longer exists.
  const arch = MAC_UPDATE_ARCH
  try {
    broadcast({ kind: 'downloading', percent: 0 })
    const url = macAssetUrl(version, arch)
    const work = mkdtempSync(join(tmpdir(), 'haptyx-update-'))
    const zipPath = join(work, 'update.zip')
    try {
      await downloadFile(url, zipPath, (pct) => broadcast({ kind: 'downloading', percent: pct }))
    } catch (e) {
      // Name the asset and arch so a 404 (e.g. an Intel Mac asking for an
      // arch we don't ship, or a release missing its mac zip) is obvious from
      // the banner rather than a bare "failed".
      const msg = (e as Error).message
      throw new Error(`Couldn't download the ${arch} update for v${version} (${msg}) Asset: ${url}`)
    }

    const unzipDir = join(work, 'unpacked')
    await new Promise<void>((resolve, reject) => {
      const p = spawn('ditto', ['-x', '-k', zipPath, unzipDir])
      p.on('error', reject)
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Couldn't unpack the downloaded update (ditto exit ${code}).`))))
    })
    const appName = readdirSync(unzipDir).find((n) => n.endsWith('.app'))
    if (!appName) throw new Error('The downloaded update did not contain an app bundle.')
    const newApp = join(unzipDir, appName)

    const script = join(work, 'install.sh')
    writeFileSync(script, MAC_INSTALL_SCRIPT, { mode: 0o755 })
    chmodSync(script, 0o755)
    const child = spawn('/bin/bash', [script, String(process.pid), newApp, targetApp, RELEASES_URL], {
      detached: true,
      stdio: 'ignore'
    })
    child.unref()

    // Quit shortly so the helper can take over the bundle. The banner shows the
    // ready state in the meantime.
    broadcast({ kind: 'ready', version })
    setTimeout(() => app.quit(), 500)
  } catch (e) {
    broadcast({ kind: 'error', message: (e as Error).message })
  }
}

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseNotes?: string }
  | { kind: 'downloading'; percent: number }
  | { kind: 'ready'; version: string; releaseNotes?: string }
  | { kind: 'none'; currentVersion: string }
  | { kind: 'error'; message: string }

let current: UpdateState = { kind: 'idle' }

function broadcast(state: UpdateState): void {
  current = state
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send('update:state', state)
    } catch {
      // window may have closed mid-broadcast — ignore
    }
  }
}

export function getCurrentUpdateState(): UpdateState {
  return current
}

export function installUpdateAndRestart(): void {
  // electron-updater's quitAndInstall closes all windows + spawns the
  // installer + relaunches. Safe to call multiple times — internally
  // guarded.
  autoUpdater.quitAndInstall(true, true)
}

export function checkForUpdates(): void {
  // Manual checks (footer version click) are also a no-op on the preview
  // build, for the same reason installAutoUpdater bails there.
  if (detectPreviewBuild({ plexiAppEnv: process.env['PLEXI_APP'], execPath: process.execPath, appName: app.getName() })) {
    broadcast({ kind: 'idle' })
    return
  }
  // checkForUpdatesAndNotify is the all-in-one but it spawns a native
  // notification, which we don't want — the in-app banner is enough.
  // Plain checkForUpdates() emits the events we wire to below.
  autoUpdater.checkForUpdates().catch((err: Error) => {
    broadcast({ kind: 'error', message: err.message })
  })
}

/** Install the auto-update lifecycle. Idempotent. */
export function installAutoUpdater(): void {
  // Dev/test builds don't have a code-signed app, and electron-updater
  // refuses to run against them. Bail without erroring so the rest of
  // the boot path stays green.
  if (!app.isPackaged) {
    broadcast({ kind: 'idle' })
    return
  }
  // The side-by-side "PlexiDesk 3 Preview" build must never be offered the
  // release channel's updates (that would "upgrade" it back to the current
  // production version). It has no channel of its own; testers rebuild.
  if (detectPreviewBuild({ plexiAppEnv: process.env['PLEXI_APP'], execPath: process.execPath, appName: app.getName() })) {
    broadcast({ kind: 'idle' })
    return
  }
  // Silence the native (Squirrel.Mac) updater so we don't see two
  // simultaneous flows in dev/test environments. electron-updater
  // delegates to Squirrel internally, this guards against a second
  // event loop being installed by a third-party module.
  nativeAutoUpdater.removeAllListeners()

  // On macOS we only DETECT updates (autoDownload off) because staging the
  // download for Squirrel.Mac fails on an ad-hoc signature; the renderer turns
  // the "available" state into a one-click download instead. On Windows the
  // full download-and-install-on-quit flow works.
  autoUpdater.autoDownload = !IS_MAC
  autoUpdater.autoInstallOnAppQuit = !IS_MAC
  // Don't run on dev builds (no signature → updater refuses).
  autoUpdater.forceDevUpdateConfig = false

  autoUpdater.on('checking-for-update', () => broadcast({ kind: 'checking' }))
  autoUpdater.on('update-available', (info: UpdateInfo) =>
    broadcast({
      kind: 'available',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined
    })
  )
  autoUpdater.on('update-not-available', (info: UpdateInfo) =>
    broadcast({ kind: 'none', currentVersion: info.version })
  )
  autoUpdater.on('download-progress', (p: ProgressInfo) =>
    broadcast({ kind: 'downloading', percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (info: UpdateInfo) =>
    broadcast({
      kind: 'ready',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined
    })
  )
  autoUpdater.on('error', (err: Error) =>
    broadcast({ kind: 'error', message: err.message })
  )

  // Kick off the first check shortly after boot so the user doesn't
  // wait. Then poll every 4 hours.
  const FIRST_CHECK_MS = 30 * 1000
  const POLL_MS = 4 * 60 * 60 * 1000
  setTimeout(() => checkForUpdates(), FIRST_CHECK_MS)
  setInterval(() => checkForUpdates(), POLL_MS)
}
