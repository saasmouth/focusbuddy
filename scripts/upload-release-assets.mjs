// Upload large release assets one at a time, verifying each, with retries.
//
// Why this exists, twice over.
//
// FIRST: `gh release upload` pushed four files in one call, died partway on
// HTTP 408 ("Upload body timed out due to inactivity"), and the failure was
// invisible — seventeen minutes produced nothing but the small files, and the
// wrapper's non-zero exit was masked by a pipe. So: one file per request, and
// an exit code that means something.
//
// SECOND, and worse: verifying by SIZE passes an upload that never finished.
// GitHub creates the asset record with its DECLARED size the moment an upload
// starts, so a dead upload leaves an asset reporting the full byte count in
// state "starter". 4.3.7 shipped three such ghosts and every mac client's
// in-app update broke. `gh release view` compounds it by not listing "starter"
// assets at all — one tool says missing, the other says complete. The only
// honest check is state === "uploaded" AND the byte count matching local.
//
// THIRD: this script lived in the scratchpad and was deleted between releases,
// so a release step silently did nothing. A step the release depends on belongs
// in the repo. That is the same lesson scripts/release-env.mjs carries.
//
// Usage:  node scripts/upload-release-assets.mjs <version>   e.g. 4.3.8
import { spawnSync } from 'node:child_process'
import { existsSync, copyFileSync, statSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = process.argv[2] ?? JSON.parse(
  spawnSync('cat', [join(root, 'package.json')], { encoding: 'utf8' }).stdout
).version
// The R2 credentials live in .env, and nothing loads that file for this script:
// it is invoked directly, as `node scripts/upload-release-assets.mjs <version>`.
// Without this, mirrorToR2 finds process.env empty, takes its "not configured"
// branch, and the release reports success while the R2 download origin stays
// empty — the exact silent skip the rest of this file exists to prevent.
//
// Parsed, not sourced, and only these four keys. .env contains a bare value on a
// line of its own, with no `KEY=`, which a shell executes when it sources the
// file; scripts/release-env.mjs carries the same warning and the same parser.
const R2_KEYS = ['R2_BUCKET', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']
for (const line of existsSync(join(root, '.env'))
  ? readFileSync(join(root, '.env'), 'utf8').split('\n')
  : []) {
  const t = line.trim()
  if (!t || t.startsWith('#') || !t.includes('=')) continue
  const i = t.indexOf('=')
  const k = t.slice(0, i).trim()
  if (!R2_KEYS.includes(k)) continue
  const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  // A key present but empty is a placeholder awaiting a value, not configuration.
  if (v && !process.env[k]) process.env[k] = v
}

// A plan-only mode, so the file selection can be checked without uploading
// anything to a live release or a live download origin.
const DRY_RUN = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run')
const REPO = process.env.REPO ?? 'saasmouth/focusbuddy'
// Overridable so the file-selection logic can be exercised against a fixture
// directory rather than only against a real build output.
const DIR = process.env.RELEASE_DIR ?? join(root, 'release')
const TAG = `v${VERSION}`
const ATTEMPTS = 4

const gh = (args, opts = {}) =>
  spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })

const token = gh(['auth', 'token']).stdout.trim() // never printed

// Resolve the release id by LISTING, not by tag: `releases/tags/<tag>` 404s for
// a draft, and gh prints that 404 to stdout as well as failing, so an `A || B`
// fallback once captured the error JSON concatenated with the real id.
const relId = (gh(['api', `repos/${REPO}/releases`, '--paginate', '--jq',
  `.[] | select(.tag_name=="${TAG}") | .id`]).stdout || '').trim().split('\n')[0]
if (!/^\d+$/.test(relId) && !DRY_RUN) {
  console.error(`FATAL: no numeric release id for ${TAG} (got: '${relId}')`)
  process.exit(2)
}
console.log(`release ${TAG} id ${relId}`)

