// Publish the on-device AI models to Plexii's download host (Cloudflare R2
// behind dl.plexiidesk.com), laid out exactly like each model's folder inside
// the app, per version:
//
//   models/<bundleId>/<version>/<file>
//   models/<bundleId>/<version>/LICENSE.txt
//   models/<bundleId>/<version>/manifest.sha256    (the SAME file the app ships)
//
//   node scripts/upload-local-models.mjs            # dry run (default)
//   node scripts/upload-local-models.mjs --upload   # really upload, then verify
//   node scripts/upload-local-models.mjs --verify   # verify what is published
//   [--dir <models dir>]  default resources/models (staged by
//                         scripts/fetch-bundled-models.mjs)
//   [--catalog <json>]    default resources/local-models.json (tests point it
//                         at a fixture catalog)
//
// What it does, in order, and refuses to continue past any failure:
//   1. reads resources/local-models.json (name, version, file, size, sha256,
//      licence, source URL — the app compiles the same checksums in:
//      src/shared/localModelCatalog.ts, held equal by a unit test);
//   2. for each model directory, checks manifest.sha256 parses, lists every
//      file in the directory, matches every file's sha256, and agrees with
//      local-models.json for the weights — so a wrong or truncated file, or a
//      wrong manifest, can never be published;
//   3. uploads the weights and licence, then the manifest last, so a client
//      never sees a manifest for files not yet there. Cache headers per file
//      (cacheControlFor): ONLY the versioned weights are immutable for a year;
//      the manifest (and any .json) must never be pinned in a cache — it is
//      the integrity anchor a client reads first, and a stale or wrong one
//      cached for a year would refuse every download of that version — so it
//      is no-cache (revalidated on every request); the licence text is short-
//      cached;
//   4. verifies each public URL over HTTPS: status, content-length, the
//      Cache-Control each file was given, that a Range request is honoured
//      (the in-app downloader resumes with Range), and that the published
//      manifest is byte-identical to the staged one.
//
// R2 credentials are read from .env (R2_BUCKET, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY) the same way scripts/upload-release-assets.mjs reads
// them, and are never printed. Uses the aws CLI against the R2 endpoint.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (n) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : null
}
const DIR = opt('dir') ?? join(root, 'resources', 'models')
const CATALOG = opt('catalog') ?? join(root, 'resources', 'local-models.json')
const UPLOAD = args.includes('--upload')
const VERIFY_ONLY = args.includes('--verify')
const PUBLIC_BASE = 'https://dl.plexiidesk.com'
const MANIFEST_NAMES = ['manifest.sha256', 'manifest.json', 'model.manifest.json']

/**
 * The Cache-Control a published file gets. Only model weights (.gguf, .bin,
 * .safetensors) are immutable: they live under a versioned path and a new file
 * means a new version. Manifests and any JSON are no-cache; everything else
 * (the licence text) a short public cache.
 */
export function cacheControlFor(name) {
  const base = name.split('/').pop() ?? name
  if (/^(manifest\.sha256|manifest\.json|model\.manifest\.json)$/.test(base) || base.endsWith('.json')) return 'no-cache'
  if (/\.(gguf|bin|safetensors)$/i.test(base)) return 'public, max-age=31536000, immutable'
  return 'public, max-age=3600'
}

const manifest = JSON.parse(readFileSync(CATALOG, 'utf8'))
const entries = [...manifest.models, manifest.embedding]

const R2_KEYS = ['R2_BUCKET', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']
for (const line of existsSync(join(root, '.env')) ? readFileSync(join(root, '.env'), 'utf8').split('\n') : []) {
  const t = line.trim()
  if (!t || t.startsWith('#') || !t.includes('=')) continue
  const i = t.indexOf('=')
  const k = t.slice(0, i).trim()
  if (!R2_KEYS.includes(k)) continue
  const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  if (v && !process.env[k]) process.env[k] = v
}

const sha256 = (p) =>
  new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject)
  })

