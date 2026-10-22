// Page-view pagination: pasted content must stay inside the margins and inside
// each page's content band.
//
// The reported bug was markdown paste "not respecting margins and page
// boundaries". Horizontal margins turned out to be fine for every paste type;
// the fault was vertical and only on multi-page documents. lineBoxesOf treated
// TABLE and PRE as atomic — "move whole, overflowing only if taller than a
// page" — so a pasted table or code fence longer than a sheet painted straight
// through the bottom margin, the inter-sheet gap and the sheets below.
// Measured before the fix: a 60-row table ran 3781px past its band, a 90-line
// fence 1085px.
//
// Note for anyone extending this: measure LINE boxes, not element boxes. A
// block's own box legitimately spans a spacer when a break lands inside it, so
// element boxes report false violations.
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp, selectBarTab } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => { if (launched) { await launched.dispose(); launched = null } })

const LONG_TOKEN = 'A'.repeat(300)
const CASES: { name: string; text: string; html?: string }[] = [
  { name: 'plain paragraph', text: 'Just some ordinary prose that should wrap normally inside the column.' },
  { name: 'md headings+list', text: '# Title\n\n## Sub\n\n- one\n- two\n- three\n\nSome body text.' },
  { name: 'md long code block', text: '```\nconst x = "' + LONG_TOKEN + '";\n```' },
  { name: 'md inline long URL', text: 'See https://example.com/' + LONG_TOKEN + '/end for details.' },
  { name: 'md wide table', text: '| ' + Array.from({length:12},(_,i)=>'Column heading '+(i+1)).join(' | ') + ' |\n|' + Array.from({length:12},()=>'---').join('|') + '|\n| ' + Array.from({length:12},(_,i)=>'value '+(i+1)).join(' | ') + ' |' },
  { name: 'md blockquote long token', text: '> ' + LONG_TOKEN },
  { name: 'md image', text: '![alt](https://example.com/x.png)' },
  { name: 'html inline-width div', text: 'fallback', html: '<div style="width:2000px">forced wide</div>' },
  { name: 'html wide table', html: '<table><tr>' + Array.from({length:14},(_,i)=>`<td>cell ${i+1} with text</td>`).join('') + '</tr></table>', text: 'fallback' },
  { name: 'html pre long line', html: '<pre>' + LONG_TOKEN + '</pre>', text: 'fallback' }
]

