// @vitest-environment node
//
// The in-app model download, end to end over real HTTP: the same code the
// Download button runs (modelDownload.downloadModels → modelManifest +
// downloadManager), with the real fetch, against a local server laid out like
// dl.plexiidesk.com/models and serving a tiny fixture model with its manifest.
//
//   URL format, manifest first; full download and install; resume after an
//   interrupted transfer (Range); the sha256 checked against the manifest and
//   the pin; low disk refused before any model byte; cancel keeps the partial
//   file and the next attempt resumes; a 404 or 5xx says what it means.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { downloadModels, type WantedModel } from '../../src/main/ai/local/modelDownload'
import { isInstalled, partPath, type DownloadProgress } from '../../src/main/ai/local/downloadManager'

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

// Two models, like a tier plus the embedding model.
const CHAT = Buffer.alloc(300_000, 0)
for (let i = 0; i < CHAT.length; i++) CHAT[i] = (i * 7) % 251
const EMBED = Buffer.from('embed-'.repeat(5_000))
const CHAT_M: WantedModel = { bundleId: 'tiny-chat', version: '2', file: 'tiny-chat.gguf', sizeBytes: CHAT.length, sha256: sha(CHAT) }
const EMBED_M: WantedModel = { bundleId: 'tiny-embed', version: '1', file: 'tiny-embed.gguf', sizeBytes: EMBED.length, sha256: sha(EMBED) }

interface Behaviour {
  /** Status to answer for a path (e.g. 404 for a manifest). */
  status?: Record<string, number>
  /** Close the connection after this many body bytes, once. */
  cutAfter?: number
  /** Serve these bytes instead of the real file (a corrupted upload). */
  replace?: Record<string, Buffer>
  /** Manifest text to serve instead of the real one. */
  manifest?: Record<string, string>
  /** Slow streaming: chunk size and delay between chunks. */
  slow?: { chunk: number; ms: number }
}

let server: http.Server
let BASE = ''
let behaviour: Behaviour = {}
const requests: Array<{ path: string; range: string | null }> = []

