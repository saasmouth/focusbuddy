// Ingesting files that already exist on a disk.
//
// This is the part of the Drive that cannot follow the app into a browser. Not
// because of effort -- because a tab is never handed a filesystem path. It gets
// a File object from a picker or a drop, whose bytes it must read itself, which
// is what db/files.ts ingestFromBuffer is for. These two take a path and walk
// it, so they belong to the desktop and are kept out of the shared module for
// exactly that reason: a browser build that pulled them in would drag `fs` and
// `electron` into a graph that is otherwise free of both.
import { randomUUID } from 'crypto'
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join, extname, basename } from 'path'
import { fileBlobs } from './fileBlobs'
import { downsampleImage, isDownsampleable } from './imageDownsample'
import { createFolder, insertFileRow, mimeFromExt } from './files'
import type { FbFile } from '@shared/fields'

/**
 * Ingest a file from a source path on disk. Copies it into userData/files
 * with a fresh UUID, records metadata, and returns the FbFile. Original is
 * left untouched.
 */
export async function ingestFromPath(
  sourcePath: string,
  opts: { originalName?: string; mimeType?: string; parentId?: string | null } = {}
): Promise<FbFile> {
  if (!existsSync(sourcePath)) {
    throw new Error(`File not found: ${sourcePath}`)
  }
  const stats = statSync(sourcePath)
  const original = opts.originalName ?? basename(sourcePath)
  const ext = extname(original).toLowerCase()
  const id = randomUUID()
  const dest = fileBlobs.locate(id, ext)
  // An image is read, shrunk and written; anything else is copied as before.
  // The copy path stays for non-images because streaming a large video through
  // memory to achieve nothing would be a poor trade.
  let sizeBytes = stats.size
  if (isDownsampleable(opts.mimeType ?? mimeFromExt(ext), ext)) {
    const src = readFileSync(sourcePath)
    const shrunk = await downsampleImage(src, opts.mimeType ?? mimeFromExt(ext), ext)
    writeFileSync(dest, shrunk.bytes)
    sizeBytes = shrunk.bytes.length
  } else {
    copyFileSync(sourcePath, dest)
  }
  return insertFileRow({
    id,
    originalName: original,
    mimeType: opts.mimeType ?? mimeFromExt(ext),
    sizeBytes,
    ext,
    createdAt: Date.now(),
    parentId: opts.parentId ?? null
  })
}

// Recursively import a local folder tree into the Drive under `parentId`,
// mirroring its structure as fb_files folders and ingesting each file (which the
// brain then indexes on its next sync). Skips hidden entries and the usual heavy
// build dirs, caps file size and total count so a stray huge tree can't wedge the
// import, and never throws on a single unreadable entry. Returns what it did.
export function importFolderTree(
  sourceDir: string,
  parentId: string | null,
  opts?: { maxFiles?: number; maxFileBytes?: number }
): { files: number; folders: number; skipped: number; rootId: string | null } {
  const maxFiles = opts?.maxFiles ?? 5000
  const maxFileBytes = opts?.maxFileBytes ?? 100 * 1024 * 1024
  const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.DS_Store'])
  const stats = { files: 0, folders: 0, skipped: 0, rootId: null as string | null }
  if (!existsSync(sourceDir)) return stats

  // Create a top folder named after the imported directory, so the import lands as
  // one tidy folder rather than dumping its contents into the current view.
  const root = createFolder(parentId, basename(sourceDir) || 'Imported folder')
  stats.folders++
  stats.rootId = root.id

  const walk = (dir: string, parent: string): void => {
    if (stats.files >= maxFiles) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (stats.files >= maxFiles) return
      if (name.startsWith('.') || SKIP_DIRS.has(name)) {
        stats.skipped++
        continue
      }
      const full = join(dir, name)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(full)
      } catch {
        stats.skipped++
        continue
      }
      if (st.isDirectory()) {
        const folder = createFolder(parent, name)
        stats.folders++
        walk(full, folder.id)
      } else if (st.isFile()) {
        if (st.size > maxFileBytes) {
          stats.skipped++
          continue
        }
        try {
          ingestFromPath(full, { parentId: parent })
          stats.files++
        } catch {
          stats.skipped++
        }
      }
    }
  }
  walk(sourceDir, root.id)
  return stats
}
