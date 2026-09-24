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

describe('macAssetUrl', () => {
  it('builds the release asset URL for a version and arch', () => {
    expect(macAssetUrl('2.5.18', 'arm64')).toBe(
      'https://github.com/saasmouth/focusbuddy/releases/download/v2.5.18/Haptyx-2.5.18-mac-arm64.zip'
    )
  })

  it('names the universal asset the mac build actually publishes', () => {
    expect(macAssetUrl('4.3.1', MAC_UPDATE_ARCH)).toBe(
      'https://github.com/saasmouth/focusbuddy/releases/download/v4.3.1/Haptyx-4.3.1-mac-universal.zip'
    )
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
