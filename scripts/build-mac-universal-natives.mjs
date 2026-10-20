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
const FAT_ADDONS = ['node-mac-haptics/build/Release/haptics.node']

// Addons that ship PER-ARCH prebuilt binaries and pick one at runtime by
// `process.arch`, rather than compiling to a single path that has to be fat.
//
// better-sqlite3 moved to this layout at v12 (we upgraded to 13 with Electron
// 44). The binaries are N-API, so they are ABI-stable and need no rebuild per
// Electron version at all — a straight improvement. But it silently broke this
// script's check: the old fixed path no longer exists, so the loop below hit
// "skip — not installed" and then printed "all addons are OK". A universal
// build missing its x64 slice would have passed that check and failed on an
// Intel Mac. Both files are now required explicitly.
const PREBUILD_ADDONS = [
  { pkg: 'better-sqlite3', dir: 'better-sqlite3/prebuilds', files: ['darwin-arm64.node', 'darwin-x64.node'] },
  // The on-device model runtime ships one package per arch: Metal on Apple
  // Silicon, CPU on Intel (scripts/fetch-mac-x64-natives.mjs adds the latter).
  {
    pkg: 'node-llama-cpp',
    dir: '@node-llama-cpp',
    files: ['mac-arm64-metal/bins/mac-arm64-metal/llama-addon.node', 'mac-x64/bins/mac-x64/llama-addon.node']
  }
]

/**
 * Check a per-arch addon: every listed file must exist and be the arch its
 * name claims. Returns true when something is wrong.
 */
const reportPrebuilds = ({ pkg, dir, files }) => {
  let bad = false
  if (!existsSync(join(NM, pkg))) {
    console.log(`  skip ${pkg} — not installed`)
    return false
  }
  for (const name of files) {
    const file = join(NM, dir, name)
    const rel = relative(NM, file)
    if (!existsSync(file)) {
      console.log(`  MISSING ${rel} — the universal build would break on that arch`)
      bad = true
      continue
    }
    const want = name.includes('arm64') ? 'arm64' : 'x86_64'
    const archs = archsOf(file)
    console.log(`  ${rel} → ${archs.join(' ') || '(unreadable)'}`)
    if (!archs.includes(want)) {
      console.log(`  WRONG ARCH ${rel} — expected ${want}`)
      bad = true
    }
  }
  return bad
}

const electronVersion = JSON.parse(
  readFileSync(join(NM, 'electron', 'package.json'), 'utf8')
).version

const archsOf = (file) => {
  try {
    // stdio 'pipe' for stderr: lipo writes a fatal-error line for every file
    // that is not Mach-O, and the scan below deliberately walks linux and
    // win32 prebuilds too. Those are expected misses, not problems to print.
    return execFileSync('lipo', ['-archs', file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .trim()
      .split(/\s+/)
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

/**
 * Every single-arch native payload in node_modules, so a NEW dependency that
 * ships per-arch binaries is caught here rather than seven minutes into a
 * universal build.
 *
 * @electron/universal refuses any file that is byte-identical in both slices
 * but is not itself universal, unless electron-builder's `x64ArchFiles`
 * pattern names it. Finding that out one package at a time, one failed build
 * apiece, is how this check earned its keep: canvas, then node-mac-haptics,
 * then onnxruntime, each a separate round trip. This lists them all at once.
 *
 * Reports rather than fails, because most hits are devDependencies that never
 * reach the package (rollup, lightningcss, the bundler's own binaries) and
 * this script cannot know electron-builder's `files` rules. The point is that
 * a human sees the list before the build does.
 */
const scanSingleArch = () => {
  const hits = []
  const walk = (dir, depth) => {
    if (depth > 6) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        // electron's own framework is universal-by-construction and huge.
        if (e.name === 'electron' && depth === 0) continue
        walk(full, depth + 1)
      } else if (/\.(node|dylib)$/.test(e.name)) {
        const archs = archsOf(full)
        // Only darwin binaries matter to a mac universal merge; a linux or
        // win32 prebuild is unreadable by lipo and is not what trips it.
        if (archs.length === 1 && (archs[0] === 'arm64' || archs[0] === 'x86_64')) {
          hits.push({ rel: relative(NM, full), arch: archs[0] })
        }
      }
    }
  }
  walk(NM, 0)
  return hits
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
  for (const spec of PREBUILD_ADDONS) {
    if (reportPrebuilds(spec)) bad = true
  }
  if (bad) {
    console.error(
      'universal-natives: addons are not universal — run: node scripts/build-mac-universal-natives.mjs'
    )
    process.exit(1)
  }
  const single = scanSingleArch()
  if (single.length > 0) {
    console.log(
      `universal-natives: ${single.length} single-arch darwin binaries in node_modules.`
    )
    console.log(
      '  Any of these that actually SHIP must be matched by mac.x64ArchFiles in'
    )
    console.log(
      '  electron-builder.cjs, or the universal merge fails. Most are devDeps and do not ship.'
    )
    for (const h of single) console.log(`    [${h.arch}] ${h.rel}`)
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
for (const spec of PREBUILD_ADDONS) reportPrebuilds(spec)
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