async function paste(window: Page, text: string, html?: string): Promise<void> {
  await window.evaluate(({ t, h }) => {
    const pm = document.querySelector('.ProseMirror') as HTMLElement
    pm.focus()
    const dt = new DataTransfer()
    dt.setData('text/plain', t)
    if (h) dt.setData('text/html', h)
    pm.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, { t: text, h: html })
  await window.waitForTimeout(450)
}

async function clearDoc(window: Page): Promise<void> {
  // Real key events: execCommand does not reliably drive ProseMirror.
  await window.evaluate(() => (document.querySelector('.ProseMirror') as HTMLElement).focus())
  await window.keyboard.press('Meta+a')
  await window.keyboard.press('Backspace')
  await window.waitForTimeout(250)
}

/** Proof the paste actually landed — otherwise "no overflow" means nothing. */
async function docState(window: Page): Promise<{ blocks: number; chars: number }> {
  return window.evaluate(() => {
    const pm = document.querySelector('.ProseMirror') as HTMLElement
    return { blocks: pm.children.length, chars: (pm.textContent ?? '').length }
  })
}

async function measure(window: Page): Promise<{
  pages: number; padL: number; padR: number; padT: number; colOverR: number; colOverL: number
  worstRight: number; worstLeft: number; sheetOverflow: number; offenders: string[]
}> {
  return window.evaluate(() => {
    const sheet = document.querySelector('[data-testid="doc-page"]') as HTMLElement
    const pm = document.querySelector('.ProseMirror') as HTMLElement
    const col = pm.getBoundingClientRect()
    const sh = sheet.getBoundingClientRect()
    // The margin box is the sheet inset by the page's own padding. Report the
    // insets directly: a 1in margin at 96dpi should read 96.
    const host = pm.parentElement as HTMLElement
    const cs = getComputedStyle(host)
    const padL = Math.round(parseFloat(cs.paddingLeft) || 0)
    const padR = Math.round(parseFloat(cs.paddingRight) || 0)
    const padT = Math.round(parseFloat(cs.paddingTop) || 0)
    let worstRight = 0, worstLeft = 0
    const offenders: string[] = []
    for (const el of Array.from(pm.children) as HTMLElement[]) {
      const r = el.getBoundingClientRect()
      const over = Math.round(r.right - col.right)
      const under = Math.round(col.left - r.left)
      if (over > worstRight) worstRight = over
      if (under > worstLeft) worstLeft = under
      if (over > 1 || under > 1) offenders.push(`${el.tagName.toLowerCase()}(+${over}/${under})`)
    }
    return {
      pages: Number(sheet.dataset.pages ?? 1),
      padL, padR, padT,
      // Does the CONTENT COLUMN itself sit outside the sheet's margin box?
      colOverR: Math.round(col.right - (sh.right - padR)),
      colOverL: Math.round((sh.left + padL) - col.left),
      worstRight, worstLeft,
      sheetOverflow: Math.max(0, sheet.scrollWidth - Math.round(sh.width)),
      offenders: offenders.slice(0, 3)
    }
  })
}

test('pasted content stays inside the margins and the sheet', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.documents.create({ docType: 'doc', title: 'Paste Margin Probe', body: { type: 'doc', content: [{ type: 'paragraph' }] } })
  })
  await window.reload()
  await waitForReady(window)
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => Record<string, () => void> } }
    w.__fbView?.getState()['goDocuments']?.()
  })
  await window.waitForTimeout(600)
  await window.locator('text=Paste Margin Probe').first().click()
  await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 10_000 })
  // Page view: sheets with real margins.
  await selectBarTab(window, 'doc-toolbar', 'layout')
  const btn = window.locator('[data-testid="doc-pageview-btn"]')
  if (await btn.count()) await btn.click()
  await expect(window.locator('[data-testid="doc-page"]')).toBeVisible({ timeout: 8_000 })
  await window.waitForTimeout(500)

  console.log('  case'.padEnd(26) + 'pg  padL/padR/padT   colOut(R/L)  childOut(R/L)  sheet')
  for (const c of CASES) {
    await clearDoc(window)
    const before = await docState(window)
    await paste(window, c.text, c.html)
    const after = await docState(window)
    const landed = after.chars > before.chars || after.blocks > before.blocks
    const m = await measure(window)
    const flag = m.worstRight > 1 || m.worstLeft > 1 || m.sheetOverflow > 1 ? '  <== OVERFLOW' : ''
    console.log(
      '  ' + c.name.padEnd(24) +
      String(m.pages).padEnd(4) +
      `${m.padL}/${m.padR}/${m.padT}`.padEnd(18) +
      `${m.colOverR}/${m.colOverL}`.padEnd(13) +
      `${m.worstRight}/${m.worstLeft}`.padEnd(15) +
      String(m.sheetOverflow) +
      (landed ? '' : '  [PASTE DID NOT LAND]') +
      ((m.colOverR > 1 || m.colOverL > 1 || m.worstRight > 1 || m.worstLeft > 1 || m.sheetOverflow > 1) ? '  <== OUTSIDE MARGINS' : '')
    )
    expect(landed, `${c.name}: paste did not land, so the measurement means nothing`).toBe(true)
    expect(m.worstRight, `${c.name} overflows the column on the right`).toBeLessThanOrEqual(1)
    expect(m.worstLeft, `${c.name} overflows the column on the left`).toBeLessThanOrEqual(1)
    expect(m.sheetOverflow, `${c.name} makes the sheet itself scroll`).toBeLessThanOrEqual(1)
  }
})

// ── Multi-page: does pasted content respect the top/bottom margins and the
// gap between sheets, once it spans more than one page?
function longMarkdown(paras: number): string {
  const out: string[] = ['# A pasted report', '']
  for (let i = 1; i <= paras; i++) {
    if (i % 8 === 0) out.push(`## Section ${i / 8}`, '')
    out.push(`Paragraph ${i}. ` + 'This is body prose that should flow from one sheet to the next without ever being drawn in a margin or across the gap between two pages. '.repeat(3), '')
  }
  return out.join('\n')
}

