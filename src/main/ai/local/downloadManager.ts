// Downloads an on-device model file from Plexii's own host
// (dl.plexiidesk.com/models/…), resumably, and installs it only once its
// SHA-256 matches the value compiled into the signed app.
//
//   <dir>/<file>.part      bytes received so far (kept on cancel, so the next
//                          attempt resumes with an HTTP Range request)
//   <dir>/<file>           the verified model, renamed into place atomically
//   <dir>/<file>.verified  the sha256 it was verified against, so start-up
//                          does not re-hash gigabytes to know it is installed
//
// Refuses up front when the disk cannot hold what is left to download plus a
// safety margin, rather than filling the disk and failing at 95%. A checksum
// mismatch deletes the partial file (it cannot be trusted to resume from) and
// says so. Nothing here is Electron-specific; fetch and the free-space probe
// are injected so tests can drive every path.

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface DownloadSpec {
  url: string
  file: string
  sizeBytes: number
  sha256: string
}

export type DownloadPhase = 'checking' | 'downloading' | 'verifying' | 'done' | 'cancelled' | 'error'

export interface DownloadProgress {
  file: string
  state: DownloadPhase
  receivedBytes: number
  totalBytes: number
  error: string | null
}

export type DownloadResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'cancelled' | 'checksum' | 'disk' | 'http' | 'network'; error: string }

export interface DownloadDeps {
  dir: string
  fetch: typeof fetch
  /** Bytes free on the volume holding dir, or null if unknown. */
  freeBytes: (dir: string) => Promise<number | null>
  onProgress?: (p: DownloadProgress) => void
  /** Free space to leave on the disk after the download. Default 1 GiB. */
  marginBytes?: number
}

const GiB = 1024 ** 3

export function partPath(dir: string, file: string): string {
  return join(dir, `${file}.part`)
}
export function finalPath(dir: string, file: string): string {
  return join(dir, file)
}
function markerPath(dir: string, file: string): string {
  return join(dir, `${file}.verified`)
}

/** Installed = the file exists at the right size AND was verified against this sha256. */
export function isInstalled(dir: string, spec: Pick<DownloadSpec, 'file' | 'sizeBytes' | 'sha256'>): boolean {
  const f = finalPath(dir, spec.file)
  try {
    if (!existsSync(f) || statSync(f).size !== spec.sizeBytes) return false
    return readFileSync(markerPath(dir, spec.file), 'utf8').trim() === spec.sha256
  } catch {
    return false
  }
}

/**
 * fetch() for file:// URLs (a local test manifest), honouring Range so resume
 * works the same as over HTTPS. Everything else goes to the real fetch.
 */
export function fetchWithFile(base: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith('file:')) return base(input, init)
    const path = decodeURIComponent(new URL(url).pathname)
    if (!existsSync(path)) return new Response('not found', { status: 404 })
    const size = statSync(path).size
    const range = new Headers(init?.headers as HeadersInit | undefined).get('range')
    const from = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0
    if (from >= size && range) return new Response(null, { status: 416 })
    const { Readable } = await import('node:stream')
    const stream = Readable.toWeb(createReadStream(path, { start: from })) as unknown as ReadableStream<Uint8Array>
    return new Response(stream, { status: range ? 206 : 200, headers: { 'content-length': String(size - from) } })
  }) as typeof fetch
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve())
      .on('error', reject)
  })
  return h.digest('hex')
}

function fmtGB(n: number): string {
  return `${(n / 1e9).toFixed(1)} GB`
}

/** Remove the model, its partial download and its marker. */
export function removeModel(dir: string, file: string): void {
  for (const p of [finalPath(dir, file), partPath(dir, file), markerPath(dir, file)]) {
    try {
      if (existsSync(p)) unlinkSync(p)
    } catch {
      /* best effort; a leftover file is reported by the next status read */
    }
  }
}

