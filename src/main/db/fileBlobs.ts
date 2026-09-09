// Where a Drive file's bytes actually live.
//
// Everything else about a file -- its name, type, size, folder, tags, trash
// state -- is a row in fb_files and syncs like any other row. Only the bytes
// need somewhere to sit, and that somewhere differs by runtime: the desktop has
// a directory in userData, and the browser has OPFS. Keeping the difference to
// this one small interface is what lets the other 900 lines of db/files.ts --
// folders, tags, smart folders, trash, search -- be the same code on both,
// rather than a second implementation that drifts.
//
// Ordering is by (id, ext) rather than by path on purpose: a path is a
// desktop-shaped idea, and `locate` is the only member that admits one.
// Asynchronous because the browser has no choice: OPFS is navigated through
// promises, and no amount of pre-opening makes getFileHandle synchronous. The
// desktop's implementation is synchronous underneath and simply resolves
// immediately, which costs nothing and keeps one interface instead of two.
export interface FileBlobStore {
  write(id: string, ext: string, bytes: Uint8Array): Promise<void>
  read(id: string, ext: string): Promise<Uint8Array | null>
  exists(id: string, ext: string): Promise<boolean>
  remove(id: string, ext: string): Promise<void>
  /**
   * Where the bytes are, as a string the rest of the app can carry around.
   *
   * On the desktop this is a real filesystem path, and things depend on that:
   * Quick Look, the preview generator, the OCR pipeline and the external-editor
   * bridge all hand it to something that opens files by name. In the browser it
   * is an opfs: locator that identifies the blob and would be meaningless to
   * any of those -- which is correct, because none of them run there.
   */
  locate(id: string, ext: string): string
}

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

// Uploaded files are named by their own UUID plus the original extension, so
// the OS preview pane still works if a user navigates to the folder.
function filesDir(): string {
  const dir = join(app.getPath('userData'), 'files')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export const fileBlobs: FileBlobStore = {
  async write(id, ext, bytes) {
    mkdirSync(filesDir(), { recursive: true })
    writeFileSync(join(filesDir(), `${id}${ext}`), bytes)
  },
  async read(id, ext) {
    try {
      return readFileSync(join(filesDir(), `${id}${ext}`))
    } catch {
      return null
    }
  },
  async exists(id, ext) {
    return existsSync(join(filesDir(), `${id}${ext}`))
  },
  async remove(id, ext) {
    try {
      unlinkSync(join(filesDir(), `${id}${ext}`))
    } catch {
      // Best effort: the row is the source of truth, and a missing blob is the
      // state we were heading for anyway.
    }
  },
  locate(id, ext) {
    return join(filesDir(), `${id}${ext}`)
  }
}
