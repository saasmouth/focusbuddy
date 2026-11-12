// VMP signing with castLabs EVS: the production Widevine signature that lets
// Netflix and other commercial services play in PlexiiDesk's web pages.
//
// WHAT IT IS. Widevine checks that the app playing protected video is a
// Verified Media Path: a binary castLabs has signed. The ECS binaries in
// node_modules carry castLabs' DEVELOPMENT signature, which Widevine's test
// servers accept and commercial services refuse. EVS issues the PRODUCTION
// signature, free, to an account (docs/drm.md has the sign-up commands).
//
// WHERE IT RUNS. Order matters and differs by platform (castLabs EVS wiki):
//   macOS:   VMP-sign BEFORE Apple code-signing. The signature is a file in
//            the framework's Resources, which the code signature then seals.
//            So it runs from build/harden.cjs (afterPack): after the fuses are
//            flipped (they rewrite the binary the signature covers) and, for a
//            universal build, after @electron/universal has merged the two
//            slices (each slice's development signature differs, so the merge
//            refuses them: harden.cjs deletes them per slice and the merged,
//            fat binary is signed once, here). electron-builder signs and
//            notarises after afterPack.
//   Windows: VMP-sign AFTER Authenticode signing (Windows' VMP rejects any
//            change to a signed executable). So it runs from
//            build/vmp-after-sign.cjs (afterSign), before the installer is
//            made. Written for the Windows CI build; not run on this Mac.
//
// WHEN THERE IS NO ACCOUNT. The build goes on without a production signature
// and says so in one clear log line, and the app records 'none' in
// Resources/vmp.json so its notice can say why Netflix refuses it
// (src/shared/drm.ts). Widevine itself still works: test and UAT streams play.
//
// PLEXII_VMP controls it:
//   auto (default) sign when an account and the EVS client are present, else skip
//   require        fail the build instead of skipping (use for releases once
//                  the account exists)
//   off            never sign
'use strict'

