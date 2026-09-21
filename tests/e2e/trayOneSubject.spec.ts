// One screen, one tab — however you got there.
//
// Reaching Mail as a top-level view and as Office's Mail app produced two tabs,
// both labelled "Mail", for the same inbox. Reaching a desk directly and via
// "My Desk" produced two tabs for the same canvas.

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

test.setTimeout(180_000)
let launched: LaunchedApp | null = null
test.afterEach(async () => { if (launched) { await launched.dispose(); launched = null } })

const tray = (w: Page): Promise<{ key: string; label: string }[]> =>
  w.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="tray-item-"]')].map((n) => ({
      key: (n.getAttribute('data-testid') || '').replace('tray-item-', ''),
      label: (n.textContent || '').trim()
    })))

test('Mail reached both ways is one tab', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await window.evaluate(() => (window as any).__fbView.getState().go({ kind: 'mail' }))
  await window.waitForTimeout(600)
  await window.evaluate(() => (window as any).__fbView.getState().goOffice('mail'))
  await window.waitForTimeout(1200)

  const mail = (await tray(window)).filter((t) => t.label === 'Mail')
  expect(mail, `got ${mail.length} Mail tabs`).toHaveLength(1)
})

test('a desk reached directly and via My Desk is one tab', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const id = await window.evaluate(async () => {
    const w = window as any
    const d = await w.__fbNodes.getState().create({ kind: 'task', title: 'Q4 launch', parentId: null })
    await w.__fbNodes.getState().refresh()
    return d.id as string
  })
  await window.evaluate((i) => (window as any).__fbView.getState().goTask(i), id)
  await window.waitForTimeout(600)
  await window.evaluate(() => (window as any).__fbView.getState().goPlexiDesk('desk'))
  await window.waitForTimeout(1200)

  const t = await tray(window)
  // The desk keeps its own name; "My Desk" adds nothing beside it.
  expect(t.filter((x) => x.key === `task:${id}`)).toHaveLength(1)
  expect(t.filter((x) => x.key === 'plexidesk:desk'), 'My Desk should not be a second tab').toHaveLength(0)
})
