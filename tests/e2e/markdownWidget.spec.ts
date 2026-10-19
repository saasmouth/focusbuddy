import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Markdown widget — slash menu, export buttons, export IPC wiring, and
// robustness checks. All tests use an isolated hermetic userData directory.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// Boot the app, dismiss modal, create a task + markdown widget, navigate to the
// task and wait until the markdown widget toolbar has hydrated (we probe for the
// export buttons which are the last items in the toolbar).
async function seedMarkdownWidget(
  l: LaunchedApp,
  initialContent = ''
): Promise<{ taskId: string; widgetId: string }> {
  const { window } = l
  await waitForReady(window)

  const seeded = await window.evaluate(
    async ({ content }: { content: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const t = await api.nodes.create({ parentId: null, kind: 'task', title: 'MdTest' })
      const w = await api.widgets.create({
        taskId: t.id,
        kind: 'markdown',
        title: '',
        content,
        x: 80,
        y: 80,
        width: 500,
        height: 400
      })
      return { taskId: t.id, widgetId: w.id }
    },
    { content: initialContent }
  )

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /MdTest/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })

  // Wait for the widget element to be in the DOM and for the markdown toolbar
  // to hydrate. We poll until the export PDF button appears — it is the last
  // toolbar element, so its presence means the full toolbar has rendered.
  await window.waitForFunction(
    (wid) => {
      const el = document.querySelector(`[data-widget-id="${wid}"]`)
      return !!el?.querySelector('[data-testid="md-export-pdf"]')
    },
    seeded.widgetId,
    { timeout: 8_000 }
  )

  return seeded
}

// Scroll the tiptap editor into the visible area, focus it directly, and wait
// for ProseMirror to register the focus event before we type.
async function focusEditor(window: LaunchedApp['window'], widgetId: string): Promise<void> {
  const editorSelector = `[data-widget-id="${widgetId}"] .tiptap`
  await window.waitForSelector(editorSelector, { timeout: 5_000 })
  await window.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null
    el?.scrollIntoView({ behavior: 'instant', block: 'center' })
    el?.focus()
  }, editorSelector)
  // Let ProseMirror propagate the focus and mark the editor as active.
  await window.waitForTimeout(300)
}

// ─── A: Slash menu ────────────────────────────────────────────────────────────

test('A1 — slash menu appears when "/" is typed in the markdown editor', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { widgetId } = await seedMarkdownWidget(launched, '')

  await focusEditor(window, widgetId)
  await window.keyboard.type('/')
  // handleKeyDown schedules a setTimeout(0) before calling setSlashOpen — give
  // it two ticks to fire and React to re-render.
  await window.waitForTimeout(300)

  const menuExists = await window.evaluate(
    () => !!document.querySelector('[data-testid="md-slash-menu"]')
  )
  expect(menuExists, 'md-slash-menu is in the DOM after typing "/"').toBe(true)
})

test('A2 — selecting "Heading 1" inserts <h1> and removes the "/" trigger', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { widgetId } = await seedMarkdownWidget(launched, '')

  await focusEditor(window, widgetId)
  await window.keyboard.type('hello ')
  await window.keyboard.type('/')
  await window.waitForTimeout(300)

  const menuOpened = await window.evaluate(
    () => !!document.querySelector('[data-testid="md-slash-menu"]')
  )
  expect(menuOpened, 'slash menu must be open before clicking Heading 1').toBe(true)

  // Click the "Heading 1" item via DOM — avoids Playwright frame matching issues.
  await window.evaluate(() => {
    const menu = document.querySelector('[data-testid="md-slash-menu"]')
    if (!menu) throw new Error('slash menu not found')
    // The button text is "<icon-ligature><label><shortcut>" (the Icon renders
    // its name as ligature text), so match on includes, not startsWith.
    const btn = Array.from(menu.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Heading 1')
    ) as HTMLButtonElement | undefined
    if (!btn) throw new Error('Heading 1 button not found in menu')
    btn.click()
  })
  await window.waitForTimeout(200)

  // Menu is gone.
  const menuGone = await window.evaluate(
    () => !document.querySelector('[data-testid="md-slash-menu"]')
  )
  expect(menuGone, 'menu closes after selection').toBe(true)

  // An <h1> now exists in the tiptap editor.
  const hasH1 = await window.evaluate(
    (wid) => !!document.querySelector(`[data-widget-id="${wid}"] .tiptap h1`),
    widgetId
  )
  expect(hasH1, 'h1 was inserted').toBe(true)

  // The "/" trigger was deleted by applyBlock. The editor HTML must not contain
  // a text node that is literally just "/" — e.g. <p>/</p> or >/<.
  const editorHtml = await window.evaluate(
    (wid) =>
      (
        document.querySelector(`[data-widget-id="${wid}"] .tiptap`) as HTMLElement | null
      )?.innerHTML ?? '',
    widgetId
  )
  expect(editorHtml, 'no bare slash remains as text').not.toContain('>/</')
})

