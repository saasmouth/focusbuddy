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
  'APPLE_API_ISSUER'
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
Object.assign(env, {
  VITE_USE_REMOTE_SIGNAL: 'true',
  VITE_SIGNAL_HTTP_URL: 'https://focusbuddy-signal.fly.dev',
  VITE_SIGNAL_WS_URL: 'wss://focusbuddy-signal.fly.dev/ws',
  VITE_VIEWER_URL: 'https://focusbuddy-viewer.vercel.app'
})

// Names only, never values.
console.log(`apple credentials loaded: ${found.sort().join(' ') || 'NONE'}`)
if (found.length === 0) {
  console.log(
    'WARNING: no Apple credentials found, so this build will be ad-hoc signed and NOT notarised.'
  )
}

const [cmd, ...args] = process.argv.slice(2)
if (!cmd) {
  console.error('usage: node scripts/release-env.mjs <command> [args...]')
  process.exit(2)
}
const r = spawnSync(cmd, args, { cwd: root, env, stdio: 'inherit', shell: false })
process.exit(r.status ?? 1)
