// @vitest-environment node
// The on-device model download: resumable, checksum-verified, disk-checked.
// A model is gigabytes, so each failure mode here is one a user would hit.
import { describe, it, expect, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { downloadModel, isInstalled, partPath, removeModel, fetchWithFile, type DownloadProgress } from '../../src/main/ai/local/downloadManager'
import { pathToFileURL } from 'node:url'
import { mkdirSync } from 'node:fs'

const BODY = Buffer.from('x'.repeat(50_000) + 'model-bytes-end')
const SHA = createHash('sha256').update(BODY).digest('hex')
const SPEC = { url: 'https://dl.plexiidesk.com/models/1/test.gguf', file: 'test.gguf', sizeBytes: BODY.length, sha256: SHA }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plexii-dl-'))
})

/** A fake server honouring Range, recording every request. */
function server(body: Buffer, opts: { ignoreRange?: boolean; status?: number } = {}) {
  const calls: Array<{ url: string; range: string | null }> = []
  const f = (async (url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.Range ?? null
    calls.push({ url, range })
    if (opts.status) return new Response('nope', { status: opts.status })
    if (range && !opts.ignoreRange) {
      const from = Number(/bytes=(\d+)-/.exec(range)![1])
      if (from >= body.length) return new Response(null, { status: 416 })
      return new Response(body.subarray(from), { status: 206 })
    }
    return new Response(body, { status: 200 })
  }) as unknown as typeof fetch
  return { f, calls }
}

const plenty = async (): Promise<number> => 100e9

