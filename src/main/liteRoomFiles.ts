// "Open This Room in Plexii" (shared/liteRoom.ts): reading what PlexiiLite handed
// over, and checking each of the person's files before it is copied. No Electron
// here, so tests/unit/liteRoomFiles.test.ts runs it against real files, links and
// folders.
//
// Two rules hold everything up:
//
//   1. Plexii only READS PlexiiLite's folder, and only the one file a link names:
//      <PlexiiLite data>/handoff/<id>.json, where it is once every link is resolved,
//      a regular file and not a link, at most 1 MiB. A link that points the handoff
//      somewhere else is refused, not followed.
//   2. A file only in iCloud is never read: reading one byte makes macOS download
//      all of it (PlexiiLite measured a 16.6 GB screen recording starting that way).
//      PlexiiLite marks them; each file is checked again here from its flags, without
//      reading it, before it is copied.

import { execFileSync } from 'node:child_process'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync, type Stats } from 'node:fs'
import { join, sep } from 'node:path'
import { isRoomName, LITE_ROOM_ID, LITE_ROOM_MAX_JSON_BYTES, parseLiteRoom, type LeftOutWhy, type LiteRoom, type LiteRoomRefusal } from '../shared/liteRoom'

export type LiteRoomRead = { ok: true; room: LiteRoom } | { ok: false; refusal: LiteRoomRefusal | 'missing' | 'unreadable' }

/** The path a handoff id names, inside PlexiiLite's data folder. */
export const liteRoomHandoffPath = (liteData: string, id: string): string => join(liteData, 'handoff', `${id}.json`)

const isInside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)

/** PlexiiLite's handoff for `id`, checked in full, or why not. Nothing outside that one file is read. */
export function readLiteRoomHandoff(liteData: string, id: string, now: number = Date.now()): LiteRoomRead {
  if (!LITE_ROOM_ID.test(id)) return { ok: false, refusal: 'missing' }
  const path = liteRoomHandoffPath(liteData, id)
  let dataReal: string
  let real: string
  try {
    dataReal = realpathSync(liteData)
    real = realpathSync(path)
  } catch (e) {
    return { ok: false, refusal: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' }
  }
  // Exactly <PlexiiLite data>/handoff/<id>.json with every link resolved: a handoff
  // folder or file that is a link to anywhere else is not followed.
  if (real !== liteRoomHandoffPath(dataReal, id)) return { ok: false, refusal: 'unreadable' }
  let fd: number
  try {
    const l = lstatSync(path)
    if (l.isSymbolicLink() || !l.isFile() || l.size > LITE_ROOM_MAX_JSON_BYTES) return { ok: false, refusal: 'unreadable' }
    // O_NOFOLLOW: the file opened is the one just checked, never a link swapped in.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return { ok: false, refusal: 'unreadable' }
  }
  let text: string
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > LITE_ROOM_MAX_JSON_BYTES) return { ok: false, refusal: 'unreadable' }
    const buf = Buffer.alloc(LITE_ROOM_MAX_JSON_BYTES + 1)
    let got = 0
    for (;;) {
      const n = readSync(fd, buf, got, buf.length - got, null)
      if (n <= 0) break
      got += n
      if (got > LITE_ROOM_MAX_JSON_BYTES) return { ok: false, refusal: 'unreadable' }
    }
    text = buf.subarray(0, got).toString('utf8')
  } catch {
    return { ok: false, refusal: 'unreadable' }
  } finally {
    closeSync(fd)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, refusal: 'schema' }
  }
  const parsed = parseLiteRoom(raw, now)
  return parsed.ok ? parsed : { ok: false, refusal: parsed.refusal }
}

/** macOS's flag for a file whose contents are in the cloud, not on this Mac (sys/stat.h SF_DATALESS). */
export const SF_DATALESS = 0x40000000

/** A file's flags, read by /usr/bin/stat without touching its contents. */
export function statFlags(path: string): number {
  const out = execFileSync('/usr/bin/stat', ['-f', '%Xf', path], { encoding: 'utf8', timeout: 5000 }).trim()
  const n = parseInt(out, 16)
  if (!Number.isFinite(n)) throw new Error(`stat said ${out}`)
  return n
}

/**
 * Whether a file is only in iCloud (or another cloud drive): its contents not on
 * this Mac. A local file always has blocks (an HFS-compressed one reports some
 * too); one with bytes and no blocks may be in the cloud, and its SF_DATALESS
 * flag decides. If the flag can't be read, it counts as in the cloud: never read
 * one by accident (PlexiiLite's own rule).
 */
export function isDataless(path: string, st: Pick<Stats, 'size' | 'blocks'>, flags: (p: string) => number = statFlags, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'darwin' || st.size === 0 || st.blocks > 0) return false
  try {
    return (flags(path) & SF_DATALESS) !== 0
  } catch {
    return true
  }
}

export type RoomFileCheck = { ok: true; path: string; size: number } | { ok: false; why: LeftOutWhy }

const whyFor = (e: unknown): LeftOutWhy => {
  const code = (e as NodeJS.ErrnoException)?.code
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'gone' : code === 'EACCES' || code === 'EPERM' ? 'denied' : 'unreadable'
}

/**
 * One of the room's files, checked just before it is copied: `relPath` names a
 * file directly in the folder, it is a regular file (a link only to a file inside
 * the folder), and not only in iCloud. Returns the real path to copy from.
 */
export function checkRoomFile(folderReal: string, relPath: string, dataless: (path: string, st: Stats) => boolean = (p, st) => isDataless(p, st)): RoomFileCheck {
  if (!isRoomName(relPath)) return { ok: false, why: 'outside' }
  const path = join(folderReal, relPath)
  let real = path
  try {
    const l = lstatSync(path)
    if (l.isSymbolicLink()) {
      real = realpathSync(path)
      if (!isInside(real, folderReal) || real === folderReal) return { ok: false, why: 'outside' }
    }
    const st = statSync(real)
    if (!st.isFile()) return { ok: false, why: 'not-a-file' }
    if (dataless(real, st)) return { ok: false, why: 'in-cloud' }
    return { ok: true, path: real, size: st.size }
  } catch (e) {
    return { ok: false, why: whyFor(e) }
  }
}

export type RoomFolderCheck = { ok: true; real: string } | { ok: false; why: 'gone' | 'denied' | 'unreadable' | 'not-a-folder' }

/** The room's folder: its real path, which must be a folder. */
export function checkRoomFolder(folder: string): RoomFolderCheck {
  try {
    const real = realpathSync(folder)
    if (!statSync(real).isDirectory()) return { ok: false, why: 'not-a-folder' }
    return { ok: true, real }
  } catch (e) {
    const why = whyFor(e)
    return { ok: false, why: why === 'gone' ? 'gone' : why === 'denied' ? 'denied' : 'unreadable' }
  }
}
