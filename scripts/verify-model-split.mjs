#!/usr/bin/env node
// The model-split gate. Run on the LOCAL build artifacts, before upload.
//
// From the release that bundles the local AI model, mac ships two different
// bundles for one version:
//
//   the .dmg   a fresh install, WITH Contents/Resources/models/
//   the .zip   the auto-update payload, WITHOUT it
//
// They have to be two separate signed and notarised builds. electron-builder
// packages the app once per platform and then writes every target from that
// one directory (release/mac-<arch>/PlexiiDesk.app), so a single invocation
// cannot put the model in the dmg and leave it out of the zip. And stripping
// it afterwards is not an option: removing a file from a signed bundle breaks
// the seal and voids notarisation, so the omission has to happen before
// signing, which means a second packaging pass.
//
// Two builds for one version is the risk this script exists to control. The
// update payload and the fresh install must be the SAME APPLICATION, differing
// only by the model. If pass 2 is built from a dirty tree, a different commit,
// or a changed config, then people who update and people who install fresh are
// running different code under the same version number, and nothing else in
// the pipeline would notice.
//
// Why the model must never be in the zip: the mac updater is custom (see
// src/main/updaterInstall.ts — macOS does not use electron-updater's feed) and
// downloadFile() in autoUpdate.ts is a plain https.get of the whole asset. No
// Range header, no blockmap, no delta. A model left in the update zip is
// re-downloaded in full by every user on every update: roughly 388MB becoming
// 2.9GB, paid again at each release, including by users who never touch AI.
// Windows is different and fine — it goes through electron-updater's nsis
// blockmap, which does reuse unchanged blocks.
//
// Exit 0 = safe to upload. Exit 1 = do not upload.
//
// Usage: node scripts/verify-model-split.mjs [version] [--release-dir=release]
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'

const args = process.argv.slice(2)
const flag = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const positional = args.filter((a) => !a.startsWith('--'))
const ROOT = new URL('..', import.meta.url).pathname
const VERSION = positional[0] || JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const RELEASE_DIR = flag('release-dir', 'release')
const DIR = isAbsolute(RELEASE_DIR) ? RELEASE_DIR : join(ROOT, RELEASE_DIR)
const MAC_ARCH = process.env.MAC_ARCH || 'universal'

// The model lives under the app's Resources. Kept as a prefix rather than an
// exact path so the per-model subdirectory (models/<id>/…) does not matter.
const MODEL_PREFIX = 'Contents/Resources/models/'

let failed = false
const ok = (m) => console.log(`  ok    ${m}`)
const bad = (m) => {
  console.error(`  FAIL  ${m}`)
  failed = true
}
const note = (m) => console.log(`  --    ${m}`)

const ZIP = join(DIR, `PlexiDesk-${VERSION}-mac-${MAC_ARCH}.zip`)
const DMG = join(DIR, `PlexiDesk-${VERSION}-mac-${MAC_ARCH}.dmg`)

console.log(`Model-split gate for ${VERSION} (${MAC_ARCH})`)

for (const f of [ZIP, DMG]) {
  if (!existsSync(f)) {
    console.error(`  FAIL  missing build artifact: ${relative(ROOT, f)}`)
    process.exit(1)
  }
}

/** Paths inside the zip, as the archive lists them. */
function zipPaths(zip) {
  const out = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8', maxBuffer: 1 << 28 })
  return out.split('\n').filter(Boolean)
}

/** Shell-quote for the /bin/sh pipelines below. */
function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/**
 * sha256 of a file, via shasum so the bytes stream rather than landing in a
 * Buffer. The model is gigabytes; reading it into memory to hash it is a
 * needless way to make a release gate fail on a build machine.
 */
function shaFile(path) {
  const out = execFileSync('/bin/sh', ['-c', `shasum -a 256 ${q(path)}`], { encoding: 'utf8' })
  return out.trim().split(/\s+/)[0]
}

/** sha256 of one zip member, streamed straight into shasum. */
function zipMemberSha(zip, member) {
  const out = execFileSync('/bin/sh', ['-c', `unzip -p ${q(zip)} ${q(member)} | shasum -a 256`], {
    encoding: 'utf8'
  })
  return out.trim().split(/\s+/)[0]
}

function zipMemberText(zip, member) {
  return execFileSync('unzip', ['-p', zip, member], { encoding: 'utf8', maxBuffer: 1 << 26 })
}

