/**
 * E2E for the PlexiDesign redesign wizard — the content-first path.
 *
 * This is the user's actual journey: dump a document in, pick a look, get a
 * finished multi-page publication, then keep editing the words. The old
 * frame-first threading was unusable (double-clicking a threaded frame opened an
 * empty box and typing vanished), so the regression tests here are deliberately
 * about EDITING after the layout, not only about producing it.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import { existsSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PARAGRAPH =
  'The quarterly numbers landed on a Tuesday and nobody quite believed them. Revenue had climbed for the sixth consecutive quarter, and the team that had spent two years rebuilding the platform finally had something to point at. It is worth saying plainly that this did not happen by accident or by luck. '

function articleText(paragraphs: number): string {
  const out = ['A Quarter Worth Reading About', '', 'How a rebuilt platform finally started paying for itself', '']
  for (let i = 0; i < paragraphs; i++) {
    if (i > 0 && i % 3 === 0) out.push(`### Section ${i / 3}`, '')
    out.push(PARAGRAPH.repeat(2).trim(), '')
  }
  out.push('- First point worth listing', '- Second point worth listing', '', '> A line somebody said once.', '> — A Person', '')
  return out.join('\n')
}

/**
 * Click (or double-click) a point inside a body text frame, as a user would.
 * The point is chosen below any floating object (a pull quote sits ON TOP of the
 * column, so a click near the top of the frame correctly selects the float).
 */
async function clickInBodyText(window: Page, dbl = false): Promise<void> {
  const frame = await window.evaluate(() => {
    const els = [...document.querySelectorAll('[data-testid="slide-element"][data-eltype="text"]')] as HTMLElement[]
    // The tallest text element on the page is a body column, not the headline.
    let best: DOMRect | null = null
    for (const el of els) {
      const r = el.getBoundingClientRect()
      if (!best || r.height > best.height) best = r
    }
    if (!best) return null
    const x = best.x + best.width / 2
    // Walk down the column until the topmost element at that point IS the column.
    for (let dy = 40; dy < Math.min(best.height - 20, 600); dy += 40) {
      const y = best.y + dy
      const hit = document.elementFromPoint(x, y) as HTMLElement | null
      const owner = hit?.closest('[data-testid="slide-element"]') as HTMLElement | null
      if (owner && owner.getBoundingClientRect().height === best.height) return { x, y }
    }
    return { x, y: best.y + Math.min(best.height * 0.5, 300) }
  })
  if (!frame) throw new Error('no body text frame on the page')
  if (dbl) await window.mouse.dblclick(frame.x, frame.y)
  else await window.mouse.click(frame.x, frame.y)
}

async function openPublication(window: Page): Promise<void> {
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => Record<string, () => void> } }
    w.__fbView?.getState().goDesign?.()
  })
  await expect(window.locator('[data-testid="designs-size-a4-portrait"]')).toBeVisible({ timeout: 10_000 })
  await window.locator('[data-testid="designs-size-a4-portrait"]').click()
  await expect(window.locator('[data-testid="design-editor"]')).toBeVisible({ timeout: 10_000 })
}

/** Every word the pages actually set, reconstructed from the flowed lines. */
async function setText(window: Page): Promise<string> {
  return window.evaluate(() => {
    const out: string[] = []
    document.querySelectorAll('[data-testid="slide-canvas"] [data-testid="slide-element"]').forEach((el) => {
      out.push(el.textContent ?? '')
    })
    return out.join(' ')
  })
}

