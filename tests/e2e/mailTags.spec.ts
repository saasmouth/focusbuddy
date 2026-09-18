// Mail tags, end to end.
//
// The tags themselves are real here: created through the real IPC into the
// real SQLite database, listed back, and used to filter. Only the MAIL is
// seeded, because there is no IMAP server in e2e and `window.api` is a
// contextBridge object that cannot be stubbed from the renderer.
//
// What matters most in this file is the Unsorted count. It is the number the
// whole feature exists to move, and it is the one thing that cannot be faked:
// it has to fall by exactly the number of messages a new tag claimed.

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

test.setTimeout(120_000)

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function openMail(window: Page): Promise<void> {
  await window.locator('[data-testid="switch-office"]').click()
  await window.locator('[data-testid="office-comms-app-mail"]').click()
}

/** A mailbox of known shape: 6 from acme, 4 from beta, 2 personal. */
async function seedInbox(window: Page): Promise<void> {
  await window.evaluate(() => {
    const w = window as unknown as {
      __fbMail: { setState: (s: Record<string, unknown>) => void }
    }
    const make = (uid: number, address: string, name: string, subject: string) => ({
      uid,
      fromName: name,
      fromAddress: address,
      subject,
      date: uid * 100000,
      seen: uid % 3 !== 0,
      flagged: false,
      hasAttachments: false,
      messageId: `<${uid}@x>`,
      inReplyTo: null,
      references: []
    })
    const messages = [
      ...Array.from({ length: 6 }, (_, i) =>
        make(100 + i, `p${i}@acme.com`, `Acme ${i}`, `Acme note ${i}`)
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        make(200 + i, `q${i}@beta.com`, `Beta ${i}`, `Invoice ${i}`)
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        make(300 + i, `dana${i}@gmail.com`, `Dana ${i}`, `Lunch ${i}`)
      )
    ]
    w.__fbMail.setState({
      account: { configured: true, email: 'me@example.com' },
      loadedAccount: true,
      messages,
      hasMore: false,
      nextCursor: null,
      total: messages.length,
      loadingList: false,
      loadingMore: false,
      error: null
    })
  })
}

/** Remove every tag, so each case starts from a known state. */
async function clearTags(window: Page): Promise<void> {
  await window.evaluate(async () => {
    const w = window as unknown as {
      api: { mailTags: { list: () => Promise<Array<{ id: string }>>; remove: (id: string) => Promise<boolean> } }
      __fbMailTags: { getState: () => { refresh: () => Promise<void> } }
    }
    for (const f of await w.api.mailTags.list()) await w.api.mailTags.remove(f.id)
    await w.__fbMailTags.getState().refresh()
  })
}

const unsorted = (window: Page): Promise<string> =>
  window.locator('[data-testid="mail-unsorted-count"]').innerText()

test('1. a tag files mail and the unsorted pile falls by exactly that much', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openMail(window)
  await clearTags(window)
  await seedInbox(window)

  await expect(window.locator('[data-testid="mail-tag-rail"]')).toBeVisible({ timeout: 8000 })
  expect(await unsorted(window)).toBe('12')

  await window.locator('[data-testid="mail-tag-new"]').click()
  await expect(window.locator('[data-testid="mail-tag-editor"]')).toBeVisible({ timeout: 5000 })
  await window.locator('[data-testid="tag-name"]').fill('Acme')
  await window.locator('[data-testid="tag-from"]').fill('acme.com')
  // The editor states what the rule catches BEFORE saving, so an empty tag
  // and a broken rule are never confused for each other.
  await expect(window.locator('[data-testid="tag-preview-count"]')).toContainText('6 of the 12')
  await window.locator('[data-testid="tag-save"]').click()

  await expect(window.locator('[data-testid="mail-tag-editor"]')).toHaveCount(0, { timeout: 5000 })
  // 12 - 6 = 6. This is the number the feature exists to move.
  await expect(window.locator('[data-testid="mail-unsorted-count"]')).toHaveText('6', {
    timeout: 8000
  })
})

test('2. selecting a tag shows only its mail, and Unsorted only what nothing claimed', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openMail(window)
  await clearTags(window)
  await seedInbox(window)

  await window.locator('[data-testid="mail-tag-new"]').click()
  await window.locator('[data-testid="tag-name"]').fill('Beta')
  await window.locator('[data-testid="tag-from"]').fill('beta.com')
  await window.locator('[data-testid="tag-save"]').click()
  await expect(window.locator('[data-testid="mail-unsorted-count"]')).toHaveText('8', { timeout: 8000 })

  const betaId = await window.evaluate(async () => {
    const w = window as unknown as { api: { mailTags: { list: () => Promise<Array<{ id: string; name: string }>> } } }
    return (await w.api.mailTags.list()).find((f) => f.name === 'Beta')!.id
  })
  await window.locator(`[data-testid="mail-tag-${betaId}"]`).click()
  await expect(window.locator('[data-testid="mail-scope-title"]')).toHaveText('Beta')
  expect(await window.locator('[data-testid="mail-thread"]').count()).toBe(4)

  await window.locator('[data-testid="mail-scope-unsorted"]').click()
  await expect(window.locator('[data-testid="mail-scope-title"]')).toHaveText('Unsorted')
  expect(await window.locator('[data-testid="mail-thread"]').count()).toBe(8)

  await window.locator('[data-testid="mail-scope-inbox"]').click()
  expect(await window.locator('[data-testid="mail-thread"]').count()).toBe(12)
})

