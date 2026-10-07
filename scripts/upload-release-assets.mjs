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

const REPO = process.env.REPO ?? 'saasmouth/focusbuddy'
const DIR = join(root, 'release')
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
if (!/^\d+$/.test(relId)) {
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
  let ok = true
  for (const name of files) {
    const src = join(DIR, name)
    if (!existsSync(src)) continue
    // Flat per-version prefix, matching releaseAssetUrl's object-store shape in
    // src/shared/productDomains.ts. The two must agree or the updater asks for
    // a path nothing was ever written to.
    const remote = `v${VERSION}/${name}`
    const r = spawnSync('aws', [
      's3', 'cp', src, `s3://${bucket}/${remote}`,
      '--endpoint-url', endpoint, '--checksum-algorithm', 'CRC32'
    ], {
      encoding: 'utf8',
      env: { ...process.env, AWS_ACCESS_KEY_ID: key, AWS_SECRET_ACCESS_KEY: secret, AWS_DEFAULT_REGION: 'auto' }
    })
    if (r.status === 0) {
      console.log(`  r2 OK   ${remote}`)
    } else {
      console.log(`  r2 FAIL ${remote}: ${(r.stderr || '').trim().split('\n').slice(-1)[0]}`)
      ok = false
    }
  }
  return ok
}

const u = `Haptyx-${VERSION}-mac-universal`
// The arm64-named aliases exist for clients up to 4.3.0, which build their
// update URL from process.arch. The universal zip runs fine on arm64.
copyFileSync(join(DIR, `${u}.zip`), join(DIR, `Haptyx-${VERSION}-mac-arm64.zip`))
copyFileSync(join(DIR, `${u}.zip.blockmap`), join(DIR, `Haptyx-${VERSION}-mac-arm64.zip.blockmap`))

let ok = true
for (const name of [
  `${u}.zip`, `${u}.zip.blockmap`, `${u}.dmg`, `${u}.dmg.blockmap`,
  `Haptyx-${VERSION}-mac-arm64.zip`, `Haptyx-${VERSION}-mac-arm64.zip.blockmap`,
  'latest-mac.yml'
]) {
  if (!push(join(DIR, name), name)) ok = false
}
const MIRRORED = [
  `${u}.zip`, `${u}.zip.blockmap`, `${u}.dmg`, `${u}.dmg.blockmap`,
  `Haptyx-${VERSION}-mac-arm64.zip`, `Haptyx-${VERSION}-mac-arm64.zip.blockmap`,
  'latest-mac.yml', 'latest.yml', `Haptyx-${VERSION}-win-x64.exe`
]
const mirrored = await mirrorToR2(MIRRORED)
if (!mirrored) ok = false

console.log(`UPLOAD_DONE ok=${ok}`)
process.exit(ok ? 0 : 1)
