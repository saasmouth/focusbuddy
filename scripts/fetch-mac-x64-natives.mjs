// Place the x86_64 prebuilt native packages into node_modules alongside the
// arm64 ones, so a universal mac build has a slice for both architectures.
//
// npm cannot do this itself. Some native modules ship one npm package per
// platform+arch (@napi-rs/canvas-darwin-arm64, -darwin-x64, ...) and select
// between them with the `os`/`cpu` fields, so on an Apple Silicon machine npm
// installs only the arm64 package. Asking for the x64 one with
// `npm install --cpu x64 --os darwin` does not add it — it re-resolves the
// WHOLE tree as x64 and *removes* the arm64 package, which silently breaks the
// arm64 half of the universal build. So fetch the tarball directly instead and
// unpack it next to its sibling, leaving the dependency tree untouched.
//
// Modules that compile from source (better-sqlite3, node-mac-haptics) are not
// handled here — electron-builder rebuilds those per arch during the universal
// build.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const NM = join(root, 'node_modules')

// Each entry: the x64 package to fetch, and the installed package whose version
// pins it (a platform package must match its parent exactly).
const WANTED = [{ pkg: '@napi-rs/canvas-darwin-x64', versionFrom: '@napi-rs/canvas' }]

const installedVersion = (name) => {
  const p = join(NM, name, 'package.json')
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf8')).version
}

const archOf = (file) => {
  try {
    return execFileSync('lipo', ['-archs', file], { encoding: 'utf8' }).trim()
  } catch {
    return '(unreadable)'
  }
}

let failed = false
for (const { pkg, versionFrom } of WANTED) {
  const version = installedVersion(versionFrom)
  if (!version) {
    console.error(`x64-natives: ${versionFrom} is not installed — run npm install first`)
    failed = true
    continue
  }

  const dest = join(NM, pkg)
  if (installedVersion(pkg) === version) {
    console.log(`x64-natives: ${pkg}@${version} already present`)
    continue
  }

  const spec = `${pkg}@${version}`
  const staging = mkdtempSync(join(tmpdir(), 'x64-natives-'))
  try {
    // npm pack writes <scope>-<name>-<version>.tgz; find it rather than guess.
    execFileSync('npm', ['pack', spec, '--pack-destination', staging, '--silent'], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'inherit']
    })
    const tgz = readdirSync(staging).find((f) => f.endsWith('.tgz'))
    if (!tgz) throw new Error('npm pack produced no tarball')

    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dest, { recursive: true })
    // Every npm tarball roots at package/, so strip that one level.
    execFileSync('tar', ['-xzf', join(staging, tgz), '-C', dest, '--strip-components=1'])
    console.log(`x64-natives: unpacked ${spec}`)
  } catch (err) {
    console.error(`x64-natives: could not install ${spec} — ${err.message}`)
    failed = true
    continue
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }

  // Prove the thing we unpacked really is an x86_64 binary. A silently-arm64
  // payload here would produce a "universal" app whose Intel slice cannot load
  // its own addon, and the failure would only show up on a user's Intel Mac.
  const addons = readdirSync(dest).filter((f) => f.endsWith('.node'))
  if (addons.length === 0) {
    console.error(`x64-natives: ${pkg} contains no .node addon`)
    failed = true
    continue
  }
  for (const a of addons) {
    const archs = archOf(join(dest, a))
    if (!archs.split(/\s+/).includes('x86_64')) {
      console.error(`x64-natives: ${pkg}/${a} is ${archs}, expected x86_64`)
      failed = true
    } else {
      console.log(`x64-natives: ${pkg}/${a} → ${archs}`)
    }
  }
}

if (failed) process.exit(1)
console.log('x64-natives: OK')