test.describe('PlexiDesign redesign wizard', () => {
  let app: LaunchedApp
  let window: Page

  test.beforeAll(async () => {
    app = await launchApp()
    window = app.window
    await waitForReady(window)
    await openPublication(window)
  })

  test.afterAll(async () => {
    await app.dispose()
  })

  test('RW-1 the wizard opens and reads the pasted document', async () => {
    await window.locator('[data-testid="design-redesign-btn"]').click()
    await expect(window.locator('[data-testid="design-redesign-wizard"]')).toBeVisible()
    await window.locator('[data-testid="design-wizard-text"]').fill(articleText(9))
    const stats = window.locator('[data-testid="design-wizard-stats"]')
    await expect(stats).toBeVisible({ timeout: 5_000 })
    await expect(stats).toContainText('words')
    await expect(stats).toContainText('headings')
  })

  test('RW-2 every look is a live preview of the real words, and one is recommended', async () => {
    const options = window.locator('[data-testid="design-wizard-options"] button')
    await expect(options).toHaveCount(5)
    // Each preview is a real laid-out page, so each reports its own page count.
    await expect(window.locator('[data-testid="design-wizard-style-editorial"]')).toContainText('page')
    await expect(window.locator('[data-testid="design-wizard-reason"]')).toBeVisible()
  })

  test('RW-3 applying a look builds a real multi-page document', async () => {
    await window.locator('[data-testid="design-wizard-style-editorial"]').click()
    await window.locator('[data-testid="design-wizard-apply"]').click()
    await expect(window.locator('[data-testid="design-redesign-wizard"]')).toHaveCount(0)
    // More than one page, and the page rail proves it.
    await expect(window.locator('[data-testid="design-page-1"]')).toBeVisible({ timeout: 8_000 })
    // The headline is set as display type on the opening page.
    expect(await setText(window)).toContain('A Quarter Worth Reading About')
  })

  test('RW-4 the body copy really is on the page, not hidden in a data structure', async () => {
    const text = await setText(window)
    expect(text).toContain('quarterly numbers landed')
    expect(text).toContain('Section 1')
  })

  test('RW-5 nothing is overset — the layout grew to fit the copy', async () => {
    await expect(window.locator('[data-testid="design-overset"]')).toHaveCount(0)
  })

  test('RW-6 the story editor is still reachable from the inspector', async () => {
    // Clicking a frame selects it; the inspector then offers the story editor for
    // people who would rather write in a panel than on the page.
    await clickInBodyText(window)
    await window.locator('[data-testid="design-open-story"]').click()
    const editor = window.locator('[data-testid="design-story-editor"]')
    await expect(editor).toBeVisible({ timeout: 5_000 })
    const box = window.locator('[data-testid="design-story-text"]')
    expect((await box.inputValue()).length).toBeGreaterThan(200)
  })

  test('RW-7 typing in the story editor changes what the page shows — the old bug', async () => {
    const box = window.locator('[data-testid="design-story-text"]')
    await box.fill('### A brand new section\n\nAnd the only paragraph that should remain on the page now.')
    await expect.poll(async () => await setText(window), { timeout: 8_000 }).toContain('A brand new section')
    const text = await setText(window)
    expect(text).toContain('the only paragraph that should remain')
    expect(text).not.toContain('quarterly numbers landed')
  })

  test('RW-8 pouring more text back in reflows across the frames', async () => {
    const box = window.locator('[data-testid="design-story-text"]')
    await box.fill(articleText(6))
    await expect.poll(async () => await setText(window), { timeout: 8_000 }).toContain('quarterly numbers landed')
    // Close the panel so the following tests work on the page itself.
    await window.locator('[data-testid="design-story-editor"] button').first().click()
    await expect(window.locator('[data-testid="design-story-editor"]')).toHaveCount(0)
  })

  test('RW-9 re-running the wizard keeps the document, headline included', async () => {
    await window.locator('[data-testid="design-redesign-btn"]').click()
    const text = await window.locator('[data-testid="design-wizard-text"]').inputValue()
    expect(text).toContain('A Quarter Worth Reading About')
    await window.locator('[data-testid="design-wizard-style-report"]').click()
    await window.locator('[data-testid="design-wizard-apply"]').click()
    await expect(window.locator('[data-testid="design-redesign-wizard"]')).toHaveCount(0)
    expect(await setText(window)).toContain('A Quarter Worth Reading About')
  })

  test('RW-10 undo puts the previous layout back', async () => {
    await window.locator('[data-testid="design-undo"]').click()
    await expect.poll(async () => await setText(window), { timeout: 8_000 }).toContain('A Quarter Worth Reading About')
  })

  test('RW-11 double-clicking the page puts a caret in the text — no side panel', async () => {
    // A publishing editor lets you type ON the page. Double-clicking a threaded
    // frame drops a caret where the pointer was.
    await clickInBodyText(window, true)
    await expect(window.locator('[data-testid="design-text-caret"]')).toBeVisible({ timeout: 5_000 })
    await expect(window.locator('[data-testid="design-text-input"]')).toBeAttached()
  })

  test('RW-12 typing on the page inserts into the story and reflows it', async () => {
    const input = window.locator('[data-testid="design-text-input"]')
    await input.focus()
    await input.type('ZZMARKERZZ')
    await expect.poll(async () => await setText(window), { timeout: 8_000 }).toContain('ZZMARKERZZ')
  })

  test('RW-13 the caret moves with the arrow keys and selects with shift', async () => {
    const input = window.locator('[data-testid="design-text-input"]')
    await input.press('ArrowLeft')
    await input.press('Shift+ArrowLeft')
    await input.press('Shift+ArrowLeft')
    await expect(window.locator('[data-testid="design-text-selection"]').first()).toBeVisible({ timeout: 5_000 })
  })

  test('RW-14 typing over a selection replaces it', async () => {
    const before = await setText(window)
    expect(before).toContain('ZZMARKERZZ')
    const input = window.locator('[data-testid="design-text-input"]')
    await input.type('Q')
    await expect.poll(async () => await setText(window), { timeout: 8_000 }).not.toContain('ZZMARKERZZ')
  })

  test('RW-15 Enter starts a new paragraph on the page', async () => {
    const input = window.locator('[data-testid="design-text-input"]')
    await input.press('Enter')
    await input.type('A fresh paragraph typed straight onto the page.')
    await expect.poll(async () => await setText(window), { timeout: 8_000 }).toContain('A fresh paragraph typed straight onto the page.')
  })

  test('RW-16 Backspace deletes, and Escape leaves text editing', async () => {
    const input = window.locator('[data-testid="design-text-input"]')
    for (let i = 0; i < 5; i++) await input.press('Backspace')
    await expect.poll(async () => await setText(window), { timeout: 8_000 }).not.toContain('onto the page.')
    await input.press('Escape')
    await expect(window.locator('[data-testid="design-text-caret"]')).toHaveCount(0, { timeout: 5_000 })
    // And the page is interactive again the moment the caret is gone.
    await expect(window.locator('[data-testid="design-text-surface"]')).toHaveCount(0)
  })

  test('RW-17 a run of typing is ONE undo step, not one per character', async () => {
    await clickInBodyText(window, true)
    const input = window.locator('[data-testid="design-text-input"]')
    await input.type('UNDOWORD')
    await expect.poll(async () => await setText(window), { timeout: 8_000 }).toContain('UNDOWORD')
    await input.press('Escape')
    await window.locator('[data-testid="design-undo"]').click()
    await expect.poll(async () => await setText(window), { timeout: 8_000 }).not.toContain('UNDOWORD')
  })

  test('RW-18 the laid-out document exports as a real multi-page PDF', async () => {
    const path = join(tmpdir(), `plexi-redesign-${process.pid}.pdf`)
    try {
      await app.app.evaluate(async ({ dialog }, filePath) => {
        // @ts-expect-error test override
        dialog.showSaveDialog = async () => ({ canceled: false, filePath })
      }, path)

      const res = await window.evaluate(async () => {
        const store = (window as unknown as { __fbDocuments?: { getState: () => { active: { body: unknown; title: string } | null } } }).__fbDocuments
        const active = store?.getState().active
        if (!active) return { ok: false, error: 'no active document' }
        const api = (window as unknown as { api: typeof window.api }).api
        return api.design.export({ design: active.body as never, title: 'redesign', format: 'pdf' })
      })
      expect(res.ok).toBe(true)
      expect(existsSync(path)).toBe(true)

      const pdf = readFileSync(path)
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
      // The page tree records how many pages were really written.
      const count = /\/Count\s+(\d+)/.exec(pdf.toString('latin1'))
      expect(count).toBeTruthy()
      expect(Number(count![1])).toBeGreaterThan(1)
    } finally {
      if (existsSync(path)) rmSync(path)
    }
  })
})