const assets = () => {
  const out = gh(['api', `repos/${REPO}/releases/${relId}/assets`, '--paginate',
    '--jq', '.[] | [.name, .state, .size, .id] | @tsv']).stdout || ''
  return out.split('\n').filter(Boolean).map((l) => {
    const [name, state, size, id] = l.split('\t')
    return { name, state, size: Number(size), id }
  })
}

function push(file, name) {
  if (!existsSync(file)) { console.log(`  SKIP  ${name} (no local file)`); return false }
  const want = statSync(file).size
  for (let a = 1; a <= ATTEMPTS; a++) {
    const found = assets().find((x) => x.name === name)
    if (found?.state === 'uploaded' && found.size === want) {
      console.log(`  OK    ${name} (${want} bytes, uploaded)`); return true
    }
    if (found) {
      // A "starter" ghost still occupies the name, so a retry would 422.
      console.log(`  clearing incomplete/mismatched record for ${name}`)
      gh(['api', '-X', 'DELETE', `repos/${REPO}/releases/assets/${found.id}`])
    }
    console.log(`  attempt ${a}/${ATTEMPTS}: ${name} (${want} bytes)`)
    const r = spawnSync('curl', ['-sS', '--fail-with-body', '-o', '/dev/null',
      '-w', '%{http_code}', '-X', 'POST',
      '-H', `Authorization: Bearer ${token}`,
      '-H', 'Content-Type: application/octet-stream',
      '-H', 'Accept: application/vnd.github+json',
      '--max-time', '3600', '--expect100-timeout', '60',
      '--data-binary', `@${file}`,
      `https://uploads.github.com/repos/${REPO}/releases/${relId}/assets?name=${name}`],
      { encoding: 'utf8' })
    console.log(`    http ${(r.stdout || '').trim() || r.status}`)
  }
  console.log(`  FAILED ${name} after ${ATTEMPTS} attempts`)
  return false
}

