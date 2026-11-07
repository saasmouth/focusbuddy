// The desktop end of "Download this desk on Plexii" (shared/deskHandoff.ts).
//
// A deep link plexii://desk?handoff=<id> names a visitor's copy of a shared
// desk, waiting on Signal. It usually arrives in an app nobody is signed in to
// yet -- the person has just installed it from the share page -- and the
// account is required before anything opens (LaunchSignInModal). So the id is
// KEPT here, on disk, until the renderer has a session to claim it with:
// signing up can take minutes, and the app can be quit and reopened on the way.
//
// The claim itself is the renderer's (it holds the session token and speaks to
// Signal, like every other account call); the import is here, because it writes
// the database and the file store.
import { app, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESK_HANDOFF_ID, rekeyDeskBundle, type RekeyableBundle } from '@shared/deskHandoff'
import { VISITOR_LAYOUT_USER } from '@shared/sitePresentation'
import { importDeskBundle, DESK_BUNDLE_FORMAT, DESK_BUNDLE_VERSION, type DeskBundle } from './db/deskBundle'
import { ensureDeskLayoutSchema } from './db/deskLayoutStore'
import { getDb } from './db/database'

export interface PendingDeskHandoff {
  id: string
  /** When the link arrived (ms). */
  at: number
}

/** A pending handoff older than this is dropped: Signal keeps them 30 days. */
export const PENDING_HANDOFF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

let memo: PendingDeskHandoff | null | undefined

function file(): string {
  return join(app.getPath('userData'), 'desk-handoff.json')
}

/** The handoff waiting to be claimed, if any. */
export function pendingDeskHandoff(now: number = Date.now()): PendingDeskHandoff | null {
  if (memo === undefined) {
    memo = null
    try {
      if (existsSync(file())) {
        const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<PendingDeskHandoff>
        if (typeof raw.id === 'string' && DESK_HANDOFF_ID.test(raw.id) && typeof raw.at === 'number') {
          memo = { id: raw.id, at: raw.at }
        }
      }
    } catch {
      memo = null
    }
  }
  if (memo && now - memo.at > PENDING_HANDOFF_MAX_AGE_MS) {
    clearDeskHandoff(memo.id)
    return null
  }
  return memo
}

/** Keep a handoff until it is claimed. A newer link replaces an older one. */
export function rememberDeskHandoff(id: string, now: number = Date.now()): PendingDeskHandoff | null {
  if (!DESK_HANDOFF_ID.test(id)) return null
  memo = { id, at: now }
  try {
    writeFileSync(file(), JSON.stringify(memo))
  } catch {
    // Kept in memory for this run; a quit before sign-in loses it, which the
    // share page's "Open this desk in Plexii" button can always send again.
  }
  return memo
}

/** Forget a handoff (claimed, or gone on the server). Only that one. */
export function clearDeskHandoff(id?: string): void {
  if (id && memo && memo.id !== id) return
  memo = null
  try {
    rmSync(file(), { force: true })
  } catch {
    /* nothing to remove */
  }
}

/** The deep link arrived: keep it and tell every window. */
export function receiveDeskHandoff(id: string): void {
  const kept = rememberDeskHandoff(id)
  if (!kept) return
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send('deskHandoff:incoming', kept)
    } catch {
      /* still loading: it asks for the pending one when it is ready */
    }
    if (win.isMinimized()) win.restore()
    win.focus()
  }
}

export interface DeskHandoffImport {
  ok: boolean
  /** The desk (or room) that arrived, under its NEW id. */
  rootId?: string
  rootKind?: 'task' | 'folder'
  title?: string
  imported?: number
  filesOmitted?: number
  reason?: string
}

/**
 * Import a claimed handoff's bundle into this workspace, under fresh ids and
 * as the signed-in person's own (see rekeyDeskBundle for why).
 */
export async function importDeskHandoff(bundleText: string, accountId: string): Promise<DeskHandoffImport> {
  let parsed: RekeyableBundle
  try {
    parsed = JSON.parse(String(bundleText ?? '')) as RekeyableBundle
  } catch {
    return { ok: false, reason: 'The desk could not be read.' }
  }
  if (parsed?.format !== DESK_BUNDLE_FORMAT || parsed.formatVersion !== DESK_BUNDLE_VERSION || !parsed.tables || !parsed.desk) {
    return { ok: false, reason: 'That is not a Plexii desk this version can open.' }
  }
  const layoutUser = String(accountId || '').trim()
  if (!layoutUser) return { ok: false, reason: 'Sign in first.' }

  const { bundle } = rekeyDeskBundle(parsed, {
    newId: () => randomUUID(),
    layoutUser,
    visitorLayoutUser: VISITOR_LAYOUT_USER
  })
  // desk_layouts is created on first use; a workspace that has never arranged a
  // Workcentre would otherwise drop every layout the desk brought with it.
  try {
    ensureDeskLayoutSchema(getDb() as unknown as Parameters<typeof ensureDeskLayoutSchema>[0])
  } catch {
    /* the import carries on without layouts */
  }
  const result = await importDeskBundle(bundle as unknown as DeskBundle)
  if (!result.ok) return { ok: false, reason: result.reason ?? 'The desk could not be added.' }
  const root = (bundle.tables.nodes ?? []).find((n) => n.id === bundle.desk.id)
  return {
    ok: true,
    rootId: bundle.desk.id,
    rootKind: root?.kind === 'folder' ? 'folder' : 'task',
    title: bundle.desk.title,
    imported: result.imported,
    filesOmitted: bundle.filesOmitted?.length ?? 0
  }
}

/** Tests: forget the cached pending handoff. */
export function resetDeskHandoffForTests(): void {
  memo = undefined
}
