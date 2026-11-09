// "Open This Room in Plexii": a room handed over by PlexiiLite (the free app that
// shows real folders as rooms and files as live tiles, and leads people to Plexii).
//
// The contract is docs/PLEXIILITE-ROOM-HANDOFF.md, kept word for word in
// PlexiiLite's repo too, with its example in tests/fixtures/plexiilite-room-v1.json.
// PlexiiLite writes a small JSON file into ITS OWN data folder
// (~/Library/Application Support/PlexiiLite/handoff/<id>.json) and opens
// plexii://lite-room?id=<id>. Plexii keeps the id until someone is signed in,
// reads that one file, checks it, ASKS (a web page can open a plexii:// link too,
// so a link alone never brings anything in), then copies the files into its own
// store the way a file dropped from Finder is copied and makes a new desk named
// after the folder, laid out as the room was.
//
// This file is the part with no disk and no Electron: the link, the schema, what
// will be brought in and what left out, the words of the question and of the
// summary, and how PlexiiLite's places map onto a Plexii desk. The reading and
// the copying are main/liteRoomFiles.ts and main/liteRoomReceiver.ts.

import { DEEP_LINK_SCHEME, isKnownDeepLinkProtocol } from './deepLink'
import type { FbNode, Widget } from './types'
import type { WorkcentreLayout } from './deskLayout'

export const LITE_ROOM_FORMAT = 'plexiilite.room'
/** The handoff version this build reads (and declares in its Info.plist, below). */
export const LITE_ROOM_VERSION = 1
/**
 * The Info.plist key PlexiiLite reads, on the app macOS opens plexii:// links
 * with, before it offers "Open This Room in Plexii": the highest handoff version
 * this build reads. electron-builder.cjs mac.extendInfo sets it.
 */
export const LITE_ROOM_INFO_KEY = 'PlexiiTakesLiteRooms'
/** A handoff id: a lower-case version 4 UUID, as PlexiiLite's crypto.randomUUID makes. */
export const LITE_ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
/** The handoff file is at most this big. */
export const LITE_ROOM_MAX_JSON_BYTES = 1024 * 1024
/** A handoff older than this is expired (PlexiiLite removes its own after a day too). */
export const LITE_ROOM_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** Clocks differ a little; a handoff from further in the future than this is refused. */
export const LITE_ROOM_FUTURE_SKEW_MS = 5 * 60 * 1000
/** What the format allows: files and folders listed, browser windows. */
export const LITE_ROOM_MAX_LISTED = 2000
export const LITE_ROOM_MAX_PAGES = 100
/** Plexii's own limits for one room: the files after these, in the room's order, are left out and named. */
export const LITE_ROOM_MAX_FILES = 200
export const LITE_ROOM_MAX_TOTAL_BYTES = 1024 * 1024 * 1024

/** The deep link that hands a room to Plexii (PlexiiLite builds the same). */
export function liteRoomLink(id: string): string {
  return `${DEEP_LINK_SCHEME}://lite-room?id=${encodeURIComponent(id)}`
}

/** The handoff id in a deep link, or null if it is not one. */
export function parseLiteRoomLink(url: string): string | null {
  try {
    const u = new URL(url)
    if (!isKnownDeepLinkProtocol(u.protocol) || u.host !== 'lite-room') return null
    const ids = u.searchParams.getAll('id')
    return ids.length === 1 && LITE_ROOM_ID.test(ids[0]!) ? ids[0]! : null
  } catch {
    return null
  }
}

// ── The file ────────────────────────────────────────────────────────────────

export type LiteRoomView = 'desk' | 'workcentre' | 'list' | 'focus'

export interface LiteRoomDesk {
  x: number
  y: number
  w: number
  h: number
  z: number
}

export interface LiteRoomCell {
  x: number
  y: number
  w: number
  h: number
  fixW?: boolean
  fixH?: boolean
}

export interface LiteRoomTile {
  name: string
  relPath: string
  kind: string
  size: number
  inCloud: boolean
  desk: LiteRoomDesk | null
  workcentre: LiteRoomCell | null
}

export interface LiteRoomPage {
  url: string
  title: string | null
  desk: LiteRoomDesk | null
  workcentre: LiteRoomCell | null
}

export interface LiteRoom {
  format: typeof LITE_ROOM_FORMAT
  version: typeof LITE_ROOM_VERSION
  createdAt: string
  app: string
  folder: string
  name: string
  view: LiteRoomView
  cols: number | null
  tiles: LiteRoomTile[]
  folders: { name: string; relPath: string }[]
  pages: LiteRoomPage[]
  more: { files: number; folders: number }
}