test('A3 — Escape key closes the slash menu without inserting any block', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { widgetId } = await seedMarkdownWidget(launched, '')

  await focusEditor(window, widgetId)
  await window.keyboard.type('/')
  await window.waitForTimeout(300)

  const menuOpenedBefore = await window.evaluate(
    () => !!document.querySelector('[data-testid="md-slash-menu"]')
  )
  expect(menuOpenedBefore, 'menu must open before Escape').toBe(true)

  await window.keyboard.press('Escape')
  await window.waitForTimeout(200)

  const menuGone = await window.evaluate(
    () => !document.querySelector('[data-testid="md-slash-menu"]')
  )
  expect(menuGone, 'menu closes on Escape').toBe(true)

  const hasH1 = await window.evaluate(
    (wid) => !!document.querySelector(`[data-widget-id="${wid}"] .tiptap h1`),
    widgetId
  )
  expect(hasH1, 'no h1 after Escape').toBe(false)
})

// ─── B: Export buttons ────────────────────────────────────────────────────────

test('B1 — Export HTML and Export PDF toolbar buttons are present in the markdown widget', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { widgetId } = await seedMarkdownWidget(launched, 'Check export buttons')

  // seedMarkdownWidget already waited for md-export-pdf to be in the DOM.
  const buttonState = await window.evaluate((wid) => {
    const htmlBtn = document.querySelector(
      `[data-widget-id="${wid}"] [data-testid="md-export-html"]`
    )
    const pdfBtn = document.querySelector(
      `[data-widget-id="${wid}"] [data-testid="md-export-pdf"]`
    )
    return {
      htmlBtnExists: !!htmlBtn,
      pdfBtnExists: !!pdfBtn,
      htmlBtnTitle: (htmlBtn as HTMLElement | null)?.title ?? '',
      pdfBtnTitle: (pdfBtn as HTMLElement | null)?.title ?? ''
    }
  }, widgetId)

  expect(buttonState.htmlBtnExists, 'md-export-html is in DOM').toBe(true)
  expect(buttonState.pdfBtnExists, 'md-export-pdf is in DOM').toBe(true)
  expect(buttonState.htmlBtnTitle, 'HTML button has correct title').toContain('HTML')
  expect(buttonState.pdfBtnTitle, 'PDF button has correct title').toContain('PDF')
})

// ─── B2/B3: Export IPC wiring ─────────────────────────────────────────────────
//
// contextBridge.exposeInMainWorld returns a frozen proxy — renderer-side
// assignment to window.api.exportDoc.pdf silently fails. Instead we spy in the
// MAIN PROCESS via app.evaluate, replacing the ipcMain handlers with stubs that
// capture the invocation argument and return { ok: true, path: ... } so the
// renderer's status line shows "Saved …". Same pattern used in fileWidget.spec.ts.

async function installExportSpy(l: LaunchedApp): Promise<void> {
  await l.app.evaluate(async ({ ipcMain }) => {
    interface SpyGlobal {
      __fb_export_html_args: Array<{ html: string; suggestedName: string }>
      __fb_export_pdf_args: Array<{ html: string; suggestedName: string }>
    }
    const g = globalThis as unknown as SpyGlobal
    g.__fb_export_html_args = []
    g.__fb_export_pdf_args = []

    // removeHandler is the correct API for handlers registered with ipcMain.handle.
    ipcMain.removeHandler('export:html')
    ipcMain.removeHandler('export:pdf')

    ipcMain.handle('export:html', (_e, input: { html: string; suggestedName: string }) => {
      g.__fb_export_html_args.push(input)
      return { ok: true as const, path: '/tmp/stub-export.html' }
    })
    ipcMain.handle('export:pdf', (_e, input: { html: string; suggestedName: string }) => {
      g.__fb_export_pdf_args.push(input)
      return { ok: true as const, path: '/tmp/stub-export.pdf' }
    })
  })
}

async function readExportSpyArgs(l: LaunchedApp): Promise<{
  html: Array<{ html: string; suggestedName: string }>
  pdf: Array<{ html: string; suggestedName: string }>
}> {
  return l.app.evaluate(() => {
    interface SpyGlobal {
      __fb_export_html_args: Array<{ html: string; suggestedName: string }>
      __fb_export_pdf_args: Array<{ html: string; suggestedName: string }>
    }
    const g = globalThis as unknown as SpyGlobal
    return {
      html: g.__fb_export_html_args ?? [],
      pdf: g.__fb_export_pdf_args ?? []
    }
  })
}