/** Mount a dmg read-only and hand its mountpoint to fn, always detaching. */
function withMountedDmg(dmg, fn) {
  const mnt = mkdtempSync(join(tmpdir(), 'plexii-dmg-'))
  // -nobrowse keeps it out of Finder; -noautoopen stops a window appearing on
  // a developer's machine mid-release.
  execFileSync('hdiutil', ['attach', dmg, '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mnt], {
    stdio: 'pipe'
  })
  try {
    return fn(mnt)
  } finally {
    try {
      execFileSync('hdiutil', ['detach', mnt, '-force'], { stdio: 'pipe' })
    } catch {
      // A failed detach must not mask the real result; the mountpoint is in
      // tmp and the next reboot clears it.
    }
    try {
      rmSync(mnt, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}

/** Recursive relative file list under a directory. */
function walk(dir, base = dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, base, acc)
    else acc.push(relative(base, p))
  }
  return acc
}

// createHash stays imported for nothing else now; shaFile covers every case.

// ---------------------------------------------------------------------------
// 1. What each artifact actually contains.
// ---------------------------------------------------------------------------
console.log('[1/5] model placement')

const zipList = zipPaths(ZIP)
const zipApp = zipList.find((p) => /\.app\/$/.test(p)) || zipList.find((p) => /\.app\//.test(p))
if (!zipApp) {
  bad('no .app found inside the update zip')
  process.exit(1)
}
const appName = zipApp.slice(0, zipApp.indexOf('.app') + 4)
const zipHasModel = zipList.some((p) => p.startsWith(`${appName}/${MODEL_PREFIX}`))

const dmg = withMountedDmg(DMG, (mnt) => {
  const appDir = readdirSync(mnt).find((n) => n.endsWith('.app'))
  if (!appDir) return null
  const appPath = join(mnt, appDir)
  const files = walk(appPath)
  const modelFiles = files.filter((p) => p.startsWith(MODEL_PREFIX))
  const asar = join(appPath, 'Contents/Resources/app.asar')
  return {
    appDir,
    files,
    modelFiles,
    modelBytes: modelFiles.reduce((n, p) => n + statSync(join(appPath, p)).size, 0),
    asarSha: existsSync(asar) ? shaFile(asar) : null,
    // path -> sha256 for the bundled model, so it can be checked against both
    // the build inputs and the manifest.
    modelShas: Object.fromEntries(
      modelFiles.map((p) => [p.slice(MODEL_PREFIX.length), shaFile(join(appPath, p))])
    ),
    plist: existsSync(join(appPath, 'Contents/Info.plist'))
      ? readFileSync(join(appPath, 'Contents/Info.plist'), 'utf8')
      : null
  }
})

if (!dmg) {
  bad('no .app found inside the dmg')
  process.exit(1)
}

const dmgHasModel = dmg.modelFiles.length > 0

// ---------------------------------------------------------------------------
// 2. The split is either in use, or it is not. Both are valid; a model in the
//    UPDATE payload never is.
// ---------------------------------------------------------------------------
if (zipHasModel) {
  bad(
    `the update zip contains ${MODEL_PREFIX} — every user would re-download the model ` +
      'on every update. Build the zip pass with the model omitted (PLEXII_OMIT_MODEL=1).'
  )
} else {
  ok('update zip carries no model')
}

if (!dmgHasModel && !zipHasModel) {
  note('neither artifact bundles a model: the split is not in use for this release')
  note('nothing further to check')
  process.exit(failed ? 1 : 0)
}

if (dmgHasModel) {
  const gb = (dmg.modelBytes / 1e9).toFixed(2)
  ok(`dmg bundles a model (${dmg.modelFiles.length} file(s), ${gb} GB)`)
} else {
  bad('the dmg bundles no model, so a fresh install has no local AI and no offline default')
}

// ---------------------------------------------------------------------------
// 3. Two builds, one version: prove they are the same application.
//
//    app.asar is the whole JS application, so an equal hash means both bundles
//    run identical code. The signature directories are EXPECTED to differ:
//    signing seals the file list, and the two bundles have different file
//    lists by design, so _CodeSignature and the sealed resource map legitimately
//    diverge. Everything else must line up.
// ---------------------------------------------------------------------------
console.log('[2/5] same application in both artifacts')

const zipAsar = `${appName}/Contents/Resources/app.asar`
if (!zipList.includes(zipAsar)) {
  bad('no app.asar in the update zip')
} else if (!dmg.asarSha) {
  bad('no app.asar in the dmg')
} else {
  const a = zipMemberSha(ZIP, zipAsar)
  if (a === dmg.asarSha) ok(`app.asar identical in both (sha256 ${a.slice(0, 12)}…)`)
  else
    bad(
      'app.asar DIFFERS between the dmg and the update zip. The two passes were not built ' +
        'from the same source, so fresh installs and updates would run different code under ' +
        `one version. dmg=${dmg.asarSha.slice(0, 12)}… zip=${a.slice(0, 12)}…`
    )
}

console.log('[3/5] version metadata agrees')
const plistVersion = (xml, key) => {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml || '')
  return m?.[1] ?? null
}
const zipPlist = zipList.includes(`${appName}/Contents/Info.plist`)
  ? zipMemberText(ZIP, `${appName}/Contents/Info.plist`)
  : null
for (const key of ['CFBundleShortVersionString', 'CFBundleVersion', 'CFBundleIdentifier']) {
  const z = plistVersion(zipPlist, key)
  const d = plistVersion(dmg.plist, key)
  if (z && d && z === d) ok(`${key} matches (${z})`)
  else bad(`${key} differs or is missing: dmg=${d ?? 'none'} zip=${z ?? 'none'}`)
}
const shipped = plistVersion(zipPlist, 'CFBundleShortVersionString')
if (shipped && shipped !== VERSION)
  bad(`the bundles say ${shipped} but this release is ${VERSION}`)

// ---------------------------------------------------------------------------
// 4. The ONLY structural difference may be the model.
// ---------------------------------------------------------------------------
console.log('[4/5] the only difference is the model')
const SIGNATURE_NOISE = (p) =>
  p.includes('/_CodeSignature/') || p.startsWith('_CodeSignature/') || p.endsWith('/CodeResources')

const zipFiles = new Set(
  zipList
    .filter((p) => p.startsWith(`${appName}/`) && !p.endsWith('/'))
    .map((p) => p.slice(appName.length + 1))
    .filter((p) => !SIGNATURE_NOISE(p))
)
const dmgFiles = new Set(dmg.files.filter((p) => !SIGNATURE_NOISE(p)))

const onlyInDmg = [...dmgFiles].filter((p) => !zipFiles.has(p))
const onlyInZip = [...zipFiles].filter((p) => !dmgFiles.has(p))
const unexpectedDmg = onlyInDmg.filter((p) => !p.startsWith(MODEL_PREFIX))

if (onlyInZip.length === 0) ok('the update zip adds no file the dmg lacks')
else {
  bad(`the update zip contains ${onlyInZip.length} file(s) absent from the dmg:`)
  for (const p of onlyInZip.slice(0, 10)) console.error(`          + ${p}`)
}

if (unexpectedDmg.length === 0) ok(`the dmg adds only ${MODEL_PREFIX} files`)
else {
  bad(`the dmg contains ${unexpectedDmg.length} non-model file(s) absent from the zip:`)
  for (const p of unexpectedDmg.slice(0, 10)) console.error(`          + ${p}`)
}

// ---------------------------------------------------------------------------
// 5. The bundled model is the model that was meant to ship.
//
//    Two independent checks, because they catch different things:
//
//    a) bundled vs the BUILD INPUT (resources/models). Needs no manifest, so
//       it works today. Catches the packaging step mangling the payload: a
//       truncated copy, a file silently dropped, a symlink followed or not.
//    b) bundled vs the MANIFEST. Catches a corrupt or substituted weights file
//       that was already wrong before packaging, which (a) cannot see because
//       it would compare a bad file against itself.
//
//    A manifest that exists and does not parse is a FAILURE, never a skip. A
//    hash gate that quietly does nothing is the kind that gets discovered
//    after shipping.
// ---------------------------------------------------------------------------
console.log('[5/5] the bundled model is the intended model')

const SRC_DIR = join(ROOT, 'resources/models')

if (!existsSync(SRC_DIR)) {
  note('resources/models is absent here, so the bundled payload cannot be compared to its input')
  note('(expected when the gate runs away from the build machine)')
} else {
  const srcFiles = walk(SRC_DIR)
  const bundled = Object.keys(dmg.modelShas)
  const missing = srcFiles.filter((p) => !bundled.includes(p))
  const extra = bundled.filter((p) => !srcFiles.includes(p))

  if (missing.length) {
    bad(`${missing.length} model file(s) in resources/models did not reach the bundle:`)
    for (const p of missing.slice(0, 10)) console.error(`          - ${p}`)
  }
  if (extra.length) {
    bad(`${extra.length} model file(s) in the bundle are not in resources/models:`)
    for (const p of extra.slice(0, 10)) console.error(`          + ${p}`)
  }
  let mismatched = 0
  for (const rel of srcFiles) {
    if (!bundled.includes(rel)) continue
    if (shaFile(join(SRC_DIR, rel)) !== dmg.modelShas[rel]) {
      bad(`bundled model file differs from its build input: ${rel}`)
      mismatched++
    }
  }
  if (!missing.length && !extra.length && !mismatched)
    ok(`all ${srcFiles.length} model file(s) match resources/models byte for byte`)
}

// The manifest. Two shapes are accepted and the one found is named, so a
// format change surfaces as a reported mismatch rather than a silent pass:
//
//   shasum style   "<sha256>  <path relative to the manifest's directory>"
//   JSON           { "files": { "<path>": "<sha256>" } }  (also accepts a bare
//                  { "<path>": "<sha256>" } map)
//
// Searched for inside the bundled model tree so it travels with the weights.
const MANIFEST_NAMES = ['manifest.sha256', 'SHA256SUMS', 'manifest.json', 'model.manifest.json']

function findManifest() {
  if (!existsSync(SRC_DIR)) return null
  for (const rel of walk(SRC_DIR)) {
    const base = rel.split('/').pop()
    if (MANIFEST_NAMES.includes(base)) return { rel, abs: join(SRC_DIR, rel) }
  }
  return null
}

function parseManifest(text, name) {
  if (name.endsWith('.json')) {
    const j = JSON.parse(text)
    const map = j && typeof j === 'object' && j.files && typeof j.files === 'object' ? j.files : j
    if (!map || typeof map !== 'object') throw new Error('no object of path -> sha256')
    const out = {}
    for (const [k, v] of Object.entries(map)) {
      if (typeof v !== 'string' || !/^[0-9a-f]{64}$/i.test(v)) throw new Error(`bad sha256 for ${k}`)
      out[k] = v.toLowerCase()
    }
    if (!Object.keys(out).length) throw new Error('manifest lists no files')
    return out
  }
  const out = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    // shasum writes "<hash>  <path>"; BSD and GNU differ only in the separator
    // width, and "*" marks binary mode.
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(t)
    if (!m) throw new Error(`unparseable line: ${t.slice(0, 60)}`)
    out[m[2].trim()] = m[1].toLowerCase()
  }
  if (!Object.keys(out).length) throw new Error('manifest lists no files')
  return out
}

