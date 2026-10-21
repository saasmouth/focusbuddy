// @vitest-environment node
//
// scripts/upload-local-models.mjs publishes the on-device models. It used to
// give EVERY file, manifest.sha256 included, "public, max-age=31536000,
// immutable" (a `step.mutable` flag that nothing ever set). The manifest is the
// integrity anchor the app reads before any model byte; cached for a year, a
// wrong or replaced one would refuse every download of that version with no
// way to fix it short of a new version. Only the versioned weights may be
// immutable.
//
// This runs the real script, dry, on a fixture model folder and catalog, and
// asserts the Cache-Control it would send for each file. It also holds the
// published layout to the URLs the app downloads from.
import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { modelDownloadUrl, modelManifestUrl, MODEL_DOWNLOAD_BASE } from '../../src/shared/localAi'

const SCRIPT = join(__dirname, '../../scripts/upload-local-models.mjs')
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

let dir = ''
let catalog = ''
const models = [
  { id: 'compact', bundleId: 'tiny-chat', version: '3', file: 'tiny-chat.Q4.gguf', body: Buffer.from('chat-weights'.repeat(100)) },
  { id: 'embed', bundleId: 'tiny-embed', version: '1', file: 'tiny-embed.Q8.gguf', body: Buffer.from('embed-weights'.repeat(50)) }
]

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plexii-upload-'))
  for (const m of models) {
    const d = join(dir, m.bundleId)
    mkdirSync(d)
    writeFileSync(join(d, m.file), m.body)
    writeFileSync(join(d, 'LICENSE.txt'), `Licence for ${m.bundleId}\n`)
    writeFileSync(join(d, 'manifest.sha256'), `${sha(`Licence for ${m.bundleId}\n`)}  LICENSE.txt\n${sha(m.body)}  ${m.file}\n`)
  }
  const entry = (m: (typeof models)[number]) => ({ id: m.id, bundleId: m.bundleId, file: m.file, version: m.version, sizeBytes: m.body.length, sha256: sha(m.body) })
  catalog = join(dir, 'catalog.json')
  writeFileSync(catalog, JSON.stringify({ schema: 1, models: [entry(models[0])], embedding: entry(models[1]) }))
})

function dryRun(): { status: number | null; out: string; headers: Map<string, { cache: string; type: string }> } {
  const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--catalog', catalog], {
    encoding: 'utf8',
    // No credentials: a dry run must never need them (or reach R2).
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }
  })
  const headers = new Map<string, { cache: string; type: string }>()
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*headers\s+(\S+)\s+Cache-Control: (.+?)\s+Content-Type: (.+)$/.exec(line)
    if (m) headers.set(m[1], { cache: m[2], type: m[3] })
  }
  return { status: r.status, out: r.stdout + r.stderr, headers }
}

describe('upload-local-models.mjs cache headers (dry run)', () => {
  it('plans every file of both models', () => {
    const r = dryRun()
    expect(r.status, r.out).toBe(0)
    expect([...r.headers.keys()].sort()).toEqual(
      [
        'models/tiny-chat/3/LICENSE.txt',
        'models/tiny-chat/3/manifest.sha256',
        'models/tiny-chat/3/tiny-chat.Q4.gguf',
        'models/tiny-embed/1/LICENSE.txt',
        'models/tiny-embed/1/manifest.sha256',
        'models/tiny-embed/1/tiny-embed.Q8.gguf'
      ].sort()
    )
  })

  it('manifests are never cached as immutable: no-cache', () => {
    const r = dryRun()
    for (const [key, h] of r.headers) {
      if (!key.endsWith('manifest.sha256')) continue
      expect(h.cache, key).toBe('no-cache')
      expect(h.cache).not.toMatch(/immutable|max-age=31536000/)
    }
  })

  it('only the versioned weight files are immutable for a year', () => {
    const r = dryRun()
    for (const [key, h] of r.headers) {
      if (key.endsWith('.gguf')) expect(h.cache, key).toBe('public, max-age=31536000, immutable')
      else expect(h.cache, key).not.toMatch(/immutable/)
    }
    expect(r.headers.get('models/tiny-chat/3/LICENSE.txt')!.cache).toBe('public, max-age=3600')
  })

  it('uploads each manifest after the files it lists', () => {
    const r = dryRun()
    const keys = [...r.headers.keys()]
    for (const m of models) {
      const mf = keys.indexOf(`models/${m.bundleId}/${m.version}/manifest.sha256`)
      expect(mf).toBeGreaterThan(keys.indexOf(`models/${m.bundleId}/${m.version}/${m.file}`))
      expect(mf).toBeGreaterThan(keys.indexOf(`models/${m.bundleId}/${m.version}/LICENSE.txt`))
    }
  })

  it('publishes at exactly the URLs the app downloads from', () => {
    const r = dryRun()
    const host = MODEL_DOWNLOAD_BASE.replace(/\/models$/, '')
    for (const m of models) {
      expect(r.headers.has(modelDownloadUrl(m).slice(host.length + 1))).toBe(true)
      expect(r.headers.has(modelManifestUrl(m).slice(host.length + 1))).toBe(true)
    }
  })

  it('refuses a folder whose weights do not match the manifest (nothing is planned)', () => {
    writeFileSync(join(dir, models[1].bundleId, models[1].file), Buffer.from('tampered'))
    const r = dryRun()
    writeFileSync(join(dir, models[1].bundleId, models[1].file), models[1].body)
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/MISMATCH/)
    expect(r.headers.size).toBe(0)
  })
})
