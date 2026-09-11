// OS-level file operations for the File widget:
//   - pick a file via the native dialog
//   - generate a QuickLook thumbnail (used as the canvas preview for any
//     file type — images, PDFs, .docx, .key, .sketch, anything Finder can
//     preview)
//   - open a local file in its default app, or a remote URL in the browser
//
// We deliberately keep this separate from db/files.ts:
//   - db/files.ts owns the on-disk storage layout + sqlite metadata
//   - this file owns OS-level shell/dialog/QuickLook integration
// Two responsibilities, two files. The IPC layer wires them together.

import { app, BrowserWindow, dialog, nativeImage, shell } from 'electron'
import { existsSync, mkdirSync, statSync, writeFileSync, readFileSync } from 'fs'
import { extname, join, basename } from 'path'
import { getFile } from './db/files'
import { ingestFromPath } from './db/filesFromDisk'
import type { FbFile } from '@shared/fields'

/**
 * The window a file dialog should hang off.
 *
 * Every other dialog in the app passes one; these two did not, and on macOS
 * that is the difference between a sheet attached to the window and a
 * free-floating panel that opens unfocused and can sit BEHIND the app -- which
 * to the person clicking looks exactly like a button that does nothing.
 */
function dialogParent(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

// Generated thumbnails live in userData/thumbnails/<file-id>.png. The cache
// is content-addressed by file id, NOT mtime, because our stored files are
// immutable — once ingested, the bytes never change. Re-thumbnailing only
// happens if the cache is manually cleared.
function thumbnailsDir(): string {
  const dir = join(app.getPath('userData'), 'thumbnails')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export interface ThumbnailResult {
  base64: string
  mimeType: 'image/png'
  width: number
  height: number
}

/**
 * Generate (or read from cache) a QuickLook thumbnail for a previously
 * ingested file. Returns null if the file doesn't exist or QuickLook can't
 * produce a preview (e.g. corrupted blob, unsupported on the host OS).
 *
 * macOS only for now — `nativeImage.createThumbnailFromPath` is what makes
 * this work for arbitrary file types (Word, PDF, Sketch, Pages, even .app
 * bundles) by delegating to QuickLook. On Linux/Windows this falls back
 * to whatever the OS returns, which is often a generic icon.
 */
export async function thumbnailForFile(
  id: string,
  opts: { size?: number; force?: boolean } = {}
): Promise<ThumbnailResult | null> {
  const file = getFile(id)
  if (!file) return null
  if (!existsSync(file.storedPath)) return null

  const size = opts.size ?? 512
  const cachePath = join(thumbnailsDir(), `${id}-${size}.png`)

  if (!opts.force && existsSync(cachePath)) {
    try {
      const buf = readFileSync(cachePath)
      return {
        base64: buf.toString('base64'),
        mimeType: 'image/png',
        width: size,
        height: size
      }
    } catch {
      // cache read failed; regenerate
    }
  }

  // Hard 3s timeout — QuickLook can hang under some user-data states
  // (per the comment in localApps.ts). 3s is generous for any real file.
  try {
    const thumb = await Promise.race([
      nativeImage
        .createThumbnailFromPath(file.storedPath, { width: size, height: size })
        .catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000))
    ])
    if (!thumb || typeof (thumb as { toPNG?: unknown }).toPNG !== 'function') {
      return null
    }
    const png = (thumb as { toPNG: () => Buffer }).toPNG()
    if (png.length === 0) return null
    try {
      writeFileSync(cachePath, png)
    } catch {
      // cache write best-effort; still return the in-memory result
    }
    return {
      base64: png.toString('base64'),
      mimeType: 'image/png',
      width: size,
      height: size
    }
  } catch {
    return null
  }
}

/**
 * Open the native file picker and ingest the selected file in one shot.
 * Returns the resulting FbFile (already stored under userData/files) or
 * null if the user cancelled.
 *
 * We deliberately don't expose a raw `pick` (without ingest) on the public
 * IPC surface — every time the renderer wants a file, it wants to track it
 * as an FbFile, so the convenience pick+ingest avoids two round trips.
 */