const manifest = findManifest()
if (!manifest) {
  note('no model manifest found; the bundled-vs-input check above is the only hash gate')
  note(`(add one of ${MANIFEST_NAMES.join(', ')} inside resources/models to enable it)`)
} else {
  const dirPrefix = manifest.rel.includes('/') ? manifest.rel.slice(0, manifest.rel.lastIndexOf('/') + 1) : ''
  let entries = null
  try {
    entries = parseManifest(readFileSync(manifest.abs, 'utf8'), manifest.rel)
  } catch (e) {
    bad(`manifest ${manifest.rel} did not parse: ${e.message}`)
    bad(`supported: "<sha256>  <path>" lines, or JSON {"files":{"<path>":"<sha256>"}}`)
  }
  if (entries) {
    ok(`manifest ${manifest.rel} lists ${Object.keys(entries).length} file(s)`)
    let checked = 0
    for (const [rel, want] of Object.entries(entries)) {
      // Manifest paths are relative to the manifest's own directory.
      const key = `${dirPrefix}${rel}`.replace(/^\.\//, '')
      const got = dmg.modelShas[key]
      if (!got) {
        bad(`manifest lists ${rel}, which is not in the bundled model`)
        continue
      }
      if (got !== want) {
        bad(`sha256 mismatch for ${key}: manifest ${want.slice(0, 12)}… bundle ${got.slice(0, 12)}…`)
        continue
      }
      checked++
    }
    if (checked === Object.keys(entries).length) ok(`every manifest hash matches the bundled file`)
    // Weights present but unlisted are worth knowing about: an unverified file
    // in the bundle is exactly what a manifest is supposed to rule out.
    const unlisted = Object.keys(dmg.modelShas).filter(
      (p) => !Object.keys(entries).some((rel) => `${dirPrefix}${rel}`.replace(/^\.\//, '') === p)
    ).filter((p) => !MANIFEST_NAMES.includes(p.split('/').pop()))
    if (unlisted.length) {
      bad(`${unlisted.length} bundled model file(s) are not covered by the manifest:`)
      for (const p of unlisted.slice(0, 10)) console.error(`          ? ${p}`)
    } else {
      ok('the manifest covers every bundled model file')
    }
  }
}

console.log(failed ? '\nMODEL-SPLIT GATE FAILED — do not upload.' : '\nModel-split gate passed.')
process.exit(failed ? 1 : 0)
