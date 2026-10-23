import { test, expect } from '@playwright/test'
import { gotoView, launchApp, openProduct, waitForReady } from './_helpers'

// PlexiAPI verification.
// HTTP calls are made from the Playwright test process (Node.js) directly to
// 127.0.0.1 so there are no renderer CORS / mixed-content issues.
// IPC APIs used for seeding: window.api.apiAccess.{status,setEnabled,createToken,
//   listTokens,revokeToken}, window.api.nodes.list.

// Helper: make an HTTP request from the Node test process.
async function httpReq(
  url: string,
  method: 'GET' | 'POST',
  token?: string,
  body?: unknown
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  let json: unknown
  try {
    json = await res.json()
  } catch {
    json = null
  }
  return { status: res.status, json }
}

// Helper: attempt a connection and return false if it fails (ECONNREFUSED).
async function canConnect(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1_500) })
    return true
  } catch {
    return false
  }
}

test('1. off by default: plexiapi-view shows Stopped', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    await openProduct(window, 'api')
    await expect(window.locator('[data-testid="plexiapi-view"]')).toBeVisible({ timeout: 8_000 })

    // Status must say Stopped (not Running) on a fresh DB
    const viewText = await window.locator('[data-testid="plexiapi-view"]').innerText()
    expect(viewText).toContain('Stopped')
    expect(viewText).not.toContain('Running')

    // IPC confirms disabled
    const status = await window.evaluate(async () => window.api.apiAccess.status())
    const s = status as { enabled: boolean; running: boolean }
    expect(s.enabled).toBe(false)
    expect(s.running).toBe(false)
  } finally {
    await dispose()
  }
})

test('2. create write token: revealed secret starts with plx_', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    await openProduct(window, 'api')
    await expect(window.locator('[data-testid="plexiapi-view"]')).toBeVisible({ timeout: 8_000 })

    // Fill token name
    await window.locator('[data-testid="api-token-name"]').fill('Write Token')
    // Check the write checkbox
    await window.locator('[data-testid="api-token-write"]').click()
    // Create
    await window.locator('[data-testid="api-token-create"]').click()
    await window.waitForTimeout(400)

    // api-token-revealed must appear with the secret
    await expect(window.locator('[data-testid="api-token-revealed"]')).toBeVisible({ timeout: 5_000 })
    const revealedText = await window.locator('[data-testid="api-token-revealed"]').innerText()
    expect(revealedText).toMatch(/plx_[0-9a-f]{64}/)
  } finally {
    await dispose()
  }
})

