#!/usr/bin/env node
// Bank a green full run, then test only what a change can affect.
//
//   node scripts/test-changed.mjs <green-ref> [--dry]
//
// <green-ref> is a commit whose FULL vitest run passed (e.g. the last tip the
// aggregator ran the whole suite on). This runs:
//
//   1. vitest --changed <green-ref>: every test whose import graph reaches a
//      file changed since <green-ref>. Vitest walks the module graph, so a
//      change to a shared module pulls in every test that imports it.
//   2. Every GUARD test: the unit tests that read source files from disk
//      (readFileSync/readdirSync/glob) instead of importing them. The import
//      graph cannot see that dependency, so --changed alone would skip them.
//      That is not hypothetical: on 2026-10-22 the snippets merge broke
//      shareSurfaceUrlColor (a reviewed-dangerouslySetInnerHTML guard) and only
//      a full run caught it.
//
// It does NOT replace the full suite before a release build: run plain
// `npx vitest run` once on the final tip. It also never decides e2e; each app's
// own specs plus the cross-app officeShellLayout pass still own that.
import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ref = process.argv[2]
const dry = process.argv.includes('--dry')
if (!ref) {
  console.error('usage: node scripts/test-changed.mjs <green-ref> [--dry]')
  process.exit(2)
}
try {
  execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { stdio: 'ignore' })
} catch {
  console.error(`test-changed: ${ref} is not a commit here`)
  process.exit(2)
}

const changed = execFileSync('git', ['diff', '--name-only', `${ref}...HEAD`], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
console.log(`test-changed: ${changed.length} file(s) changed since ${ref}${dirty ? ' (plus uncommitted changes)' : ''}`)

const SCANS_DISK = /readFileSync|readdirSync|globSync|fast-glob|import\.meta\.glob/
const guards = readdirSync('tests/unit', { recursive: true })
  .map(String)
  .filter((f) => /\.test\.(ts|tsx|mjs|js)$/.test(f))
  .map((f) => join('tests/unit', f))
  .filter((f) => SCANS_DISK.test(readFileSync(f, 'utf8')))
console.log(`test-changed: ${guards.length} guard test file(s) always run (they read source from disk)`)

const run = (label, args) => {
  console.log(`\n── ${label}: npx vitest ${args.join(' ')}`)
  if (dry) return 0
  return spawnSync('npx', ['vitest', ...args], { stdio: 'inherit' }).status ?? 1
}

const a = run('import-graph related', ['run', '--maxWorkers=4', '--changed', ref, '--passWithNoTests'])
const b = run('guards', ['run', '--maxWorkers=4', ...guards])
if (a !== 0 || b !== 0) {
  console.error(`\ntest-changed: FAILED (related=${a}, guards=${b})`)
  process.exit(1)
}
console.log(`\ntest-changed: passed. Full suite still required once before the release build.`)