describe('downloadModel', () => {
  it('downloads, verifies the sha256 and installs atomically', async () => {
    const s = server(BODY)
    const seen: DownloadProgress[] = []
    const r = await downloadModel(SPEC, { dir, fetch: s.f, freeBytes: plenty, onProgress: (p) => seen.push(p) })
    expect(r.ok).toBe(true)
    expect(readFileSync(join(dir, 'test.gguf')).equals(BODY)).toBe(true)
    expect(existsSync(partPath(dir, 'test.gguf'))).toBe(false)
    expect(isInstalled(dir, SPEC)).toBe(true)
    expect(seen.map((p) => p.state)).toContain('verifying')
    expect(seen.at(-1)?.state).toBe('done')
    expect(s.calls[0].range).toBeNull()
  })

  it('resumes from a partial file with an HTTP Range request', async () => {
    writeFileSync(partPath(dir, 'test.gguf'), BODY.subarray(0, 20_000))
    const s = server(BODY)
    const r = await downloadModel(SPEC, { dir, fetch: s.f, freeBytes: plenty })
    expect(r.ok).toBe(true)
    expect(s.calls[0].range).toBe('bytes=20000-')
    expect(readFileSync(join(dir, 'test.gguf')).equals(BODY)).toBe(true)
  })

  it('starts over when the server ignores Range, instead of appending a second copy', async () => {
    writeFileSync(partPath(dir, 'test.gguf'), BODY.subarray(0, 20_000))
    const s = server(BODY, { ignoreRange: true })
    const r = await downloadModel(SPEC, { dir, fetch: s.f, freeBytes: plenty })
    expect(r.ok).toBe(true)
    expect(statSync(join(dir, 'test.gguf')).size).toBe(BODY.length)
  })

  it('refuses a checksum mismatch: deletes the partial file and installs nothing', async () => {
    const tampered = Buffer.from(BODY)
    tampered[10] = 0x41
    const s = server(tampered)
    const r = await downloadModel(SPEC, { dir, fetch: s.f, freeBytes: plenty })
    expect(r).toMatchObject({ ok: false, reason: 'checksum' })
    expect(existsSync(join(dir, 'test.gguf'))).toBe(false)
    expect(existsSync(partPath(dir, 'test.gguf'))).toBe(false)
    expect(isInstalled(dir, SPEC)).toBe(false)
  })

  it('refuses up front when the disk cannot hold the rest plus the margin', async () => {
    const s = server(BODY)
    const r = await downloadModel(SPEC, { dir, fetch: s.f, freeBytes: async () => 1_000, marginBytes: 0 })
    expect(r).toMatchObject({ ok: false, reason: 'disk' })
    expect(s.calls).toHaveLength(0)
  })

  it('counts what is already downloaded when checking disk space', async () => {
    writeFileSync(partPath(dir, 'test.gguf'), BODY.subarray(0, BODY.length - 100))
    const s = server(BODY)
    // 100 bytes left to fetch, 200 free: enough.
    const r = await downloadModel(SPEC, { dir, fetch: s.f, freeBytes: async () => 200, marginBytes: 0 })
    expect(r.ok).toBe(true)
  })

  it('keeps the partial file on cancel so the next attempt resumes', async () => {
    const ctrl = new AbortController()
    const f = (async (_u: string, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(BODY.subarray(0, 10_000))
          init?.signal?.addEventListener('abort', () => c.error(new Error('aborted')))
          setTimeout(() => ctrl.abort(), 10)
        }
      })
      return new Response(stream, { status: 200 })
    }) as unknown as typeof fetch
    const r = await downloadModel(SPEC, { dir, fetch: f, freeBytes: plenty }, ctrl.signal)
    expect(r).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(statSync(partPath(dir, 'test.gguf')).size).toBe(10_000)
    const s = server(BODY)
    const r2 = await downloadModel(SPEC, { dir, fetch: s.f, freeBytes: plenty })
    expect(r2.ok).toBe(true)
    expect(s.calls[0].range).toBe('bytes=10000-')
  })

  it('reports an HTTP error and a network error honestly', async () => {
    expect(await downloadModel(SPEC, { dir, fetch: server(BODY, { status: 404 }).f, freeBytes: plenty })).toMatchObject({ ok: false, reason: 'http' })
    const boom = (async () => {
      throw new Error('ENOTFOUND')
    }) as unknown as typeof fetch
    expect(await downloadModel(SPEC, { dir, fetch: boom, freeBytes: plenty })).toMatchObject({ ok: false, reason: 'network' })
  })

  it('is not installed when the marker names a different checksum, and removeModel clears everything', async () => {
    await downloadModel(SPEC, { dir, fetch: server(BODY).f, freeBytes: plenty })
    expect(isInstalled(dir, { ...SPEC, sha256: 'f'.repeat(64) })).toBe(false)
    removeModel(dir, SPEC.file)
    expect(isInstalled(dir, SPEC)).toBe(false)
    expect(existsSync(join(dir, 'test.gguf'))).toBe(false)
  })

  it('downloads from a file:// test manifest folder, resuming with Range like HTTPS', async () => {
    const host = mkdtempSync(join(tmpdir(), 'plexii-filehost-'))
    mkdirSync(join(host, '1'))
    writeFileSync(join(host, '1', 'test.gguf'), BODY)
    const url = `${pathToFileURL(host).href}/1/test.gguf`
    const noNetwork = (async () => {
      throw new Error('network must not be used for file://')
    }) as unknown as typeof fetch
    writeFileSync(partPath(dir, 'test.gguf'), BODY.subarray(0, 12_345))
    const r = await downloadModel({ ...SPEC, url }, { dir, fetch: fetchWithFile(noNetwork), freeBytes: plenty })
    expect(r.ok).toBe(true)
    expect(readFileSync(join(dir, 'test.gguf')).equals(BODY)).toBe(true)
  })

  it('end to end from a file:// host laid out like dl.plexiidesk.com: the published manifest.sha256 is checked before the model is fetched', async () => {
    const { resolveDownloads } = await import('../../src/main/ai/local/modelManifest')
    const { modelDownloadUrl, modelManifestUrl } = await import('../../src/shared/localAi')
    const host = mkdtempSync(join(tmpdir(), 'plexii-filehost-'))
    const model = { bundleId: 'test-model', version: '1', file: 'test.gguf', sizeBytes: BODY.length, sha256: SHA }
    mkdirSync(join(host, 'test-model', '1'), { recursive: true })
    writeFileSync(join(host, 'test-model', '1', 'test.gguf'), BODY)
    writeFileSync(join(host, 'test-model', '1', 'LICENSE.txt'), 'licence')
    const lic = createHash('sha256').update('licence').digest('hex')
    const mf = join(host, 'test-model', '1', 'manifest.sha256')
    writeFileSync(mf, `${lic}  LICENSE.txt\n${SHA}  test.gguf\n`)
    const base = pathToFileURL(host).href
    const requested: string[] = []
    const noNetwork = (async (u: string) => {
      throw new Error(`network must not be used for file:// (${u})`)
    }) as unknown as typeof fetch
    const f = fetchWithFile(noNetwork)
    const spy = (async (u: RequestInfo | URL, i?: RequestInit) => {
      requested.push(String(u).slice(base.length))
      return f(u, i)
    }) as typeof fetch
    const wanted = [{ manifestUrl: modelManifestUrl(model, base), url: modelDownloadUrl(model, base), file: model.file, sizeBytes: model.sizeBytes, sha256: model.sha256 }]

    const ok = await resolveDownloads(wanted, spy)
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    const r = await downloadModel(ok.files[0], { dir, fetch: spy, freeBytes: plenty })
    expect(r.ok).toBe(true)
    expect(requested).toEqual(['/test-model/1/manifest.sha256', '/test-model/1/test.gguf'])

    // A manifest that disagrees with the checksum compiled into the app: refused, nothing fetched.
    requested.length = 0
    writeFileSync(mf, `${lic}  LICENSE.txt\n${'0'.repeat(64)}  test.gguf\n`)
    const wrong = await resolveDownloads(wanted, spy)
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.error).toMatch(/not the one this version of PlexiiDesk expects/)
    expect(requested).toEqual(['/test-model/1/manifest.sha256'])

    // Unparseable: refused, never skipped.
    writeFileSync(mf, 'this is not a manifest\n')
    const bad = await resolveDownloads(wanted, spy)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toMatch(/unparseable/)

    // Not listed: refused.
    writeFileSync(mf, `${lic}  LICENSE.txt\n`)
    const unlisted = await resolveDownloads(wanted, spy)
    expect(unlisted.ok).toBe(false)
    if (!unlisted.ok) expect(unlisted.error).toMatch(/does not list test.gguf/)

    // Missing manifest: refused with the server's answer.
    const missing = await resolveDownloads([{ ...wanted[0], manifestUrl: `${base}/nope/manifest.sha256` }], spy)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error).toMatch(/answered 404/)
  })
})
