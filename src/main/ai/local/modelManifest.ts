// The model manifest: ONE format, end to end.
//
// Every on-device model lives in a directory of its own, and that directory
// carries a manifest of every file in it with its SHA-256:
//
//   resources/models/<bundleId>/manifest.sha256         (build input, staged by
//                                                         scripts/fetch-bundled-models.mjs)
//   <app>/Contents/Resources/models/<bundleId>/manifest.sha256   (shipped)
//   <download base>/<bundleId>/<version>/manifest.sha256          (the download host)
//
// The same file is read by the release gate (scripts/verify-model-split.mjs),
// by the app on first use of a bundled model (modelLocator.verifyLocated), and
// by the downloader before it trusts a download (localAiService.runDownload).
//
// Accepted shapes, exactly as the release gate accepts them:
//   shasum   "<sha256>  <path>" per line — what `shasum -a 256 <files>` writes
//            ("*" binary marker allowed, blank lines and # comments ignored)
//   JSON     {"files": {"<path>": "<sha256>"}} (or a bare {"<path>": "<sha256>"})
//            as manifest.json or model.manifest.json
// Paths are relative to the manifest's own directory. A manifest that exists
// and does not parse, or lists nothing, is an error — never a skip.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serverAnswerMessage } from './downloadManager'

export const MANIFEST_NAMES = ['manifest.sha256', 'manifest.json', 'model.manifest.json'] as const

export type ManifestEntries = Record<string, string>

export class ManifestError extends Error {}

/** Parse a manifest's text. `name` decides the shape (.json → JSON). Throws ManifestError. */
export function parseModelManifest(text: string, name: string): ManifestEntries {
  const out: ManifestEntries = {}
  if (name.endsWith('.json')) {
    let j: unknown
    try {
      j = JSON.parse(text)
    } catch (e) {
      throw new ManifestError(`${name} is not valid JSON (${(e as Error).message})`)
    }
    const o = j as { files?: unknown } | null
    const map = o && typeof o === 'object' && o.files && typeof o.files === 'object' ? o.files : o
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new ManifestError(`${name} has no object of path → sha256`)
    for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
      if (typeof v !== 'string' || !/^[0-9a-f]{64}$/i.test(v)) throw new ManifestError(`${name}: bad sha256 for ${k}`)
      out[normalise(k)] = v.toLowerCase()
    }
  } else {
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(t)
      if (!m) throw new ManifestError(`${name}: unparseable line "${t.slice(0, 60)}"`)
      out[normalise(m[2].trim())] = m[1].toLowerCase()
    }
  }
  if (!Object.keys(out).length) throw new ManifestError(`${name} lists no files`)
  return out
}

function normalise(p: string): string {
  return p.replace(/^\.\//, '')
}

/** The shasum-format text for these entries (sorted, two spaces, trailing newline). */
export function formatModelManifest(entries: ManifestEntries): string {
  return (
    Object.keys(entries)
      .sort()
      .map((p) => `${entries[p]}  ${p}`)
      .join('\n') + '\n'
  )
}

/**
 * Read the manifest in a model directory. Null when the directory has none;
 * throws ManifestError when one exists and is unusable.
 */
export function readModelManifest(dir: string): { name: string; entries: ManifestEntries } | null {
  for (const name of MANIFEST_NAMES) {
    const p = join(dir, name)
    if (existsSync(p)) return { name, entries: parseModelManifest(readFileSync(p, 'utf8'), name) }
  }
  return null
}

/**
 * The sha256 a manifest gives for `file`, checked against the value compiled
 * into the app (the catalog pin). A manifest that disagrees with the pin is
 * not trusted: that is a wrong model, or a wrong manifest, and either way the
 * file must not be loaded.
 */
export function expectedSha(entries: ManifestEntries, file: string, pinned: string): { ok: true; sha256: string } | { ok: false; error: string } {
  const sha = entries[file]
  if (!sha) return { ok: false, error: `the model manifest does not list ${file}` }
  if (sha !== pinned.toLowerCase()) return { ok: false, error: `the model manifest's checksum for ${file} is not the one this version of PlexiiDesk expects` }
  return { ok: true, sha256: sha }
}

export interface DownloadWanted {
  /** Where the published manifest is (…/<bundleId>/<version>/manifest.sha256). */
  manifestUrl: string
  url: string
  file: string
  sizeBytes: number
  /** The sha256 compiled into the app (the pin). */
  sha256: string
}

/**
 * Before any model byte is fetched: read each model's published manifest — the
 * same file that ships beside the bundled model — and require that it parses,
 * lists the model, and agrees with the pin. Returns what to download, each
 * with the sha256 the downloader must then see.
 */
export async function resolveDownloads(
  wanted: DownloadWanted[],
  doFetch: typeof fetch,
  signal?: AbortSignal
): Promise<{ ok: true; files: Array<{ url: string; file: string; sizeBytes: number; sha256: string }> } | { ok: false; error: string }> {
  const files: Array<{ url: string; file: string; sizeBytes: number; sha256: string }> = []
  for (const m of wanted) {
    let text: string
    try {
      const res = await doFetch(m.manifestUrl, { signal })
      if (!res.ok) return { ok: false, error: serverAnswerMessage(res.status, 'checksum list') }
      text = await res.text()
    } catch (e) {
      if (signal?.aborted) return { ok: false, error: 'Download cancelled.' }
      return { ok: false, error: `Could not reach the download server: ${(e as Error).message}` }
    }
    try {
      const e = expectedSha(parseModelManifest(text, 'manifest.sha256'), m.file, m.sha256)
      if (!e.ok) return { ok: false, error: `The download was refused: ${e.error}.` }
      files.push({ url: m.url, file: m.file, sizeBytes: m.sizeBytes, sha256: e.sha256 })
    } catch (e) {
      return { ok: false, error: `The download was refused: ${(e as Error).message}.` }
    }
  }
  return { ok: true, files }
}
