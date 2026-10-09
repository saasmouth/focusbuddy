#!/usr/bin/env node
// Generate the persona demo images with the same provider the app's own image
// generator uses (OpenAI images, see src/main/imageGen.ts), and keep them small
// enough to live inline on a desk.
//
// Every image is an AI illustration and is titled as one on the desk. Files are
// named by lib.imageFile — persona, desk, slot and a hash of model + aspect +
// prompt — so re-running only generates what is new or changed; nothing already
// paid for is generated twice. Each image gets a sidecar <file>.json recording
// what produced it; images/manifest.json is rebuilt from the sidecars, so several
// runs at once (one per persona) never overwrite each other's records.
//
// Usage
//   node scripts/persona-demos/generate-images.cjs [personas/NN-x.json …]   generate missing images
//   --dry-run   list what would be generated, call nothing
//   --prune     delete image files no spec refers to any more (always judged
//               against every spec, whatever files are named)
//   --redo <file.jpg>   regenerate one file (e.g. after a review rejected it)
//
// Reads OPENAI_API_KEY from the environment or from projects/focusbuddy/.env. The
// key is never printed.

const fs = require('node:fs')
const { join, basename } = require('node:path')
const { execFileSync } = require('node:child_process')
const { tmpdir } = require('node:os')
const lib = require('./lib.cjs')
const { loadSpecs, IMAGE_DIR } = require('./seed.cjs')

const args = process.argv.slice(2)
const flag = (f) => args.includes(f)
const opt = (f) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}

// Constant guidance appended to every prompt: the desks are sample data, so the
// pictures must not carry a real brand, a legible (and inevitably garbled) word,
// or a face that reads as a specific real person.
const PROMPT_SUFFIX =
  ' No text, no lettering, no numbers, no logos, no brand names, no watermarks. If people appear they are anonymous and not looking at the camera.'
const CONCURRENCY = 4
// A data: URL of the file must stay under lib.MAX_IMAGE_DATA_URL (base64 is 4/3).
const MAX_BYTES = Math.floor((lib.MAX_IMAGE_DATA_URL - 64) * 0.75)
const LONG_EDGE = 1280

function apiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim()
  const env = join(__dirname, '..', '..', '.env')
  if (fs.existsSync(env)) {
    const m = /^OPENAI_API_KEY=(.*)$/m.exec(fs.readFileSync(env, 'utf8'))
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, '')
  }
  throw new Error('OPENAI_API_KEY not set and not found in projects/focusbuddy/.env')
}

function wanted(specs) {
  const out = []
  for (const s of specs)
    s.desks.forEach((d, di) =>
      (d.images ?? []).forEach((im, ii) =>
        out.push({ file: lib.imageFile(s, di, ii, im), persona: s.persona, desk: d.title, title: im.title, prompt: im.prompt, aspect: im.aspect })
      )
    )
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function generate(key, job) {
  const body = {
    model: lib.IMAGE_MODEL,
    prompt: `${job.prompt}${PROMPT_SUFFIX}`,
    size: lib.IMAGE_ASPECTS[job.aspect].size,
    quality: 'medium',
    output_format: 'jpeg',
    n: 1
  }
  for (let attempt = 1; ; attempt++) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 240_000)
    try {
      const res = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal
      })
      const json = await res.json().catch(() => ({}))
      if (res.ok && json.data?.[0]?.b64_json) return Buffer.from(json.data[0].b64_json, 'base64')
      const msg = json.error?.message ?? `HTTP ${res.status}`
      // A refused prompt will be refused again; surface it for a rewrite.
      if (res.status === 400) throw Object.assign(new Error(msg), { fatal: true })
      if (attempt >= 5) throw new Error(msg)
      await sleep(Math.min(60_000, 4000 * 2 ** (attempt - 1)))
    } catch (e) {
      if (e.fatal || attempt >= 5) throw e
      await sleep(Math.min(60_000, 4000 * 2 ** (attempt - 1)))
    } finally {
      clearTimeout(timer)
    }
  }
}