export async function pickAndIngestFile(opts: {
  title?: string
  defaultPath?: string
  filters?: Electron.FileFilter[]
} = {}): Promise<FbFile | null> {
  const dialogOpts: Electron.OpenDialogOptions = {
    title: opts.title ?? 'Choose a file',
    defaultPath: opts.defaultPath,
    properties: ['openFile'],
    filters: opts.filters
  }
  let result: Electron.OpenDialogReturnValue
  try {
    const parent = dialogParent()
    result = parent
      ? await dialog.showOpenDialog(parent, dialogOpts)
      : await dialog.showOpenDialog(dialogOpts)
  } catch (err) {
    console.error('[files:pick] dialog failed:', err)
    throw err
  }
  if (result.canceled || result.filePaths.length === 0) return null
  const sourcePath = result.filePaths[0]
  if (!existsSync(sourcePath)) return null
  // Sanity guard: if the user somehow picks a directory, refuse rather than
  // copy a bunch of arbitrary bytes via fs.copyFileSync.
  const stats = statSync(sourcePath)
  if (stats.isDirectory()) return null
  return ingestFromPath(sourcePath, {
    originalName: basename(sourcePath),
    mimeType: mimeFromExt(extname(sourcePath).toLowerCase())
  })
}

/**
 * Open the native multi-select picker and ingest every chosen file into the
 * given folder of the file/folder manager. Returns the FbFiles created.
 */
export async function pickFilesIntoFolder(parentId: string | null): Promise<FbFile[]> {
  let result: Electron.OpenDialogReturnValue
  try {
    const parent = dialogParent()
    const opts: Electron.OpenDialogOptions = {
      title: 'Add files',
      properties: ['openFile', 'multiSelections']
    }
    result = parent
      ? await dialog.showOpenDialog(parent, opts)
      : await dialog.showOpenDialog(opts)
  } catch (err) {
    console.error('[fileManager:pick] dialog failed:', err)
    throw err
  }
  if (result.canceled || result.filePaths.length === 0) return []
  const out: FbFile[] = []
  for (const sourcePath of result.filePaths) {
    try {
      if (!existsSync(sourcePath) || statSync(sourcePath).isDirectory()) continue
      out.push(
        await ingestFromPath(sourcePath, {
          originalName: basename(sourcePath),
          mimeType: mimeFromExt(extname(sourcePath).toLowerCase()),
          parentId
        })
      )
    } catch (err) {
      console.error('[fileManager:pick] ingest failed for', sourcePath, err)
    }
  }
  return out
}

/**
 * Reveal an ingested file in the OS file browser (Finder / Explorer).
 */
export function revealFile(id: string): { ok: boolean } {
  const file = getFile(id)
  if (!file || !existsSync(file.storedPath)) return { ok: false }
  shell.showItemInFolder(file.storedPath)
  return { ok: true }
}

/**
 * Open a locally ingested file in the user's default app — Preview for
 * images, Word for .docx, etc. Returns ok=false on a missing file id or
 * shell.openPath returning a non-empty error string.
 */
export async function openLocalFile(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const file = getFile(id)
  if (!file) return { ok: false, error: `Unknown file id: ${id}` }
  if (!existsSync(file.storedPath)) {
    return { ok: false, error: `File missing on disk: ${file.storedPath}` }
  }
  const err = await shell.openPath(file.storedPath)
  // shell.openPath returns "" on success, an error message string on failure.
  if (err) return { ok: false, error: err }
  return { ok: true }
}

/**
 * Open an external URL in the user's default browser. We allow only
 * http:/https: to avoid e.g. `file://` arbitrary-path traversal from a
 * compromised renderer or a malicious paste.
 */
export async function openExternalUrl(
  url: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (typeof url !== 'string' || url.length === 0) {
    return { ok: false, error: 'Empty URL' }
  }
  // URL constructor throws on garbage — also enforce the protocol allowlist.
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: `Refused non-http protocol: ${parsed.protocol}` }
    }
  } catch {
    return { ok: false, error: 'Not a valid URL' }
  }
  try {
    await shell.openExternal(url)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// Minimal MIME guesser — kept in sync with db/files.ts. Duplication is
// cheap and avoids forcing db/files.ts to export an internal helper.
function mimeFromExt(ext: string): string {
  const e = ext.replace(/^\./, '').toLowerCase()
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    pdf: 'application/pdf',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    m4v: 'video/x-m4v',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv',
    zip: 'application/zip',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    key: 'application/vnd.apple.keynote',
    pages: 'application/vnd.apple.pages',
    numbers: 'application/vnd.apple.numbers'
  }
  return map[e] ?? 'application/octet-stream'
}