// ── The R2 mirror ───────────────────────────────────────────────────────────
//
// Why both, and in this order.
//
// The download URL is COMPILED INTO every installer. Someone running 4.3.8 asks
// GitHub for its update forever, because that is what their copy was built
// with. So R2 cannot replace GitHub by being switched on — GitHub has to keep
// serving until every client still expected to update in place has taken a
// build that points at R2. Until then, each release goes to both.
//
// Skipped cleanly when the bucket is not configured, so this does nothing at
// all until R2 exists, rather than failing a release that is otherwise fine.
async function mirrorToR2(files) {
  const [bucket, account, key, secret] = R2_KEYS.map((n) => process.env[n])
  const missing = R2_KEYS.filter((n) => !process.env[n])
  if (missing.length === R2_KEYS.length) {
    console.log(`r2: not configured (${R2_KEYS.join(' / ')}) — skipping mirror`)
    return true
  }
  // Partially configured is NOT the inert case. Something is set, so someone
  // meant this to run; skipping would leave the download origin empty while the
  // release reports success. That is the failure this file was written for.
  if (missing.length) {
    console.log(`  r2 FAIL: partially configured — missing ${missing.join(', ')}`)
    return false
  }
  const endpoint = `https://${account}.r2.cloudflarestorage.com`
  // Fail loudly rather than silently skipping: once R2 is configured, a missing
  // uploader means the mirror did not happen, and a release that reports success
  // while half the clients' download origin is empty is the failure this whole
  // file exists to prevent.
  if (spawnSync('aws', ['--version'], { encoding: 'utf8' }).status !== 0) {
    console.log('  r2 FAIL: R2 is configured but the aws CLI is not installed (brew install awscli)')
    return false
  }
  const put = (src, remote) => {
    const r = spawnSync('aws', [
      's3', 'cp', src, `s3://${bucket}/${remote}`,
      '--endpoint-url', endpoint, '--checksum-algorithm', 'CRC32'
    ], {
      encoding: 'utf8',
      env: { ...process.env, AWS_ACCESS_KEY_ID: key, AWS_SECRET_ACCESS_KEY: secret, AWS_DEFAULT_REGION: 'auto' }
    })
    if (r.status === 0) {
      console.log(`  r2 OK   ${remote}`)
      return true
    }
    console.log(`  r2 FAIL ${remote}: ${(r.stderr || '').trim().split('\n').slice(-1)[0]}`)
    return false
  }

  // Every release is written TWICE, and the order matters.
  //
  //   v<version>/<file>   Immutable, one prefix per release. This is the shape
  //                       releaseAssetUrl() builds, so it is what the website's
  //                       download buttons and the macOS installer step fetch.
  //
  //   <file> at the root  The rolling "latest", overwritten each release. This
  //                       is the electron-updater `generic` feed that
  //                       electron-builder bakes into app-update.yml, and it has
  //                       to be FLAT: electron-updater reads <root>/latest.yml
  //                       and resolves that manifest's `path` beside it. A
  //                       versioned prefix cannot be the feed, because the feed
  //                       URL is compiled into the installer and would have to
  //                       name the NEXT version's prefix.
  //
  // MANIFESTS LAST. The root copies are a live feed being read by installed
  // clients. A client that polls mid-upload and reads a new latest.yml naming an
  // artifact still uploading gets a 404 and a failed update, so the manifest
  // that points at the artifacts is written only once they are all there.
  // Every file asked for must exist. This used to filter to whatever happened
  // to be present, which hid the whole Windows half: the caller always listed
  // latest.yml and the .exe, the mac runner never has either, so they were
  // dropped without a word and the release reported success. The caller now
  // asks only for the platform it actually built, so a missing file here is a
  // broken build, not a different platform.
  const absent = files.filter((n) => !existsSync(join(DIR, n)))
  if (absent.length) {
    console.log(`r2 FATAL: expected files not in ${DIR}: ${absent.join(', ')}`)
    return false
  }
  const manifests = files.filter((n) => n.endsWith('.yml'))
  const artifacts = files.filter((n) => !n.endsWith('.yml'))
  let ok = true
  for (const name of [...artifacts, ...manifests]) {
    for (const remote of [`v${VERSION}/${name}`, name]) {
      if (DRY_RUN) { console.log(`  r2 DRY  ${remote}`); continue }
      if (!put(join(DIR, name), remote)) ok = false
    }
  }
  return ok
}

// Release artifacts are named PlexiDesk-<v>-... from 4.3.11, because that is
// the filename a user sees in their Downloads folder.
//
// THE OLD NAMES MUST KEEP RESOLVING. A shipped client builds its own update URL
// (src/main/updaterInstall.ts), so every copy out there asks for
// Haptyx-<next version>-mac-universal.zip and cannot be taught otherwise. Drop
// the old name and every installed mac client's one-click update 404s — on the
// release that was supposed to fix the branding.
//
// So each artifact is published twice, under both names. Same bytes, two keys.
const LEGACY_PREFIX = `Haptyx-${VERSION}`
const CURRENT_PREFIX = `PlexiDesk-${VERSION}`
/** The pre-rename name for an artifact, or null if it needs no alias. */
const legacyNameFor = (name) =>
  name.startsWith(CURRENT_PREFIX) ? LEGACY_PREFIX + name.slice(CURRENT_PREFIX.length) : null

// WHICH PLATFORM BUILT THIS, decided by what is on disk rather than assumed.
//
// mac and Windows are built on different machines — Windows in CI — so each run
// of this script sees only its own artifacts. Treating the mac set as mandatory
// made the script unusable on the Windows runner in the most abrupt way: the
// arm64 aliasing below is a bare copyFileSync, so it threw ENOENT before a
// single byte was uploaded.
// WHICH NAMING this directory uses, per platform, decided by what is on disk.
//
// Builds before 4.3.11 produced Haptyx-named artifacts, and re-running this
// against an older release directory is a real recovery case — the script
// exists because a release step once silently did nothing. So the prefix is
// discovered rather than assumed, and the aliasing below is skipped when the
// artifacts are already legacy-named (there is nothing to alias them to).
const prefixFor = (suffix) =>
  existsSync(join(DIR, `${CURRENT_PREFIX}-${suffix}`))
    ? CURRENT_PREFIX
    : existsSync(join(DIR, `${LEGACY_PREFIX}-${suffix}`))
      ? LEGACY_PREFIX
      : null