/**
 * Why a handoff file was refused. `newer`: a later PlexiiLite wrote a version this
 * build doesn't read. Every refusal brings nothing in.
 */
export type LiteRoomRefusal = 'format' | 'newer' | 'schema' | 'expired' | 'future'

export type LiteRoomParse = { ok: true; room: LiteRoom } | { ok: false; refusal: LiteRoomRefusal; detail: string }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const VIEWS: readonly LiteRoomView[] = ['desk', 'workcentre', 'list', 'focus']

/** A name directly in the room: 1 to 255 characters, no "/", no NUL, not "." or "..". */
export function isRoomName(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= 255 && !v.includes('/') && !v.includes('\0') && v !== '.' && v !== '..'
}

/** An absolute, normalised folder path: no "." or ".." parts, no "//", no trailing "/", not "/". */
export function isRoomFolder(v: unknown): v is string {
  if (typeof v !== 'string' || v.length < 2 || v.length > 4096 || !v.startsWith('/') || v.endsWith('/') || v.includes('\0')) return false
  return v
    .slice(1)
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..')
}

class Bad extends Error {}
const need = (cond: unknown, what: string): void => {
  if (!cond) throw new Bad(what)
}

function deskOf(v: unknown, at: string): LiteRoomDesk | null {
  if (v === null) return null
  need(isObj(v), `${at}.desk`)
  const d = v as Record<string, unknown>
  const LIM = 10_000_000
  need(isNum(d.x) && isNum(d.y) && Math.abs(d.x) <= LIM && Math.abs(d.y) <= LIM, `${at}.desk x/y`)
  need(isNum(d.w) && isNum(d.h) && d.w > 0 && d.h > 0 && d.w <= 100_000 && d.h <= 100_000, `${at}.desk w/h`)
  need(isNum(d.z) && Math.abs(d.z) <= LIM, `${at}.desk z`)
  return { x: d.x as number, y: d.y as number, w: d.w as number, h: d.h as number, z: d.z as number }
}

function cellOf(v: unknown, at: string): LiteRoomCell | null {
  if (v === null) return null
  need(isObj(v), `${at}.workcentre`)
  const c = v as Record<string, unknown>
  need(isInt(c.x) && isInt(c.y) && c.x >= 0 && c.y >= 0 && c.x <= 100_000 && c.y <= 100_000, `${at}.workcentre x/y`)
  need(isInt(c.w) && isInt(c.h) && c.w >= 1 && c.h >= 1 && c.w <= 200 && c.h <= 200, `${at}.workcentre w/h`)
  need(c.fixW === undefined || typeof c.fixW === 'boolean', `${at}.workcentre fixW`)
  need(c.fixH === undefined || typeof c.fixH === 'boolean', `${at}.workcentre fixH`)
  const out: LiteRoomCell = { x: c.x as number, y: c.y as number, w: c.w as number, h: c.h as number }
  if (c.fixW === true) out.fixW = true
  if (c.fixH === true) out.fixH = true
  return out
}

const isWebAddress = (v: unknown): v is string => {
  if (typeof v !== 'string' || v.length > 8192) return false
  try {
    const p = new URL(v).protocol
    return p === 'http:' || p === 'https:'
  } catch {
    return false
  }
}

/**
 * The handoff, checked in full against the contract, or why not. Fields this
 * version doesn't know are ignored; a known field that breaks a rule refuses
 * the WHOLE file: nothing is brought in from a file that can't be trusted in full.
 */