export async function downloadModel(spec: DownloadSpec, deps: DownloadDeps, signal?: AbortSignal): Promise<DownloadResult> {
  const { dir } = deps
  mkdirSync(dir, { recursive: true })
  const progress = (state: DownloadPhase, received: number, error: string | null = null): void =>
    deps.onProgress?.({ file: spec.file, state, receivedBytes: received, totalBytes: spec.sizeBytes, error })
  const fail = (reason: Exclude<DownloadResult, { ok: true }>['reason'], error: string, received = 0): DownloadResult => {
    progress(reason === 'cancelled' ? 'cancelled' : 'error', received, reason === 'cancelled' ? null : error)
    return { ok: false, reason, error }
  }

  if (isInstalled(dir, spec)) {
    progress('done', spec.sizeBytes)
    return { ok: true, path: finalPath(dir, spec.file) }
  }

  progress('checking', 0)
  const part = partPath(dir, spec.file)
  let have = existsSync(part) ? statSync(part).size : 0
  if (have > spec.sizeBytes) {
    unlinkSync(part)
    have = 0
  }

  const need = spec.sizeBytes - have + (deps.marginBytes ?? GiB)
  const free = await deps.freeBytes(dir)
  if (free !== null && free < need) {
    return fail(
      'disk',
      `Not enough free disk space: the model needs ${fmtGB(spec.sizeBytes - have)} more plus ${fmtGB(deps.marginBytes ?? GiB)} to spare, and ${fmtGB(free)} is free.`,
      have
    )
  }

  if (have < spec.sizeBytes) {
    let res: Response
    try {
      res = await deps.fetch(spec.url, {
        headers: have > 0 ? { Range: `bytes=${have}-` } : {},
        signal
      })
    } catch (e) {
      if (signal?.aborted) return fail('cancelled', 'Download cancelled.', have)
      return fail('network', `Could not reach the download server: ${(e as Error).message}`, have)
    }
    if (res.status === 200 && have > 0) {
      // The server ignored the Range header: start over rather than append a
      // second copy onto the partial file.
      unlinkSync(part)
      have = 0
    } else if (res.status === 416 && have > 0) {
      // Nothing left to send; fall through to verification.
    } else if (res.status !== 200 && res.status !== 206) {
      return fail('http', `The download server answered ${res.status}.`, have)
    }
    if (res.status !== 416) {
      if (!res.body) return fail('http', 'The download server sent no data.', have)
      const out = createWriteStream(part, { flags: have > 0 ? 'a' : 'w' })
      let received = have
      let lastReport = 0
      try {
        const reader = res.body.getReader()
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
          received += value.byteLength
          if (received > spec.sizeBytes) {
            await new Promise<void>((r) => out.end(() => r()))
            unlinkSync(part)
            return fail('http', 'The server sent more data than the model should contain; the partial file was discarded.', 0)
          }
          const now = Date.now()
          if (now - lastReport > 250) {
            lastReport = now
            progress('downloading', received)
          }
        }
      } catch (e) {
        await new Promise<void>((r) => out.end(() => r()))
        if (signal?.aborted) return fail('cancelled', 'Download cancelled.', received)
        return fail('network', `The download was interrupted: ${(e as Error).message}. It will resume from ${fmtGB(received)}.`, received)
      }
      await new Promise<void>((r, j) => out.end((err?: Error | null) => (err ? j(err) : r())))
      have = received
      progress('downloading', received)
    }
  }

  if (have !== spec.sizeBytes) {
    return fail('network', `The download stopped at ${fmtGB(have)} of ${fmtGB(spec.sizeBytes)}. Try again to resume.`, have)
  }

  progress('verifying', have)
  const digest = await sha256File(part)
  if (digest !== spec.sha256) {
    unlinkSync(part)
    return fail(
      'checksum',
      'The downloaded file did not match its published checksum, so it was deleted and not installed. Try the download again.',
      0
    )
  }
  const final = finalPath(dir, spec.file)
  renameSync(part, final)
  writeFileSync(markerPath(dir, spec.file), spec.sha256 + '\n')
  progress('done', spec.sizeBytes)
  return { ok: true, path: final }
}
