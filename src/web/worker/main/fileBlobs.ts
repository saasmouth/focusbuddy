// Drive file bytes in the browser, on OPFS.
//
// The desktop keeps these as real files in userData so the OS can preview them.
// A browser has the Origin Private File System, which is a real filesystem with
// one difference that shapes this file: it is navigated through promises. There
// is no synchronous way to reach a file handle, and pre-opening the directory
// does not help, because getFileHandle is per-file and async as well. That is
// why FileBlobStore is asynchronous on both runtimes rather than only here.
//
// Files are named by id + extension, exactly as on the desktop, so the same
// row identifies the same bytes in either runtime and a file synced from one
// lands where the other expects it.
//
// This is a different OPFS user from the database: SQLite has its own pool VFS
// under its own name, and these live in a plain directory beside it. They do
// not share handles and cannot collide.
const DIR = 'plexii-files'

async function dir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(DIR, { create: true })
}

const nameFor = (id: string, ext: string): string => `${id}${ext}`

export const fileBlobs = {
  async write(id: string, ext: string, bytes: Uint8Array): Promise<void> {
    const handle = await (await dir()).getFileHandle(nameFor(id, ext), { create: true })
    const writable = await handle.createWritable()
    try {
      // A fresh writable truncates, so a rewrite replaces rather than overlays --
      // which matters for writeSyncedFileBytes landing a shorter version of a
      // file that already exists here.
      await writable.write(bytes)
    } finally {
      await writable.close()
    }
  },

  async read(id: string, ext: string): Promise<Uint8Array | null> {
    try {
      const handle = await (await dir()).getFileHandle(nameFor(id, ext))
      const file = await handle.getFile()
      return new Uint8Array(await file.arrayBuffer())
    } catch {
      // NotFoundError, or a browser that has revoked the origin's storage.
      // Either way there are no bytes, which is what the caller asked.
      return null
    }
  },

  async exists(id: string, ext: string): Promise<boolean> {
    try {
      await (await dir()).getFileHandle(nameFor(id, ext))
      return true
    } catch {
      return false
    }
  },

  async remove(id: string, ext: string): Promise<void> {
    try {
      await (await dir()).removeEntry(nameFor(id, ext))
    } catch {
      // Best effort, as on the desktop: the row is the source of truth and a
      // missing blob is the state we were heading for.
    }
  },

  /**
   * There is no path here, and nothing in this runtime should pretend there is.
   * The desktop returns a real filesystem path because Quick Look, the preview
   * generator and the OCR pipeline open files by name; none of those run in a
   * browser. An opfs: locator identifies the blob and is honest about what it
   * is not.
   */
  locate(id: string, ext: string): string {
    return `opfs:/${DIR}/${nameFor(id, ext)}`
  }
}