test('B2 — Export PDF button invokes IPC with a well-formed HTML document', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { widgetId } = await seedMarkdownWidget(launched, 'Export PDF test content')

  await installExportSpy(launched)

  // Click the PDF button by DOM direct call so canvas transform doesn't
  // prevent Playwright's synthetic click from reaching it.
  await window.evaluate((wid) => {
    const btn = document.querySelector(
      `[data-widget-id="${wid}"] [data-testid="md-export-pdf"]`
    ) as HTMLButtonElement | null
    if (!btn) throw new Error('md-export-pdf not found in DOM')
    btn.click()
  }, widgetId)

  await window.waitForTimeout(1_200)

  const args = await readExportSpyArgs(launched)
  expect(args.pdf.length, 'export:pdf IPC handler was called exactly once').toBe(1)

  const arg = args.pdf[0]
  // Document structure — every field from buildExportHtml.
  expect(arg.html.slice(0, 15).toLowerCase(), 'starts with <!doctype html>').toBe('<!doctype html>')
  expect(arg.html, 'body wrapped in <main class="doc">').toContain('class="doc"')
  expect(arg.html, 'contains inline <style> block').toContain('<style>')
  // suggestedName is a clean slug, no heading markers.
  expect(arg.suggestedName.length, 'suggestedName is non-empty').toBeGreaterThan(0)
  expect(arg.suggestedName, 'suggestedName has no leading "#"').not.toMatch(/^#/)

  // Status line shows "Saved" because the stub returned ok: true.
  const statusText = await window.evaluate(
    (wid) =>
      (
        document.querySelector(
          `[data-widget-id="${wid}"] [data-testid="md-export-status"]`
        ) as HTMLElement | null
      )?.innerText ?? '',
    widgetId
  )
  expect(statusText, 'status shows "Saved"').toContain('Saved')

  console.log('[B2] suggestedName:', arg.suggestedName)
  console.log('[B2] html[:80]:', arg.html.slice(0, 80))
})

test('B3 — Export HTML button invokes IPC with a well-formed HTML document', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { widgetId } = await seedMarkdownWidget(launched, 'Export HTML test content')

  await installExportSpy(launched)

  await window.evaluate((wid) => {
    const btn = document.querySelector(
      `[data-widget-id="${wid}"] [data-testid="md-export-html"]`
    ) as HTMLButtonElement | null
    if (!btn) throw new Error('md-export-html not found in DOM')
    btn.click()
  }, widgetId)

  await window.waitForTimeout(1_200)

  const args = await readExportSpyArgs(launched)
  expect(args.html.length, 'export:html IPC handler was called exactly once').toBe(1)

  const arg = args.html[0]
  expect(arg.html.slice(0, 15).toLowerCase()).toBe('<!doctype html>')
  expect(arg.html).toContain('class="doc"')
  expect(arg.html).toContain('<style>')
  expect(arg.suggestedName.length).toBeGreaterThan(0)
  expect(arg.suggestedName).not.toMatch(/^#/)

  const statusText = await window.evaluate(
    (wid) =>
      (
        document.querySelector(
          `[data-widget-id="${wid}"] [data-testid="md-export-status"]`
        ) as HTMLElement | null
      )?.innerText ?? '',
    widgetId
  )
  expect(statusText).toContain('Saved')

  console.log('[B3] suggestedName:', arg.suggestedName)
  console.log('[B3] html[:80]:', arg.html.slice(0, 80))
})

// ─── C: Robustness — exactly one "/" is removed ──────────────────────────────

test('C — applyBlock removes exactly one "/" and preserves surrounding characters', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { widgetId } = await seedMarkdownWidget(launched, '')

  await focusEditor(window, widgetId)
  // Type "abc" then "/" — menu opens with "abc" in the paragraph.
  await window.keyboard.type('abc/')
  await window.waitForTimeout(300)

  const menuOpened = await window.evaluate(
    () => !!document.querySelector('[data-testid="md-slash-menu"]')
  )
  expect(menuOpened, 'slash menu opens mid-word').toBe(true)

  // Select "Bullet list" via DOM — stable regardless of canvas scroll.
  await window.evaluate(() => {
    const menu = document.querySelector('[data-testid="md-slash-menu"]')
    if (!menu) throw new Error('slash menu not found')
    const btn = Array.from(menu.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Bullet list')
    ) as HTMLButtonElement | undefined
    if (!btn) throw new Error('Bullet list button not found in menu')
    btn.click()
  })
  await window.waitForTimeout(200)

  const hasBullet = await window.evaluate(
    (wid) => !!document.querySelector(`[data-widget-id="${wid}"] .tiptap ul`),
    widgetId
  )
  expect(hasBullet, 'bullet list was inserted').toBe(true)

  const editorText = await window.evaluate(
    (wid) =>
      (
        document.querySelector(`[data-widget-id="${wid}"] .tiptap`) as HTMLElement | null
      )?.innerText ?? '',
    widgetId
  )
  // The preceding "abc" characters must be intact — only the "/" was deleted.
  expect(editorText, '"abc" text preserved').toContain('abc')
  // No "/" remains in the editor after applyBlock removed it.
  expect(editorText, 'no slash remains').not.toContain('/')
})
