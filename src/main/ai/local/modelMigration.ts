// Before the Mac updater swaps the app bundle, keep the on-device model.
//
// Fresh installs carry the model inside the .app (Resources/models). Update
// zips do not — 2.5 GB in every update would be absurd — so a swap would throw
// the model away with the old bundle. This runs first: any catalog model the
// old bundle carries, that userData does not already hold verified and that the
// new bundle does not carry, is copied into userData/models and checked against
// its sha256. Only then may the swap go ahead. If the copy cannot be made
// (disk, checksum, I/O), the update is aborted rather than lose the model.
//
// Copy, not move: the old bundle is signed and is about to be replaced anyway;
// moving out of it would break its seal if the update were then cancelled. The
// disk briefly holds two copies and returns to one when the swap removes the old
// bundle.

import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isInstalled, sha256File } from './downloadManager'
import { bundledPath, type ModelSpec } from './modelLocator'

export interface MigrationDeps {
  /** userData/models */
  userDir: string
  /** Resources/models of the RUNNING (old) bundle. */
  oldBundleDir: string
  /** Resources/models of the downloaded (new) bundle. */
  newBundleDir: string
  freeBytes: (dir: string) => Promise<number | null>
  /** Free space to leave after copying. Default 1 GiB. */
  marginBytes?: number
  copy?: (from: string, to: string) => void
}

export type MigrationResult =
  | { ok: true; copied: string[]; skipped: string[] }
  | { ok: false; error: string; file: string }

const GiB = 1024 ** 3

function sizeIs(path: string, size: number): boolean {
  try {
    return existsSync(path) && statSync(path).size === size
  } catch {
    return false
  }
}

export async function preserveBundledModels(specs: ModelSpec[], deps: MigrationDeps): Promise<MigrationResult> {
  const copied: string[] = []
  const skipped: string[] = []
  const copy = deps.copy ?? ((a, b) => copyFileSync(a, b))
  for (const spec of specs) {
    const fromOld = bundledPath(deps.oldBundleDir, spec)
    if (isInstalled(deps.userDir, spec) || sizeIs(bundledPath(deps.newBundleDir, spec), spec.sizeBytes) || !sizeIs(fromOld, spec.sizeBytes)) {
      skipped.push(spec.file)
      continue
    }
    const free = await deps.freeBytes(deps.userDir)
    const need = spec.sizeBytes + (deps.marginBytes ?? GiB)
    if (free !== null && free < need) {
      return {
        ok: false,
        file: spec.file,
        error: `Not enough free disk space to keep the on-device AI model through this update (needs ${(need / 1e9).toFixed(1)} GB, ${(free / 1e9).toFixed(1)} GB free). The update was not installed; free some space and try again.`
      }
    }
    mkdirSync(deps.userDir, { recursive: true })
    const part = join(deps.userDir, `${spec.file}.part`)
    try {
      copy(fromOld, part)
      const digest = await sha256File(part)
      if (digest !== spec.sha256) {
        unlinkSync(part)
        return {
          ok: false,
          file: spec.file,
          error: 'The on-device AI model in this app did not match its checksum when copying it for the update. The update was not installed.'
        }
      }
      renameSync(part, join(deps.userDir, spec.file))
      writeFileSync(join(deps.userDir, `${spec.file}.verified`), spec.sha256 + '\n')
      copied.push(spec.file)
    } catch (e) {
      try {
        if (existsSync(part)) unlinkSync(part)
      } catch {
        /* nothing more to do */
      }
      return { ok: false, file: spec.file, error: `Could not keep the on-device AI model through this update (${(e as Error).message}). The update was not installed.` }
    }
  }
  return { ok: true, copied, skipped }
}