test('pasted markdown spanning several pages stays inside each page band', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.documents.create({ docType: 'doc', title: 'Multipage Paste Probe', body: { type: 'doc', content: [{ type: 'paragraph' }] } })
  })
  await window.reload()
  await waitForReady(window)
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => Record<string, () => void> } }
    w.__fbView?.getState()['goDocuments']?.()
  })
  await window.waitForTimeout(600)
  await window.locator('text=Multipage Paste Probe').first().click()
  await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 10_000 })
  await selectBarTab(window, 'doc-toolbar', 'layout')
  const btn = window.locator('[data-testid="doc-pageview-btn"]')
  if (await btn.count()) await btn.click()
  await expect(window.locator('[data-testid="doc-page"]')).toBeVisible({ timeout: 8_000 })
  await window.waitForTimeout(400)

  await clearDoc(window)
  await paste(window, longMarkdown(60))
  await window.waitForTimeout(1500)

  const r = await window.evaluate(() => {
    const GAP = 28
    const sheet = document.querySelector('[data-testid="doc-page"]') as HTMLElement
    const pm = document.querySelector('.ProseMirror') as HTMLElement
    const sh = sheet.getBoundingClientRect()
    const pages = Number(sheet.dataset.pages ?? 1)
    const totalH = Math.round(sh.height)
    const pageH = Math.round((totalH - (pages - 1) * GAP) / pages)
    // Top margin = where the first block actually starts on page 1.
    const first = pm.children[0] as HTMLElement
    const mTop = Math.round(first.getBoundingClientRect().top - sh.top)
    const mBottom = mTop // default page setup is symmetric
    const bad: string[] = []
    const spacers = pm.querySelectorAll('.fb-page-spacer').length
    // Check every LINE, not just every block: the plugin breaks at line level.
    // Per-LINE rects, via a Range over each block's text. An element's own box
    // spans the spacer when the break falls mid-block (the plugin does that on
    // purpose), so element boxes would report false violations; line boxes are
    // what the reader actually sees.
    const lineRects = (el: HTMLElement): DOMRect[] => {
      const out: DOMRect[] = []
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let n: Node | null
      while ((n = walker.nextNode())) {
        if (!n.nodeValue || !n.nodeValue.trim()) continue
        const rg = document.createRange()
        rg.selectNodeContents(n)
        out.push(...Array.from(rg.getClientRects()))
      }
      return out.filter((r) => r.height > 0 && r.width > 0)
    }
    for (const el of Array.from(pm.querySelectorAll('p,h1,h2,h3,li,pre,blockquote')) as HTMLElement[]) {
      for (const rect of lineRects(el)) {
        const top = rect.top - sh.top
        const bottom = rect.bottom - sh.top
        const pg = Math.floor(top / (pageH + GAP))
        const bandTop = pg * (pageH + GAP) + mTop
        const bandBottom = pg * (pageH + GAP) + pageH - mBottom
        if (top < bandTop - 1 || bottom > bandBottom + 1) {
          bad.push(`${el.tagName.toLowerCase()} p${pg + 1} top=${Math.round(top)} bottom=${Math.round(bottom)} band=[${Math.round(bandTop)},${Math.round(bandBottom)}]`)
        }
      }
    }
    return { pages, pageH, mTop, spacers, violations: bad.length, sample: bad.slice(0, 6) }
  })
  console.log('  pages=' + r.pages + '  pageH=' + r.pageH + '  topMargin=' + r.mTop + '  spacers=' + r.spacers)
  console.log('  LINES OUTSIDE THEIR PAGE BAND: ' + r.violations)
  r.sample.forEach((v) => console.log('    ' + v))
  expect(r.pages, 'the paste should span several pages or this proves nothing').toBeGreaterThan(3)
  // <=1 tolerates a single line box sitting 1px above the measured top margin,
  // which is leading, not a layout fault.
  expect(r.violations, 'prose lines drawn outside their page band').toBeLessThanOrEqual(1)
})

