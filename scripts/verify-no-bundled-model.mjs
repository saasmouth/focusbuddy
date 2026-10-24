#!/usr/bin/env node
// The no-bundled-model gate. Run on the LOCAL build artifacts, before upload.
//
// From 4.3.43 the local AI model does not ship with the app (owner,
// 2026-10-24). The app fetches it from dl.plexiidesk.com/models when Local AI
// is turned on, and the release uploads only the app. This refuses a build in
// which the model crept back in, for example from a worktree with
// resources/models staged and PLEXII_BUNDLE_MODEL set by accident.
//
// Usage: node scripts/verify-no-bundled-model.mjs [version] [--release-dir=release]
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const args = process.argv.slice(2)
const dirArg = args.find((a) => a.startsWith('--release-dir='))
const DIR = dirArg ? dirArg.slice('--release-dir='.length) : 'release'
const VERSION = args.find((a) => !a.startsWith('--')) ?? JSON.parse(execFileSync('node', ['-p', 'JSON.stringify(require("./package.json").version)']).toString())
const ARCH = process.env.MAC_ARCH || 'universal'
let bad = 0
const fail = (m) => { console.error(`  FAIL  ${m}`); bad++ }
const ok = (m) => console.log(`  ok    ${m}`)

console.log(`No-bundled-model gate for ${VERSION} (${ARCH})`)
const app = join(DIR, `mac-${ARCH}`, 'PlexiiDesk.app', 'Contents', 'Resources', 'models')
if (existsSync(app)) fail(`the built app carries ${app}`)
else ok('the built app has no Contents/Resources/models')

const zip = join(DIR, `PlexiDesk-${VERSION}-mac-${ARCH}.zip`)
if (!existsSync(zip)) fail(`missing ${zip}`)
else {
  const list = execFileSync('unzip', ['-Z1', zip], { maxBuffer: 1 << 28 }).toString()
  if (/\/Contents\/Resources\/models\//.test(list)) fail('the update zip carries a model')
  else ok('the update zip carries no model')
}

const dmg = join(DIR, `PlexiDesk-${VERSION}-mac-${ARCH}.dmg`)
if (!existsSync(dmg)) fail(`missing ${dmg}`)
else {
  const out = execFileSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-noverify', dmg]).toString()
  const mount = out.split('\n').map((l) => l.split('\t').pop()?.trim()).filter((m) => m && m.startsWith('/Volumes/')).pop()
  try {
    if (!mount) fail('could not mount the dmg')
    else if (existsSync(join(mount, 'PlexiiDesk.app', 'Contents', 'Resources', 'models'))) fail('the dmg carries a model')
    else ok('the dmg carries no model')
  } finally {
    if (mount) execFileSync('hdiutil', ['detach', mount, '-quiet'])
  }
}

if (bad) {
  console.error(`No-bundled-model gate FAILED (${bad}). The model ships separately; rebuild without PLEXII_BUNDLE_MODEL.`)
  process.exit(1)
}
console.log('No-bundled-model gate passed.')
