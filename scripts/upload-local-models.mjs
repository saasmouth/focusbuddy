// Publish the on-device AI models to Plexii's download host (Cloudflare R2
// behind dl.plexiidesk.com), under models/<version>/<file>.
//
//   node scripts/upload-local-models.mjs --dir <folder holding the .gguf files>          # dry run (default)
//   node scripts/upload-local-models.mjs --dir <folder> --upload                          # really upload
//
// What it does, in order, and refuses to continue past any failure:
//   1. reads resources/local-models.json (the manifest: name, version, file,
//      size, sha256, license, source URL);
//   2. checks every file in --dir against it — exact byte size AND sha256 —
//      so a wrong or truncated file can never be published under a checksum
//      the app trusts (the app compiles the same checksums in:
//      src/shared/localModelCatalog.ts, held equal by a unit test);
//   3. uploads each model, its licence text (<file>.LICENSE.txt, as Apache-2.0
//      requires a copy to travel with the weights) and the manifest itself
//      (models/manifest.json), immutable-cached;
//   4. verifies each public URL over HTTPS: status, content-length, and that a
//      Range request is honoured (the in-app downloader resumes with Range).
//
// R2 credentials are read from .env (R2_BUCKET, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY) the same way scripts/upload-release-assets.mjs reads
// them, and are never printed. Uses the aws CLI against the R2 endpoint.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync, mkdtempSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (n) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : null
}
const DIR = opt('dir')
const UPLOAD = args.includes('--upload')
const PUBLIC_BASE = 'https://dl.plexiidesk.com'
if (!DIR) {
  console.error('usage: node scripts/upload-local-models.mjs --dir <folder with the model files> [--upload]')
  process.exit(2)
}

const manifest = JSON.parse(readFileSync(join(root, 'resources', 'local-models.json'), 'utf8'))
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
console.log(`local models: ${entries.length} file(s), ${UPLOAD ? 'UPLOAD' : 'dry run (pass --upload to publish)'}`)
for (const e of entries) {
  const p = join(DIR, e.file)
  if (!existsSync(p)) {
    console.log(`  MISSING ${e.file}`)
    failed = true
    continue
  }
  const size = statSync(p).size
  const digest = await sha256(p)
  const ok = size === e.sizeBytes && digest === e.sha256
  console.log(`  ${ok ? 'OK     ' : 'MISMATCH'} ${e.file}  ${size} bytes  sha256 ${digest}`)
  if (!ok) failed = true
  const lic = join(root, 'resources', 'local-model-licenses', e.licenseFile)
  if (!existsSync(lic)) {
    console.log(`  MISSING licence text resources/local-model-licenses/${e.licenseFile}`)
    failed = true
  }
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
const tmp = mkdtempSync(join(tmpdir(), 'local-models-'))
const manifestFile = join(tmp, 'manifest.json')
writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')

const plan = []
for (const e of entries) {
  plan.push({ src: join(DIR, e.file), key: `models/${e.version}/${e.file}`, type: 'application/octet-stream' })
  plan.push({
    src: join(root, 'resources', 'local-model-licenses', e.licenseFile),
    key: `models/${e.version}/${e.file}.LICENSE.txt`,
    type: 'text/plain; charset=utf-8'
  })
}
plan.push({ src: manifestFile, key: 'models/manifest.json', type: 'application/json', mutable: true })

for (const step of plan) {
  const cmd = [
    's3', 'cp', step.src, `s3://${bucket ?? '<R2_BUCKET>'}/${step.key}`,
    '--endpoint-url', endpoint,
    '--content-type', step.type,
    '--cache-control', step.mutable ? 'public, max-age=300' : 'public, max-age=31536000, immutable',
    '--checksum-algorithm', 'CRC32'
  ]
  if (!UPLOAD) {
    // Placeholders, not values: the account id is kept out of logs and the repo.
    const shown = cmd.map((a) =>
      a === endpoint ? 'https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com' : a.replace(`s3://${bucket}/`, 's3://$R2_BUCKET/')
    )
    console.log(`  would run: aws ${shown.join(' ')}`)
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

if (UPLOAD) {
  for (const e of entries) {
    const url = `${PUBLIC_BASE}/models/${e.version}/${e.file}`
    const head = await fetch(url, { method: 'HEAD' })
    const len = Number(head.headers.get('content-length'))
    const range = await fetch(url, { headers: { Range: 'bytes=0-15' } })
    const okRange = range.status === 206
    await range.body?.cancel()
    const ok = head.ok && len === e.sizeBytes && okRange
    console.log(`  ${ok ? 'VERIFIED' : 'FAIL    '} ${url}  status ${head.status}, ${len} bytes, Range ${okRange ? 'honoured' : 'NOT honoured'}`)
    if (!ok) failed = true
  }
  process.exit(failed ? 1 : 0)
}
