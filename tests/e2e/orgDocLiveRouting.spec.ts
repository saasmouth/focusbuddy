/**
 * orgDocLiveRouting.spec.ts — TESTER-AUTHORED, ad hoc verification spec.
 *
 * Verifies the new DocumentOpen routing claim:
 *   - A document owned by the active PERSONAL scope opens in the plain
 *     last-write-wins editor (DocumentEditorView), no ensure-org call.
 *   - A document owned by an ORG-shared scope opens in the CRDT co-editing
 *     editor (LiveDocEditorView) after POST /livedocs/:id/ensure-org
 *     succeeds.
 *
 * Requires a purpose-built app + local TLS proxy in front of a plain-http
 * signal server (see tests/e2e/orgSyncTwoWindowLive.spec.ts header for why:
 * the built app's CSP is connect-src 'self' ws: wss: https: and refuses a
 * plain http: fetch() outright, so a real network-backed run needs the TLS
 * front end). Self-skips if ORGDOC_ROUTE_PROXY_BASE isn't set.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PROXY_BASE = process.env.ORGDOC_ROUTE_PROXY_BASE // e.g. https://localhost:8891

test.beforeAll(async () => {
  test.skip(!PROXY_BASE, 'ORGDOC_ROUTE_PROXY_BASE not set — needs a purpose-built app + local TLS proxy.')
})

async function launch(label: string): Promise<{ app: ElectronApplication; window: Page; dispose: () => Promise<void> }> {
  const userDataDir = mkdtempSync(join(tmpdir(), `plexii-orgdocroute-${label}-`))
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
      await Promise.race([
        app.close(),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000))
      ])
    } catch {
      try {
        app.process().kill()
      } catch {
        /* dead already */
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
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  await expect(window.locator('[data-testid="footer-sync-chip"]')).toBeVisible({ timeout: 10_000 })
  const onb = window.locator('[role="dialog"][aria-label="Welcome to PlexiDesk"]')
  if (await onb.isVisible().catch(() => false)) {
    await window.getByRole('button', { name: 'Get started' }).click().catch(() => {})
    await window.locator('[data-testid="onboarding-key-skip"]').click().catch(() => {})
    await window.locator('[data-testid="onboarding-tour-continue"]').click().catch(() => {})
    await window.locator('[data-testid="onboarding-start-blank"]').click().catch(() => {})
  }
}

async function signUpViaUi(window: Page, email: string, password: string): Promise<void> {
  const dialog = window.locator('[role="dialog"][aria-label="Sign in to PlexiDesk"]')
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await window.getByRole('button', { name: 'Sign up' }).click()
  await window.getByPlaceholder('you@example.com').fill(email)
  await window.getByPlaceholder('at least 8 characters').fill(password)
  await window.getByRole('button', { name: 'Create account' }).click()
  await expect(dialog).not.toBeVisible({ timeout: 10_000 })
}

async function openOrgAdmin(window: Page): Promise<void> {
  await window.locator('[data-testid="org-switcher-button"]').click()
  await window.locator('[data-testid="org-switcher-manage"]').click()
  await expect(window.locator('[data-testid="org-admin"]')).toBeVisible({ timeout: 8_000 })
}

async function switchActiveOrg(window: Page, orgNameSubstring: string): Promise<void> {
  await window.locator('[data-testid="org-switcher-button"]').click()
  const menu = window.locator('[data-testid="org-switcher-menu"]')
  await expect(menu).toBeVisible({ timeout: 5_000 })
  await menu.locator(`button:has-text("${orgNameSubstring}")`).first().click()
  await expect(window.locator('[data-testid="org-switcher-button"]')).toContainText(orgNameSubstring, {
    timeout: 8_000
  })
}

test.describe.configure({ mode: 'serial' })