export function parseLiteRoom(raw: unknown, now: number = Date.now()): LiteRoomParse {
  if (!isObj(raw) || raw.format !== LITE_ROOM_FORMAT) return { ok: false, refusal: 'format', detail: 'not a PlexiiLite room' }
  if (!isInt(raw.version) || raw.version < 1) return { ok: false, refusal: 'schema', detail: 'version' }
  if (raw.version > LITE_ROOM_VERSION) return { ok: false, refusal: 'newer', detail: `version ${raw.version}` }
  try {
    need(typeof raw.createdAt === 'string' && raw.createdAt.length <= 40, 'createdAt')
    const at = Date.parse(raw.createdAt as string)
    need(Number.isFinite(at), 'createdAt')
    if (at > now + LITE_ROOM_FUTURE_SKEW_MS) return { ok: false, refusal: 'future', detail: 'createdAt' }
    if (now - at > LITE_ROOM_MAX_AGE_MS) return { ok: false, refusal: 'expired', detail: 'createdAt' }
    need(typeof raw.app === 'string' && raw.app.length <= 100, 'app')
    need(isRoomFolder(raw.folder), 'folder')
    const folder = raw.folder as string
    need(isRoomName(raw.name) && raw.name === folder.slice(folder.lastIndexOf('/') + 1), 'name')
    need(VIEWS.includes(raw.view as LiteRoomView), 'view')
    need(raw.cols === null || (isInt(raw.cols) && raw.cols >= 1 && raw.cols <= 48), 'cols')
    need(Array.isArray(raw.tiles) && raw.tiles.length <= LITE_ROOM_MAX_LISTED, 'tiles')
    need(Array.isArray(raw.folders) && raw.folders.length <= LITE_ROOM_MAX_LISTED, 'folders')
    need(Array.isArray(raw.pages) && raw.pages.length <= LITE_ROOM_MAX_PAGES, 'pages')
    need(isObj(raw.more), 'more')
    const more = raw.more as Record<string, unknown>
    need(isInt(more.files) && more.files >= 0 && isInt(more.folders) && more.folders >= 0, 'more')
    const seen = new Set<string>()
    const tiles: LiteRoomTile[] = (raw.tiles as unknown[]).map((t, i) => {
      const at = `tiles[${i}]`
      need(isObj(t), at)
      const o = t as Record<string, unknown>
      need(isRoomName(o.name), `${at}.name`)
      // Version 1 lists only files directly in the room: the path inside it IS the name.
      need(o.relPath === o.name, `${at}.relPath`)
      need(!seen.has(o.name as string), `${at}.name repeated`)
      seen.add(o.name as string)
      need(typeof o.kind === 'string' && /^[a-z-]{1,32}$/.test(o.kind), `${at}.kind`)
      need(isInt(o.size) && o.size >= 0, `${at}.size`)
      need(typeof o.inCloud === 'boolean', `${at}.inCloud`)
      return { name: o.name as string, relPath: o.relPath as string, kind: o.kind as string, size: o.size as number, inCloud: o.inCloud as boolean, desk: deskOf(o.desk, at), workcentre: cellOf(o.workcentre, at) }
    })
    const folders = (raw.folders as unknown[]).map((f, i) => {
      const at = `folders[${i}]`
      need(isObj(f), at)
      const o = f as Record<string, unknown>
      need(isRoomName(o.name) && o.relPath === o.name, `${at}.name`)
      need(!seen.has(o.name as string), `${at}.name repeated`)
      seen.add(o.name as string)
      return { name: o.name as string, relPath: o.relPath as string }
    })
    const pages = (raw.pages as unknown[]).map((p, i) => {
      const at = `pages[${i}]`
      need(isObj(p), at)
      const o = p as Record<string, unknown>
      need(isWebAddress(o.url), `${at}.url`)
      need(o.title === null || (typeof o.title === 'string' && o.title.length <= 300), `${at}.title`)
      return { url: o.url as string, title: (o.title as string | null) ?? null, desk: deskOf(o.desk, at), workcentre: cellOf(o.workcentre, at) }
    })
    return {
      ok: true,
      room: {
        format: LITE_ROOM_FORMAT,
        version: LITE_ROOM_VERSION,
        createdAt: raw.createdAt as string,
        app: raw.app as string,
        folder,
        name: raw.name as string,
        view: raw.view as LiteRoomView,
        cols: raw.cols as number | null,
        tiles,
        folders,
        pages,
        more: { files: more.files as number, folders: more.folders as number }
      }
    }
  } catch (e) {
    if (e instanceof Bad) return { ok: false, refusal: 'schema', detail: e.message }
    throw e
  }
}

// ── What comes in, and what doesn't ─────────────────────────────────────────

/**
 * Why something stays behind. Known before asking: `in-cloud` (only in iCloud:
 * reading it would download it), `folder` (version 1 brings the files directly in
 * the room), `count` and `size` (Plexii's limits for one room), `unlisted` (more
 * than PlexiiLite lists). Found while copying, after the person said yes: `gone`,
 * `not-a-file` (a package or a special file), `outside` (a link out of the folder),
 * `denied` (macOS didn't let Plexii read it), `unreadable`.
 */
export type LeftOutWhy = 'in-cloud' | 'folder' | 'count' | 'size' | 'unlisted' | 'gone' | 'not-a-file' | 'outside' | 'denied' | 'unreadable'

