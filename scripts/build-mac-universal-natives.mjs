// Turn this project's compiled native addons into universal (x86_64 + arm64)
// binaries, so one mac build runs on both Apple Silicon and Intel.
//
// Why not let electron-builder do it: its mac universal target builds an x64
// app dir and an arm64 app dir and merges them, rebuilding native modules for
// each arch on the way. That rebuild is disabled here — `npmRebuild: false` in
// electron-builder.cjs, because the in-builder rebuild hangs on
// node-mac-haptics. With it disabled, both arch app dirs would be packed from
// whatever single .node happens to be sitting in node_modules, so one of the
// two slices would ship addons for the wrong architecture and would fail to
// load on a user's machine.
//
// Building each addon for both arches and `lipo`-ing them into one fat .node
// avoids that whole problem: every arch app dir then packs byte-identical
// files, which also makes @electron/universal's merge trivial.
//
// Addons that ship as one npm package per arch (@napi-rs/canvas-darwin-arm64
// and -darwin-x64, sharp's sharp-darwin-arm64v8.node vs sharp-darwin-x64.node)
// need none of this: their filenames differ, both can sit side by side, and the
// loader picks by process.arch at runtime. scripts/fetch-mac-x64-natives.mjs
// puts the x64 ones in place.
//
// Usage: node scripts/build-mac-universal-natives.mjs [--check]
//   --check  verify the addons are already universal; do not rebuild
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const NM = join(root, 'node_modules')
const checkOnly = process.argv.includes('--check')

// The addons that compile from source and land at one fixed path regardless of
// architecture — these are the ones that must be fat.
const FAT_ADDONS = [
  'better-sqlite3/build/Release/better_sqlite3.node',
  'node-mac-haptics/build/Release/haptics.node'
]

const electronVersion = JSON.parse(
  readFileSync(join(NM, 'electron', 'package.json'), 'utf8')
).version

const archsOf = (file) => {
  try {
    return execFileSync('lipo', ['-archs', file], { encoding: 'utf8' }).trim().split(/\s+/)
  } catch {
    return []
  }
}

const isUniversal = (file) => {
  const a = archsOf(file)
  return a.includes('x86_64') && a.includes('arm64')
}

const report = (label, file) => {
  const rel = relative(NM, file)
  if (!existsSync(file)) {
    console.log(`  ${label} ${rel} — absent`)
    return false
  }
  const archs = archsOf(file).join(' ') || '(unreadable)'
  console.log(`  ${label} ${rel} → ${archs}`)
  return isUniversal(file)
}

// ── check mode ─────────────────────────────────────────────────────────────
if (checkOnly) {
  console.log(`universal-natives: checking (electron ${electronVersion})`)
  let bad = false
  for (const rel of FAT_ADDONS) {
    const file = join(NM, rel)
    // An absent optional addon is fine; a present single-arch one is not.
    if (!existsSync(file)) {
      console.log(`  skip ${rel} — not installed`)
      continue
    }
    if (!report('', file)) bad = true
  }
  if (bad) {
    console.error(
      'universal-natives: addons are not universal — run: node scripts/build-mac-universal-natives.mjs'
    )
    process.exit(1)
  }
  console.log('universal-natives: all addons are x86_64 + arm64 — OK')
  process.exit(0)
}

// ── build mode ─────────────────────────────────────────────────────────────
if (process.platform !== 'darwin') {
  console.error('universal-natives: mac only')
  process.exit(1)
}

const rebuildFor = (arch) => {
  console.log(`universal-natives: rebuilding native modules for ${arch}…`)
  execFileSync(
    'npx',
    ['--yes', '@electron/rebuild@latest', '-f', '-a', arch, '-v', electronVersion],
    { cwd: root, stdio: ['ignore', 'inherit', 'inherit'], timeout: 20 * 60 * 1000 }
  )
}

// Snapshot the addons after a rebuild so the next rebuild can't clobber them —
// @electron/rebuild writes in place, so arm64's output must be copied out
// before x64's overwrites it.
const snapshot = (arch) => {
  const dir = mkdtempSync(join(tmpdir(), `natives-${arch}-`))
  const kept = []
  for (const rel of FAT_ADDONS) {
    const src = join(NM, rel)
    if (!existsSync(src)) continue
    const dst = join(dir, rel.replace(/[/]/g, '__'))
    copyFileSync(src, dst)
    const archs = archsOf(dst)
    if (!archs.includes(arch === 'x64' ? 'x86_64' : arch)) {
      throw new Error(
        `${rel} built for ${arch} came out as "${archs.join(' ')}" — refusing to lipo a wrong-arch slice`
      )
    }
    kept.push({ rel, dst })
  }
  return { dir, kept }
}

let arm, x64
try {
  rebuildFor('arm64')
  arm = snapshot('arm64')
  rebuildFor('x64')
  x64 = snapshot('x64')

  console.log('universal-natives: merging slices with lipo…')
  for (const { rel, dst: armFile } of arm.kept) {
    const x64Entry = x64.kept.find((e) => e.rel === rel)
    const target = join(NM, rel)
    if (!x64Entry) {
      console.error(`  ${rel} — built for arm64 but not x64; leaving arm64-only`)
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    execFileSync('lipo', ['-create', armFile, x64Entry.dst, '-output', target])
    report('✓', target)
    if (!isUniversal(target)) throw new Error(`lipo produced a non-universal ${rel}`)
  }
} finally {
  for (const s of [arm, x64]) if (s) rmSync(s.dir, { recursive: true, force: true })
}

// Restate the final state, including the per-arch packages, so the log shows
// everything the mac build is about to pack.
console.log('universal-natives: final addon state')
for (const rel of FAT_ADDONS) {
  const f = join(NM, rel)
  if (existsSync(f)) report(' ', f)
}
for (const scope of ['@napi-rs']) {
  const base = join(NM, scope)
  if (!existsSync(base)) continue
  for (const pkg of readdirSync(base)) {
    const dir = join(base, pkg)
    if (!statSync(dir).isDirectory()) continue
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.node'))) {
      report(' ', join(dir, f))
    }
  }
}
for (const f of ['sharp/build/Release']) {
  const dir = join(NM, f)
  if (!existsSync(dir)) continue
  for (const a of readdirSync(dir).filter((x) => x.endsWith('.node'))) report(' ', join(dir, a))
}
console.log('universal-natives: done')