test('org-shared doc opens LIVE, personal doc opens plain, no ensure-org call for personal', async () => {
  test.setTimeout(90_000)
  const rand = Date.now()
  const email = `orgdocroute.${rand}@example.com`
  const password = 'Test-Account-123!'
  const orgName = `Doc Route Org ${rand}`

  const { window, dispose } = await launch('A')
  const networkLog: { url: string; method: string }[] = []
  window.on('request', (req) => {
    if (req.url().includes('/livedocs/')) networkLog.push({ url: req.url(), method: req.method() })
  })

  try {
    await dismissOnboarding(window)
    await signUpViaUi(window, email, password)

    // Create + activate the org.
    await openOrgAdmin(window)
    await window.locator('[data-testid="org-new-name"]').fill(orgName)
    await window.locator('[data-testid="org-create"]').click()
    await expect(window.locator(`button:has-text("${orgName}")`).first()).toBeVisible({ timeout: 8_000 })
    // The org switcher's own store (stores/org.ts) only reloads its org list on
    // mount/token-change, not when OrgAdminView creates a new org in the same
    // session — a reload re-runs that mount path against the real server, same
    // proven workaround as orgSyncTwoWindowLive.spec.ts uses for its second window.
    await window.reload()
    await dismissOnboarding(window)
    await switchActiveOrg(window, orgName)

    // --- ORG doc: create while org is active, open it, expect LIVE editor ---
    const orgDoc = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      return api.documents.create({ docType: 'doc', title: 'Org shared doc (route test)' } as never)
    })
    const orgDocId = (orgDoc as unknown as { id: string; orgId: string | null }).id
    const orgDocOrgId = (orgDoc as unknown as { id: string; orgId: string | null }).orgId
    expect(orgDocOrgId, 'created doc should carry the active org id, not personal/null').not.toBeNull()
    expect(orgDocOrgId).not.toBe('personal')

    await window.evaluate((id) => {
      const w = window as unknown as { __fbView?: { getState: () => { goDocument: (id: string) => void } } }
      w.__fbView?.getState()?.goDocument?.(id)
    }, orgDocId)

    // Expect the LIVE editor's distinguishing chrome to mount.
    await expect(window.locator('[data-testid="livedoc-status"]')).toBeVisible({ timeout: 12_000 })
    // Plain editor's save-error testid must NOT be present (sanity that we
    // are not looking at DocumentEditorView's DOM by coincidence).
    await expect(window.locator('[data-testid="doc-save-error"]')).toHaveCount(0)

    const ensureOrgCalls = networkLog.filter((r) => r.url.includes(`/livedocs/${orgDocId}/ensure-org`) && r.method === 'POST')
    expect(ensureOrgCalls.length, `expected a POST /livedocs/${orgDocId}/ensure-org call, saw: ${JSON.stringify(networkLog)}`).toBeGreaterThan(0)

    // --- PERSONAL doc: switch back, create, open, expect PLAIN editor ---
    networkLog.length = 0
    await switchActiveOrg(window, 'Personal')

    const personalDoc = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      return api.documents.create({ docType: 'doc', title: 'Personal doc (route test)' } as never)
    })
    const personalDocId = (personalDoc as unknown as { id: string; orgId: string | null }).id
    const personalDocOrgId = (personalDoc as unknown as { id: string; orgId: string | null }).orgId
    expect(personalDocOrgId === null || personalDocOrgId === 'personal', `personal doc orgId should be personal/null, got ${personalDocOrgId}`).toBe(true)

    await window.evaluate((id) => {
      const w = window as unknown as { __fbView?: { getState: () => { goDocument: (id: string) => void } } }
      w.__fbView?.getState()?.goDocument?.(id)
    }, personalDocId)

    // Plain editor's title input / doc editor container should mount, and
    // no live-doc chrome should ever appear.
    await expect(window.locator('[data-testid="livedoc-status"]')).toHaveCount(0, { timeout: 5_000 })
    // Give any stray fetch a moment to fire, then assert no ensure-org call
    // was made for the personal document.
    await window.waitForTimeout(1_500)
    const strayEnsureOrgCalls = networkLog.filter((r) => r.url.includes('/ensure-org'))
    expect(strayEnsureOrgCalls, `no ensure-org call expected for personal doc, saw: ${JSON.stringify(networkLog)}`).toHaveLength(0)
  } finally {
    await dispose()
  }
})
