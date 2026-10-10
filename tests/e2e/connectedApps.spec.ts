import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Integration tests for Connected Apps: schema migrations, seeding, sort
// promotion + favourites split, drag MIME shape. Drives the real Electron app
// via Playwright + window.api so we exercise the same IPC the user does.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('seeded Connected Apps render in the sidebar once a desk is open', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Seed via window.api so we exercise the real IPC + the new schema columns.
  // A desk comes with it: Connected Apps are desk furniture now, so the strip
  // only stands in the sidebar while a desk is open (and otherwise lives in
  // Settings). Seeding both in one pass keeps it to a single reload.
  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.connectedApps.create({ title: 'Gmail', url: 'https://mail.google.com' })
    await api.connectedApps.create({ title: 'GitHub', url: 'https://github.com' })
    await api.nodes.create({ parentId: null, kind: 'task', title: 'Connected apps desk' })
  })

  // We mutated under the store, so reload to pick the new state up cleanly.
  await window.reload()
  await waitForReady(window)

  // On Home — no desk open — the strip is not in the sidebar.
  await expect(window.getByText('Gmail', { exact: true })).toHaveCount(0)

  await window.getByRole('button', { name: 'Connected apps desk' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })

  // With the desk open both apps appear (favourites strip — the cold list
  // promotes everything since fewer than 6 apps).
  await expect(window.getByText('Gmail', { exact: true })).toBeVisible()
  await expect(window.getByText('GitHub', { exact: true })).toBeVisible()
})

test('schema migration: new connected_apps columns return correct defaults', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const created = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return await api.connectedApps.create({
      title: 'Notion',
      url: 'https://notion.so'
    })
  })

  // Defaults from the schema must be reflected in the typed return:
  // useCount=0, lastUsedAt=null, pinned=false, vaultEntryId=null,
  // autofillEnabled=true. Catches regressions if a future migration changes
  // the column defaults silently.
  expect(created.useCount).toBe(0)
  expect(created.lastUsedAt).toBeNull()
  expect(created.pinned).toBe(false)
  expect(created.vaultEntryId).toBeNull()
  expect(created.autofillEnabled).toBe(true)
})

test('touch() bumps use_count and last_used_at', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const result = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const app = await api.connectedApps.create({
      title: 'Slack',
      url: 'https://slack.com'
    })
    const before = { useCount: app.useCount, lastUsedAt: app.lastUsedAt }
    const touched1 = await api.connectedApps.touch(app.id)
    const touched2 = await api.connectedApps.touch(app.id)
    return { before, touched1, touched2 }
  })

  expect(result.before.useCount).toBe(0)
  expect(result.before.lastUsedAt).toBeNull()
  expect(result.touched1?.useCount).toBe(1)
  expect(result.touched1?.lastUsedAt).toBeGreaterThan(0)
  expect(result.touched2?.useCount).toBe(2)
})

test('findByHostname matches on hostname (no duplicates on Pin)', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const result = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const created = await api.connectedApps.create({
      title: 'Linear',
      url: 'https://linear.app/foo/team'
    })
    // Hostname matches regardless of subpath.
    const found = await api.connectedApps.findByHostname('linear.app')
    // www. prefix stripped on both sides.
    const foundWww = await api.connectedApps.findByHostname('www.linear.app')
    // Different host returns null — guards against false-positive de-duping.
    const missing = await api.connectedApps.findByHostname('linear.example')
    return {
      createdId: created.id,
      foundId: found?.id ?? null,
      foundWwwId: foundWww?.id ?? null,
      missing
    }
  })

  expect(result.foundId).toBe(result.createdId)
  expect(result.foundWwwId).toBe(result.createdId)
  expect(result.missing).toBeNull()
})

test('Pin app affordance dedupes against existing Connected Apps by hostname', async () => {
  // Regression: if a user already has GitHub pinned and hits "pin to apps"
  // from a github.com/issues/123 webview widget, we MUST reuse the existing
  // app — not create a second one. The flow is hostname-match + link the widget.
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const result = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const original = await api.connectedApps.create({
      title: 'GitHub',
      url: 'https://github.com'
    })
    // The renderer-side dedupe path: findByHostname → reuse if found.
    const match = await api.connectedApps.findByHostname('github.com')
    return {
      originalId: original.id,
      matchedId: match?.id ?? null,
      allCount: (await api.connectedApps.list()).length
    }
  })

  expect(result.matchedId).toBe(result.originalId)
  expect(result.allCount).toBe(1)
})
