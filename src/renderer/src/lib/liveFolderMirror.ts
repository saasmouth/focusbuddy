// Promote a local file-manager folder to a live (shared, checked-out) folder,
// and open the contents of a live folder on the receiving side. Unlike the live
// canvas there is no persistent local "mirror" — the live folder view renders
// the server body directly, and a file/doc is materialised locally only when a
// member actually opens it (lazy), so structure edits never re-download blobs.

import type { FileEntry } from '@shared/fields'
import { createLiveDoc, snapshotLiveBody } from './docCollabClient'
import { uploadLiveFile, downloadLiveFile } from './liveFolderClient'
import { emptyFolderBody, type FolderBody, type FolderEntry } from './liveFolder'

// Walk a folder's subtree (depth-first), returning every descendant entry with
// its real parentId.
async function collectEntries(rootId: string): Promise<FileEntry[]> {
  const out: FileEntry[] = []
  const walk = async (parentId: string): Promise<void> => {
    const kids = await window.api.fileManager.list(parentId)
    for (const k of kids) {
      out.push(k)
      if (k.kind === 'folder') await walk(k.id)
    }
  }
  await walk(rootId)
  return out
}

// Result of a promote: the new live id plus an honest count of files whose bytes
// could not be uploaded, so the caller can tell the user rather than pretend.
export interface PromoteFolderResult {
  liveId: string
  filesUploaded: number
  filesFailed: number
}

// Promote a local folder to a live folder. Creates the entity first (so blobs
// have somewhere to go), uploads each file's bytes, inlines each document's
// body, then writes the full body. Returns null only if the entity couldn't be
// created.
export async function promoteFolderToLive(
  rootFolderId: string,
  rootName: string,
  token: string
): Promise<PromoteFolderResult | null> {
  const created = await createLiveDoc(token, {
    docType: 'folder',
    title: rootName || 'Shared folder',
    body: JSON.stringify(emptyFolderBody(rootName))
  })
  if (!created) return null

  const raw = await collectEntries(rootFolderId)
  const entries: FolderEntry[] = []
  let filesUploaded = 0
  let filesFailed = 0

  for (const e of raw) {
    const parentId = e.parentId === rootFolderId ? null : e.parentId
    if (e.kind === 'folder') {
      entries.push({ id: e.id, parentId, kind: 'folder', name: e.name })
    } else if (e.kind === 'doc' && e.docId && e.docType !== 'widget') {
      // Widget files are not carried into a live folder: its viewer renders
      // office documents only, and a widget is not one.
      const doc = await window.api.documents.get(e.docId)
      entries.push({
        id: e.id,
        parentId,
        kind: 'doc',
        name: e.name,
        docType: e.docType as 'doc' | 'sheet' | 'slides' | undefined,
        docBody: doc?.body
      })
    } else if (e.kind === 'file') {
      const blob = await window.api.files.read(e.id)
      let blobId: string | null = null
      if (blob) {
        blobId = await uploadLiveFile(token, created.id, {
          bytes: blob.buffer,
          name: e.name,
          mime: e.mimeType ?? blob.mimeType,
          ext: e.ext ?? ''
        })
      }
      if (blobId) filesUploaded++
      else filesFailed++
      entries.push({
        id: e.id,
        parentId,
        kind: 'file',
        name: e.name,
        blobId: blobId ?? undefined,
        mimeType: e.mimeType,
        ext: e.ext,
        sizeBytes: e.sizeBytes
      })
    }
  }

  const body: FolderBody = { version: 1, rootName: rootName || 'Shared folder', entries }
  // Lock-free body write (the creator just made this doc; there is no lock any more).
  await snapshotLiveBody(token, created.id, JSON.stringify(body))
  return { liveId: created.id, filesUploaded, filesFailed }
}

// Local cache of downloaded shared files: blobId -> local fb_files id, so
// re-opening a file doesn't re-download it.
const DL_CACHE_KEY = 'fb.livefolder.downloads'
function readCache(): Record<string, string> {
  try {
    const raw = localStorage.getItem(DL_CACHE_KEY)
    const o = raw ? JSON.parse(raw) : {}
    return o && typeof o === 'object' ? (o as Record<string, string>) : {}
  } catch {
    return {}
  }
}
function writeCache(m: Record<string, string>): void {
  try {
    localStorage.setItem(DL_CACHE_KEY, JSON.stringify(m))
  } catch {
    /* best-effort */
  }
}

// Open a shared file: download its bytes (once, cached), ingest a local copy
// into the user's files, and open it in their default app. Returns an error
// string on failure, or null on success.
export async function openSharedFile(
  token: string,
  liveId: string,
  entry: FolderEntry
): Promise<string | null> {
  if (!entry.blobId) return 'This file was never uploaded, so it can’t be opened.'
  const cache = readCache()
  const cachedLocal = cache[entry.blobId]
  if (cachedLocal) {
    const existing = await window.api.files.get(cachedLocal)
    if (existing) {
      const res = await window.api.files.open(cachedLocal)
      return res.ok ? null : res.error
    }
  }
  const bytes = await downloadLiveFile(token, liveId, entry.blobId)
  if (!bytes) return 'Could not download this file from the server.'
  const ingested = await window.api.files.ingestBuffer({
    buffer: bytes,
    originalName: entry.name,
    mimeType: entry.mimeType ?? 'application/octet-stream',
    parentId: null
  })
  cache[entry.blobId] = ingested.id
  writeCache(cache)
  const res = await window.api.files.open(ingested.id)
  return res.ok ? null : res.error
}

// Recreate a shared document as a real local copy and return its new id so the
// caller can open it in the document editor. Returns null on failure.
export async function recreateSharedDoc(entry: FolderEntry): Promise<string | null> {
  if (entry.kind !== 'doc') return null
  try {
    const doc = await window.api.documents.create({
      docType: entry.docType ?? 'doc',
      title: entry.name,
      body: entry.docBody as never
    })
    return doc.id
  } catch {
    return null
  }
}
