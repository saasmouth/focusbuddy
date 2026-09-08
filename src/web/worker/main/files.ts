// The Drive file store, as far as the cloud runtime currently goes.
//
// On the desktop this module owns bytes on disk: it ingests files, hands out
// paths, reads them back for text extraction and for sync. A browser has no
// such directory, and OPFS is not a drop-in for one -- the desktop hands real
// filesystem paths to native tooling (OCR, PDF rasterisation, the external
// editor bridge) that has nothing to call in a tab.
//
// So this exports the two functions the retrieval index actually asks for, and
// answers them with an empty store. That is accurate rather than convenient:
// the browser holds no file bytes today, so there is genuinely nothing to
// index. Everything else refuses by name, so a path that needs real bytes says
// which function it wanted rather than returning an empty result the caller
// would read as "no files here".
//
// The consequence is bounded and worth stating: in the browser, chunk retrieval
// covers widgets, documents, tables and chats -- everything except file
// contents. Closing that gap means giving the browser a byte store of its own
// (OPFS is a reasonable home) and moving text extraction server-side, which is
// its own piece of work rather than a line in a swap table.

export interface IndexableFile {
  id: string
  name: string
  ext: string
  sizeBytes: number
  updatedAt: number
}

/** No file bytes reach the browser yet, so the indexable set is genuinely empty. */
export function listIndexableFiles(): IndexableFile[] {
  return []
}

export function getIndexableFile(_id: string): IndexableFile | null {
  return null
}

const NO_STORE = (fn: string): Error =>
  new Error(`${fn}: Drive file bytes are not available in the browser runtime yet.`)

export function getFile(_id: string): never { throw NO_STORE('getFile') }
export function readFileBytes(_id: string): never { throw NO_STORE('readFileBytes') }
export function hasFileBytes(_id: string): boolean { return false }
export function readFileBytesForSync(_id: string): null { return null }
export function writeSyncedFileBytes(_id: string, _bytes: Uint8Array): boolean { return false }
export function ingestFromPath(): never { throw NO_STORE('ingestFromPath') }
export function ingestFromBuffer(): never { throw NO_STORE('ingestFromBuffer') }
export function deleteFile(): never { throw NO_STORE('deleteFile') }
