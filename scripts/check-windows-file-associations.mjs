#!/usr/bin/env node
// Double-click a .plexii-* file and Plexii opens it (F3): on Windows that rests on
// the registry keys the NSIS installer writes for each type in
// build/plexii-file-types.cjs (electron-builder's APP_ASSOCIATE macro, per user,
// under HKCU\Software\Classes). This checks them on a real Windows machine, after
// the installer has run silently (CI: build-windows.yml), and again after a silent
// uninstall, when they must all be gone. It never starts Plexii and never touches
// the network.
//
//   node scripts/check-windows-file-associations.mjs installed "<install dir>\PlexiiDesk.exe"
//   node scripts/check-windows-file-associations.mjs removed
//
// The checks themselves are plain functions over a registry reader, so
// tests/unit/windowsFileAssociations.test.ts runs them anywhere.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { winFileAssociations } = require('../build/plexii-file-types.cjs')

const CLASSES = 'HKCU\\Software\\Classes'

/**
 * What the installer must have written for each type, as APP_ASSOCIATE writes it:
 *   .<ext>                         (default) = <ProgID>
 *   .<ext>\OpenWithProgids         <ProgID>  (a value, no data)
 *   <ProgID>                       (default) = "Plexii <label>"
 *   <ProgID>\shell\open\command    (default) = "<exe>" "%1"
 */
export function expectedEntries(exe) {
  return winFileAssociations().map((a) => ({
    ext: a.ext,
    progId: a.name,
    description: a.description,
    command: `"${exe}" "%1"`
  }))
}

/**
 * Problems, in plain words; none when every type is registered to `exe`.
 * `read(key, value?)` returns a value's data ('' for a value with none), or null
 * when the key or value is missing. `value` undefined means the key's default.
 */
export function checkInstalled(read, exe) {
  const problems = []
  for (const e of expectedEntries(exe)) {
    const ext = read(`${CLASSES}\\.${e.ext}`)
    if (ext !== e.progId) problems.push(`.${e.ext} names ${ext === null ? 'nothing' : JSON.stringify(ext)}, not ${e.progId}`)
    if (read(`${CLASSES}\\.${e.ext}\\OpenWithProgids`, e.progId) === null) problems.push(`.${e.ext} does not list ${e.progId} under OpenWithProgids`)
    const desc = read(`${CLASSES}\\${e.progId}`)
    if (desc !== e.description) problems.push(`${e.progId} is described as ${desc === null ? 'nothing' : JSON.stringify(desc)}, not ${JSON.stringify(e.description)}`)
    const cmd = read(`${CLASSES}\\${e.progId}\\shell\\open\\command`)
    if (cmd === null || cmd.toLowerCase() !== e.command.toLowerCase()) problems.push(`${e.progId} opens with ${cmd === null ? 'nothing' : cmd}, not ${e.command}`)
  }
  return problems
}

/**
 * Problems after an uninstall, by what APP_UNASSOCIATE removes: the ProgID key
 * and the .<ext>\OpenWithProgids entry. It leaves .<ext>'s default naming the
 * ProgID it deleted, which Windows treats as no handler, so that is not checked.
 */
export function checkRemoved(read) {
  const problems = []
  for (const e of expectedEntries('')) {
    if (read(`${CLASSES}\\${e.progId}`) !== null) problems.push(`${e.progId} is still registered`)
    if (read(`${CLASSES}\\.${e.ext}\\OpenWithProgids`, e.progId) !== null) problems.push(`.${e.ext} still lists ${e.progId} under OpenWithProgids`)
  }
  return problems
}

/** Parse `reg query <key> /ve` or `/v <name>` output: the data of the one value asked for. */
export function parseRegQuery(out) {
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s{4}(.*?)\s{4}(REG_[A-Z_]+)(?:\s{4}(.*))?$/.exec(line)
    if (m) return m[3] ?? ''
  }
  return null
}

function readRegistry(key, value) {
  try {
    const args = ['query', key, ...(value === undefined ? ['/ve'] : ['/v', value])]
    return parseRegQuery(execFileSync('reg', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch {
    return null // reg exits 1 when the key or value isn't there
  }
}

function main() {
  const [mode, exe] = process.argv.slice(2)
  if (process.platform !== 'win32') {
    console.error('This checks the Windows registry: run it on Windows.')
    process.exit(2)
  }
  let problems
  if (mode === 'installed' && exe) problems = checkInstalled(readRegistry, exe)
  else if (mode === 'removed') problems = checkRemoved(readRegistry)
  else {
    console.error('Usage: check-windows-file-associations.mjs installed "<path>\\PlexiiDesk.exe" | removed')
    process.exit(2)
  }
  const n = expectedEntries('').length
  if (problems.length) {
    for (const p of problems) console.error(`::error::${p}`)
    console.error(`${problems.length} problem(s) across ${n} .plexii-* types.`)
    process.exit(1)
  }
  console.log(mode === 'installed' ? `All ${n} .plexii-* types open with ${exe}.` : `All ${n} .plexii-* types are gone after the uninstall.`)
}

const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
if (process.argv[1] && same(resolve(process.argv[1]), fileURLToPath(import.meta.url))) main()