test('pasted markdown with a long table or code block vs the page band', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.documents.create({ docType: 'doc', title: 'Atomic Paste Probe', body: { type: 'doc', content: [{ type: 'paragraph' }] } })
  })
  await window.reload()
  await waitForReady(window)
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => Record<string, () => void> } }
    w.__fbView?.getState()['goDocuments']?.()
  })
  await window.waitForTimeout(600)
  await window.locator('text=Atomic Paste Probe').first().click()
  await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 10_000 })
  await selectBarTab(window, 'doc-toolbar', 'layout')
  const btn = window.locator('[data-testid="doc-pageview-btn"]')
  if (await btn.count()) await btn.click()
  await expect(window.locator('[data-testid="doc-page"]')).toBeVisible({ timeout: 8_000 })
  await window.waitForTimeout(400)

  const mdTable = (rows: number): string => {
    const out = ['| Item | Owner | Status | Notes |', '|---|---|---|---|']
    for (let i = 1; i <= rows; i++) out.push(`| Row ${i} | Person ${i} | In progress | Some note about row ${i} |`)
    return out.join('\n')
  }
  const mdCode = (lines: number): string =>
    '```\n' + Array.from({ length: lines }, (_, i) => `const line${i} = ${i};`).join('\n') + '\n```'

  const cases: { name: string; md: string }[] = [
    { name: 'short table (fits a page)', md: 'Intro.\n\n' + mdTable(8) },
    { name: 'table taller than a page', md: 'Intro.\n\n' + mdTable(60) },
    { name: 'code block taller than a page', md: 'Intro.\n\n' + mdCode(90) },
    { name: 'prose then a table near the fold', md: Array.from({ length: 22 }, (_, i) => `Paragraph ${i + 1}. Filler prose to push the table down toward the bottom of the sheet.`).join('\n\n') + '\n\n' + mdTable(10) }
  ]

  console.log('  case'.padEnd(36) + 'pages  atomicBlocks  overflowingBlocks  worstOverflowPx')
  for (const c of cases) {
    await clearDoc(window)
    await paste(window, c.md)
    await window.waitForTimeout(1200)
    const r = await window.evaluate(() => {
      const GAP = 28
      const sheet = document.querySelector('[data-testid="doc-page"]') as HTMLElement
      const pm = document.querySelector('.ProseMirror') as HTMLElement
      const sh = sheet.getBoundingClientRect()
      const pages = Number(sheet.dataset.pages ?? 1)
      const pageH = Math.round((Math.round(sh.height) - (pages - 1) * GAP) / pages)
      const mTop = 96
      const atoms = Array.from(pm.querySelectorAll('table,pre,img,figure,.tableWrapper')) as HTMLElement[]
      let worst = 0
      let bad = 0
      const detail: string[] = []
      // Measure LINE boxes for anything splittable: a block's own box legitimately
      // spans a spacer when a break lands inside it. Only genuinely atomic
      // elements are judged on their own box.
      const boxesOf = (el: HTMLElement): DOMRect[] => {
        if (el.tagName === 'IMG' || el.tagName === 'FIGURE') return [el.getBoundingClientRect()]
        const out: DOMRect[] = []
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        let n: Node | null
        while ((n = w.nextNode())) {
          if (!n.nodeValue || !n.nodeValue.trim()) continue
          const rg = document.createRange()
          rg.selectNodeContents(n)
          out.push(...Array.from(rg.getClientRects()).filter((x) => x.width > 0.5 && x.height > 0.5))
        }
        return out.length ? out : [el.getBoundingClientRect()]
      }
      for (const el of atoms) {
       for (const r of boxesOf(el)) {
        const top = r.top - sh.top
        const bottom = r.bottom - sh.top
        const pg = Math.floor(top / (pageH + GAP))
        const bandBottom = pg * (pageH + GAP) + pageH - mTop
        const over = Math.round(bottom - bandBottom)
        if (over > 1) {
          bad++
          if (over > worst) worst = over
          detail.push(`${el.tagName.toLowerCase()} p${pg + 1} runs ${over}px past the band`)
        }
       }
      }
      return { pages, atoms: atoms.length, bad, worst, detail: detail.slice(0, 2) }
    })
    console.log(
      '  ' + c.name.padEnd(34) + String(r.pages).padEnd(7) + String(r.atoms).padEnd(14) +
      String(r.bad).padEnd(19) + String(r.worst) + (r.bad > 0 ? '   <== OVERFLOWS' : '')
    )
    r.detail.forEach((d) => console.log('      ' + d))
    expect(r.bad, `${c.name}: blocks running past the page band`).toBe(0)
  }
})

