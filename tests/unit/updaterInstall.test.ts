import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  macAssetUrl,
  appBundlePath,
  isTranslocated,
  MAC_INSTALL_SCRIPT,
  MAC_UPDATE_ARCH
} from '../../src/main/updaterInstall'
import { ACTIVE, releaseAssetUrl } from '../../src/shared/productDomains'

describe('macAssetUrl', () => {
  // This is the mac update channel, not a convenience: macOS does not use
  // electron-updater's feed to download, it builds this URL and fetches the zip.
  //
  // Two kinds of assertion below, deliberately. The first pins the WIRING — that
  // the URL tracks ACTIVE.downloads — and never needs editing. The second pins
  // the literal string that is compiled into the installer, and is MEANT to fail
  // at a cutover, so that moving the origin is a decision rather than a drift.
  it('tracks ACTIVE.downloads rather than any hardcoded host', () => {
    expect(macAssetUrl('2.5.18', 'arm64')).toBe(
      releaseAssetUrl(ACTIVE.downloads, '2.5.18', 'PlexiDesk-2.5.18-mac-arm64.zip')
    )
    expect(macAssetUrl('4.3.1', MAC_UPDATE_ARCH)).toBe(
      releaseAssetUrl(ACTIVE.downloads, '4.3.1', 'PlexiDesk-4.3.1-mac-universal.zip')
    )
  })

  it('resolves to R2, which is where this release mirrors to', () => {
    expect(macAssetUrl('2.5.18', 'arm64')).toBe(
      'https://dl.plexiidesk.com/v2.5.18/PlexiDesk-2.5.18-mac-arm64.zip'
    )
    expect(macAssetUrl('4.3.1', MAC_UPDATE_ARCH)).toBe(
      'https://dl.plexiidesk.com/v4.3.1/PlexiDesk-4.3.1-mac-universal.zip'
    )
  })

  it('asks for the product name, which is what new releases publish', () => {
    // The rename from Haptyx- is only safe because the uploader publishes
    // Haptyx-named copies too: a client already installed builds its URL with
    // the OLD pattern and cannot be changed retroactively. This asserts the
    // half that lives in the app; scripts/upload-release-assets.mjs owns the
    // aliases, and its ALIAS_OF map is what keeps them resolving.
    expect(macAssetUrl('4.3.11', MAC_UPDATE_ARCH)).toContain('PlexiDesk-4.3.11-mac-universal.zip')
    expect(macAssetUrl('4.3.11', MAC_UPDATE_ARCH)).not.toContain('Haptyx')
  })
})

describe('MAC_UPDATE_ARCH', () => {
  // The mac build is a single universal artifact from 4.3.1, so there is no
  // per-arch asset to pick. Deriving this from process.arch — which is what the
  // updater used to do — makes every one-click mac update 404, because
  // Haptyx-<v>-mac-arm64.zip and -mac-x64.zip are no longer published.
  it('is the universal slice, never the running process arch', () => {
    expect(MAC_UPDATE_ARCH).toBe('universal')
    expect(MAC_UPDATE_ARCH).not.toBe(process.arch)
  })

  it('is what the updater asks for, so the URL never carries a per-arch name', () => {
    const url = macAssetUrl('4.3.1', MAC_UPDATE_ARCH)
    expect(url).not.toContain('mac-arm64')
    expect(url).not.toContain('mac-x64')
  })
})

describe('appBundlePath', () => {
  it('derives the .app bundle from the executable path', () => {
    expect(appBundlePath('/Applications/Haptyx.app/Contents/MacOS/Haptyx')).toBe(
      '/Applications/Haptyx.app'
    )
  })
  it('returns null when not running from a bundle', () => {
    expect(appBundlePath('/usr/local/bin/node')).toBeNull()
  })
})