let failed = false
console.log(`local models: ${entries.length} model(s) from ${DIR}, ${UPLOAD ? 'UPLOAD' : 'dry run (pass --upload to publish)'}`)
const plan = []
for (const e of entries) {
  const dir = join(DIR, e.bundleId)
  const mf = join(dir, 'manifest.sha256')
  if (!existsSync(mf)) {
    console.log(`  MISSING ${e.bundleId}/manifest.sha256 (run scripts/fetch-bundled-models.mjs)`)
    failed = true
    continue
  }
  const listed = {}
  for (const line of readFileSync(mf, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(t)
    if (!m) {
      console.log(`  UNPARSEABLE ${e.bundleId}/manifest.sha256: ${t.slice(0, 60)}`)
      failed = true
      continue
    }
    listed[m[2].trim().replace(/^\.\//, '')] = m[1].toLowerCase()
  }
  const present = readdirSync(dir).filter((f) => !MANIFEST_NAMES.includes(f) && !f.startsWith('.') && !f.endsWith('.part'))
  for (const f of present) if (!listed[f]) { console.log(`  UNLISTED ${e.bundleId}/${f}`); failed = true }
  for (const [f, want] of Object.entries(listed)) {
    const p = join(dir, f)
    if (!existsSync(p)) { console.log(`  MISSING ${e.bundleId}/${f}`); failed = true; continue }
    const got = await sha256(p)
    const pinOk = f !== e.file || (want === e.sha256 && statSync(p).size === e.sizeBytes)
    const ok = got === want && pinOk
    console.log(`  ${ok ? 'OK      ' : 'MISMATCH'} ${e.bundleId}/${f}  ${statSync(p).size} bytes  sha256 ${got}${pinOk ? '' : '  (not the sha256/size in local-models.json)'}`)
    if (!ok) failed = true
  }
  if (!listed[e.file]) { console.log(`  manifest for ${e.bundleId} does not list ${e.file}`); failed = true }
  const key = (f) => `models/${e.bundleId}/${e.version}/${f}`
  for (const f of Object.keys(listed).sort()) {
    plan.push({ src: join(dir, f), key: key(f), type: f.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'application/octet-stream', cache: cacheControlFor(f) })
  }
  plan.push({ src: mf, key: key('manifest.sha256'), type: 'text/plain; charset=utf-8', cache: cacheControlFor('manifest.sha256') })
}
if (failed) {
  console.log('refusing: fix the files above first')
  process.exit(1)
}

const bucket = process.env.R2_BUCKET
const endpoint = process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '<R2 endpoint>'
const awsEnv = {
  ...process.env,
  AWS_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
  AWS_DEFAULT_REGION: 'auto'
}
for (const step of VERIFY_ONLY ? [] : plan) {
  const cmd = [
    's3', 'cp', step.src, `s3://${bucket ?? '<R2_BUCKET>'}/${step.key}`,
    '--endpoint-url', endpoint,
    '--content-type', step.type,
    '--cache-control', step.cache,
    '--checksum-algorithm', 'CRC32'
  ]
  if (!UPLOAD) {
    // Placeholders, not values: the account id is kept out of logs and the repo.
    const shown = cmd.map((a) =>
      a === endpoint ? 'https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com' : a.replace(`s3://${bucket}/`, 's3://$R2_BUCKET/')
    )
    console.log(`  would run: aws ${shown.join(' ')}`)
    console.log(`  headers  ${step.key}  Cache-Control: ${step.cache}  Content-Type: ${step.type}`)
    continue
  }
  const missing = R2_KEYS.filter((k) => !process.env[k])
  if (missing.length) {
    console.log(`refusing: R2 not configured (missing ${missing.join(', ')})`)
    process.exit(1)
  }
  const r = spawnSync('aws', cmd, { encoding: 'utf8', env: awsEnv })
  if (r.status !== 0) {
    const why = (r.stderr || '').trim().split('\n').slice(-1)[0].replaceAll(process.env.R2_ACCOUNT_ID ?? '\u0000', '$R2_ACCOUNT_ID')
    console.log(`  FAIL ${step.key}: ${why}`)
    process.exit(1)
  }
  console.log(`  uploaded ${step.key}`)
}

if (UPLOAD || VERIFY_ONLY) {
  // Every published file, by its public URL: 200, the right length and
  // Cache-Control; the weights also answer a Range request (resume), and the
  // manifest is byte-identical to the staged one.
  for (const step of plan) {
    const url = `${PUBLIC_BASE}/${step.key}`
    const problems = []
    let res
    try {
      res = await fetch(url, { method: 'HEAD', cache: 'no-store' })
    } catch (e) {
      console.log(`  FAIL     ${url}  ${e.message}`)
      failed = true
      continue
    }
    const len = Number(res.headers.get('content-length'))
    const cc = res.headers.get('cache-control') ?? '(none)'
    if (res.status !== 200) problems.push(`status ${res.status}`)
    if (len !== statSync(step.src).size) problems.push(`${len} bytes, expected ${statSync(step.src).size}`)
    if (cc !== step.cache) problems.push(`Cache-Control "${cc}", expected "${step.cache}"`)
    let extra = ''
    if (step.key.endsWith('manifest.sha256')) {
      const published = await (await fetch(url, { cache: 'no-store' })).text()
      const same = published === readFileSync(step.src, 'utf8')
      if (!same) problems.push('manifest DIFFERS from the staged one')
      extra = `, manifest ${same ? 'identical' : 'DIFFERS'}`
    } else if (/\.gguf$/.test(step.key)) {
      const range = await fetch(url, { headers: { Range: 'bytes=0-15' }, cache: 'no-store' })
      const okRange = range.status === 206 && (range.headers.get('content-range') ?? '').startsWith('bytes 0-15/')
      await range.body?.cancel()
      if (!okRange) problems.push(`Range NOT honoured (status ${range.status})`)
      extra = `, Range ${okRange ? 'honoured' : 'NOT honoured'}`
    }
    console.log(`  ${problems.length ? 'FAIL    ' : 'VERIFIED'} ${url}  status ${res.status}, ${len} bytes, Cache-Control "${cc}"${extra}${problems.length ? '  — ' + problems.join('; ') : ''}`)
    if (problems.length) failed = true
  }
  process.exit(failed ? 1 : 0)
}
