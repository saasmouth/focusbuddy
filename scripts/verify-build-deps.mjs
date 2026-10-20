#!/usr/bin/env node
// Refuse to build, or to accept a build, that is missing a runtime dependency.
//
// This exists because it already happened. node-llama-cpp is the entire local
// AI engine and it is a plain entry in package.json "dependencies", but it was
// absent from this worktree's node_modules. Nothing complained. tsc said
// "cannot find module" and that was treated as a types problem; electron-builder
// packaged whatever node_modules held and exited 0; install-local.sh installed
// it; the app launched and looked completely normal.
//
// The result was a build handed over for local-AI testing that could not load a
// model at all. Not degraded — absent. It would have been discovered by the
// person who sat down to test it, after a day had been set aside for that.
//
// A missing dependency is silent in exactly the way that matters: the build
// succeeds, the app starts, and only the feature you were going to test is
// gone. So it gets a gate on both sides of the build.
//
//   --pre            every "dependencies" entry resolves in node_modules
//   --app <path>     the critical native modules are in the packaged .app
//
// Usage:
//   node scripts/verify-build-deps.mjs --pre
//   node scripts/verify-build-deps.mjs --app "/Applications/PlexiiDesk 1.2.3.app"
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const args = process.argv.slice(2)
const appFlag = args.indexOf('--app')
const APP = appFlag >= 0 ? args[appFlag + 1] : null
const PRE = args.includes('--pre')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/**
 * Dependencies whose absence removes a whole feature rather than breaking the
 * build loudly. These are checked inside the packaged app as well, because
 * "it compiled" says nothing about whether they were bundled.
 *
 * Keep this list short and justified: it is a promise that the build is
 * checked, not a second copy of package.json.
 */
const CRITICAL = [
  { name: 'node-llama-cpp', why: 'the on-device AI engine; without it local AI cannot load a model' },
  { name: 'better-sqlite3', why: 'the workspace database; without it the app has no data layer' }
]

let failed = false
const ok = (m) => console.log(`  ok    ${m}`)
const bad = (m) => {
  console.error(`  FAIL  ${m}`)
  failed = true
}

if (PRE) {
  console.log('[deps] every runtime dependency resolves')
  const missing = Object.keys(pkg.dependencies || {}).filter(
    (d) => !existsSync(join(ROOT, 'node_modules', d))
  )
  if (missing.length) {
    bad(`${missing.length} dependency(ies) declared in package.json are not installed:`)
    for (const m of missing) {
      const crit = CRITICAL.find((c) => c.name === m)
      console.error(`          - ${m}${crit ? `  <- ${crit.why}` : ''}`)
    }
    bad('run `npm install` before building, or the app ships without them and says nothing')
  } else {
    ok(`all ${Object.keys(pkg.dependencies || {}).length} runtime dependencies present`)
  }
}

if (APP) {
  console.log(`[deps] the packaged app carries its native modules`)
  if (!existsSync(APP)) {
    bad(`no app at ${APP}`)
  } else {
    const unpacked = join(APP, 'Contents/Resources/app.asar.unpacked/node_modules')
    if (!existsSync(unpacked)) {
      bad(`no app.asar.unpacked/node_modules in the bundle — nothing native was shipped`)
    } else {
      for (const { name, why } of CRITICAL) {
        const p = join(unpacked, name)
        if (!existsSync(p)) bad(`${name} is NOT in the packaged app — ${why}`)
        else ok(`${name} is in the packaged app`)
      }
      // node-llama-cpp is useless without a binding for this platform: the
      // package can be present while every prebuilt binary for this arch is
      // missing, which fails at model-load time rather than at build time.
      const llamaScope = join(unpacked, '@node-llama-cpp')
      if (existsSync(llamaScope)) {
        const bindings = readdirSync(llamaScope).filter((d) => d.startsWith('mac-') || d.startsWith('win-'))
        if (bindings.length) ok(`native binding(s) present: ${bindings.join(', ')}`)
        else bad('@node-llama-cpp holds no mac/win binding — the engine cannot start on this platform')
      } else {
        bad('@node-llama-cpp bindings directory is absent — the engine cannot start')
      }
    }
  }
}

if (!PRE && !APP) {
  console.error('usage: verify-build-deps.mjs --pre | --app <path to .app>')
  process.exit(2)
}

console.log(failed ? '\nDEPENDENCY GATE FAILED.' : '\nDependency gate passed.')
process.exit(failed ? 1 : 0)
