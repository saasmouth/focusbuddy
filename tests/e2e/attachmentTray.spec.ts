// Pictures and documents attached in the assistant's composer (owner,
// 2026-11-19: "check the ability to paste into the ai prompt"; d0: "build the
// attachment tray").
//
//   AT-1  Paste a screenshot into the composer: it waits in the tray as a
//         thumbnail that opens larger and can be removed; sent with a
//         question, it goes as a picture (an image for the model) and the
//         message says what was attached. (A pasted picture used to vanish.)
//   AT-2  Paste a document: it is kept in Files and its text goes with the
//         message, as the desk's open documents do.
//   AT-3  A file the assistant cannot read is refused in words, not dropped.
//
// What is sent is caught at the chat store; no AI is reached. The model side
// (image blocks on the last user turn, OpenAI's image_url, Local's
// ask-before-cloud) is tests/unit/chatImages.test.ts and the router's own.
// A pasted file is what the OS hands the page on ⌘V, so the composer is handed
// a paste event carrying the file, as the platform would.
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import { installClipboardStub, installMainClipboardStub } from './_clipboardStub'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
})

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8AARwzEcQCukw/x0F8jngAAAABJRU5ErkJggg=='

interface Sent {
  content: string
  extra?: { images?: Array<{ mediaType: string; data: string; name?: string }>; files?: Array<{ title: string; text: string; kind: string }> }
}

async function openComposer(l: LaunchedApp): Promise<Page> {
  const { window } = l
  await waitForReady(window)
  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.nodes.create({ parentId: null, kind: 'task', title: 'TrayDesk' })
  })
  await window.reload()
  await waitForReady(window)
  await installClipboardStub(window)
  await window.getByRole('button', { name: /TrayDesk/ }).first().click()
  await window.locator('[data-testid="assistant-pill"]').click()
  await expect(window.locator('[data-testid="chat-composer"]').first()).toBeVisible({ timeout: 10_000 })
  await window.evaluate(() => {
    const chat = (window as unknown as { __fbChat: { setState: (p: unknown) => void } }).__fbChat
    ;(window as unknown as { __sent: Sent[] }).__sent = []
    chat.setState({
      send: async (_t: unknown, content: string, _k: unknown, extra: Sent['extra']) => {
        ;(window as unknown as { __sent: Sent[] }).__sent.push({ content, extra })
      }
    })
  })
  return window
}

/** Paste one file into the composer, as the platform does on ⌘V. */
async function pasteFile(page: Page, name: string, type: string, b64: string): Promise<void> {
  await page.locator('[data-testid="chat-composer"]').first().click()
  await page.evaluate(
    ({ name, type, b64 }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], name, { type }))
      const target = document.querySelector('[data-testid="chat-composer"]') as HTMLElement
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    },
    { name, type, b64 }
  )
}

const sent = (p: Page): Promise<Sent[]> => p.evaluate(() => (window as unknown as { __sent: Sent[] }).__sent)

test('AT-1 a pasted screenshot waits in the tray, previews, and is sent as a picture', async () => {
  launched = await launchApp()
  await installMainClipboardStub(launched.app)
  const page = await openComposer(launched)
  await pasteFile(page, 'Screenshot.png', 'image/png', PNG_B64)
  const chip = page.locator('[data-testid="composer-attachment"]')
  await expect(chip).toHaveCount(1)
  await expect(chip).toHaveAttribute('data-status', 'ready', { timeout: 10_000 })
  // Nothing was typed into the message for it.
  expect(((await page.locator('[data-testid="chat-composer"]').first().textContent()) ?? '').trim()).toBe('')

  await page.locator('[data-testid="composer-attachment-preview"]').click()
  await expect(page.locator('[data-testid="composer-attachment-lightbox"] img')).toBeVisible()
  await page.locator('[data-testid="composer-attachment-lightbox"]').click()
  await expect(page.locator('[data-testid="composer-attachment-lightbox"]')).toHaveCount(0)

  // Removed, then pasted again.
  await page.locator('[data-testid="composer-attachment-remove"]').click()
  await expect(chip).toHaveCount(0)
  await pasteFile(page, 'Screenshot.png', 'image/png', PNG_B64)
  await expect(chip).toHaveAttribute('data-status', 'ready', { timeout: 10_000 })

  await page.keyboard.type('What is in this?')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await sent(page)).length).toBe(1)
  const [msg] = await sent(page)
  expect(msg.content).toBe('What is in this?\n\n(Attached: Screenshot.png)')
  expect(msg.extra?.images?.length).toBe(1)
  expect(msg.extra?.images?.[0].mediaType).toBe('image/png')
  expect(msg.extra?.images?.[0].data).toMatch(/^[A-Za-z0-9+/]+=*$/)
  await expect(chip).toHaveCount(0)
})

test('AT-2 a pasted document goes as its text', async () => {
  launched = await launchApp()
  await installMainClipboardStub(launched.app)
  const page = await openComposer(launched)
  const text = 'Budget review\nQ3 spend was 41k against a plan of 38k.'
  await pasteFile(page, 'review.txt', 'text/plain', Buffer.from(text).toString('base64'))
  await expect(page.locator('[data-testid="composer-attachment"]')).toHaveAttribute('data-status', 'ready', { timeout: 15_000 })
  await page.keyboard.type('Summarise this')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await sent(page)).length).toBe(1)
  const [msg] = await sent(page)
  expect(msg.content).toBe('Summarise this\n\n(Attached: review.txt)')
  expect(msg.extra?.files?.[0]).toMatchObject({ title: 'review.txt', kind: 'file' })
  expect(msg.extra?.files?.[0].text).toContain('Q3 spend was 41k')
})

test('AT-3 a file the assistant cannot read is refused in words', async () => {
  launched = await launchApp()
  await installMainClipboardStub(launched.app)
  const page = await openComposer(launched)
  await pasteFile(page, 'app.zip', 'application/zip', 'UEsDBA==')
  const chip = page.locator('[data-testid="composer-attachment"]')
  await expect(chip).toHaveAttribute('data-status', 'error')
  await expect(chip).toContainText('cannot read “app.zip”')
  // Nothing to send: the button stays off with only a refused file.
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled()
})
