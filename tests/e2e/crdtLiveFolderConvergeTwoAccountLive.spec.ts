/**
 * E2E: WS01 cross-account substrate — LIVE FOLDER convergence WITHOUT the check-out
 * lock. Two DIFFERENT accounts; A creates a live folder and invites B (live-doc
 * membership, not org membership); with fb.sync.crdt.livefolders on, A reorganises
 * the shared tree (create + rename + delete an entry) and every change reaches B via
 * the `lfe:folder:<folderId>` partition — authorised server-side by liveDocs.isMember.
 *
 * This is the first of the two migrations that let the check-out lock be retired: a
 * live folder that used to require a single holder now converges per-entry, so both
 * accounts hold no lock and both can edit. The spec asserts B converges via the real
 * view path (the New folder / rename / delete controls), reading B's materialised
 * tree from the __fbLiveFolders store.
 *
 * HARNESS (identical to the other live specs — signal:8792 + tls-proxy:8793 + app
 * built against the proxy). Self-skips unless CRDT_LIVE_PROXY_BASE is set.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PROXY_BASE = process.env.CRDT_LIVE_PROXY_BASE

test.beforeAll(async () => {
  test.skip(!PROXY_BASE, 'CRDT_LIVE_PROXY_BASE not set — needs the purpose-built app + local TLS proxy. Skipping.')
})

interface Launched {
  app: ElectronApplication
  window: Page
  dispose: () => Promise<void>
}

async function launch(label: string): Promise<Launched> {
  const userDataDir = mkdtempSync(join(tmpdir(), `fb-crdtlf-${label}-`))
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env }
  delete cleanEnv.ELECTRON_RUN_AS_NODE
  delete cleanEnv.ANTHROPIC_API_KEY
  delete cleanEnv.OPENAI_API_KEY
  const app = await electron.launch({
    args: ['--ignore-certificate-errors', '.'],
    cwd: process.cwd(),
    env: { ...cleanEnv, FB_TEST_USER_DATA: userDataDir, NODE_ENV: 'test' },
    timeout: 20_000
  })
  app.process().stdout?.on('data', (b) => process.stdout.write(`[${label}] ${b}`))
  app.process().stderr?.on('data', (b) => process.stderr.write(`[${label}] ${b}`))
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  async function dispose(): Promise<void> {
    try {
      await Promise.race([app.close(), new Promise<void>((_, r) => setTimeout(() => r(new Error('t')), 5_000))])
    } catch {
      try {
        app.process().kill()
      } catch {
        /* dead */
      }
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
  return { app, window, dispose }
}

async function dismissOnboarding(window: Page): Promise<void> {
  await window.waitForFunction(() => typeof (window as unknown as { api?: unknown }).api === 'object', null, {
    timeout: 10_000
  })
  await expect(window.locator('[data-testid="footer-sync-chip"]')).toBeVisible({ timeout: 10_000 })
  const onb = window.locator('[role="dialog"][aria-label="Welcome to PlexiiDesk"]')
  if (await onb.isVisible().catch(() => false)) {
    await window.getByRole('button', { name: 'Get started' }).click().catch(() => {})
    await window.locator('[data-testid="onboarding-key-skip"]').click().catch(() => {})
    await window.locator('[data-testid="onboarding-tour-continue"]').click().catch(() => {})
    await window.locator('[data-testid="onboarding-start-blank"]').click().catch(() => {})
  }
}

async function signUp(window: Page, email: string, password: string): Promise<void> {
  const d = window.locator('[role="dialog"][aria-label="Sign in to PlexiiDesk"]')
  await expect(d).toBeVisible({ timeout: 10_000 })
  await window.getByRole('button', { name: 'Sign up' }).click()
  await window.getByPlaceholder('you@example.com').fill(email)
  await window.getByPlaceholder('at least 8 characters').fill(password)
  await window.getByRole('button', { name: 'Create account' }).click()
  await expect(d).not.toBeVisible({ timeout: 10_000 })
}

async function enableAllFlagsReload(window: Page): Promise<void> {
  await window.evaluate(() => {
    for (const k of ['widgets', 'nodes', 'tables', 'timeblocks', 'files', 'documents', 'livefolders']) {
      localStorage.setItem(`fb.sync.crdt.${k}`, '1')
    }
  })
  await window.reload()
}

