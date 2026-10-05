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
import { existsSync, copyFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = process.argv[2] ?? JSON.parse(
  spawnSync('cat', [join(root, 'package.json')], { encoding: 'utf8' }).stdout
).version
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
console.log(`UPLOAD_DONE ok=${ok}`)
process.exit(ok ? 0 : 1)
