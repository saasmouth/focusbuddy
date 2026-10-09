#!/usr/bin/env node
// Turn a `seed.cjs --dry-run` copy into a profile the built app can open under
// the Playwright harness without side effects (tests/e2e/_personaDeskShots.spec.ts).
//
// Never point this at a live profile: it refuses anything under
// ~/Library/Application Support.
//
// Usage: node scripts/persona-demos/prepare-profile.cjs <profile dir>

const fs = require('node:fs')
const { join, resolve } = require('node:path')
const { homedir } = require('node:os')
const { DatabaseSync } = require('node:sqlite')

const dir = resolve(process.argv[2] ?? '')
if (!process.argv[2] || !fs.existsSync(join(dir, 'focusbuddy.db'))) {
  console.error('usage: prepare-profile.cjs <dir holding a dry-run focusbuddy.db>')
  process.exit(2)
}
if (dir.startsWith(join(homedir(), 'Library', 'Application Support'))) {
  console.error('refusing: that is a live profile')
  process.exit(2)
}

// Signed out, sign-in modal skipped, launch counter reset — rewritten before
// every launch because past three anonymous launches the modal has no way out.
fs.writeFileSync(
  join(dir, 'account-session.json'),
  JSON.stringify({ encryptedToken: null, skippedAt: Date.now(), cachedEmail: null, anonLaunches: 0 })
)
// Skips the multi-hundred-MB auto-backup at launch.
fs.mkdirSync(join(dir, 'backups'), { recursive: true })
fs.writeFileSync(join(dir, 'backups', 'auto-harness.fbbackup'), '')

const db = new DatabaseSync(join(dir, 'focusbuddy.db'))
const has = (t) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t)
// Schedulers run against whatever profile is open; nothing may fire in a copy.
if (has('fb_flows')) db.exec('UPDATE fb_flows SET enabled = 0')
if (has('fb_live_desks')) db.exec('DELETE FROM fb_live_desks')
db.close()
console.log(`profile ready: ${dir}`)
