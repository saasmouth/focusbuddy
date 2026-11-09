// "Open This Room in Plexii", the app end (shared/liteRoom.ts has the contract;
// docs/PLEXIILITE-ROOM-HANDOFF.md says it in full).
//
// A plexii://lite-room?id=<id> link names a room PlexiiLite described in its own
// data folder. Like a desk handed over by a share page (deskHandoffReceiver.ts),
// it can arrive in an app nobody is signed in to yet, and a desk is the
// signed-in person's: so the id is KEPT here, on disk, until the renderer has a
// session (LiteRoomEffects.tsx), and only then is the room read, the person
// ASKED, and the files brought in.
//
// The asking is here, in main, in the same call that reads and imports: the
// window can't bring a room in without the person's yes, and a link alone (a web
// page can open plexii:// links) never does.
//
// The bringing in is the drop pipeline's: each file is copied into Plexii's own
// store by ingestFromPath (as a file dropped from Finder is, by ingestFromBuffer:
// the same copy, the same image shrinking, the same fb_files row), and placed as
// a `file` widget holding that copy by createWidget, with the same events a
// create from the window emits. The renderer then tells the sync engine about the
// new desk and widgets, exactly as its own creates do.
import { app, BrowserWindow, dialog } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Widget, WidgetDraft } from '@shared/types'
import type { WorkcentreLayout } from '@shared/deskLayout'
import {
  homeShort,
  LITE_ROOM_ID,
  LITE_ROOM_MAX_AGE_MS,
  LITE_ROOM_MAX_TOTAL_BYTES,
  LITE_ROOM_REFUSED,
  liteRoomNothing,
  liteRoomQuestion,
  liteRoomSummary,
  mapLiteRoomLayout,
  planLiteRoom,
  type LeftOut,
  type LiteRoomBegin,
  type LiteRoomObject,
  type LiteRoomPlan
} from '@shared/liteRoom'
import { checkRoomFile, checkRoomFolder, readLiteRoomHandoff } from './liteRoomFiles'
import { createNode } from './db/nodes'
import { createWidget } from './db/widgets'
import { createFolder } from './db/files'
import { ingestFromPath } from './db/filesFromDisk'
import { emitObjectEvent, markReviewed } from './context/engine'

export interface PendingLiteRoom {
  id: string
  /** When the link arrived (ms). */
  at: number
}

let memo: PendingLiteRoom | null | undefined

const pendingFile = (): string => join(app.getPath('userData'), 'lite-room.json')

/**
 * PlexiiLite's data folder: where its handoffs are. Its own name, pinned by
 * PlexiiLite (main/index.ts there), in this user's Application Support. The e2e
 * harness alone may point it elsewhere (FB_TEST_LITE_DATA): never a packaged
 * build, and only on a throwaway test profile, so a test can never read the
 * owner's PlexiiLite.
 */
export function liteDataDir(env: NodeJS.ProcessEnv = process.env, packaged: boolean = app.isPackaged): string {
  if (env.FB_TEST_LITE_DATA && !packaged && env.NODE_ENV === 'test' && env.FB_TEST_USER_DATA) return env.FB_TEST_LITE_DATA
  return join(app.getPath('appData'), 'PlexiiLite')
}

/** The room waiting to be brought in, if any (a day at most: PlexiiLite's handoff lasts that long). */
export function pendingLiteRoom(now: number = Date.now()): PendingLiteRoom | null {
  if (memo === undefined) {
    memo = null
    try {
      if (existsSync(pendingFile())) {
        const raw = JSON.parse(readFileSync(pendingFile(), 'utf8')) as Partial<PendingLiteRoom>
        if (typeof raw.id === 'string' && LITE_ROOM_ID.test(raw.id) && typeof raw.at === 'number') memo = { id: raw.id, at: raw.at }
      }
    } catch {
      memo = null
    }
  }
  if (memo && now - memo.at > LITE_ROOM_MAX_AGE_MS) {
    clearLiteRoom(memo.id)
    return null
  }
  return memo
}