// `fn` runs IN THE PAGE via page.evaluate, which serialises only the function's
// source text — any outer-scope closure (like a captured folderId) is NOT sent
// across, so the arg MUST be passed explicitly as `evaluate`'s second parameter.
async function until<T, A>(
  window: Page,
  arg: A,
  fn: (a: A) => Promise<T>,
  pred: (v: T) => boolean,
  ms = 15_000
): Promise<number> {
  const start = Date.now()
  for (;;) {
    const v = await window.evaluate(fn, arg)
    if (pred(v)) return Date.now() - start
    if (Date.now() - start > ms) throw new Error(`converge timeout ${ms}ms; last=${JSON.stringify(v)}`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

// The materialised live-folder tree on B (via the __fbLiveFolders debug store).
// Runs in the page; folderId arrives as the explicit evaluate() argument.
async function entriesOf(folderId: string): Promise<Array<{ id: string; name: string; kind: string }>> {
  const s = (window as unknown as { __fbLiveFolders?: { getState: () => { entries: Record<string, Array<{ id: string; name: string; kind: string }>> } } }).__fbLiveFolders
  return (s?.getState()?.entries?.[folderId] ?? []) as Array<{ id: string; name: string; kind: string }>
}

test.describe.configure({ mode: 'serial' })

test('live folder: A reorganises a shared folder and B converges via the folder partition — no lock', async () => {
  test.setTimeout(220_000)
  const rand = Date.now()
  const emailA = `crdt.lf.a.${rand}@example.com`
  const emailB = `crdt.lf.b.${rand}@example.com`
  const password = 'Test-Account-123!'
  const A = await launch('A')
  const B = await launch('B')
  try {
    await dismissOnboarding(A.window)
    await dismissOnboarding(B.window)
    await signUp(A.window, emailA, password)
    await signUp(B.window, emailB, password) // B must exist so the invite resolves to a member

    await enableAllFlagsReload(A.window)
    await enableAllFlagsReload(B.window)
    await dismissOnboarding(A.window)
    await dismissOnboarding(B.window)

    // A creates a live folder + invites B, straight through the signal REST (the same
    // calls the Documents UI makes), using A's live session token.
    const base = PROXY_BASE as string
    const folderId = await A.window.evaluate(
      async ({ apiBase, email }) => {
        const tok = (window as unknown as { __fbAccount: { getState: () => { sessionToken: string } } }).__fbAccount
          .getState().sessionToken
        const body = JSON.stringify({ version: 1, rootName: 'Shared Folder', entries: [] })
        const created = await fetch(`${apiBase}/livedocs`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ docType: 'folder', title: 'Shared Folder', body })
        }).then((r) => r.json())
        const id = created.doc.id as string
        await fetch(`${apiBase}/livedocs/${id}/invite-email`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        })
        return id
      },
      { apiBase: base, email: emailB }
    )

    // Both open the live folder (mounts LiveFolderView → joins lfe:folder:<id>).
    for (const w of [A.window, B.window]) {
      await w.evaluate((id) => {
        const view = (window as unknown as { __fbView?: { getState: () => { goLiveFolder: (i: string) => void } } }).__fbView
        view?.getState()?.goLiveFolder?.(id)
      }, folderId)
    }
    // Both should render the live status strip (flag on → no lock UI).
    await expect(A.window.locator('[data-testid="livefolder-live"]')).toBeVisible({ timeout: 12_000 })
    await expect(B.window.locator('[data-testid="livefolder-live"]')).toBeVisible({ timeout: 12_000 })

    // A creates + names a folder entry via the REAL view controls.
    await A.window.locator('[data-testid="livefolder-newfolder"]').click()
    const rename = A.window.locator('[data-testid="livefolder-rename-input"]')
    await expect(rename).toBeVisible({ timeout: 5_000 })
    await rename.fill('Reports')
    await rename.press('Enter')

    // B converges: the entry appears with kind 'folder' and the LWW-resolved name.
    const createMs = await until(B.window, folderId, entriesOf, (es) => es.some((e) => e.kind === 'folder'), 15_000)
    const nameMs = await until(
      B.window,
      folderId,
      entriesOf,
      (es) => es.some((e) => e.kind === 'folder' && e.name === 'Reports'),
      15_000
    )
    const entryId = (await B.window.evaluate(entriesOf, folderId)).find((e) => e.kind === 'folder')!.id

    // A deletes the entry → B converges to it being gone (remove-wins tombstone).
    const row = A.window.locator('[data-testid="livefolder-entry"]').filter({ hasText: 'Reports' })
    await row.hover()
    await row.locator('[data-testid="livefolder-delete"]').click({ force: true })
    const deleteMs = await until(
      B.window,
      folderId,
      entriesOf,
      (es) => !es.some((e) => e.id === entryId),
      15_000
    )

    console.log(`[CRDT-LF] live-folder convergence: create ${createMs}ms, rename ${nameMs}ms, delete ${deleteMs}ms (folder ${folderId})`)
  } finally {
    await A.dispose()
    await B.dispose()
  }
})