export interface LeftOut {
  /** The name, or for `unlisted` a count ("12 more files"). */
  name: string
  why: LeftOutWhy
}

export interface LiteRoomPlan {
  room: LiteRoom
  /** The files to copy, in the room's order. */
  bring: LiteRoomTile[]
  /** Their total size as PlexiiLite listed it (each is checked again when copied). */
  bytes: number
  /** The browser windows, each a browser on the desk. */
  pages: LiteRoomPage[]
  leftOut: LeftOut[]
}

export function planLiteRoom(room: LiteRoom, limits: { files: number; bytes: number } = { files: LITE_ROOM_MAX_FILES, bytes: LITE_ROOM_MAX_TOTAL_BYTES }): LiteRoomPlan {
  const bring: LiteRoomTile[] = []
  const leftOut: LeftOut[] = []
  let bytes = 0
  for (const t of room.tiles) {
    if (t.inCloud) leftOut.push({ name: t.name, why: 'in-cloud' })
    else if (bring.length >= limits.files) leftOut.push({ name: t.name, why: 'count' })
    else if (bytes + t.size > limits.bytes) leftOut.push({ name: t.name, why: 'size' })
    else {
      bring.push(t)
      bytes += t.size
    }
  }
  for (const f of room.folders) leftOut.push({ name: f.name, why: 'folder' })
  if (room.more.files) leftOut.push({ name: `${room.more.files} more ${room.more.files === 1 ? 'file' : 'files'}`, why: 'unlisted' })
  if (room.more.folders) leftOut.push({ name: `${room.more.folders} more ${room.more.folders === 1 ? 'folder' : 'folders'}`, why: 'unlisted' })
  return { room, bring, bytes, pages: room.pages, leftOut }
}

// ── The words ───────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/** A size as people read it: "980 bytes", "12 KB", "3.4 MB", "1.2 GB". */
export function sizeWords(bytes: number): string {
  if (bytes < 1000) return plural(bytes, 'byte')
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes
  let u = -1
  do {
    v /= 1000
    u++
  } while (v >= 1000 && u < units.length - 1)
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[u]}`
}

/** A path as people read it: the home folder as "~". */
export function homeShort(path: string, home: string): string {
  const h = home.replace(/\/+$/, '')
  return h && (path === h || path.startsWith(`${h}/`)) ? `~${path.slice(h.length)}` : path
}

/** Why, in a few words, for the summary after: "talk.mov (only in iCloud)". */
export const LEFT_OUT_SHORT: Record<LeftOutWhy, string> = {
  'in-cloud': 'only in iCloud',
  folder: 'a folder',
  count: `over the ${LITE_ROOM_MAX_FILES}-file limit`,
  size: 'over the 1 GB limit',
  unlisted: 'not listed by PlexiiLite',
  gone: 'no longer there',
  'not-a-file': 'not a plain file',
  outside: 'a link to outside the folder',
  denied: 'Plexii wasn’t allowed to read it',
  unreadable: 'couldn’t be read'
}

/** Why, said in full, for a group in the question: "Only in iCloud (Plexii doesn’t download it)". */
const LEFT_OUT_LONG: Record<LeftOutWhy, (n: number) => string> = {
  'in-cloud': (n) => `Only in iCloud, so Plexii doesn’t download ${n === 1 ? 'it' : 'them'}`,
  folder: (n) => `${n === 1 ? 'A folder' : 'Folders'}: only the files directly in the room come in`,
  count: () => `Over Plexii’s limit of ${LITE_ROOM_MAX_FILES} files from one room`,
  size: () => 'Over Plexii’s limit of 1 GB from one room',
  unlisted: () => 'More than PlexiiLite lists',
  gone: () => 'No longer there',
  'not-a-file': (n) => (n === 1 ? 'Not a plain file (a package or a special file)' : 'Not plain files (packages or special files)'),
  outside: (n) => (n === 1 ? 'A link to somewhere outside the folder' : 'Links to somewhere outside the folder'),
  denied: (n) => `Plexii wasn’t allowed to read ${n === 1 ? 'it' : 'them'}`,
  unreadable: () => 'Couldn’t be read'
}

const listNames = (names: string[], max = 4): string => (names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`)

/** The left-out lines of the question, grouped by why, in the order they were found. */
export function leftOutLines(leftOut: LeftOut[]): string[] {
  const groups = new Map<LeftOutWhy, string[]>()
  for (const l of leftOut) groups.set(l.why, [...(groups.get(l.why) ?? []), l.name])
  return [...groups].map(([why, names]) => `• ${listNames(names)}. ${LEFT_OUT_LONG[why](names.length)}.`)
}