const { spawnSync } = require('node:child_process')
const { existsSync, readFileSync, writeFileSync, rmSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')

/** Where the EVS client keeps its account tokens (castlabs_evs/auth.py). */
function evsConfigFile(env = process.env, home = homedir()) {
  const p = env.EVS_CONFIG_FILE || '~/.config/evs/config.json'
  return p.startsWith('~') ? join(home, p.slice(1)) : p
}

/**
 * Are there EVS credentials the client can use without asking anyone?
 * Either the account name and password in the environment (CI), or a config
 * file from `castlabs_evs.account signup`/`reauth` holding an account name and
 * a refresh token (a person's machine). Mirrors castlabs_evs/auth.py.
 */
function evsCredentials({ env = process.env, home = homedir(), readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  if (env.EVS_ACCOUNT_NAME && env.EVS_PASSWD) return { source: 'env', account: env.EVS_ACCOUNT_NAME }
  const file = evsConfigFile(env, home)
  let auth = null
  try {
    auth = JSON.parse(readFile(file)).Auth || null
  } catch {
    auth = null
  }
  if (auth && auth.AccountName && auth.RefreshToken) return { source: 'config', account: auth.AccountName, file }
  return null
}

/**
 * The Python that has the EVS client: EVS_PYTHON, else the virtualenv at
 * ~/.castlabs-evs (Homebrew's python3 is "externally managed", so pip can't
 * install into it; docs/drm.md), else python3 on PATH.
 */
function evsPython({ env = process.env, home = homedir(), exists = existsSync } = {}) {
  if (env.EVS_PYTHON) return env.EVS_PYTHON
  const venv = join(home, '.castlabs-evs', 'bin', 'python')
  if (exists(venv)) return venv
  return process.platform === 'win32' ? 'python' : 'python3'
}

/** Does that Python import castlabs_evs? */
function evsClientAvailable(python, spawn = spawnSync) {
  try {
    const r = spawn(python, ['-I', '-c', 'import castlabs_evs, sys; sys.stdout.write(castlabs_evs.__version__)'], {
      encoding: 'utf8',
      timeout: 30_000
    })
    return r.status === 0 ? String(r.stdout || '').trim() || 'unknown' : null
  } catch {
    return null
  }
}

const SIGN_UP_HINT =
  'To enable it, sign up once (docs/drm.md): ~/.castlabs-evs/bin/python -m castlabs_evs.account signup ' +
  '(the client is in the ~/.castlabs-evs virtualenv), then rebuild.'

/**
 * Sign, skip or fail — the whole decision, with no side effects.
 *
 * @param {{ mode?: string, platform: string, credentials: object|null, client: string|null, python: string }} input
 * @returns {{ action: 'sign'|'skip'|'fail', reason: string }}
 */
function vmpDecision({ mode = 'auto', platform, credentials, client, python }) {
  const m = String(mode || 'auto').toLowerCase()
  if (platform !== 'darwin' && platform !== 'win32') {
    return { action: 'skip', reason: `VMP is not available on ${platform} (castLabs: macOS and Windows only)` }
  }
  if (m === 'off') return { action: 'skip', reason: 'PLEXII_VMP=off' }
  if (m !== 'auto' && m !== 'require') {
    return { action: 'fail', reason: `PLEXII_VMP must be auto, require or off, not "${mode}"` }
  }
  const missing = !credentials
    ? 'no castLabs EVS account on this machine (no EVS_ACCOUNT_NAME/EVS_PASSWD, no token in ~/.config/evs/config.json)'
    : !client
      ? `the castlabs-evs client is not installed for ${python}`
      : null
  if (missing) {
    return m === 'require'
      ? { action: 'fail', reason: `PLEXII_VMP=require, but ${missing}` }
      : {
          action: 'skip',
          reason:
            `${missing}. This build gets NO production VMP signature: Widevine test streams play, ` +
            `Netflix and other commercial services will refuse it. ${SIGN_UP_HINT}`
        }
  }
  return {
    action: 'sign',
    reason: `EVS account ${credentials.account} (${credentials.source}), castlabs-evs ${client}`
  }
}

/** Work out the decision for this machine. */
function decideForThisMachine(platform, env = process.env) {
  const python = evsPython({ env })
  const credentials = evsCredentials({ env })
  // Only look for the client when it could matter (it spawns Python).
  const client = credentials && (env.PLEXII_VMP || 'auto').toLowerCase() !== 'off' ? evsClientAvailable(python) : null
  return { ...vmpDecision({ mode: env.PLEXII_VMP, platform, credentials, client, python }), python }
}

/** Run the EVS CLI, non-interactively, streaming its output into the build log. */
function runEvs(python, args, env = process.env) {
  const r = spawnSync(python, ['-I', '-m', 'castlabs_evs.vmp', '--no-ask', ...args], {
    stdio: 'inherit',
    env: { ...env, EVS_NO_ASK: '1' }
  })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`castlabs_evs.vmp ${args[0]} exited ${r.status}`)
}

/** Resources/vmp.json: what the app reads to explain a refusal (src/main/widevine.ts). */
function writeVmpMarker(resourcesDir, vmp, extra = {}) {
  writeFileSync(join(resourcesDir, 'vmp.json'), `${JSON.stringify({ vmp, ...extra }, null, 2)}\n`)
}

/** macOS: the development signature castLabs ships, which fuses or a merge invalidate. */
function macFrameworkSig(appPath) {
  return join(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources', 'Electron Framework.sig')
}

function removeDevelopmentSig(appPath) {
  const sig = macFrameworkSig(appPath)
  if (!existsSync(sig)) return false
  rmSync(sig, { force: true })
  return true
}

/**
 * VMP-sign one packaged app, or skip with the reason, and record the outcome
 * in its Resources/vmp.json. `pkgDir` is the directory HOLDING the .app/.exe
 * (EVS takes the directory). Throws when the decision is to fail, or when
 * signing or its verification fails: a build that meant to be signed must not
 * come out unsigned without anyone noticing.
 */
function vmpSignPackage({ platform, pkgDir, nameHint, resourcesDir, env = process.env, log = console.log }) {
  const d = decideForThisMachine(platform, env)
  if (d.action === 'fail') throw new Error(`[vmp] ${d.reason}`)
  if (d.action === 'skip') {
    log(`[vmp] SKIPPED VMP signing: ${d.reason}`)
    writeVmpMarker(resourcesDir, 'none', { reason: d.reason.split('. ')[0] })
    return 'skipped'
  }
  log(`[vmp] signing ${pkgDir} with castLabs EVS: ${d.reason}`)
  // The name hint picks THIS app's .app/.exe in the directory, not whatever
  // else might sit beside it.
  const hint = nameHint ? ['--name-hint', nameHint] : []
  runEvs(d.python, ['sign-pkg', ...hint, pkgDir], env)
  // verify-pkg is local (no account): the signature must match this binary and
  // be a PRODUCTION certificate; castLabs' development one fails it.
  runEvs(d.python, ['verify-pkg', ...hint, pkgDir], env)
  writeVmpMarker(resourcesDir, 'production', { kind: 'streaming', signedAt: new Date().toISOString() })
  log('[vmp] production VMP signature applied and verified')
  return 'signed'
}

module.exports = {
  evsConfigFile,
  evsCredentials,
  evsPython,
  evsClientAvailable,
  vmpDecision,
  decideForThisMachine,
  vmpSignPackage,
  writeVmpMarker,
  macFrameworkSig,
  removeDevelopmentSig
}