describe('isTranslocated', () => {
  it('flags an App Translocation mount', () => {
    expect(
      isTranslocated('/private/var/folders/xy/AppTranslocation/ABC/d/Haptyx.app/Contents/MacOS/Haptyx')
    ).toBe(true)
  })
  it('flags a randomised /private/var/folders run path', () => {
    expect(isTranslocated('/private/var/folders/ab/cd/T/Haptyx.app/Contents/MacOS/Haptyx')).toBe(true)
  })
  it('does NOT flag a normal /Applications install', () => {
    expect(isTranslocated('/Applications/Haptyx.app/Contents/MacOS/Haptyx')).toBe(false)
  })
  it('does NOT flag a user-folder install', () => {
    expect(isTranslocated('/Users/me/Applications/Haptyx.app/Contents/MacOS/Haptyx')).toBe(false)
  })
})

// Exercise the real swap helper against throwaway directories. This is the risky
// part of the updater (it replaces the app bundle), so we prove the swap, the
// restore-on-failure, the admin-elevation retry, and the manual-download
// fallback rather than trust the script by reading.
const runnable = process.platform === 'darwin' || process.platform === 'linux'

describe.runIf(runnable)('MAC_INSTALL_SCRIPT swap behaviour', () => {
  function setup(): {
    work: string
    scriptPath: string
    env: NodeJS.ProcessEnv
    target: string
    fresh: string
    openLog: string
    osaLog: string
  } {
    const work = mkdtempSync(join(tmpdir(), 'haptyx-swap-'))
    const target = join(work, 'Haptyx.app')
    const fresh = join(work, 'new', 'Haptyx.app')
    mkdirSync(target, { recursive: true })
    mkdirSync(fresh, { recursive: true })
    writeFileSync(join(target, 'VERSION'), 'old')
    writeFileSync(join(fresh, 'VERSION'), 'new')
    const bin = join(work, 'bin')
    mkdirSync(bin)
    const openLog = join(work, 'open.log')
    const osaLog = join(work, 'osa.log')
    const sh = (name: string, body: string): void => {
      writeFileSync(join(bin, name), body, { mode: 0o755 })
      chmodSync(join(bin, name), 0o755)
    }
    // `open` records what it was asked to open so we can assert the manual
    // fallback opens the releases URL; it never actually launches anything.
    sh('open', `#!/bin/bash\necho "$@" >> "${openLog}"\nexit 0\n`)
    sh('xattr', '#!/bin/bash\nexit 0\n')
    // `osascript` must NEVER show a real password dialog in a test. We record
    // that elevation was attempted and fail (simulating a declined / impossible
    // prompt), which exercises the manual-download fallback.
    sh('osascript', `#!/bin/bash\necho "$@" >> "${osaLog}"\nexit 1\n`)
    if (process.platform !== 'darwin') {
      sh('ditto', '#!/bin/bash\ncp -a "$1" "$2"\n')
    }
    const scriptPath = join(work, 'install.sh')
    writeFileSync(scriptPath, MAC_INSTALL_SCRIPT, { mode: 0o755 })
    chmodSync(scriptPath, 0o755)
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }
    return { work, scriptPath, env, target, fresh, openLog, osaLog }
  }

  it('swaps the new bundle into the target after the watched process exits', () => {
    const { scriptPath, env, target, fresh } = setup()
    const r = spawnSync('bash', [scriptPath, '999999', fresh, target, ''], { env, timeout: 30_000 })
    expect(r.status).toBe(0)
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(join(target, 'VERSION'), 'utf8')).toBe('new')
  })

  it('attempts admin elevation, then restores + opens releases when every swap fails', () => {
    const { work, scriptPath, env, target, openLog, osaLog } = setup() // osascript fails
    const missing = join(work, 'does-not-exist.app')
    const url = 'https://github.com/saasmouth/focusbuddy/releases/latest'
    spawnSync('bash', [scriptPath, '999999', missing, target, url], { env, timeout: 30_000 })
    // The elevated retry was attempted (the script did not give up unprivileged).
    expect(existsSync(osaLog)).toBe(true)
    expect(readFileSync(osaLog, 'utf8')).toContain('administrator privileges')
    // The old bundle survives, never lost.
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(join(target, 'VERSION'), 'utf8')).toBe('old')
    // And the user is routed to a manual download instead of looping silently.
    expect(readFileSync(openLog, 'utf8')).toContain(url)
  })
})
