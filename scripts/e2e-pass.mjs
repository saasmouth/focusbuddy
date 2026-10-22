#!/usr/bin/env node
// Run one e2e pass and record, in the log itself, WHAT it ran against.
//
//   node scripts/e2e-pass.mjs --log .baseline/cellsA.log --specs-from .baseline/cells-specs.txt
//   node scripts/e2e-pass.mjs --log .baseline/after.log -- tests/e2e/sheetEditor.spec.ts
//
// This exists because of a failure no other check could see. A Cells baseline
// was taken as two passes, as the method requires — but pass A ran before the
// specs were converted and pass B ran after, both against the same bundle.
// Pass A had 4 failures, pass B had 15, and the 11 extra were converted specs
// correctly failing against an unconverted app. Both logs said "Running 87
// tests", both had clean summaries, and the intersection looked like an
// ordinary noisy-machine result while silently shrinking the baseline — which
// is the dangerous direction, because a real regression then gets excused as a
// known red.
//
// Two passes are comparable only if they ran the same spec code against the
// same bundle. That is not something to remember; it is something to record.
// e2e-baseline-diff.mjs refuses when two baseline logs disagree on this header.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync, statSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
const log = flag('--log')
const specsFrom = flag('--specs-from')
const dashdash = argv.indexOf('--')
const inlineSpecs = dashdash === -1 ? [] : argv.slice(dashdash + 1)

if (!log || (!specsFrom && inlineSpecs.length === 0)) {
  console.error('usage: e2e-pass.mjs --log <path> (--specs-from <file> | -- <spec>...)')
  process.exit(2)
}

const specs = specsFrom
  ? readFileSync(specsFrom, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
  : inlineSpecs

const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16)

/** Hash the spec files this pass will run, in a stable order. */
const specsHash = sha([...specs].sort().map((f) => readFileSync(f)).join('\u0000'))

/** Hash the built renderer, so a pass against a different bundle is visible. */
function walk(dir) {
  const out = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    out.push(...(statSync(p).isDirectory() ? walk(p) : [p]))
  }
  return out
}
let bundleHash = 'none'
try {
  bundleHash = sha(walk('out/renderer').sort().map((f) => readFileSync(f)).join('\u0000'))
} catch {
  // no build present; recorded as "none" rather than guessed
}

const git = (args, fallback = '?') => {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim()
  } catch {
    return fallback
  }
}
const rev = git(['rev-parse', '--short', 'HEAD'])
const dirty = git(['status', '--porcelain', '--', 'src', 'tests']).split('\n').filter(Boolean).length

const header =
  `# fingerprint git=${rev} dirty=${dirty}\n` +
  `# fingerprint specs=${specsHash} count=${specs.length}\n` +
  `# fingerprint bundle=${bundleHash}\n`

writeFileSync(log, header)
process.stdout.write(header)
if (dirty > 0) {
  process.stdout.write(
    `# note: ${dirty} uncommitted file(s) under src/ or tests/ — this pass is not reproducible from ${rev} alone\n`
  )
}

const fd = openSync(log, 'a')
const res = spawnSync('npx', ['playwright', 'test', ...specs, '--reporter=list'], {
  stdio: ['ignore', fd, fd]
})
process.exit(res.status ?? 1)
