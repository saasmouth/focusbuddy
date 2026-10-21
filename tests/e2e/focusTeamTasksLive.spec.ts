/**
 * E2E (DEC-144): Focus tasks in a TEAM workspace, assigned to several people —
 * an org member and an org guest — over the real (proxied) signal server.
 *
 *   owner A creates a desk and three tasks in the team:
 *     t1 → member M and guest G      t2 → member M only      t3 → guest G
 *   M's Focus holds t1 and t2.  G's Focus holds t1 and t3 — and G receives no
 *   desk, no other task. G closes t1: A sees it closed. A unassigns G from t3:
 *   it leaves G's device.
 *
 * HARNESS (same as crdtOrgConvergeTwoAccountLive): signal:8792 (this branch's
 * focusbuddy-signal, which carries orgGuestScope) + tls-proxy:8793 + the app
 * built against the proxy. Self-skips unless CRDT_LIVE_PROXY_BASE is set.
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
  const userDataDir = mkdtempSync(join(tmpdir(), `fb-focusteam-${label}-`))
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env }
  delete cleanEnv.ELECTRON_RUN_AS_NODE
  delete cleanEnv.ANTHROPIC_API_KEY
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

async function sessionToken(window: Page): Promise<string> {
  const t = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const cached = (await api.account.load()) as { sessionToken?: string } | null
    return cached?.sessionToken ?? ''
  })
  if (!t) throw new Error('no session token after signup')
  return t
}

// A renderer-side fetch to the proxied signal (CSP allows https; the self-signed
// proxy cert is accepted via --ignore-certificate-errors).
async function apiPost(window: Page, base: string, path: string, token: string, body: unknown): Promise<unknown> {
  return window.evaluate(
    async ({ url, tok, b }) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
        body: JSON.stringify(b)
      })
      return res.json()
    },
    { url: `${base}${path}`, tok: token, b: body }
  )
}

// Turn on all CRDT flags and reload so the engine boots with them set. Active org
// is switched AFTER, at runtime, so the engine's org subscription fires the re-route.
async function enableAllFlagsReload(window: Page): Promise<void> {
  await window.evaluate(() => {
    for (const k of ['widgets', 'nodes', 'tables', 'timeblocks', 'files', 'documents']) {
      localStorage.setItem(`fb.sync.crdt.${k}`, '1')
    }
  })
  await window.reload()
}

// Switch into the org through the org store (the same setActive the org-switcher UI
// calls), which updates useOrgStore.activeOrgId and fires the CRDT engine's org
// subscription → re-route to the org partition. load() first so the just-joined org
// is in the store. Asserts adoption so a setup failure fails fast + clearly.
async function switchToOrg(window: Page, orgId: string): Promise<void> {
  const active = await window.evaluate(async (id) => {
    const store = (window as unknown as { __fbOrg?: { getState: () => { load: () => Promise<void>; setActive: (o: string) => Promise<void>; activeOrgId: string } } }).__fbOrg
    if (!store) return '(no __fbOrg handle)'
    await store.getState().load()
    await store.getState().setActive(id)
    return store.getState().activeOrgId
  }, orgId)
  expect(active, 'both windows must actually adopt the org as active before convergence is meaningful').toBe(orgId)
}

async function until<T>(window: Page, fn: () => Promise<T>, pred: (v: T) => boolean, ms = 15_000): Promise<number> {
  const start = Date.now()
  for (;;) {
    const v = await window.evaluate(fn as unknown as () => Promise<T>)
    if (pred(v)) return Date.now() - start
    if (Date.now() - start > ms) throw new Error(`converge timeout ${ms}ms; last=${JSON.stringify(v)}`)
    await new Promise((r) => setTimeout(r, 300))
  }
}


type Item = { id: string; title: string; workItemState: string | null; assigneeIds: string | null; trashedAt?: number | null }
const focusList = async (): Promise<Item[]> =>
  (await (window as unknown as { api: typeof window.api }).api.workItems.list()) as unknown as Item[]

async function accountId(window: Page): Promise<string> {
  return window.evaluate(() => {
    const s = (window as unknown as { __fbAccount: { getState: () => { account: { id: string } | null } } }).__fbAccount
    return s.getState().account?.id ?? ''
  })
}

test.describe.configure({ mode: 'serial' })

test('team Focus: tasks assigned to a member and a guest reach exactly them', async () => {
  test.setTimeout(420_000)
  const rand = Date.now()
  const pw = 'Test-Account-123!'
  const emails = { A: `focus.a.${rand}@example.com`, M: `focus.m.${rand}@example.com`, G: `focus.g.${rand}@example.com` }
  const A = await launch('A')
  const M = await launch('M')
  const G = await launch('G')
  try {
    for (const w of [A, M, G]) await dismissOnboarding(w.window)
    await signUp(A.window, emails.A, pw)
    await signUp(M.window, emails.M, pw)
    await signUp(G.window, emails.G, pw)
    const tokenA = await sessionToken(A.window)
    const created = (await apiPost(A.window, PROXY_BASE!, '/orgs', tokenA, { name: `Focus Team ${rand}` })) as { org?: { id: string } }
    const orgId = created.org?.id
    if (!orgId) throw new Error(`org create failed: ${JSON.stringify(created)}`)
    expect(((await apiPost(A.window, PROXY_BASE!, `/orgs/${orgId}/members`, tokenA, { email: emails.M, role: 'member' })) as { ok?: boolean }).ok).toBe(true)
    expect(((await apiPost(A.window, PROXY_BASE!, `/orgs/${orgId}/members`, tokenA, { email: emails.G, role: 'guest' })) as { ok?: boolean }).ok).toBe(true)

    for (const w of [A, M, G]) await enableAllFlagsReload(w.window)
    for (const w of [A, M, G]) await dismissOnboarding(w.window)
    for (const w of [A, M, G]) await switchToOrg(w.window, orgId)
    const ids = { M: await accountId(M.window), G: await accountId(G.window) }
    expect(ids.M && ids.G).toBeTruthy()

    // A: a desk on a room, and three tasks with different assignees.
    const made = await A.window.evaluate(async ({ m, g }) => {
      const nodes = (window as unknown as { __fbNodes: { getState: () => { create: (d: unknown) => Promise<{ id: string }> } } }).__fbNodes
      const wi = (window as unknown as { __fbWorkItems: { getState: () => { create: (d: unknown) => Promise<{ id: string }> } } }).__fbWorkItems
      const room = await nodes.getState().create({ parentId: null, kind: 'folder', title: 'Launch room' })
      const desk = await nodes.getState().create({ parentId: room.id, kind: 'task', title: 'Launch desk', description: 'Board-only notes' })
      const t1 = await wi.getState().create({ title: 'Send the venue contract', parentId: desk.id, assigneeIds: [m, g] })
      const t2 = await wi.getState().create({ title: 'Budget sign-off', parentId: desk.id, assigneeIds: [m] })
      const t3 = await wi.getState().create({ title: 'Print the badges', parentId: desk.id, assigneeIds: [g] })
      return { desk: desk.id, t1: t1.id, t2: t2.id, t3: t3.id }
    }, { m: ids.M, g: ids.G })

    // The owner's own Focus in the team: none of these are assigned to A.
    const aList = await A.window.evaluate(focusList)
    expect(aList.map((i) => i.id)).not.toContain(made.t1)

    // MEMBER: t1 and t2.
    const mMs = await until(M.window, focusList, (l) => [made.t1, made.t2].every((id) => l.some((i) => i.id === id)), 90_000)
    const mList = await M.window.evaluate(focusList)
    expect(mList.map((i) => i.id)).not.toContain(made.t3)

    // GUEST: t1 and t3, and no desk, no t2.
    const gMs = await until(G.window, focusList, (l) => [made.t1, made.t3].every((id) => l.some((i) => i.id === id)), 120_000).catch(
      async (e) => {
        const tokG = await sessionToken(G.window)
        const diag = await G.window.evaluate(
          async ({ base, tok, org }) => {
            const res = await fetch(`${base}/workspace/org/sync?since=0`, { headers: { authorization: `Bearer ${tok}`, 'x-plexi-org': org } })
            const api = (window as unknown as { api: typeof window.api }).api
            const orgStore = (window as unknown as { __fbOrg: { getState: () => { activeOrgId: string } } }).__fbOrg
            return {
              status: res.status,
              server: await res.json(),
              activeOrg: orgStore.getState().activeOrgId,
              local: await api.workItems.list()
            }
          },
          { base: PROXY_BASE!, tok: tokG, org: orgId }
        )
        console.log('[FOCUS-TEAM][diag guest]', JSON.stringify(diag).slice(0, 3000))
        throw e
      }
    )
    const gList = await G.window.evaluate(focusList)
    expect(gList.map((i) => i.id)).not.toContain(made.t2)
    // The desk above the guest's tasks arrives as a stub: its title, none of
    // its content (the owner's private notes stay on the server).
    const gNodes = (await G.window.evaluate(async () => (await (window as unknown as { api: typeof window.api }).api.nodes.list()) as Array<{ id: string; title: string; description: string }>))
    const gDesk = gNodes.find((n) => n.id === made.desk)
    expect(gDesk?.title).toBe('Launch desk')
    expect(gDesk?.description ?? '').toBe('')
    const gBadge = await G.window.evaluate(async () => (await (window as unknown as { api: typeof window.api }).api.workItems.badgeCounts()).headline)
    expect(gBadge).toBeGreaterThanOrEqual(2)

    // GUEST closes t1; the owner sees it closed.
    const closeProbe = await G.window.evaluate(
      async ({ id, org }) => {
        const api = (window as unknown as { api: typeof window.api }).api
        const wi = (window as unknown as { __fbWorkItems: { getState: () => { setState: (id: string, s: string) => Promise<boolean> } } }).__fbWorkItems
        const ok = await wi.getState().setState(id, 'completed')
        const s0 = (await api.workItems.get(id))?.workItemState
        const p0 = (await api.workspaceSync.pendingOrg(org)).upserts.map((u: { id: string; baseRev: number }) => [u.id, u.baseRev, Date.now()])
        await new Promise((r) => setTimeout(r, 3000))
        const s3 = (await api.workItems.get(id))?.workItemState
        const p3 = (await api.workspaceSync.pendingOrg(org)).upserts.map((u: { id: string }) => u.id)
        return { ok, s0, p0, s3, p3 }
      },
      { id: made.t1, org: orgId }
    )
    console.log('[FOCUS-TEAM][close probe]', JSON.stringify(closeProbe))
    // t1 is not in A's own Focus (it is not assigned to A), so read it by id.
    await A.window.evaluate((id) => ((window as unknown as { __t1: string }).__t1 = id), made.t1)
    const closeMs = await until(
      A.window,
      async () => {
        const api = (window as unknown as { api: typeof window.api }).api
        const got = (await api.workItems.get((window as unknown as { __t1: string }).__t1)) as Item | null
        return got?.workItemState ?? null
      },
      (s) => s === 'completed',
      120_000
    ).catch(async (e) => {
      const diag = await G.window.evaluate(
        async ({ org, id }) => {
          const api = (window as unknown as { api: typeof window.api }).api
          const pending = await api.workspaceSync.pendingOrg(org)
          const local = await api.workItems.get(id)
          let direct: unknown
          try {
            direct = await api.workItems.setState(id, 'completed')
          } catch (err) {
            direct = `threw: ${String(err)}`
          }
          const after = await api.workItems.get(id)
          const pending2 = await api.workspaceSync.pendingOrg(org)
          return {
            pending: pending.upserts.map((u: { id: string; baseRev: number }) => [u.id, u.baseRev]),
            localState: local?.workItemState,
            direct,
            afterState: after?.workItemState,
            pending2: pending2.upserts.map((u: { id: string; baseRev: number }) => [u.id, u.baseRev])
          }
        },
        { org: orgId, id: made.t1 }
      )
      console.log('[FOCUS-TEAM][diag close]', JSON.stringify(diag).slice(0, 2500))
      throw e
    })

    // OWNER unassigns the guest from t3; it leaves the guest's device.
    await A.window.evaluate(async ({ id, m }) => {
      const wi = (window as unknown as { __fbWorkItems: { getState: () => { updateFields: (id: string, p: unknown) => Promise<unknown> } } }).__fbWorkItems
      await wi.getState().updateFields(id, { assigneeIds: [m] })
    }, { id: made.t3, m: ids.M })
    const revokeMs = await until(G.window, focusList, (l) => !l.some((i) => i.id === made.t3), 120_000)

    console.log(`[FOCUS-TEAM] member got tasks in ${mMs}ms, guest in ${gMs}ms, guest close seen by owner in ${closeMs}ms, unassign-revoke in ${revokeMs}ms (org ${orgId})`)
  } finally {
    await A.dispose()
    await M.dispose()
    await G.dispose()
  }
})

// Owner report (4.3.40): "I can't seem to assign a task." Driven through the
// UI this time: the row's Assign action, the picker, Save, and the member's
// Focus. First with nobody else in the team (the picker says so and offers the
// invite, rather than "could not load"), then after the member joins.
test('team Focus: the owner assigns a task through the picker, and it reaches the member', async () => {
  test.setTimeout(300_000)
  const rand = Date.now()
  const pw = 'Test-Account-123!'
  const emails = { A: `assign.a.${rand}@example.com`, M: `assign.m.${rand}@example.com` }
  const A = await launch('A2')
  const M = await launch('M2')
  try {
    for (const w of [A, M]) await dismissOnboarding(w.window)
    await signUp(A.window, emails.A, pw)
    await signUp(M.window, emails.M, pw)
    const tokenA = await sessionToken(A.window)
    const created = (await apiPost(A.window, PROXY_BASE!, '/orgs', tokenA, { name: `Assign Team ${rand}` })) as { org?: { id: string } }
    const orgId = created.org?.id
    if (!orgId) throw new Error(`org create failed: ${JSON.stringify(created)}`)

    for (const w of [A, M]) await enableAllFlagsReload(w.window)
    for (const w of [A, M]) await dismissOnboarding(w.window)
    await switchToOrg(A.window, orgId)

    // The owner raises a task in the team; unassigned, it is in their own Focus.
    const taskId = await A.window.evaluate(async () => {
      const wi = (window as unknown as { __fbWorkItems: { getState: () => { create: (d: unknown) => Promise<{ id: string }> } } }).__fbWorkItems
      return (await wi.getState().create({ title: 'Book the caterer' })).id
    })
    await A.window.evaluate(() => {
      ;(window as unknown as { __fbView: { getState: () => { goAttention: () => void } } }).__fbView.getState().goAttention()
    })
    const row = A.window.locator(`[data-item-row][data-item-id="${taskId}"]`).first()
    await expect(row).toBeVisible({ timeout: 15_000 })

    // A new account is asked to verify its email; that prompt is not part of this.
    const later = A.window.locator('[data-testid="verify-email-later"]')
    if (await later.isVisible({ timeout: 5_000 }).catch(() => false)) await later.click()

    const openAssign = async (): Promise<void> => {
      if (await later.isVisible().catch(() => false)) await later.click()
      await row.hover()
      await row.locator('[data-testid="task-assign"]').click()
      await expect(A.window.getByRole('dialog', { name: 'Edit task' })).toBeVisible()
    }

    // Nobody else yet: an honest hint and the way to fix it, not an error.
    await openAssign()
    const picker = A.window.locator('[data-testid="assignee-picker"]')
    await expect(picker.locator('[data-testid="assignee-picker-nobody"]')).toBeVisible({ timeout: 15_000 })
    await expect(picker).toContainText('Invite someone to assign tasks to them.')
    await expect(picker).not.toContainText('Could not load')
    await expect(picker.locator('[data-testid="assignee-picker-invite"]')).toBeVisible()
    await A.window.keyboard.press('Escape')

    // The member joins.
    expect(((await apiPost(A.window, PROXY_BASE!, `/orgs/${orgId}/members`, tokenA, { email: emails.M, role: 'member' })) as { ok?: boolean }).ok).toBe(true)
    await switchToOrg(M.window, orgId)
    const mId = await accountId(M.window)
    const mName = await M.window.evaluate(() => {
      const s = (window as unknown as { __fbAccount: { getState: () => { account: { handle: string | null; firstName: string | null; email: string } | null } } }).__fbAccount
      const a = s.getState().account!
      return a.firstName || (a.handle && a.handle !== 'Someone' ? a.handle : null) || a.email
    })

    // Reopened, the picker lists them; pick and save.
    await openAssign()
    const chip = picker.getByRole('button', { name: mName, exact: false }).first()
    await expect(chip).toBeVisible({ timeout: 15_000 })
    await expect(picker.locator('[data-testid="assignee-picker-nobody"]')).toHaveCount(0)
    await chip.click()
    await expect(chip).toHaveAttribute('aria-pressed', 'true')
    await A.window.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(A.window.getByRole('dialog', { name: 'Edit task' })).toHaveCount(0)

    // Saved on the owner's device…
    const saved = await A.window.evaluate(async (id) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return ((await api.workItems.get(id)) as unknown as { assigneeIds: string | null } | null)?.assigneeIds ?? null
    }, taskId)
    expect(JSON.parse(saved ?? '[]')).toEqual([mId])
    // …and in the member's Focus.
    const ms = await until(M.window, focusList, (l) => l.some((i) => i.id === taskId), 90_000).catch(async (e) => {
      const tokM = await sessionToken(M.window)
      const diag = await M.window.evaluate(
        async ({ base, tok, org, id }) => {
          const res = await fetch(`${base}/workspace/org/sync?since=0`, { headers: { authorization: `Bearer ${tok}`, 'x-plexi-org': org } })
          const body = await res.json()
          const api = (window as unknown as { api: typeof window.api }).api
          const node = await api.workItems.get(id)
          return { status: res.status, serverHasIt: JSON.stringify(body).includes(id), serverSnippet: JSON.stringify(body).slice(0, 1500), localNode: node, orgActive: (window as unknown as { __fbOrg: { getState: () => { activeOrgId: string } } }).__fbOrg.getState().activeOrgId }
        },
        { base: PROXY_BASE!, tok: tokM, org: orgId, id: taskId }
      )
      console.log('[FOCUS-ASSIGN][diag member]', JSON.stringify(diag).slice(0, 3000))
      throw e
    })
    console.log(`[FOCUS-ASSIGN] picker assignment reached the member in ${ms}ms (org ${orgId})`)
  } finally {
    await A.dispose()
    await M.dispose()
  }
})
