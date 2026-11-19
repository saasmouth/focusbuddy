// Files copied in Finder (or Explorer) and pasted into Plexii.
//
// Chromium hands a page only the copied files' NAMES (as text) and their ICON
// (as a picture), never the files, so a pasted PDF arrived as its name and a
// pasted screenshot file as a generic icon (owner, 2026-11-19: paste must work
// everywhere). The main process can see the files: the pasteboard lists their
// URLs (public.file-url / text/uri-list, and NSFilenamesPboardType for a
// multi-file copy; drawClipboard.copiedFilePaths reads both).
//
// So a paste that begins in main -- Edit › Paste, an unhandled ⌘V (which the
// Edit menu runs), the page context menu's Paste -- first asks whether the
// pasteboard holds copied files. If it does and the paste is aimed at one of
// the app's own windows, the files are read here (each up to 40 MB, at most 64:
// File › Place's limits, drawImport.readPicked) and sent to the page on
// PASTE_FILES_CHANNEL; the page puts them where the paste was aimed
// (renderer lib/pastedFiles.ts). Otherwise the paste runs as before.
//
// Windows: Electron lists the clipboard's raw formats by name; Explorer's copy
// is CF_HDROP (a DROPFILES block: every path) and FileNameW (the first path).
// Both are read (dropFilesPaths); untested on Windows.
import { BrowserWindow, clipboard, type WebContents } from 'electron'
import { basename, extname } from 'path'
import type { PastedFilesPayload } from '../shared/types'
import { copiedFilePaths } from './drawClipboard'
import { readPicked } from './drawImport'

export const PASTE_FILES_CHANNEL = 'clipboard:pasteFiles'

/**
 * The paths in a Windows DROPFILES block (CF_HDROP): a 20-byte header whose
 * first field is the offset of the list and whose fifth says it is UTF-16, then
 * the paths, each ended by a NUL, the list by one more.
 */
export function dropFilesPaths(buf: Buffer): string[] {
  if (buf.length < 20) return []
  const offset = buf.readUInt32LE(0)
  const wide = buf.readUInt32LE(16) !== 0
  if (offset < 20 || offset >= buf.length) return []
  const body = wide ? buf.subarray(offset).toString('utf16le') : buf.subarray(offset).toString('latin1')
  const out: string[] = []
  for (const p of body.split('\0')) {
    if (!p) break
    out.push(p)
  }
  return out
}

const RAW_FORMAT = /^electron application\/osclipboard;format="([^"]+)"$/

/** Paths of the files copied in Finder / Explorer, if that is what the clipboard holds. */
export async function pasteboardFilePaths(): Promise<string[]> {
  try {
    const items = await clipboard.read()
    const paths = await copiedFilePaths(items)
    if (paths.length) return paths
    // Windows Explorer's formats.
    for (const item of items) {
      for (const t of item.types) {
        const format = RAW_FORMAT.exec(t)?.[1]
        if (format !== 'CF_HDROP' && format !== 'FileNameW') continue
        const buf = Buffer.from(await ((await item.getType(t)) as Blob).arrayBuffer())
        const found = format === 'CF_HDROP' ? dropFilesPaths(buf) : [buf.toString('utf16le').replace(/\0+$/, '')].filter(Boolean)
        if (found.length) return found
      }
    }
    return []
  } catch {
    return []
  }
}

export interface PastedFilesDeps {
  read: typeof readPicked
  mimeOf: (ext: string) => string
}

/** Read the copied files into what the page receives. */
export async function pastedFilesPayload(paths: string[], deps: PastedFilesDeps): Promise<PastedFilesPayload> {
  const r = await deps.read(paths)
  const skipped = r.skipped.map((s) => ({ name: s.name, reason: s.reason }))
  // readPicked reads at most 64; say so for the rest rather than drop them unnamed.
  for (const p of paths.slice(64)) skipped.push({ name: basename(p), reason: 'more than 64 files were copied' })
  return {
    files: r.files.map((f) => ({ name: f.name, mimeType: deps.mimeOf(extname(f.name)), bytes: f.bytes })),
    skipped
  }
}

/** Whether this page is one of the app's own windows (it has the preload that receives pasted files). */
function isAppWindow(wc: WebContents): boolean {
  return wc.getType() === 'window' && BrowserWindow.fromWebContents(wc) !== null
}

/**
 * Paste into this page: copied files go to it as files; anything else is the
 * ordinary paste. A web page inside a browser work widget always gets the
 * ordinary paste (it has no way to receive them).
 */
export async function pasteInto(wc: WebContents, deps: PastedFilesDeps, ordinary: () => void = () => wc.paste()): Promise<void> {
  if (wc.isDestroyed()) return
  if (isAppWindow(wc)) {
    const paths = await pasteboardFilePaths()
    if (paths.length && !wc.isDestroyed()) {
      wc.send(PASTE_FILES_CHANNEL, await pastedFilesPayload(paths, deps))
      return
    }
  }
  if (!wc.isDestroyed()) ordinary()
}
