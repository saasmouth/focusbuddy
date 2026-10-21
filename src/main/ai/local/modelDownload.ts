// The whole in-app model download, in one place and free of Electron, so the
// path a person's Download button takes can be tested against a real HTTP
// server (tests/unit/localAiDownloadServer.test.ts):
//
//   1. the URLs: <base>/<bundleId>/<version>/{<file>,manifest.sha256}, exactly
//      the layout scripts/upload-local-models.mjs publishes;
//   2. each model's published manifest is fetched FIRST and must list the file
//      with the sha256 compiled into the app (modelManifest.resolveDownloads);
//   3. the disk must hold everything still to fetch plus a margin, checked up
//      front for all files together, not discovered at 95%;
//   4. each file downloads resumably (HTTP Range from the .part file), is
//      hashed, and is installed only if it matches (downloadManager);
//   5. cancel keeps the partial file for the next attempt; a 404 or 5xx says
//      what it means (downloadManager.serverAnswerMessage).
//
// localAiService.runDownload wires this to the real fetch, the userData models
// directory and the progress broadcast.

import { existsSync, statSync } from 'node:fs'
import { downloadModel, isInstalled, partPath, type DownloadProgress } from './downloadManager'
import { resolveDownloads } from './modelManifest'
import { modelDownloadUrl, modelManifestUrl } from '@shared/localAi'

export interface WantedModel {
  bundleId: string
  version: string
  file: string
  sizeBytes: number
  sha256: string
}

export interface ModelDownloadDeps {
  /** userData/models */
  dir: string
  fetch: typeof fetch
  freeBytes: (dir: string) => Promise<number | null>
  onProgress?: (p: DownloadProgress) => void
  /** The download host; default MODEL_DOWNLOAD_BASE (dl.plexiidesk.com/models). */
  base?: string
  /** Free space to leave after everything is downloaded. Default 1 GiB. */
  marginBytes?: number
}

export type ModelDownloadResult =
  | { ok: true; installed: string[] }
  | { ok: false; reason: 'cancelled' | 'checksum' | 'disk' | 'http' | 'network' | 'manifest'; error: string }

const GiB = 1024 ** 3
const fmtGB = (n: number): string => `${(n / 1e9).toFixed(1)} GB`

/** Bytes still to fetch for a model, counting a partial download already on disk. */
function remaining(dir: string, m: WantedModel): number {
  if (isInstalled(dir, m)) return 0
  const part = partPath(dir, m.file)
  const have = existsSync(part) ? Math.min(statSync(part).size, m.sizeBytes) : 0
  return m.sizeBytes - have
}

export async function downloadModels(wanted: WantedModel[], deps: ModelDownloadDeps, signal?: AbortSignal): Promise<ModelDownloadResult> {
  const todo = wanted.filter((m) => !isInstalled(deps.dir, m))
  if (todo.length === 0) return { ok: true, installed: [] }

  const resolved = await resolveDownloads(
    todo.map((m) => ({
      manifestUrl: modelManifestUrl(m, deps.base),
      url: modelDownloadUrl(m, deps.base),
      file: m.file,
      sizeBytes: m.sizeBytes,
      sha256: m.sha256
    })),
    deps.fetch,
    signal
  )
  if (!resolved.ok) {
    const cancelled = signal?.aborted === true
    deps.onProgress?.({ file: todo[0].file, state: cancelled ? 'cancelled' : 'error', receivedBytes: 0, totalBytes: todo[0].sizeBytes, error: cancelled ? null : resolved.error })
    return { ok: false, reason: cancelled ? 'cancelled' : 'manifest', error: resolved.error }
  }

  // All of it must fit, before the first byte: a 2.5 GB model that fills the
  // disk at 95% helps nobody.
  const margin = deps.marginBytes ?? GiB
  const need = todo.reduce((n, m) => n + remaining(deps.dir, m), 0)
  const free = await deps.freeBytes(deps.dir)
  if (free !== null && free < need + margin) {
    const error = `Not enough free disk space: the download needs ${fmtGB(need)} plus ${fmtGB(margin)} to spare, and ${fmtGB(free)} is free. Free some space and try again; nothing was changed.`
    deps.onProgress?.({ file: todo[0].file, state: 'error', receivedBytes: 0, totalBytes: todo[0].sizeBytes, error })
    return { ok: false, reason: 'disk', error }
  }

  const installed: string[] = []
  for (const spec of resolved.files) {
    const r = await downloadModel(spec, { dir: deps.dir, fetch: deps.fetch, freeBytes: deps.freeBytes, onProgress: deps.onProgress, marginBytes: margin }, signal)
    if (!r.ok) return { ok: false, reason: r.reason, error: r.error }
    installed.push(spec.file)
  }
  return { ok: true, installed }
}