const macPrefix = prefixFor('mac-universal.zip')
const winPrefix = prefixFor('win-x64.exe')
const hasMac = macPrefix !== null
const hasWin = winPrefix !== null
const u = `${macPrefix}-mac-universal`
if (!hasMac && !hasWin) {
  console.error(
    `FATAL: ${DIR} holds no release artifacts. Looked for ` +
      `${CURRENT_PREFIX}-mac-universal.zip, ${LEGACY_PREFIX}-mac-universal.zip, ` +
      `${CURRENT_PREFIX}-win-x64.exe and ${LEGACY_PREFIX}-win-x64.exe.`
  )
  process.exit(2)
}

// The arm64-named aliases exist for clients up to 4.3.0, which build their
// update URL from process.arch. The universal zip runs fine on arm64.
if (hasMac) {
  copyFileSync(join(DIR, `${u}.zip`), join(DIR, `${macPrefix}-mac-arm64.zip`))
  copyFileSync(join(DIR, `${u}.zip.blockmap`), join(DIR, `${macPrefix}-mac-arm64.zip.blockmap`))
}

const MAC_FILES = [
  `${u}.zip`, `${u}.zip.blockmap`, `${u}.dmg`, `${u}.dmg.blockmap`,
  `${macPrefix}-mac-arm64.zip`, `${macPrefix}-mac-arm64.zip.blockmap`,
  'latest-mac.yml'
]
// latest.yml is the Windows update feed. electron-updater's generic provider
// reads <root>/latest.yml and resolves its `path` beside it, so without this
// file in R2 every Windows client built against the R2 origin asks for a 404
// forever and auto-update silently never finds anything.
// The blockmap is listed, not optional. electron-updater uses it to fetch only
// the changed blocks; without it every Windows user downloads the whole 240 MB
// installer again. CI did not even carry it out of the runner until the
// artifact pattern was fixed, so requiring it here is what keeps that fixed.
const WIN_FILES = [
  `${winPrefix}-win-x64.exe`,
  `${winPrefix}-win-x64.exe.blockmap`,
  'latest.yml'
]

const PRIMARY = [...(hasMac ? MAC_FILES : []), ...(hasWin ? WIN_FILES : [])]

// The aliases, created on disk so both destinations treat them as ordinary
// files. Manifests are NOT aliased: latest.yml and latest-mac.yml are read by
// name and their contents already point at the primary artifacts.
const ALIAS_OF = new Map()
for (const name of PRIMARY) {
  if (name.endsWith('.yml')) continue
  const legacy = legacyNameFor(name)
  if (!legacy) continue
  copyFileSync(join(DIR, name), join(DIR, legacy))
  ALIAS_OF.set(legacy, name)
}
const FILES = [...PRIMARY, ...ALIAS_OF.keys()]
console.log(`publishing ${PRIMARY.length} artifacts + ${ALIAS_OF.size} legacy-named aliases`)
console.log(`platform artifacts: ${hasMac ? 'mac' : ''}${hasMac && hasWin ? ' + ' : ''}${hasWin ? 'windows' : ''}`)

let ok = true
// GitHub still gets every release. Clients already installed were built with
// the github provider and ask it for updates forever; R2 only serves the ones
// built after the cutover.
for (const name of FILES) {
  if (DRY_RUN) { console.log(`  gh DRY  ${name}`); continue }
  if (!push(join(DIR, name), name)) ok = false
}
const mirrored = await mirrorToR2(FILES)
if (!mirrored) ok = false

console.log(`UPLOAD_DONE ok=${ok}`)
process.exit(ok ? 0 : 1)