const files: Record<string, Buffer> = {
  '/models/tiny-chat/2/tiny-chat.gguf': CHAT,
  '/models/tiny-chat/2/manifest.sha256': Buffer.from(`${sha('lic')}  LICENSE.txt\n${sha(CHAT)}  tiny-chat.gguf\n`),
  '/models/tiny-embed/1/tiny-embed.gguf': EMBED,
  '/models/tiny-embed/1/manifest.sha256': Buffer.from(`${sha(EMBED)}  tiny-embed.gguf\n`)
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? '/'
    const range = (req.headers.range as string | undefined) ?? null
    requests.push({ path, range })
    const forced = behaviour.status?.[path]
    if (forced) {
      res.writeHead(forced, { 'content-type': 'text/plain' })
      res.end('nope')
      return
    }
    let body = behaviour.replace?.[path] ?? (behaviour.manifest?.[path] !== undefined ? Buffer.from(behaviour.manifest[path]) : files[path])
    if (!body) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    let status = 200
    const headers: Record<string, string> = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' }
    if (range) {
      const from = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0)
      if (from >= body.length) {
        res.writeHead(416, { 'content-range': `bytes */${body.length}` })
        res.end()
        return
      }
      headers['content-range'] = `bytes ${from}-${body.length - 1}/${body.length}`
      body = body.subarray(from)
      status = 206
    }
    headers['content-length'] = String(body.length)
    res.writeHead(status, headers)
    const cut = behaviour.cutAfter
    if (cut !== undefined && path.endsWith('.gguf')) {
      behaviour.cutAfter = undefined
      res.write(body.subarray(0, cut), () => setTimeout(() => res.destroy(), 20))
      return
    }
    if (behaviour.slow && path.endsWith('.gguf')) {
      const { chunk, ms } = behaviour.slow
      let at = 0
      const tick = (): void => {
        if (res.destroyed) return
        if (at >= body.length) return void res.end()
        res.write(body.subarray(at, at + chunk))
        at += chunk
        setTimeout(tick, ms)
      }
      tick()
      return
    }
    res.end(body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}/models`
})
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plexii-dlsrv-'))
  behaviour = {}
  requests.length = 0
})

const plenty = async (): Promise<number> => 100e9
const realFetch: typeof fetch = (i, n) => globalThis.fetch(i, n)
const deps = (over: Partial<Parameters<typeof downloadModels>[1]> = {}) => ({ dir, fetch: realFetch, freeBytes: plenty, base: BASE, marginBytes: 0, ...over })

describe('the in-app model download against a real HTTP server', () => {
  it('fetches <base>/<bundleId>/<version>/manifest.sha256 first, then the file, and installs both models verified', async () => {
    const seen: DownloadProgress[] = []
    const r = await downloadModels([CHAT_M, EMBED_M], deps({ onProgress: (p) => seen.push(p) }))
    expect(r).toEqual({ ok: true, installed: ['tiny-chat.gguf', 'tiny-embed.gguf'] })
    expect(requests.map((q) => q.path)).toEqual([
      '/models/tiny-chat/2/manifest.sha256',
      '/models/tiny-embed/1/manifest.sha256',
      '/models/tiny-chat/2/tiny-chat.gguf',
      '/models/tiny-embed/1/tiny-embed.gguf'
    ])
    expect(readFileSync(join(dir, 'tiny-chat.gguf')).equals(CHAT)).toBe(true)
    expect(isInstalled(dir, CHAT_M)).toBe(true)
    expect(isInstalled(dir, EMBED_M)).toBe(true)
    expect(seen.some((p) => p.state === 'verifying')).toBe(true)
    // Already installed: nothing is fetched again.
    requests.length = 0
    expect(await downloadModels([CHAT_M, EMBED_M], deps())).toEqual({ ok: true, installed: [] })
    expect(requests).toEqual([])
  })

  it('an interrupted transfer keeps its bytes, and the next attempt resumes with a Range request', async () => {
    behaviour.cutAfter = 120_000
    const first = await downloadModels([CHAT_M], deps())
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.reason).toBe('network')
    const kept = statSync(partPath(dir, CHAT_M.file)).size
    expect(kept).toBeGreaterThan(0)
    expect(kept).toBeLessThan(CHAT.length)
    requests.length = 0
    const second = await downloadModels([CHAT_M], deps())
    expect(second.ok).toBe(true)
    const model = requests.find((q) => q.path.endsWith('.gguf'))!
    expect(model.range).toBe(`bytes=${kept}-`)
    expect(readFileSync(join(dir, CHAT_M.file)).equals(CHAT)).toBe(true)
  })

  it('a manifest that does not agree with the checksum built into the app: refused before any model byte', async () => {
    behaviour.manifest = { '/models/tiny-chat/2/manifest.sha256': `${sha('something else')}  tiny-chat.gguf\n` }
    const r = await downloadModels([CHAT_M], deps())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('manifest')
      expect(r.error).toMatch(/not the one this version of PlexiiDesk expects/)
    }
    expect(requests.some((q) => q.path.endsWith('.gguf'))).toBe(false)
  })

  it('a served file that does not match its sha256 is deleted, not installed', async () => {
    const bad = Buffer.from(CHAT)
    bad[1000] ^= 0xff
    behaviour.replace = { '/models/tiny-chat/2/tiny-chat.gguf': bad }
    const r = await downloadModels([CHAT_M], deps())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('checksum')
    expect(existsSync(join(dir, CHAT_M.file))).toBe(false)
    expect(existsSync(partPath(dir, CHAT_M.file))).toBe(false)
    expect(isInstalled(dir, CHAT_M)).toBe(false)
  })

  it('low disk: refused up front for everything still to fetch together, before any model byte', async () => {
    // Room for either model alone, not for both: checked one at a time, the
    // first would download and the second fail with the disk full.
    const free = CHAT.length + 1000
    const r = await downloadModels([CHAT_M, EMBED_M], deps({ freeBytes: async () => free }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('disk')
      expect(r.error).toMatch(/Not enough free disk space/)
      expect(r.error).toMatch(/nothing was changed/)
    }
    expect(requests.some((q) => q.path.endsWith('.gguf'))).toBe(false)
  })

  it('cancel stops the transfer, keeps the partial file, and the next attempt resumes', async () => {
    behaviour.slow = { chunk: 16_384, ms: 15 }
    const ctrl = new AbortController()
    let aborted = false
    const r = await downloadModels(
      [CHAT_M],
      deps({
        onProgress: (p) => {
          if (!aborted && p.state === 'downloading' && p.receivedBytes > 30_000) {
            aborted = true
            ctrl.abort()
          }
        }
      }),
      ctrl.signal
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('cancelled')
    const kept = existsSync(partPath(dir, CHAT_M.file)) ? statSync(partPath(dir, CHAT_M.file)).size : 0
    expect(kept).toBeGreaterThan(0)
    behaviour.slow = undefined
    requests.length = 0
    expect((await downloadModels([CHAT_M], deps())).ok).toBe(true)
    expect(requests.find((q) => q.path.endsWith('.gguf'))!.range).toBe(`bytes=${kept}-`)
  })

  it('a 404 for the checksum list says the server does not have it, and that nothing changed', async () => {
    behaviour.status = { '/models/tiny-chat/2/manifest.sha256': 404 }
    const r = await downloadModels([CHAT_M], deps())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/does not have this model's checksum list \(it answered 404\)/)
      expect(r.error).toMatch(/nothing was downloaded/)
    }
  })

  it('a 5xx for the model says the server is having trouble and that the download resumes', async () => {
    behaviour.status = { '/models/tiny-chat/2/tiny-chat.gguf': 503 }
    const r = await downloadModels([CHAT_M], deps())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('http')
      expect(r.error).toMatch(/having trouble \(it answered 503\)/)
      expect(r.error).toMatch(/resumes/)
    }
  })

  it('a server that cannot be reached says so', async () => {
    const r = await downloadModels([CHAT_M], deps({ base: 'http://127.0.0.1:9/models' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Could not reach the download server/)
  })

  it('the leftover partial file from an older attempt larger than the model is discarded, not appended to', async () => {
    writeFileSync(partPath(dir, CHAT_M.file), Buffer.alloc(CHAT.length + 10))
    const r = await downloadModels([CHAT_M], deps())
    expect(r.ok).toBe(true)
    expect(readFileSync(join(dir, CHAT_M.file)).equals(CHAT)).toBe(true)
  })
})