export interface LiteRoomQuestion {
  message: string
  detail: string
  /** [yes, no]: the dialog's buttons, yes first. */
  buttons: [string, string]
}

/** The question asked before anything is brought in: the folder, how much, the copy, what's left out and why. */
export function liteRoomQuestion(plan: LiteRoomPlan, home: string): LiteRoomQuestion {
  const { room } = plan
  const what = [plan.bring.length ? `${plural(plan.bring.length, 'file')} (${sizeWords(plan.bytes)})` : '', plan.pages.length ? plural(plan.pages.length, 'browser window') : ''].filter(Boolean).join(' and ')
  const lines = [
    `Plexii will make a new desk, “${room.name}”, with its own copy of ${what} from ${homeShort(room.folder, home)}, laid out as they are in PlexiiLite.`,
    '',
    'The folder and its files aren’t changed: Plexii keeps its own copy.'
  ]
  if (plan.leftOut.length) lines.push('', `Left out (${plan.leftOut.length}):`, ...leftOutLines(plan.leftOut))
  return { message: `Bring “${room.name}” into Plexii?`, detail: lines.join('\n'), buttons: ['Bring In', 'Cancel'] }
}

/** Nothing could come in: said instead of asking. */
export function liteRoomNothing(plan: LiteRoomPlan): string {
  const why = leftOutLines(plan.leftOut).map((l) => l.replace(/^• /, ''))
  return `Nothing in “${plan.room.name}” can be brought into Plexii.${why.length ? ` ${why.join(' ')}` : ' The room is empty.'}`
}

/** What was done, after: "24 files brought in from “Projects”; 2 left out: talk.mov (only in iCloud), Ideas (a folder)." */
export function liteRoomSummary(name: string, files: number, pages: number, leftOut: LeftOut[]): string {
  const came = [plural(files, 'file'), pages ? plural(pages, 'browser window') : ''].filter(Boolean).join(' and ')
  const head = `${came} brought in from “${name}”`
  if (!leftOut.length) return `${head}.`
  const named = leftOut.slice(0, 3).map((l) => `${l.name} (${LEFT_OUT_SHORT[l.why]})`)
  const rest = leftOut.length > 3 ? ` and ${leftOut.length - 3} more` : ''
  return `${head}; ${leftOut.length} left out: ${named.join(', ')}${rest}.`
}

/** Why nothing was brought in, said to the person. */
export const LITE_ROOM_REFUSED: Record<LiteRoomRefusal | 'missing' | 'unreadable', string> = {
  missing: 'That room from PlexiiLite isn’t there any more, so nothing was brought in. Send it again from PlexiiLite (Open This Room in Plexii).',
  unreadable: 'That room from PlexiiLite couldn’t be read, so nothing was brought in. Send it again from PlexiiLite.',
  format: 'That wasn’t a room from PlexiiLite, so nothing was brought in.',
  schema: 'That room from PlexiiLite couldn’t be trusted in full, so nothing was brought in. Send it again from PlexiiLite.',
  newer: 'That room was sent by a newer PlexiiLite than this Plexii reads. Update Plexii, then send it again.',
  expired: 'That room was sent from PlexiiLite more than a day ago, so nothing was brought in. Send it again from PlexiiLite.',
  future: 'That room from PlexiiLite has a date in the future, so nothing was brought in. Check this Mac’s clock, then send it again.'
}

// ── Where things go on the desk ─────────────────────────────────────────────

/** What a tile becomes on a Plexii desk: a file (as dropped from Finder), or a browser window. */
export type LiteRoomObjectKind = 'file' | 'page'

export interface LiteRoomObject {
  /** The tile's name, or "page/<n>" for a browser window. */
  key: string
  kind: LiteRoomObjectKind
  desk: LiteRoomDesk | null
  cell: LiteRoomCell | null
}

export interface LiteRoomPlacement {
  x: number
  y: number
  width: number
  height: number
}

export interface LiteRoomLayout {
  /** Canvas places by key, in world px. */
  canvas: Record<string, LiteRoomPlacement>
  /** The order to create them in: back to front (Plexii stacks each new object on top). */
  order: string[]
  /** The Workcentre, in grid units, by key; null when the room had none. */
  workcentre: { cols: number; items: Record<string, LiteRoomCell> } | null
  /** The view the new desk opens in. */
  view: 'canvas' | 'workcentre' | 'list'
}