/** Keep a room until it can be asked about. A newer link replaces an older one. */
export function rememberLiteRoom(id: string, now: number = Date.now()): PendingLiteRoom | null {
  if (!LITE_ROOM_ID.test(id)) return null
  memo = { id, at: now }
  try {
    writeFileSync(pendingFile(), JSON.stringify(memo))
  } catch {
    // Kept in memory for this run; PlexiiLite can always send it again.
  }
  return memo
}

/** Forget a room (asked about, refused, or gone). Only that one. */
export function clearLiteRoom(id?: string): void {
  if (id && memo && memo.id !== id) return
  memo = null
  try {
    rmSync(pendingFile(), { force: true })
  } catch {
    /* nothing to remove */
  }
}

/** The deep link arrived: keep it and tell every window (which asks once someone is signed in). */
export function receiveLiteRoom(id: string): void {
  const kept = rememberLiteRoom(id)
  if (!kept) return
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send('liteRoom:incoming', kept)
    } catch {
      /* still loading: it asks for the pending one when it is ready */
    }
    if (win.isMinimized()) win.restore()
    win.focus()
  }
}

const asking = new Set<string>()
const done = new Set<string>()

/** Ask the person: yes is 0. */
export type LiteRoomAsk = (q: { message: string; detail: string; buttons: [string, string] }) => Promise<boolean>

/** The question, as a sheet on the window that asked (or the app's own dialog). */
export function askWithDialog(win: BrowserWindow | null): LiteRoomAsk {
  return async (q) => {
    const opts = { type: 'question' as const, message: q.message, detail: q.detail, buttons: q.buttons, defaultId: 0, cancelId: 1, noLink: true }
    const r = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    return r.response === 0
  }
}

/**
 * Read the room the link named, ask, and bring it in on yes. The pending id is
 * forgotten whatever the answer: a refusal, a no or a yes all end it (PlexiiLite
 * sends a new id each time the person chooses Open This Room in Plexii).
 */
export async function beginLiteRoom(id: string, ask: LiteRoomAsk, opts: { liteData?: string; home?: string; now?: number } = {}): Promise<LiteRoomBegin> {
  if (!LITE_ROOM_ID.test(id)) return { ok: false, stop: 'missing', message: LITE_ROOM_REFUSED.missing }
  if (asking.has(id)) return { ok: false, stop: 'busy', message: '' }
  if (done.has(id)) {
    clearLiteRoom(id)
    return { ok: false, stop: 'done', message: 'That room from PlexiiLite has already been brought in.' }
  }
  asking.add(id)
  try {
    const read = readLiteRoomHandoff(opts.liteData ?? liteDataDir(), id, opts.now)
    if (!read.ok) {
      clearLiteRoom(id)
      return { ok: false, stop: read.refusal, message: LITE_ROOM_REFUSED[read.refusal] }
    }
    const plan = planLiteRoom(read.room)
    if (!plan.bring.length && !plan.pages.length) {
      clearLiteRoom(id)
      return { ok: false, stop: 'empty', message: liteRoomNothing(plan) }
    }
    const yes = await ask(liteRoomQuestion(plan, opts.home ?? homedir()))
    clearLiteRoom(id)
    done.add(id)
    if (!yes) return { ok: false, stop: 'declined', message: `Nothing was brought in from “${read.room.name}”.` }
    return await importLiteRoom(plan, opts.home ?? homedir())
  } finally {
    asking.delete(id)
  }
}