test('table header repeat: right-click toggle, repeated headers, persistence', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.documents.create({ docType: 'doc', title: 'Header Repeat Probe', body: { type: 'doc', content: [{ type: 'paragraph' }] } })
  })
  await window.reload()
  await waitForReady(window)
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => Record<string, () => void> } }
    w.__fbView?.getState()['goDocuments']?.()
  })
  await window.waitForTimeout(600)
  await window.locator('text=Header Repeat Probe').first().click()
  await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 10_000 })
  await selectBarTab(window, 'doc-toolbar', 'layout')
  const btn = window.locator('[data-testid="doc-pageview-btn"]')
  if (await btn.count()) await btn.click()
  await expect(window.locator('[data-testid="doc-page"]')).toBeVisible({ timeout: 8_000 })

  const rows = 60
  const md = ['| Item | Owner | Status | Notes |', '|---|---|---|---|']
  for (let i = 1; i <= rows; i++) md.push(`| Row ${i} | Person ${i} | In progress | Note ${i} |`)
  await clearDoc(window)
  await paste(window, md.join('\n'))
  await window.waitForTimeout(1200)

  const before = await window.evaluate(() => ({
    repeated: document.querySelectorAll('.fb-repeat-header').length,
    rowSpacers: document.querySelectorAll('tr.fb-page-spacer').length,
    pages: Number((document.querySelector('[data-testid="doc-page"]') as HTMLElement).dataset.pages ?? 1)
  }))
  console.log('  OFF  ' + JSON.stringify(before))

  // Right-click the table -> the menu -> toggle on.
  const table = window.locator('.ProseMirror table').first()
  await table.click({ button: 'right', position: { x: 40, y: 40 } })
  await expect(window.locator('[data-testid="doc-table-menu"]')).toBeVisible({ timeout: 5_000 })
  await window.locator('[data-testid="doc-table-header-repeat"]').click()
  await window.waitForTimeout(1500)

  const after = await window.evaluate(() => ({
    repeated: document.querySelectorAll('.fb-repeat-header').length,
    rowSpacers: document.querySelectorAll('tr.fb-page-spacer').length,
    pages: Number((document.querySelector('[data-testid="doc-page"]') as HTMLElement).dataset.pages ?? 1),
    attr: document.querySelector('.ProseMirror table')?.getAttribute('data-header-repeat')
  }))
  console.log('  ON   ' + JSON.stringify(after))

  // The repeated header must sit INSIDE the page band, not in a margin.
  const bands = await window.evaluate(() => {
    const GAP = 28
    const sheet = document.querySelector('[data-testid="doc-page"]') as HTMLElement
    const sh = sheet.getBoundingClientRect()
    const pages = Number(sheet.dataset.pages ?? 1)
    const pageH = Math.round((Math.round(sh.height) - (pages - 1) * GAP) / pages)
    let bad = 0
    const detail: string[] = []
    for (const el of Array.from(document.querySelectorAll('.fb-repeat-header')) as HTMLElement[]) {
      const r = el.getBoundingClientRect()
      const top = r.top - sh.top
      const pg = Math.floor(top / (pageH + GAP))
      const bandTop = pg * (pageH + GAP) + 96
      const bandBottom = pg * (pageH + GAP) + pageH - 96
      if (top < bandTop - 2 || r.bottom - sh.top > bandBottom + 2) bad++
      detail.push(`hdr top=${Math.round(top)} bottom=${Math.round(r.bottom - sh.top)} pg=${pg + 1} band=[${Math.round(bandTop)},${Math.round(bandBottom)}]`)
    }
    return { bad, detail: detail.slice(0, 4), pageH }
  })
  console.log('  repeated headers outside their page band: ' + bands.bad + '  (pageH=' + bands.pageH + ')')
  bands.detail.forEach((d) => console.log('    ' + d))
  expect(before.repeated, 'no headers should repeat before the setting is on').toBe(0)
  expect(after.repeated, 'one repeated header per page break').toBe(after.rowSpacers)
  expect(after.rowSpacers, 'the table should break across pages at all').toBeGreaterThan(0)
  expect(bands.bad, 'repeated headers drawn outside the page band').toBe(0)

  // Persistence across a reload.
  await window.waitForTimeout(1200)
  await window.reload()
  await waitForReady(window)
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => Record<string, () => void> } }
    w.__fbView?.getState()['goDocuments']?.()
  })
  await window.waitForTimeout(600)
  await window.locator('text=Header Repeat Probe').first().click()
  await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 10_000 })
  await window.waitForTimeout(1200)
  // Persistence is a property of the stored document, not of the rendered DOM.
  const persisted = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const list = await api.documents.list()
    const meta = list.find((d: { title: string }) => d.title === 'Header Repeat Probe')
    if (!meta) return 'no doc'
    const full = await api.documents.get(meta.id)
    const json = JSON.stringify(full?.body ?? {})
    const m = json.match(/"headerRepeat":(true|false)/)
    return m ? m[1] : 'attribute absent from stored body'
  })
  console.log('  stored body headerRepeat = ' + persisted)
  expect(persisted, 'the setting must survive a reload').toBe('true')
})

