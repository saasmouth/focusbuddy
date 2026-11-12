// A copy of the test Electron that macOS never gives a Dock icon (owner,
// 2026-11-05: "Electron is opening and closing constantly on my local
// machine", during a background e2e run).
//
// Background e2e (_backgroundMain.cjs) makes the app an accessory app the
// moment its main script runs, but macOS registers a plain app bundle as a
// regular, Dock-showing app at LAUNCH, before any JavaScript: every spec's
// launch flashed an "Electron" icon in the owner's Dock and took it away
// again. LSUIElement in the bundle's Info.plist is the only switch macOS reads
// at launch. node_modules' own Electron.app is left exactly as installed (dev
// runs and the packager use it); this clones it (APFS clone: no space), sets
// LSUIElement, re-signs it ad hoc, and hands launchGuarded its executable.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

let cached: string | null = null

export function quietElectronExecutable(): string | null {
  if (process.platform !== 'darwin') return null
  if (cached && existsSync(cached)) return cached
  // require('electron') in Node resolves to the path of the real executable.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const real = require('electron') as unknown as string
  const bundle = real.slice(0, real.indexOf('.app/') + 4)
  const root = join(__dirname, '..', '..', 'node_modules', '.cache', 'plexii-e2e-quiet-electron')
  const version = (JSON.parse(readFileSync(join(dirname(require.resolve('electron/package.json')), 'package.json'), 'utf8')) as { version: string }).version
  // Keyed on the binary as well as the version string: the same version can
  // name two different runtimes (ELECTRON_OVERRIDE_DIST_PATH pointing at stock
  // Electron for a Widevine mutation run, or a reinstalled castLabs build), and
  // a clone of the wrong one would run every spec on it without a word.
  const framework = join(bundle, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework')
  let fingerprint = 'nofw'
  try {
    const st = statSync(framework)
    fingerprint = createHash('sha1').update(`${realpathSync(bundle)}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 10)
  } catch {
    /* no framework where expected: the version alone keys it */
  }
  const dest = join(root, `Electron-${version.replace(/[^\w.-]/g, '_')}-${fingerprint}.app`)
  const exe = join(dest, 'Contents', 'MacOS', 'Electron')
  if (!existsSync(exe)) {
    mkdirSync(root, { recursive: true })
    // Built aside, then renamed into place: parallel workers never see half a bundle.
    const tmp = join(root, `.building-${process.pid}-${Date.now()}.app`)
    try {
      execFileSync('cp', ['-cR', bundle, tmp])
      execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :LSUIElement bool true', join(tmp, 'Contents', 'Info.plist')])
      execFileSync('codesign', ['--force', '--sign', '-', tmp], { stdio: 'ignore' })
      try {
        renameSync(tmp, dest)
      } catch {
        // another worker won the race: use theirs
        rmSync(tmp, { recursive: true, force: true })
      }
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true })
      console.warn('[e2e] could not prepare the Dock-less Electron; launching the installed one:', (err as Error).message)
      return null
    }
  }
  cached = exe
  return exe
}