/** Copy the room's files in (the drop pipeline), make its desk, and place everything as it was. */
export async function importLiteRoom(plan: LiteRoomPlan, home: string): Promise<LiteRoomBegin> {
  const { room } = plan
  const folder = checkRoomFolder(room.folder)
  if (!folder.ok) {
    const where = homeShort(room.folder, home)
    const message =
      folder.why === 'denied'
        ? `Plexii wasn’t allowed to read ${where}, so nothing was brought in. Allow Plexii in System Settings › Privacy & Security › Files and Folders, then send the room again from PlexiiLite.`
        : `${where} isn’t there any more, so nothing was brought in.`
    return { ok: false, stop: 'folder', message }
  }
  const leftOut: LeftOut[] = [...plan.leftOut]
  const copied: { key: string; title: string; fileId: string; desk: LiteRoomObject['desk']; cell: LiteRoomObject['cell'] }[] = []
  let total = 0
  let filesFolder: { id: string } | null = null
  for (const t of plan.bring) {
    const c = checkRoomFile(folder.real, t.relPath)
    if (!c.ok) {
      leftOut.push({ name: t.name, why: c.why })
      continue
    }
    // The limit holds for the files as they are now, not only as PlexiiLite listed them.
    if (total + c.size > LITE_ROOM_MAX_TOTAL_BYTES) {
      leftOut.push({ name: t.name, why: 'size' })
      continue
    }
    try {
      // In Files, beside the desk: a folder named after the room (made with the first file that comes in).
      filesFolder ??= createFolder(null, room.name)
      const file = await ingestFromPath(c.path, { originalName: t.name, parentId: filesFolder.id })
      total += c.size
      copied.push({ key: t.name, title: t.name, fileId: file.id, desk: t.desk, cell: t.workcentre })
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      leftOut.push({ name: t.name, why: code === 'EACCES' || code === 'EPERM' ? 'denied' : code === 'ENOENT' ? 'gone' : 'unreadable' })
    }
  }
  if (!copied.length && !plan.pages.length) {
    return { ok: false, stop: 'empty', message: liteRoomNothing({ ...plan, leftOut }) }
  }

  // The desk, as nodes:create makes one (a real create: its event, and reviewed by its maker).
  const node = createNode({ parentId: null, kind: 'task', title: room.name })
  emitObjectEvent({
    eventType: 'DeskCreated',
    category: 'user',
    objectId: node.id,
    deskId: null,
    currentState: { title: node.title, kind: node.kind, importance: node.importance, status: node.status },
    changeSummary: `Created ${node.kind} "${node.title}"`
  })
  markReviewed(node.id)

  const objects: LiteRoomObject[] = [
    ...copied.map((c) => ({ key: c.key, kind: 'file' as const, desk: c.desk, cell: c.cell })),
    ...plan.pages.map((p, i) => ({ key: `page/${i}`, kind: 'page' as const, desk: p.desk, cell: p.workcentre }))
  ]
  const layout = mapLiteRoomLayout(objects, room.cols, room.view)
  const fileOf = new Map(copied.map((c) => [c.key, c]))
  const widgets: Widget[] = []
  const idOf = new Map<string, string>()
  for (const key of layout.order) {
    const at = layout.canvas[key]!
    const file = fileOf.get(key)
    const page = file ? null : plan.pages[Number(key.slice('page/'.length))]!
    const draft: WidgetDraft = file
      ? { taskId: node.id, kind: 'file', title: file.title, content: file.fileId, x: at.x, y: at.y, width: at.width, height: at.height, color: null }
      : { taskId: node.id, kind: 'webview', title: page!.title || new URL(page!.url).hostname, content: page!.url, x: at.x, y: at.y, width: at.width, height: at.height }
    // As widgets:create makes one: the row, its event, reviewed by its maker.
    const w = createWidget(draft)
    emitObjectEvent({
      eventType: 'WidgetCreated',
      category: 'user',
      objectId: w.id,
      deskId: w.taskId ?? null,
      currentState: { kind: w.kind, title: w.title ?? null },
      changeSummary: `Added ${w.kind}${w.title ? ` "${w.title}"` : ''}`
    })
    markReviewed(w.id)
    widgets.push(w)
    idOf.set(key, w.id)
  }
  const workcentre: WorkcentreLayout | null = layout.workcentre
    ? { cols: layout.workcentre.cols, items: Object.fromEntries(Object.entries(layout.workcentre.items).flatMap(([k, cell]) => (idOf.has(k) ? [[idOf.get(k)!, cell]] : []))) }
    : null
  return {
    ok: true,
    title: room.name,
    node,
    widgets,
    workcentre,
    view: layout.view,
    files: copied.length,
    pages: plan.pages.length,
    leftOut,
    summary: liteRoomSummary(room.name, copied.length, plan.pages.length, leftOut)
  }
}

/** Tests: forget the cached pending room and the rooms asked about. */
export function resetLiteRoomForTests(): void {
  memo = undefined
  asking.clear()
  done.clear()
}