test('an image taller than the page is capped to the content band, not overflowed', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.documents.create({ docType: 'doc', title: 'Tall Image Probe', body: { type: 'doc', content: [{ type: 'paragraph' }] } })
  })
  await window.reload()
  await waitForReady(window)
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => Record<string, () => void> } }
    w.__fbView?.getState()['goDocuments']?.()
  })
  await window.waitForTimeout(600)
  await window.locator('text=Tall Image Probe').first().click()
  await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 10_000 })
  await selectBarTab(window, 'doc-toolbar', 'layout')
  const btn = window.locator('[data-testid="doc-pageview-btn"]')
  if (await btn.count()) await btn.click()
  await expect(window.locator('[data-testid="doc-page"]')).toBeVisible({ timeout: 8_000 })

  // A 600x2400 SVG — far taller than a Letter page's 864px content band.
  const svg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="2400"><rect width="600" height="2400" fill="#4444aa"/></svg>')
  await clearDoc(window)
  await paste(window, 'x', `<img src="data:image/svg+xml;utf8,${svg}" />`)
  await window.waitForTimeout(2500)

  const r = await window.evaluate(() => {
    const GAP = 28
    const sheet = document.querySelector('[data-testid="doc-page"]') as HTMLElement
    const sh = sheet.getBoundingClientRect()
    const pages = Number(sheet.dataset.pages ?? 1)
    const pageH = Math.round((Math.round(sh.height) - (pages - 1) * GAP) / pages)
    const img = document.querySelector('.ProseMirror img') as HTMLElement | null
    if (!img) return { found: false }
    const ir = img.getBoundingClientRect()
    const band = pageH - 96 * 2
    const top = ir.top - sh.top
    const pg = Math.floor(top / (pageH + GAP))
    const bandBottom = pg * (pageH + GAP) + pageH - 96
    return {
      found: true,
      pages,
      imgTop: Math.round(top),
      imgHeight: Math.round(ir.height),
      band,
      spacers: document.querySelectorAll('.fb-page-spacer').length,
      structure: Array.from(document.querySelector('.ProseMirror')!.children).map((el) => {
        const b = (el as HTMLElement).getBoundingClientRect()
        return `${el.tagName.toLowerCase()}${el.querySelector('img') ? '[img]' : ''} top=${Math.round(b.top - sh.top)} h=${Math.round(b.height)}`
      }),
      spacerAt: Array.from(document.querySelectorAll('.fb-page-spacer')).map((el) => {
        const b = (el as HTMLElement).getBoundingClientRect()
        return `${el.tagName.toLowerCase()} top=${Math.round(b.top - sh.top)} h=${Math.round(b.height)} parent=${el.parentElement?.tagName.toLowerCase()}`
      }),
      overflow: Math.max(0, Math.round(ir.bottom - sh.top - bandBottom))
    }
  })
  console.log('  image: ' + JSON.stringify(r))
  expect(r.found, 'the image did not paste').toBe(true)
  // Capped well below its natural 2400px, and the whole BLOCK fits the band —
  // capping the image alone left a 931px block inside an 864px band.
  expect(r.imgHeight!).toBeLessThanOrEqual(r.band!)
  expect(r.overflow, 'the image block runs past the page band').toBe(0)
})