test('3-8. server on + auth + write + scope + hash + revoke + stop', async () => {
  // Combined test: start the server, exercise all security properties.
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openProduct(window, 'api')
    await expect(window.locator('[data-testid="plexiapi-view"]')).toBeVisible({ timeout: 8_000 })

    // --- Create a WRITE token via IPC ---
    const writeResult = await window.evaluate(async () =>
      window.api.apiAccess.createToken('Write Token', ['read', 'write'])
    )
    const writeToken = writeResult as { token: { id: string }; secret: string }
    const writeSecret = writeToken.secret
    const writeTokenId = writeToken.token.id
    expect(writeSecret).toMatch(/^plx_[0-9a-f]{64}$/)

    // --- Create a READ-ONLY token via IPC ---
    const readResult = await window.evaluate(async () =>
      window.api.apiAccess.createToken('Read Token', ['read'])
    )
    const readSecret = (readResult as { secret: string }).secret

    // --- Enable the server via the UI checkbox so the component re-renders ---
    await window.locator('[data-testid="api-enabled"]').click()

    // UI should show "Running" — wait for the async IPC toggle to complete
    await expect(window.locator('[data-testid="plexiapi-view"]')).toContainText('Running', { timeout: 8_000 })
    await expect(window.locator('[data-testid="api-base-url"]')).toBeVisible({ timeout: 5_000 })

    // Read actual port from status IPC
    const statusAfterEnable = await window.evaluate(async () => window.api.apiAccess.status())
    const enabledStatus = statusAfterEnable as { running: boolean; port: number; enabled: boolean }
    expect(enabledStatus.running).toBe(true)
    expect(enabledStatus.enabled).toBe(true)
    const port = enabledStatus.port
    const base = `http://127.0.0.1:${port}`

    await expect(window.locator('[data-testid="api-base-url"]')).toContainText(`http://127.0.0.1:${port}`)

    // Test 4a: no auth → 401
    const noAuth = await httpReq(`${base}/api/tasks`, 'GET')
    expect(noAuth.status).toBe(401)

    // Test 4b: valid write token + GET /api/tasks → 200 with tasks array
    const getTasksOk = await httpReq(`${base}/api/tasks`, 'GET', writeSecret)
    expect(getTasksOk.status).toBe(200)
    const tasksBody = getTasksOk.json as { tasks: unknown[] }
    expect(Array.isArray(tasksBody.tasks)).toBe(true)

    // Test 5: POST /api/tasks with write token → 201, REAL task in store
    const postTask = await httpReq(`${base}/api/tasks`, 'POST', writeSecret, { title: 'Zirconia API Task' })
    expect(postTask.status).toBe(201)
    const createdTask = (postTask.json as { task: { id: string; title: string } }).task
    expect(createdTask.title).toBe('Zirconia API Task')

    // Confirm the node exists in the real store
    const nodes = await window.evaluate(async () => window.api.nodes.list())
    const nodeList = nodes as Array<{ title: string; kind: string }>
    const realNode = nodeList.find((n) => n.title === 'Zirconia API Task' && n.kind === 'task')
    expect(realNode).toBeDefined()

    // Test 6a: read-only token + POST → 403
    const readPost = await httpReq(`${base}/api/tasks`, 'POST', readSecret, { title: 'Should not create' })
    expect(readPost.status).toBe(403)

    // Test 6b: read-only token + GET → 200
    const readGet = await httpReq(`${base}/api/tasks`, 'GET', readSecret)
    expect(readGet.status).toBe(200)

    // Confirm "Should not create" task was not created (403 stopped the write)
    const nodesAfterReject = await window.evaluate(async () => window.api.nodes.list())
    const rejected = (nodesAfterReject as Array<{ title: string }>).find(
      (n) => n.title === 'Should not create'
    )
    expect(rejected).toBeUndefined()

    // Test 7: listTokens has no raw secret field
    const tokensList = await window.evaluate(async () => window.api.apiAccess.listTokens())
    const tokensMeta = tokensList as Array<Record<string, unknown>>
    expect(tokensMeta.length).toBeGreaterThan(0)
    for (const t of tokensMeta) {
      // No secret, no token_hash, no raw field
      expect(t).not.toHaveProperty('secret')
      expect(t).not.toHaveProperty('token_hash')
      expect(t).not.toHaveProperty('raw')
      // Should have id, name, scopes, createdAt
      expect(t).toHaveProperty('id')
      expect(t).toHaveProperty('name')
      expect(t).toHaveProperty('scopes')
    }

    // Test 8: revoke write token → subsequent GET returns 401
    await window.evaluate(async (id) => window.api.apiAccess.revokeToken(id), writeTokenId)
    const afterRevoke = await httpReq(`${base}/api/tasks`, 'GET', writeSecret)
    expect(afterRevoke.status).toBe(401)

    // Test 9: disable the server via the UI checkbox → connection refused
    await window.locator('[data-testid="api-enabled"]').click()
    await expect(window.locator('[data-testid="plexiapi-view"]')).toContainText('Stopped', { timeout: 8_000 })
    await window.waitForTimeout(300)
    const canStillConnect = await canConnect(`${base}/api/health`)
    expect(canStillConnect).toBe(false)
  } finally {
    await dispose()
  }
})

test('10. suite launcher: PlexiAPI tile opens the view', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    // STALE: there is no "PlexiiSuite" button to click — the object-based IA
    // dropped the literal sidebar entries, so this waited out the full 30s
    // timeout. goSuite ({ kind: 'suite' }) is the view store's own route to it.
    await gotoView(window, 'goSuite')
    await expect(window.locator('[data-testid="plexisuite-home"]')).toBeVisible({ timeout: 8_000 })

    await window.locator('[data-testid="product-tile-plexiapi"]').click()
    await expect(window.locator('[data-testid="product-home-plexiapi"]')).toBeVisible({ timeout: 8_000 })

    await window.locator('[data-testid="open-plexiapi"]').click()
    await expect(window.locator('[data-testid="plexiapi-view"]')).toBeVisible({ timeout: 8_000 })
  } finally {
    await dispose()
  }
})
