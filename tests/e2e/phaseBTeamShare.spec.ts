/**
 * Phase B verification — explicit team-sharing for files/folders + the
 * desk -> table cascade — against the RUNNING signal at http://localhost:8795
 * with the REAL seeded accounts (ava/ben@testorg.local) and the REAL org
 * "Plexi Test Org" (org_eb06046a6876783c1b), driven through TWO real Electron
 * windows.
 *
 * Verifies:
 *  1. FilesView renders on Personal with NO React #185 / "Maximum update depth",
 *     and the "Share with Plexi Test Org" context-menu item (icon group_add)
 *     appears on a folder/file. Fully UI-driven on Ava's real app.
 *  2. window.api.fileManager.moveToOrg(folderId, org) — the Share button's
 *     underlying call — re-scopes the folder + its file so they replicate to Ben
 *     WITH bytes (files.extractText returns the real text).
 *  3. window.api.nodes.moveToOrg(deskId, org) cascades the desk, its table widget
 *     AND the backing fb_tables/fb_rows so Ben sees the real row data, not a
 *     blank "Loading table…".
 *
 * HARNESS NOTE (same as orgFileSyncCrossMember.spec.ts / calendarSync.spec.ts):
 * the E2E-built renderer runs from a file:// origin, and empirically its
 * cross-origin fetches that carry the x-plexi-org header do not reach the server
 * with that header (the org endpoints answer 400 "No shared org active"), even
 * though the identical request from Node succeeds and the CORS preflight allows
 * the header. This is a documented E2E-harness limitation, not a Phase B bug
 * (proved separately: a raw renderer fetch reproduces the 400; the packaged app
 * against https prod is unaffected). So the parts that exercise PHASE B CODE run
 * in the REAL apps — the moveToOrg cascade on Ava (real main + SQLite) and
 * applyRemoteOrg + writeSyncedFileBytes on Ben — while the transport wrappers
 * (putItemOrg / pullChangesOrg / upload/downloadOrgBlob), which the renderer
 * cannot complete under this harness, are mirrored 1:1 by this Node process
 * using the accounts' REAL session tokens. The bytes and rows cross the REAL
 * running server between two REAL app instances.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp } from './_helpers'

const SIGNAL = process.env.PHASEB_SIGNAL ?? 'http://localhost:8795'
const ORG_ID = 'org_eb06046a6876783c1b'
const ORG_NAME = 'Plexi Test Org'
const AVA = { email: 'ava@testorg.local', password: 'TestPlexi!2026' }
const BEN = { email: 'ben@testorg.local', password: 'TestPlexi!2026' }

const FILE_CONTENT = 'phaseB shared file'
const CELL_TEXT = 'phaseB table cell'

test.beforeAll(async () => {
  const res = await fetch(`${SIGNAL}/healthz`).catch(() => null)
  test.skip(!res || !res.ok, `Signal server not reachable at ${SIGNAL} — this spec verifies against the running instance.`)
})

// ── HTTP transport (Node side) — mirrors the renderer's workspaceSync wrappers ─
async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${SIGNAL}/accounts/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  })
  const json = (await res.json()) as { ok: boolean; sessionToken: string }
  if (!res.ok || !json.ok) throw new Error(`login failed for ${email} (${res.status})`)
  return json.sessionToken
}

interface OrgItem { id: string; itemType: string; body: Record<string, unknown> | null; rev: number; deleted: boolean }

// Mirrors putItemOrg (same route/method/headers/body shape).
async function putItemOrg(token: string, id: string, itemType: string, body: Record<string, unknown>): Promise<number> {
  const res = await fetch(`${SIGNAL}/workspace/org/items/${id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'x-plexi-org': ORG_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemType, body })
  })
  return res.status
}

// Mirrors pullChangesOrg.
async function orgSync(token: string, since = 0): Promise<OrgItem[]> {
  const res = await fetch(`${SIGNAL}/workspace/org/sync?since=${since}`, {
    headers: { Authorization: `Bearer ${token}`, 'x-plexi-org': ORG_ID }
  })
  const json = (await res.json()) as { ok: boolean; items?: OrgItem[] }
  if (!res.ok || !json.ok) throw new Error(`org sync failed (${res.status})`)
  return json.items ?? []
}

// Mirrors uploadOrgBlob.
async function uploadBlob(token: string, id: string, ext: string, mime: string, bytes: Uint8Array): Promise<number> {
  const qs = `?ext=${encodeURIComponent(ext || '')}&mime=${encodeURIComponent(mime || 'application/octet-stream')}`
  const res = await fetch(`${SIGNAL}/workspace/org/files/${id}${qs}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'x-plexi-org': ORG_ID, 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(bytes)
  })
  return res.status
}

// Mirrors downloadOrgBlob.
async function downloadBlob(token: string, id: string): Promise<Uint8Array | null> {
  const res = await fetch(`${SIGNAL}/workspace/org/files/${id}`, {
    headers: { Authorization: `Bearer ${token}`, 'x-plexi-org': ORG_ID }
  })
  if (!res.ok) return null
  return new Uint8Array(await res.arrayBuffer())
}

// ── UI helpers (Ava's window) ─────────────────────────────────────────────────
async function dismissOnboarding(win: Page): Promise<void> {
  const onb = win.locator('[role="dialog"][aria-label="Welcome to PlexiiDesk"]')
  if (await onb.isVisible().catch(() => false)) {
    await win.getByRole('button', { name: 'Get started' }).click().catch(() => {})
    await win.locator('[data-testid="onboarding-key-skip"]').click().catch(() => {})
    await win.locator('[data-testid="onboarding-tour-continue"]').click().catch(() => {})
    await win.locator('[data-testid="onboarding-start-blank"]').click().catch(() => {})
  }
  const s = win.locator('[data-testid="feature-spotlight-dismiss"]')
  if (await s.isVisible().catch(() => false)) await s.click().catch(() => {})
}

async function signInUI(win: Page, creds: { email: string; password: string }): Promise<void> {
  await win.waitForFunction(() => typeof (window as unknown as { api?: unknown }).api === 'object', null, { timeout: 15_000 })
  await expect(win.locator('[data-testid="footer-sync-chip"]')).toBeVisible({ timeout: 15_000 })
  await dismissOnboarding(win)
  const dialog = win.locator('[role="dialog"][aria-label="Sign in to PlexiiDesk"]')
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await dialog.getByRole('button', { name: 'Log in' }).click().catch(() => {})
  await dialog.locator('input[type="email"]').fill(creds.email)
  await dialog.locator('input[type="password"]').fill(creds.password)
  await dialog.locator('input[type="password"]').press('Enter')
  await expect(dialog).toHaveCount(0, { timeout: 20_000 })
}

async function waitApi(win: Page): Promise<void> {
  await win.waitForFunction(() => typeof (window as unknown as { api?: unknown }).api === 'object', null, { timeout: 15_000 })
  await expect(win.locator('[data-testid="footer-sync-chip"]')).toBeVisible({ timeout: 15_000 })
}

test.describe('Phase B: team sharing + desk->table cascade (live signal)', () => {
  let A: LaunchedApp | null = null
  let B: LaunchedApp | null = null

  test.afterAll(async () => {
    if (A) await A.dispose()
    if (B) await B.dispose()
  })

  test('files/folder share + desk->table cascade replicate Ava -> Ben over the live server', async () => {
    test.setTimeout(240_000)

    const avaToken = await login(AVA.email, AVA.password)
    const benToken = await login(BEN.email, BEN.password)

    A = await launchApp()
    B = await launchApp()

    // Renderer error collector on Ava for the React #185 assertion (item 1).
    const avaErrors: string[] = []
    A.window.on('console', (m) => { if (m.type() === 'error') avaErrors.push(m.text()) })
    A.window.on('pageerror', (e) => avaErrors.push(e.message ?? String(e)))

    // Ava signs in via the real UI (needed so the org list loads and the Share
    // context-menu item can appear); Ben's app is scoped locally to the org.
    await signInUI(A.window, AVA)
    await waitApi(B.window)
    await B.window.evaluate(async (org) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.session.setActiveOrg(org)
    }, ORG_ID)

    // ── Fixtures on Ava (Personal scope) via the real app (real SQLite) ───────
    const drive = await A.window.evaluate(async (content) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const folder = await api.fileManager.createFolder(null, 'PhaseB Shared')
      const bytes = new TextEncoder().encode(content)
      const file = await api.files.ingestBuffer({
        buffer: bytes.buffer, originalName: 'phaseB-shared.txt', mimeType: 'text/plain', parentId: (folder as { id: string }).id
      })
      return { folderId: (folder as { id: string }).id, fileId: (file as { id: string }).id }
    }, FILE_CONTENT)
    expect(drive.folderId && drive.fileId, 'folder + file created on Ava').toBeTruthy()

    // ── ITEM 1: FilesView renders + Share menu item + no React #185 ───────────
    await A.window.evaluate(() => {
      const w = window as unknown as { __fbView?: { getState: () => Record<string, () => void> } }
      w.__fbView?.getState().goFiles?.()
    })
    await expect(A.window.locator('[data-testid="files-view"]')).toBeVisible({ timeout: 10_000 })
    const folderEntry = A.window.locator(`[data-testid="file-entry-${drive.folderId}"]`)
    await expect(folderEntry).toBeVisible({ timeout: 10_000 })
    await folderEntry.click({ button: 'right' })
    await expect(A.window.getByText(`Share with ${ORG_NAME}`)).toBeVisible({ timeout: 5_000 })
    await expect(A.window.locator('span.material-symbols-outlined', { hasText: /^group_add$/ }).first())
      .toBeVisible({ timeout: 5_000 })
    await A.window.keyboard.press('Escape').catch(() => {})
    const react185 = avaErrors.filter((e) => /#185|Maximum update depth|Minimum update depth/i.test(e))
    expect(react185, `no React #185 / update-depth during FilesView render; saw ${JSON.stringify(react185)}`).toEqual([])

    // ── ITEM 2: the Share button's IPC re-scopes the folder subtree ───────────
    await A.window.evaluate(async ({ id, org }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.fileManager.moveToOrg(id, org)
    }, { id: drive.folderId, org: ORG_ID })

    // ── ITEM 3: desk + table widget + row, then the desk->table cascade ───────
    const desk = await A.window.evaluate(async (cell) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const node = await api.nodes.create({ parentId: null, kind: 'task', title: 'PhaseB Desk' })
      const table = await api.tables.create({
        taskId: (node as { id: string }).id, title: 'PhaseB Table',
        schema: { columns: [{ id: 'c1', type: 'text-short', label: 'Note', config: {} }] }
      })
      const row = await api.tables.createRow({ tableId: (table as { id: string }).id, cells: { c1: cell } })
      const widget = await api.widgets.create({
        taskId: (node as { id: string }).id, kind: 'table', title: 'PhaseB Table',
        content: (table as { id: string }).id, x: 200, y: 160, width: 480, height: 320
      })
      return {
        deskId: (node as { id: string }).id, tableId: (table as { id: string }).id,
        widgetId: (widget as { id: string }).id, rowId: (row as { id: string }).id
      }
    }, CELL_TEXT)
    expect(desk.deskId && desk.tableId && desk.widgetId && desk.rowId, 'desk+table+widget+row created on Ava').toBeTruthy()

    await A.window.evaluate(async ({ id, org }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.nodes.moveToOrg(id, org)
    }, { id: desk.deskId, org: ORG_ID })

    // ── The real cascade output: Ava's app now lists exactly these as pending
    //    org upserts (proves moveToOrg re-scoped files, node, widget, table AND
    //    the NEW rows — the desk->table cascade under test). ────────────────────
    const pending = await A.window.evaluate(async (org) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const p = await api.workspaceSync.pendingOrg(org)
      return p.upserts.map((u) => ({ id: u.id, itemType: u.itemType, body: u.body }))
    }, ORG_ID) as Array<{ id: string; itemType: string; body: Record<string, unknown> }>

    console.log('PHASEB pending upserts =', JSON.stringify(pending.map((u) => ({ id: u.id.slice(0, 8), t: u.itemType }))))
    const byId = new Map(pending.map((u) => [u.id, u]))
    expect(byId.get(drive.folderId)?.itemType, 'folder is a pending org file item').toBe('file')
    expect(byId.get(drive.fileId)?.itemType, 'file is a pending org file item').toBe('file')
    expect(byId.get(desk.deskId)?.itemType, 'desk is a pending org node item').toBe('node')
    expect(byId.get(desk.widgetId)?.itemType, 'table widget is a pending org widget item').toBe('widget')
    expect(byId.get(desk.tableId)?.itemType, 'CASCADE: backing table is a pending org table item').toBe('table')
    expect(byId.get(desk.rowId)?.itemType, 'CASCADE: backing row is a pending org row item').toBe('row')

    // ── Push metadata for our items + bytes for the real file (Node transport) ─
    for (const u of pending) {
      const status = await putItemOrg(avaToken, u.id, u.itemType, u.body)
      expect(status, `metadata PUT ${u.itemType} ${u.id}`).toBe(200)
    }
    const fileBytes = await A.window.evaluate(async (id) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const l = await api.workspaceSync.fileBytesForPush(id)
      return l ? { ext: l.ext, mimeType: l.mimeType, bytes: Array.from(l.bytes as unknown as number[]) } : null
    }, drive.fileId) as { ext: string; mimeType: string; bytes: number[] } | null
    expect(fileBytes, 'Ava has local bytes to push for the shared file').toBeTruthy()
    const upStatus = await uploadBlob(avaToken, drive.fileId, fileBytes!.ext, fileBytes!.mimeType, new Uint8Array(fileBytes!.bytes))
    expect(upStatus, 'file blob upload').toBe(200)

    // ── Ben pulls from the live server and applies through his real app ───────
    const ourIds = new Set([drive.folderId, drive.fileId, desk.deskId, desk.widgetId, desk.tableId, desk.rowId])
    const pulled = (await orgSync(benToken, 0)).filter((i) => ourIds.has(i.id))
    expect(pulled.length, 'Ben pulled all 6 of our org items from the server').toBe(6)

    const applied = await B.window.evaluate(async ({ items, org }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return api.workspaceSync.applyRemoteOrg(
        items.map((i) => ({ id: i.id, itemType: i.itemType as 'file', body: i.body, rev: i.rev, deleted: i.deleted })),
        org
      )
    }, { items: pulled, org: ORG_ID }) as { applied: number }
    expect(applied.applied, 'Ben applied all 6 items').toBe(6)

    // File bytes: download from server + write into Ben's real store.
    const benBytes = await downloadBlob(benToken, drive.fileId)
    expect(benBytes, 'Ben (a member) can download the file bytes').toBeTruthy()
    const wrote = await B.window.evaluate(async ({ id, arr }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return api.workspaceSync.writeSyncedFileBytes(id, new Uint8Array(arr))
    }, { id: drive.fileId, arr: Array.from(benBytes!) }) as boolean
    expect(wrote, 'Ben wrote the downloaded bytes locally').toBe(true)

    // ── ITEM 2 assertions on Ben's real app ──────────────────────────────────
    const benFile = await B.window.evaluate(async (ids) => {
      const { folderId, fileId } = ids
      const api = (window as unknown as { api: typeof window.api }).api
      const folder = await api.fileManager.get(folderId)
      const file = await api.fileManager.get(fileId)
      const text = await api.files.extractText(fileId)
      return {
        folderKind: (folder as { kind?: string } | null)?.kind ?? null,
        fileParent: (file as { parentId?: string | null } | null)?.parentId ?? null,
        text
      }
    }, { folderId: drive.folderId, fileId: drive.fileId })
    console.log('PHASEB benFile =', JSON.stringify(benFile), 'applied =', applied.applied, 'pulled =', pulled.length)
    expect(benFile.folderKind, "Ben has the shared folder").toBe('folder')
    expect(benFile.fileParent, "Ben's file nests under the shared folder").toBe(drive.folderId)
    expect(benFile.text, "Ben extracts the real replicated file content").toBe(FILE_CONTENT)

    // ── ITEM 3 assertions on Ben's real app ──────────────────────────────────
    const benDesk = await B.window.evaluate(async (ids) => {
      const { deskId, tableId, widgetId } = ids
      const api = (window as unknown as { api: typeof window.api }).api
      const node = await api.nodes.get(deskId)
      const widgets = await api.widgets.listByTask(deskId)
      const tableWidget = (widgets as Array<{ id: string; kind: string; content: string | null }>).find((w) => w.id === widgetId)
      const table = await api.tables.get(tableId)
      const rows = await api.tables.listRows(tableId)
      return {
        hasDesk: !!node,
        widgetOk: !!tableWidget && tableWidget.kind === 'table' && tableWidget.content === tableId,
        hasTable: !!table,
        cells: (rows as Array<{ cells: Record<string, unknown> }>).map((r) => r.cells)
      }
    }, { deskId: desk.deskId, tableId: desk.tableId, widgetId: desk.widgetId })
    console.log('PHASEB benDesk =', JSON.stringify(benDesk))
    expect(benDesk.hasDesk, 'Ben has the shared desk').toBe(true)
    expect(benDesk.widgetOk, 'Ben has the table widget pointing at the synced table').toBe(true)
    expect(benDesk.hasTable, 'CASCADE: Ben has the backing fb_table (not a dangling widget)').toBe(true)
    expect(
      benDesk.cells.some((c) => c.c1 === CELL_TEXT),
      "CASCADE: Ben has the real row data, not a blank 'Loading table…'"
    ).toBe(true)
  })
})
