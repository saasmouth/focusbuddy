// Run a release build with the Apple credentials and live backend URLs in the
// environment, WITHOUT sourcing .env.
//
// Sourcing .env is not an option here. That file contains a bare value on a line
// of its own — no `KEY=` — which a shell executes as a command when it sources the
// file. So this parses the file itself and reads only the keys it is looking for.
//
// This used to live in /tmp, which is exactly where it should not: /tmp is cleaned,
// and when it vanished a release build failed at the first step with an error that
// looked nothing like the cause. A step the release depends on belongs in the repo.
//
// It never prints a value. The names of the credentials it found are echoed so a
// missing one is obvious, because a build that silently skips notarisation still
// produces a .dmg — one that Gatekeeper refuses on someone else's Mac.
//
// Usage:  node scripts/release-env.mjs npm run dist:mac:universal

import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// RELEASE_ENV_FILE points at another file (the tests use an empty one, so they
// never read the real credentials).
const envPath = process.env.RELEASE_ENV_FILE || join(root, '.env')

/** Only these are read. Anything else in .env is none of this script's business. */
const WANTED = new Set([
  'APPLE_ID',
  'APPLE_TEAM_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  // The notarytool keychain profile (stored once; see scripts/notary-auth.cjs).
  // Optional: the stored default "plexii-notary" is found without it.
  'APPLE_KEYCHAIN_PROFILE',
  'APPLE_KEYCHAIN',
  // The update-feed credentials. release-mac.sh REFUSES to finish without
  // R2_BUCKET, because uploading to the GitHub release alone leaves every
  // installed mac client being told the previous version is current — that is
  // how 4.3.13 and 4.3.14 shipped to nobody. Loading them here means the one
  // documented command carries everything the release needs; otherwise the
  // operator hand-exports secrets at the shell, which is both error-prone and
  // the sort of thing that ends up in a scrollback.
  'R2_BUCKET',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY'
])

const env = { ...process.env }
const found = []

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim()
    // A line with no '=' is skipped rather than interpreted. This is the line that
    // makes sourcing dangerous, and the reason this script exists.
    if (!t || t.startsWith('#') || !t.includes('=')) continue
    const i = t.indexOf('=')
    const key = t.slice(0, i).trim()
    if (!WANTED.has(key)) continue
    env[key] = t
      .slice(i + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
    found.push(key)
  }
}

// The live backend, baked into the renderer. Without these the shipped app falls
// back to signalConfig's default host and cannot reach the server at all — signup,
// login, sharing and plan checks all fail with "can't connect".
//
// Read from src/shared/productDomains.ts rather than repeated here. This file
// cannot import TypeScript, so it parses that module's ACTIVE set; a contract
// test fails if the two ever disagree. Two copies of a hostname that is COMPILED
// INTO the installer is not a bug you fix in a deploy — it is one you fix in a
// release, after someone cannot sign in.
// Resolved by scripts/read-active-domains.cjs, not by a regex here. This file
// used to match `= ([A-Z]+)`, which silently stopped matching the moment ACTIVE
// became `{ ...CURRENT, downloads: PRODUCTION.downloads }` — and a release build
// that aborts at step one is the lucky outcome. One parser, one place to fix.
const { readActiveDomains } = createRequire(import.meta.url)('./read-active-domains.cjs')
let api, viewer, activeIs
try {
  const resolved = readActiveDomains(root)
  ;({ api, viewer } = resolved.domains)
  activeIs = resolved.describe
} catch (e) {
  console.error(`FATAL: could not read ACTIVE domains from src/shared/productDomains.ts\n${e.message}`)
  process.exit(2)
}
if (!api || !viewer) {
  console.error('FATAL: ACTIVE resolved but api/viewer are missing')
  process.exit(2)
}
console.log(`domains: ${activeIs} (api ${api})`)
Object.assign(env, {
  VITE_USE_REMOTE_SIGNAL: 'true',
  VITE_SIGNAL_HTTP_URL: api,
  VITE_SIGNAL_WS_URL: `${api.replace(/^http/, 'ws').replace(/\/+$/, '')}/ws`,
  VITE_VIEWER_URL: viewer
})

// Names only, never values.
console.log(`apple credentials loaded from .env: ${found.sort().join(' ') || 'NONE'}`)

// Which notarisation path this build will take — decided by
// scripts/notary-auth.cjs, which every signing gate shares.
//
// notarytool takes its credentials as ARGUMENTS. On the app-specific-password
// path that put the password itself on the process's command line, where `ps`
// shows it to anything running as this user for the minutes notarisation
// takes; on 2026-11-25 it had been read into two agent sessions' output. A
// keychain profile puts only its NAME there. And because electron-builder 26
// takes the password path whenever APPLE_ID or APPLE_APP_SPECIFIC_PASSWORD is
// set (before a key or a profile), the child gets the resolved environment:
// with a profile or a key, both are REMOVED from it, not merely outranked.
//
// The old path is the explicit fallback: NOTARY_PASSWORD_IN_ARGV=1, loudly.
// With neither a profile nor that, a password alone stops here.
const { resolveNotaryAuth } = createRequire(import.meta.url)('./notary-auth.cjs')
const auth = resolveNotaryAuth(env)
if (auth.fatal) {
  console.error(`FATAL: ${auth.fatal}`)
  process.exit(1)
}
if (auth.mode === 'none') {
  // Judged on the environment the build will actually run with, not on what
  // .env contributed.
  const partial = [...WANTED].filter((k) => env[k])
  console.log(
    'WARNING: no notarisation credentials, so a mac build will be ad-hoc signed and NOT notarised\n' +
      '  (electron-builder.cjs refuses that unless SKIP_SIGNING_CHECK=1).'
  )
  if (partial.length) console.log(`  present but not enough: ${partial.sort().join(' ')}`)
} else {
  console.log(auth.summary)
}
for (const w of auth.warnings) console.log(w)

const [cmd, ...args] = process.argv.slice(2)
if (!cmd) {
  console.error('usage: node scripts/release-env.mjs <command> [args...]')
  process.exit(2)
}
const r = spawnSync(cmd, args, { cwd: root, env: auth.env, stdio: 'inherit', shell: false })
process.exit(r.status ?? 1)