test('3. a message the rule missed can be filed by hand, and it sticks', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openMail(window)
  await clearTags(window)
  await seedInbox(window)

  await window.locator('[data-testid="mail-tag-new"]').click()
  await window.locator('[data-testid="tag-name"]').fill('Acme')
  await window.locator('[data-testid="tag-from"]').fill('acme.com')
  await window.locator('[data-testid="tag-save"]').click()
  await expect(window.locator('[data-testid="mail-unsorted-count"]')).toHaveText('6', { timeout: 8000 })

  // A personal message the acme rule cannot reach. Without a manual override a
  // rule that misses is a dead end.
  await window.locator('[data-testid="mail-scope-unsorted"]').click()
  await window.locator('[data-testid="mail-tag-open-301"]').click({ force: true })
  await expect(window.locator('[data-testid="mail-tag-menu"]')).toBeVisible({ timeout: 5000 })
  await window.locator('[data-testid^="mail-tag-apply-"]').first().click()

  await expect(window.locator('[data-testid="mail-unsorted-count"]')).toHaveText('5', { timeout: 8000 })

  // And it survives a reload, because it was written to the database.
  await window.reload()
  await waitForReady(window)
  await openMail(window)
  await seedInbox(window)
  await expect(window.locator('[data-testid="mail-unsorted-count"]')).toHaveText('5', { timeout: 8000 })
})

test('4. a tag can be about a desk, and deleting the desk keeps the tag', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // A real desk, made through the real node store.
  const deskId = await window.evaluate(async () => {
    const w = window as unknown as {
      __fbNodes: { getState: () => { create: (d: unknown) => Promise<{ id: string }>; refresh: () => Promise<void> } }
    }
    const n = await w.__fbNodes.getState().create({ kind: 'task', title: 'Ridge St', parentId: null })
    return n.id
  })

  await openMail(window)
  await clearTags(window)
  await seedInbox(window)

  await window.locator('[data-testid="mail-tag-new"]').click()
  await window.locator('[data-testid="tag-name"]').fill('Ridge St mail')
  await window.locator('[data-testid="tag-from"]').fill('acme.com')
  await window.locator('[data-testid="tag-node"]').selectOption(deskId)
  await window.locator('[data-testid="tag-save"]').click()

  // The desk it is about is shown on the tag, not hidden in a menu.
  await expect(window.locator(`[data-testid="mail-tag-desk-${deskId}"]`).or(
    window.locator('[data-testid^="mail-tag-desk-"]')
  ).first()).toHaveText('Ridge St', { timeout: 8000 })

  const folderId = await window.evaluate(async () => {
    const w = window as unknown as { api: { mailTags: { list: () => Promise<Array<{ id: string; nodeId: string | null }>> } } }
    return (await w.api.mailTags.list())[0].id
  })

  const folderNow = async (fid: string): Promise<{ name: string; nodeId: string | null } | null> =>
    window.evaluate(async (id) => {
      const w = window as unknown as {
        api: { mailTags: { list: () => Promise<Array<{ id: string; name: string; nodeId: string | null }>> } }
      }
      return (await w.api.mailTags.list()).find((f) => f.id === id) ?? null
    }, fid)

  // Trashing a desk is UNDOABLE, so the link has to survive it. Unlinking here
  // would mean restoring a desk quietly lost what its mail tag was about.
  await window.evaluate(async (id) => {
    const w = window as unknown as { api: { nodes: { delete: (i: string) => Promise<unknown> } } }
    await w.api.nodes.delete(id)
  }, deskId)
  const trashed = await folderNow(folderId)
  expect(trashed, 'the tag must survive its desk being trashed').not.toBeNull()
  expect(trashed!.nodeId, 'a trashed desk can come back, so the link stays').toBe(deskId)

  // A permanent delete is the real hard delete. The tag must still survive —
  // tidying a workspace cannot take somebody's mail filing with it — but it
  // stops being about a desk that no longer exists.
  await window.evaluate(async (id) => {
    const w = window as unknown as { api: { nodes: { deletePermanent: (i: string) => Promise<unknown> } } }
    await w.api.nodes.deletePermanent(id)
  }, deskId)
  const purged = await folderNow(folderId)
  expect(purged, 'the tag must survive its desk being purged').not.toBeNull()
  expect(purged!.name).toBe('Ridge St mail')
  expect(purged!.nodeId).toBeNull()
})