/** Where the arrangement starts on the new desk's canvas (Plexii's own default place for a new object). */
export const LITE_ROOM_ORIGIN = { x: 60, y: 60 } as const
/** Sizes for a tile never placed on the Desk: Plexii's own for a dropped file and a browser. */
export const LITE_ROOM_DEFAULT_SIZE: Record<LiteRoomObjectKind, { w: number; h: number }> = { file: { w: 320, h: 240 }, page: { w: 520, h: 360 } }
const GAP = 24
const ROW_MIN_WIDTH = 1200

/**
 * PlexiiLite's places on a Plexii desk. The Desk's world pixels are Plexii's canvas
 * pixels: moved together so the arrangement starts at LITE_ROOM_ORIGIN, sizes kept
 * (Plexii's createWidget raises any below what it can show), in the same stacking
 * order. Tiles never placed on the Desk are laid out in rows below the rest, in the
 * room's order. The Workcentre's tiles are Plexii's Workcentre tiles (the same grid:
 * 24 px rows, 12 px gaps; Plexii reflows the columns to its own view's width).
 */
export function mapLiteRoomLayout(objects: LiteRoomObject[], cols: number | null, view: LiteRoomView): LiteRoomLayout {
  const placed = objects.filter((o) => o.desk)
  const canvas: Record<string, LiteRoomPlacement> = {}
  let bottom: number = LITE_ROOM_ORIGIN.y
  let right: number = LITE_ROOM_ORIGIN.x + ROW_MIN_WIDTH
  if (placed.length) {
    const minX = Math.min(...placed.map((o) => o.desk!.x))
    const minY = Math.min(...placed.map((o) => o.desk!.y))
    for (const o of placed) {
      const d = o.desk!
      const p = { x: Math.round(d.x - minX + LITE_ROOM_ORIGIN.x), y: Math.round(d.y - minY + LITE_ROOM_ORIGIN.y), width: Math.round(d.w), height: Math.round(d.h) }
      canvas[o.key] = p
      bottom = Math.max(bottom, p.y + p.height + GAP * 2)
      right = Math.max(right, p.x + p.width)
    }
  }
  // The rest, in rows below.
  let x: number = LITE_ROOM_ORIGIN.x
  let y = bottom
  let rowH = 0
  for (const o of objects) {
    if (o.desk) continue
    const s = LITE_ROOM_DEFAULT_SIZE[o.kind]
    if (x > LITE_ROOM_ORIGIN.x && x + s.w > right) {
      x = LITE_ROOM_ORIGIN.x
      y += rowH + GAP
      rowH = 0
    }
    canvas[o.key] = { x, y, width: s.w, height: s.h }
    x += s.w + GAP
    rowH = Math.max(rowH, s.h)
  }
  // Back to front: the placed ones by their stacking order (ties keep the room's order), then the rest.
  const index = new Map(objects.map((o, i) => [o.key, i]))
  const order = [
    ...placed.slice().sort((a, b) => a.desk!.z - b.desk!.z || index.get(a.key)! - index.get(b.key)!).map((o) => o.key),
    ...objects.filter((o) => !o.desk).map((o) => o.key)
  ]
  const cells = objects.filter((o) => o.cell)
  const workcentre = cols !== null && cells.length ? { cols, items: Object.fromEntries(cells.map((o) => [o.key, { ...o.cell!, w: Math.min(o.cell!.w, cols) }])) } : null
  return { canvas, order, workcentre, view: view === 'workcentre' ? 'workcentre' : view === 'list' ? 'list' : 'canvas' }
}

// ── What the window hears back ──────────────────────────────────────────────

/**
 * Why nothing came in. `declined`: the person said no. `busy`: this room is being
 * asked about already (a second window). `done`: already asked about this session.
 * `empty`: nothing in it could come in. `folder`: its folder isn't there, or macOS
 * didn't let Plexii read it. The rest are LiteRoomRefusal and `missing`/`unreadable`.
 */
export type LiteRoomStop = LiteRoomRefusal | 'declined' | 'busy' | 'done' | 'missing' | 'unreadable' | 'empty' | 'folder'

export type LiteRoomBegin =
  | {
      ok: true
      title: string
      node: FbNode
      widgets: Widget[]
      /** The Workcentre, keyed by the new widgets' ids, for the renderer to keep with this person's layout. */
      workcentre: WorkcentreLayout | null
      view: 'canvas' | 'workcentre' | 'list'
      files: number
      pages: number
      leftOut: LeftOut[]
      summary: string
    }
  | { ok: false; stop: LiteRoomStop; message: string }