// Downscale to LONG_EDGE and step the JPEG quality down until it fits. sips ships
// with macOS, so this needs no image library.
function compress(raw, out) {
  const tmp = join(fs.mkdtempSync(join(tmpdir(), 'persona-img-')), 'raw.jpg')
  fs.writeFileSync(tmp, raw)
  for (const q of [80, 74, 68, 62, 56, 50, 44]) {
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(q), '-Z', String(LONG_EDGE), tmp, '--out', out], { stdio: 'ignore' })
    if (fs.statSync(out).size <= MAX_BYTES) return q
  }
  throw new Error(`${basename(out)} is still over ${MAX_BYTES} bytes at quality 44`)
}

// manifest.json = every sidecar, keyed by image file. Derived, so it can always
// be rebuilt; a concurrent run can only make it momentarily stale, never lossy.
function writeManifest() {
  const manifest = {}
  for (const f of fs.readdirSync(IMAGE_DIR).filter((f) => f.endsWith('.jpg.json')).sort())
    manifest[f.slice(0, -5)] = JSON.parse(fs.readFileSync(join(IMAGE_DIR, f), 'utf8'))
  fs.writeFileSync(join(IMAGE_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
}

async function main() {
  const files = args.filter((a) => a.endsWith('.json'))
  const { specs, errors } = loadSpecs(files)
  // Image generation needs only well-formed images; other spec problems are
  // reported by --check and must not block it.
  const imageErrors = errors.filter((e) => /\.images/.test(e))
  if (imageErrors.length) {
    console.error(`✗ image spec problems:\n  ${imageErrors.join('\n  ')}`)
    process.exit(1)
  }
  fs.mkdirSync(IMAGE_DIR, { recursive: true })

  if (flag('--prune')) {
    // Judged against EVERY spec: pruning with one persona's file named must not
    // delete the other personas' pictures.
    const keep = new Set(wanted(loadSpecs([]).specs).map((j) => j.file))
    let n = 0
    for (const f of fs.readdirSync(IMAGE_DIR)) {
      const img = f.endsWith('.jpg.json') ? f.slice(0, -5) : f
      if ((f.endsWith('.jpg') || f.endsWith('.jpg.json')) && !keep.has(img)) {
        fs.unlinkSync(join(IMAGE_DIR, f))
        if (f.endsWith('.jpg')) n++
      }
    }
    writeManifest()
    console.log(`pruned ${n} unreferenced image(s)`)
    return
  }

  const redo = opt('--redo')
  if (redo) for (const f of [redo, `${redo}.json`]) if (fs.existsSync(join(IMAGE_DIR, f))) fs.unlinkSync(join(IMAGE_DIR, f))
  const todo = wanted(specs).filter((j) => !fs.existsSync(join(IMAGE_DIR, j.file)))
  console.log(`${todo.length} image(s) to generate (${wanted(specs).length - todo.length} already present)`)
  if (flag('--dry-run') || todo.length === 0) {
    for (const j of todo) console.log(`  ${j.file}  ${j.aspect}  ${j.title}`)
    return
  }

  const key = apiKey()
  const failures = []
  let next = 0
  async function worker() {
    while (next < todo.length) {
      const job = todo[next++]
      const started = Date.now()
      try {
        const raw = await generate(key, job)
        const out = join(IMAGE_DIR, job.file)
        const quality = compress(raw, out)
        const record = {
          persona: job.persona,
          desk: job.desk,
          title: job.title,
          aspect: job.aspect,
          model: lib.IMAGE_MODEL,
          prompt: job.prompt,
          promptSuffix: PROMPT_SUFFIX,
          jpegQuality: quality,
          bytes: fs.statSync(out).size,
          generatedAt: new Date().toISOString()
        }
        fs.writeFileSync(`${out}.json`, JSON.stringify(record, null, 2) + '\n')
        console.log(`  ✓ ${job.file}  ${Math.round((Date.now() - started) / 1000)}s  ${fs.statSync(out).size} B  q${quality}`)
      } catch (e) {
        failures.push(`${job.file}: ${e.message}`)
        console.log(`  ✗ ${job.file}: ${e.message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker))
  writeManifest()
  if (failures.length) {
    console.error(`✗ ${failures.length} failed:\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`✓ generated ${todo.length}`)
}

main().catch((e) => {
  console.error(`✗ ${e.message}`)
  process.exit(1)
})
