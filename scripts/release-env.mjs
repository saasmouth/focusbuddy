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
const envPath = join(root, '.env')

/** Only these are read. Anything else in .env is none of this script's business. */
const WANTED = new Set([
  'APPLE_ID',
  'APPLE_TEAM_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
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

// Which notarisation path this build will take, and the cost of the older one.
//
// notarytool takes its credentials as ARGUMENTS. On the app-specific-password
// path that means the password itself appears in the process's command line,
// where `ps` shows it to anything running as this user for as long as
// notarisation takes — minutes, on a multi-GB upload. It was observed in this
// repo's own build that way, which is how this warning came to exist. The App
// Store Connect API key path passes a FILE PATH instead (--key), so no secret
// is ever on a command line.
//
// Both paths are loaded above, and electron-builder prefers the API key when
// it is present, so this is a notice rather than a gate: nothing here changes
// which path is taken, it just stops the weaker one being the silent default.
//
// Each set must be COMPLETE to say anything. An earlier version of this notice
// checked only APPLE_ID and the password, and announced "notarisation:
// app-specific password" on a machine with no APPLE_TEAM_ID — directly under
// its own line saying no credentials were found and the build would be ad-hoc.
// A warning that contradicts the line above it teaches people to ignore both.
const hasApiKey = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'].every((k) => env[k])
const hasPassword = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'].every(
  (k) => env[k]
)
if (!hasApiKey && !hasPassword) {
  // Judged on the environment the build will actually run with, not on what
  // .env contributed. The old warning keyed off .env alone, so it announced
  // "no Apple credentials found" on a machine that had a complete set
  // inherited from the shell — and would have said it just as loudly if the
  // build were about to notarise successfully.
  const partial = [...WANTED].filter((k) => env[k])
  console.log(
    'WARNING: no COMPLETE Apple credential set, so this build will be ad-hoc signed and NOT notarised.'
  )
  if (partial.length) {
    console.log(`  present but not enough: ${partial.sort().join(' ')}`)
    console.log(
      '  need either APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER (preferred),\n' +
        '  or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID.'
    )
  }
} else if (hasApiKey) {
  console.log('notarisation: App Store Connect API key (no secret on any command line)')
} else if (hasPassword) {
  console.log('notarisation: app-specific password (complete set)')
  console.log(
    '  NOTE: notarytool receives this password as a command-line argument, so it is\n' +
      '  visible in `ps` to any process running as you while notarisation runs. To avoid\n' +
      '  that, create an App Store Connect API key and put APPLE_API_KEY (the .p8 path),\n' +
      '  APPLE_API_KEY_ID and APPLE_API_ISSUER in .env instead; electron-builder prefers\n' +
      '  them automatically and the existing password entries can then be removed and\n' +
      '  revoked.'
  )
}

const [cmd, ...args] = process.argv.slice(2)
if (!cmd) {
  console.error('usage: node scripts/release-env.mjs <command> [args...]')
  process.exit(2)
}
const r = spawnSync(cmd, args, { cwd: root, env, stdio: 'inherit', shell: false })
process.exit(r.status ?? 1)
