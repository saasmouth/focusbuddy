// Where an on-device model file is, in the order the app trusts them:
//
//   1. userData/models/<file> — downloaded, or moved out of an older bundle by
//      the updater (modelMigration.ts); installed = right size + a .verified
//      marker naming the catalog sha256.
//   2. <app>/Contents/Resources/models/<file> — shipped inside the signed app
//      (electron-builder extraResources, outside app.asar). Loaded IN PLACE:
//      never copied, never written to (writing into a signed .app breaks its
//      seal). Checked once, on first use, against the manifest.sha256 that
//      ships beside it (modelManifest.ts — the same file the release gate and
//      the downloader read), which must agree with the sha256 compiled into the
//      app. The result is remembered in userData (keyed by path, size and
//      mtime), not in the bundle.
//
// Pure apart from the filesystem; every path is passed in, so it is tested
// without Electron.

import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { isInstalled, sha256File } from './downloadManager'
import { readModelManifest, expectedSha } from './modelManifest'

export interface ModelSpec {
  /** Folder inside the bundle's models/ directory. */
  bundleId?: string
  file: string
  sizeBytes: number
  sha256: string
}

export interface ModelDirs {
  /** userData/models */
  userDir: string
  /** The app bundle's Resources/models, or null when the app carries none. */
  bundleDir: string | null
}

export type Located = { path: string; where: 'userData' | 'bundle' }

/** Where a model sits inside a bundle's models/ directory. */
export function bundledPath(bundleModelsDir: string, spec: ModelSpec): string {
  return spec.bundleId ? join(bundleModelsDir, spec.bundleId, spec.file) : join(bundleModelsDir, spec.file)
}

/** Find a model without hashing it (cheap; safe to call often). */
export function locateModel(spec: ModelSpec, dirs: ModelDirs): Located | null {
  if (isInstalled(dirs.userDir, spec)) return { path: join(dirs.userDir, spec.file), where: 'userData' }
  if (dirs.bundleDir) {
    const p = bundledPath(dirs.bundleDir, spec)
    try {
      if (existsSync(p) && statSync(p).size === spec.sizeBytes) return { path: p, where: 'bundle' }
    } catch {
      /* unreadable: treat as absent */
    }
  }
  return null
}

interface VerifiedCache {
  [path: string]: { size: number; mtimeMs: number; sha256: string; ok: boolean }
}

function readCache(file: string): VerifiedCache {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as VerifiedCache
  } catch {
    return {}
  }
}

/**
 * Has this bundled file been checked? Reads the manifest beside it (it must
 * exist, parse, list the file, and agree with the catalog sha256), hashes the
 * file the first time (a few seconds for 2.5 GB) and remembers the answer in
 * `cacheFile` (in userData). A changed size or mtime re-checks. `onError`
 * hears why a check failed (for the log; never the file's contents).
 */
export async function verifyLocated(
  spec: ModelSpec,
  located: Located,
  cacheFile: string,
  onError?: (why: string) => void
): Promise<boolean> {
  if (located.where === 'userData') return true // verified when it was installed
  let want: string
  try {
    const m = readModelManifest(dirname(located.path))
    if (!m) {
      onError?.(`no manifest.sha256 beside ${spec.file}`)
      return false
    }
    const e = expectedSha(m.entries, spec.file, spec.sha256)
    if (!e.ok) {
      onError?.(e.error)
      return false
    }
    want = e.sha256
  } catch (e) {
    onError?.((e as Error).message)
    return false
  }
  const st = statSync(located.path)
  const cache = readCache(cacheFile)
  const hit = cache[located.path]
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.sha256 === want) return hit.ok
  const ok = (await sha256File(located.path)) === want
  if (!ok) onError?.(`${spec.file} does not match its manifest checksum`)
  cache[located.path] = { size: st.size, mtimeMs: st.mtimeMs, sha256: want, ok }
  try {
    mkdirSync(dirname(cacheFile), { recursive: true })
    writeFileSync(cacheFile, JSON.stringify(cache, null, 2))
  } catch {
    /* the check still stands for this run */
  }
  return ok
}
