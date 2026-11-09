/**
 * deskStartSizesContent.spec.ts: does each work widget kind still work at its
 * standard starting size once it holds real content?
 *
 * A widget can pass "starts at the right size" (deskStartSizes.spec.ts) and still
 * cut off its own controls the moment it has something in it: a long subject
 * line, a composer, a toolbar with a hint. So every kind below is given the
 * content it really holds and measured twice, at its size from
 * WIDGET_START_SIZES and at a very large size:
 *
 *   - for every button, input, select, link and text element in the frame, walk
 *     up the ancestors and report anything cut by a NON-scrolling ancestor
 *     (content inside a scroller is reachable, so it is not cut);
 *   - report any horizontal scrollbar, and any control the small size lost.
 *
 * A control cut at the large size too is not caused by the starting size, so
 * only what is newly cut at the standard size fails a test.
 *
 * ALL CONTENT HERE IS TEST DATA, seeded into launchApp's throwaway profile and
 * deleted with it. Nothing leaves the machine: mail is answered at the ipcMain
 * boundary, chat by _fakeSignal, and the four remote-page kinds are pointed at a
 * closed loopback port (see REMOTE: the e2e net guard only refuses Plexii's own
 * hosts, so a real docs.google.com URL here would really be fetched).
 *
 * The app stays hidden throughout (launchApp, background mode). Screenshots use
 * capturePage with stayHidden and are only written when DESK_SIZES_OUT is set.
 *
 * A kind that cannot show its real content here says so on its test title and
 * with a `content-not-checkable` annotation; it is never passed as if it had.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { appendFileSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { launchApp, waitForReady, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'
import { signInWithFakeSignal } from './_fakeSignal'
import { WIDGET_START_SIZES } from '../../src/shared/widgetStartSizes'

const OUT = process.env.DESK_SIZES_OUT ?? ''
const BIG = { width: 1500, height: 1160 }
// The measuring window: comfortably larger than BIG plus the side menus.
const WINDOW = { width: 2560, height: 1400 }

let launched: LaunchedApp | null = null
let page: Page
let app: ElectronApplication
let deskId: string
let portalDeskId: string

// ── What the probe reports ───────────────────────────────────────────────────

interface Measured {
  width: number
  height: number
  cutControls: string[]
  cutText: string[]
  sideways: string[]
  sidewaysDetail: string[]
  controls: string[]
  covered: string[]
  truncatedControls: string[]
  crushedBoxes: string[]
}

// Runs in the page. Self-contained: it is serialised into evaluate each call.
function measureInPage(a: { id: string; ignore: string[] }): Measured | null {
  const root = document.querySelector<HTMLElement>(`[data-widget-id="${a.id}"]`)
  if (!root) return null
  const box = root.getBoundingClientRect()
  const out: Measured = {
    width: Math.round(box.width),
    height: Math.round(box.height),
    cutControls: [],
    cutText: [],
    sideways: [],
    sidewaysDetail: [],
    controls: [],
    covered: [],
    truncatedControls: [],
    crushedBoxes: []
  }
  const scrollers = (v: string): boolean => v === 'auto' || v === 'scroll'
  const label = (el: HTMLElement): string => {
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent ?? '')
      .join(' ')
    const name =
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.dataset.testid ||
      el.getAttribute('placeholder') ||
      own ||
      el.innerText ||
      ''
    return `${el.tagName.toLowerCase()}: ${name.replace(/\s+/g, ' ').trim().slice(0, 48)}`
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    if (a.ignore.some((s) => el.closest(s))) continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.position === 'fixed') continue
    // Not checkOpacity: a control that only fades in on hover is still laid out,
    // and it is cut in exactly the same way when it does appear.
    if (!el.checkVisibility({ checkVisibilityCSS: true })) continue
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) continue

    if (el.clientWidth >= 100 && scrollers(cs.overflowX) && el.scrollWidth - el.clientWidth > 2) {
      out.sideways.push(label(el))
      out.sidewaysDetail.push(`${label(el)} (${el.clientWidth} wide, ${el.scrollWidth} of content)`)
    }

    const isControl = el.matches(
      'button,input:not([type=hidden]),select,textarea,a[href],[role=button],[role=tab],[role=menuitem]'
    )
    const isText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim())
    if (!isControl && !isText) continue
    // An empty text box whose own placeholder wraps out of sight is a control
    // the person cannot use, even though nothing clips it: a textarea scrolls.
    if (el.matches('textarea')) {
      const box = el as HTMLTextAreaElement
      if (box.value === '' && box.placeholder && box.scrollHeight - box.clientHeight > 2) out.crushedBoxes.push(label(el))
    }
    if (isControl && r.width >= 6 && r.height >= 6) {
      out.controls.push(label(el))
      if (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) out.truncatedControls.push(label(el))
    }

    let left = r.left
    let right = r.right
    let top = r.top
    let bottom = r.bottom
    let cut = false
    let elided = false
    let p: HTMLElement | null = el.parentElement
    while (p) {
      const c = getComputedStyle(p)
      const pr = p.getBoundingClientRect()
      if (scrollers(c.overflowX)) {
        left = Math.min(Math.max(left, pr.left), pr.right)
        right = Math.max(Math.min(right, pr.right), pr.left)
      } else if (c.overflowX !== 'visible' && (right > pr.right + 1.5 || left < pr.left - 1.5)) {
        if (c.textOverflow === 'ellipsis') elided = true
        else cut = true
      }
      if (scrollers(c.overflowY)) {
        top = Math.min(Math.max(top, pr.top), pr.bottom)
        bottom = Math.max(Math.min(bottom, pr.bottom), pr.top)
      } else if (c.overflowY !== 'visible' && (bottom > pr.bottom + 1.5 || top < pr.top - 1.5)) {
        cut = true
      }
      if (p === root) break
      p = p.parentElement
    }
    if (cut && !elided) {
      if (isControl) out.cutControls.push(label(el))
      else out.cutText.push(label(el))
    }
    // Only what can be seen right now: a row scrolled out of a list has nothing
    // to hit, and its clamped centre would land on whatever sits below the list.
    const onScreen = right - left >= 2 && bottom - top >= 2
    if (isControl && !cut && onScreen && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
      const x = (Math.max(left, box.left) + Math.min(right, box.right)) / 2
      const y = (Math.max(top, box.top) + Math.min(bottom, box.bottom)) / 2
      const hit = document.elementFromPoint(x, y)
      if (hit && !el.contains(hit) && !hit.contains(el)) out.covered.push(label(el))
    }
  }
  return out
}

/** What `of` has that `baseline` does not, counting repeats. */
function newlyIn(of: string[], baseline: string[]): string[] {
  const left = new Map<string, number>()
  for (const b of baseline) left.set(b, (left.get(b) ?? 0) + 1)
  return of.filter((x) => {
    const n = left.get(x) ?? 0
    if (n > 0) {
      left.set(x, n - 1)
      return false
    }
    return true
  })
}

// ── Driving the desk ─────────────────────────────────────────────────────────

const settle = async (): Promise<void> => {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  )
  await page.waitForTimeout(350)
}

interface WidgetStore {
  getState: () => {
    create: (d: object) => Promise<{ id: string }>
    update: (id: string, p: object) => Promise<void>
    remove: (id: string) => Promise<void>
    resetView: () => void
  }
}
type Win = { __fbWidgets: WidgetStore }

async function place(
  kind: string,
  content: string,
  size: { width: number; height: number },
  title: string
): Promise<string> {
  const id = await page.evaluate(
    async ({ deskId, kind, content, size, title }) => {
      const s = (window as unknown as Win).__fbWidgets.getState()
      s.resetView()
      return (await s.create({ taskId: deskId, kind, content, title, x: 40, y: 40, ...size })).id
    },
    { deskId, kind, content, size, title }
  )
  await page.waitForSelector(`[data-widget-id="${id}"]`, { timeout: 15_000 })
  return id
}

const resize = (id: string, patch: object): Promise<void> =>
  page.evaluate(
    async ({ id, patch }) => {
      await (window as unknown as Win).__fbWidgets.getState().update(id, patch)
    },
    { id, patch }
  )

const removeWidget = (id: string): Promise<void> =>
  page.evaluate(async (i) => {
    await (window as unknown as Win).__fbWidgets.getState().remove(i)
  }, id)

const measure = async (id: string, ignore: string[]): Promise<Measured> => {
  const m = await page.evaluate(measureInPage, { id, ignore })
  if (!m) throw new Error(`widget ${id} is not on the desk`)
  return m
}

async function shot(id: string, name: string): Promise<void> {
  if (!OUT) return
  const rect = await page.evaluate((i) => {
    const b = document.querySelector(`[data-widget-id="${i}"]`)!.getBoundingClientRect()
    return {
      x: Math.max(0, Math.floor(b.left) - 8),
      y: Math.max(0, Math.floor(b.top) - 8),
      width: Math.ceil(b.width) + 16,
      height: Math.ceil(b.height) + 16
    }
  }, id)
  const b64 = await app.evaluate(async ({ BrowserWindow }, r) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())!
    return (await win.webContents.capturePage(r, { stayHidden: true })).toPNG().toString('base64')
  }, rect)
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(b64, 'base64'))
}

// ── Test data, created in the throwaway profile ──────────────────────────────

type Api = {
  files: { ingestBuffer: (a: object) => Promise<{ id: string }> }
  fileManager: { createFolder: (parent: string | null, name: string) => Promise<{ id: string }> }
  nodes: { create: (a: object) => Promise<{ id: string }> }
  widgets: { create: (a: object) => Promise<{ id: string }> }
}
type W = { api: Api }

// A real PNG, drawn in the page, ingested as a file.
const seedPicture = (name: string, w: number, h: number, hue: number): Promise<string> =>
  page.evaluate(
    async ({ name, w, h, hue }) => {
      const c = new OffscreenCanvas(w, h)
      const g = c.getContext('2d')!
      const grad = g.createLinearGradient(0, 0, w, h)
      grad.addColorStop(0, `hsl(${hue} 70% 62%)`)
      grad.addColorStop(1, `hsl(${(hue + 60) % 360} 60% 38%)`)
      g.fillStyle = grad
      g.fillRect(0, 0, w, h)
      g.fillStyle = 'rgba(255,255,255,.85)'
      g.font = `${Math.round(h / 12)}px Helvetica`
      g.fillText('Test picture', w * 0.08, h * 0.2)
      g.fillText(name, w * 0.08, h * 0.34)
      const blob = await c.convertToBlob({ type: 'image/png' })
      const buffer = await blob.arrayBuffer()
      const api = (window as unknown as W).api
      return (await api.files.ingestBuffer({ buffer, originalName: name, mimeType: 'image/png', parentId: null })).id
    },
    { name, w, h, hue }
  )

// A short real video, recorded from a canvas in the page.
const seedVideo = (name: string): Promise<string> =>
  page.evaluate(async (name) => {
    const c = document.createElement('canvas')
    c.width = 640
    c.height = 360
    const g = c.getContext('2d')!
    const stream = c.captureStream(15)
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm' })
    const chunks: Blob[] = []
    rec.ondataavailable = (e): void => {
      if (e.data.size) chunks.push(e.data)
    }
    const stopped = new Promise<void>((r) => (rec.onstop = (): void => r()))
    rec.start(100)
    for (let i = 0; i < 18; i++) {
      g.fillStyle = `hsl(${i * 20} 70% 40%)`
      g.fillRect(0, 0, 640, 360)
      g.fillStyle = '#fff'
      g.font = '32px Helvetica'
      g.fillText(`Test video frame ${i + 1}`, 120, 190)
      await new Promise((r) => setTimeout(r, 60))
    }
    rec.stop()
    await stopped
    const buffer = await new Blob(chunks, { type: 'video/webm' }).arrayBuffer()
    const api = (window as unknown as W).api
    return (await api.files.ingestBuffer({ buffer, originalName: name, mimeType: 'video/webm', parentId: null })).id
  }, name)

// A real two-page PDF with text on both pages.
function pdfText(): string {
  const page1 = [
    'BT /F1 22 Tf 72 720 Td (Contract of sale: Ridge St) Tj ET',
    ...[
      'Test document for the e2e sizing check. Not a real contract.',
      'The purchaser agrees to buy the property at the price stated in the schedule.',
      'Settlement is due forty-two days after the date of this contract.',
      'The deposit is held in trust by the conveyancer until settlement.'
    ].map((t, i) => `BT /F1 12 Tf 72 ${680 - i * 22} Td (${t}) Tj ET`)
  ].join('\n')
  const page2 = 'BT /F1 16 Tf 72 720 Td (Schedule: sample terms for the sizing check) Tj ET'
  const stream = (s: string): string => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
    stream(page1),
    stream(page2),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let out = '%PDF-1.4\n'
  const offs: number[] = []
  objs.forEach((o, i) => {
    offs.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return out
}

const seedTextFile = (name: string, mimeType: string, text: string, parentId: string | null = null): Promise<string> =>
  page.evaluate(
    async ({ name, mimeType, text, parentId }) => {
      const buffer = new TextEncoder().encode(text).buffer
      const api = (window as unknown as W).api
      return (await api.files.ingestBuffer({ buffer, originalName: name, mimeType, parentId })).id
    },
    { name, mimeType, text, parentId }
  )

// A mailbox of real shape, answered at the ipcMain boundary (the same stub the
// mail specs use): there is no IMAP server in e2e. Test data.
async function stubMail(a: ElectronApplication): Promise<void> {
  await a.evaluate(({ ipcMain }) => {
    const now = Date.now()
    const subjects = [
      'Ridge St settlement: final figures and the adjustments the bank wants before Friday',
      'Re: Ridge St inspection booked for Tuesday morning',
      'Ridge St: the signed counterpart of the contract is attached, please confirm receipt',
      'Your Ridge St rates notice for the second quarter',
      'FW: Ridge St strata records and the minutes of the last three meetings',
      'Ridge St deposit release: who approved it and the reference number',
      'Re: Re: Ridge St settlement date moved',
      'Ridge St insurance needs to start before handover',
      'Council reply about the Ridge St permit',
      'Ridge St title search results',
      'Ridge St: building report, three items to fix',
      'Reminder: Ridge St bond paperwork',
      'Ridge St final invoice',
      'Re: Ridge St keys and access on the day'
    ]
    const people = [
      ['Sarah Chen', 'sarah@northshore.example'],
      ['David Okafor (Okafor Conveyancing)', 'david@okaforlaw.example'],
      ['Priya Natarajan', 'priya@studio9.example'],
      ['Tom Willis', 'tom@willisbuild.example'],
      ['Maria Santos Finance Team Long Name Pty Ltd', 'maria@santosfinance.example']
    ]
    const items = subjects.map((subject, i) => ({
      uid: 2000 + i,
      fromName: people[i % people.length][0],
      fromAddress: people[i % people.length][1],
      subject,
      date: now - (i + 1) * 3_400_000,
      seen: i % 3 !== 0,
      flagged: i % 5 === 0,
      hasAttachments: i % 2 === 0,
      messageId: `<ridge-${i}@example.test>`,
      inReplyTo: null,
      references: []
    }))
    const body = (who: string, lines: string[]): string => lines.join('\n') + `\n\nThanks,\n${who}`
    const thread = [
      {
        uid: 3001,
        fromName: 'Sarah Chen',
        fromAddress: 'sarah@northshore.example',
        toText: 'me@example.test, david@okaforlaw.example',
        subject: 'Ridge St settlement: final figures',
        date: now - 30 * 3_600_000,
        seen: true,
        hasAttachments: true,
        bodyText: body('Sarah', [
          'Hi both, the bank has confirmed the final figures for settlement on Friday. The adjustments for rates and water are in the attached statement.',
          '',
          'Could you check the deposit release lines against what you have? The reference number is in the second table.'
        ]),
        attachments: [
          { filename: 'Ridge St settlement statement final v3 (bank copy).pdf', contentType: 'application/pdf', sizeBytes: 482_113 },
          { filename: 'Rates and water adjustments.xlsx', contentType: 'application/vnd.ms-excel', sizeBytes: 38_204 }
        ]
      },
      {
        uid: 3002,
        fromName: 'David Okafor',
        fromAddress: 'david@okaforlaw.example',
        toText: 'sarah@northshore.example',
        subject: 'Re: Ridge St settlement: final figures',
        date: now - 26 * 3_600_000,
        seen: true,
        hasAttachments: false,
        bodyText:
          body('David', [
            'Thanks Sarah. The deposit release matches. One question on the water adjustment: is that the quarter to September or the one before?'
          ]) +
          '\n\nOn Tue, Sarah Chen wrote:\n> Hi both, the bank has confirmed the final figures for settlement on Friday.\n> The adjustments for rates and water are in the attached statement.\n>\n> Could you check the deposit release lines against what you have?',
        attachments: []
      },
      {
        uid: 3003,
        fromName: 'Sarah Chen',
        fromAddress: 'sarah@northshore.example',
        toText: 'david@okaforlaw.example',
        subject: 'Re: Ridge St settlement: final figures',
        date: now - 22 * 3_600_000,
        seen: false,
        hasAttachments: true,
        bodyText: body('Sarah', [
          'It is the quarter to September, sorry for the confusion. The updated statement is attached and replaces the earlier one.'
        ]),
        attachments: [{ filename: 'Ridge St statement revised.pdf', contentType: 'application/pdf', sizeBytes: 502_880 }]
      }
    ]
    for (const ch of ['mail:getAccount', 'mail:list', 'mail:storedThread']) ipcMain.removeHandler(ch)
    ipcMain.handle('mail:getAccount', () => ({
      configured: true,
      host: 'imap.example.test',
      port: 993,
      secure: true,
      user: 'me@example.test',
      email: 'me@example.test',
      authKind: 'password'
    }))
    ipcMain.handle('mail:list', () => ({ ok: true, items }))
    ipcMain.handle('mail:storedThread', () => ({ ok: true, messages: thread }))
  })
}

// Chat history for the fake signal session. Test data.
const CHAT_MESSAGES = [
  'Are we still good for the inspection on Tuesday morning?',
  'Yes, 9am. The agent will meet us at the front.',
  'Great. Can you bring the building report from last year so we can compare the items?',
  'Will do.',
  'The bank wants the signed counterpart before they release the deposit, so please send it through today if you can.',
  'Sending now.',
  'One more thing: the settlement statement has a rates adjustment that looks wrong. It says the quarter to March but we paid up to June.',
  'I will ask Sarah.',
  'Thanks!',
  'Sarah says it is the wrong quarter and she will reissue the statement tomorrow.',
  'Perfect. And the insurance needs to start before handover.',
  'Booked: policy starts on settlement day.',
  'The council replied about the permit. They need the plans again in PDF.',
  'I will forward the plans.',
  'Sent them. Anything else before Friday?',
  'Just the keys and access on the day, then we are done.',
  'Sounds good.',
  'See you Tuesday.'
].map((body, i) => ({
  id: `msg-${i}`,
  conversationId: 'conv-ridge',
  fromAccount: i % 3 === 2 ? 'acc_e2e' : 'acc_other',
  body,
  attachment: null,
  createdAt: Date.now() - (18 - i) * 900_000
}))

const LONG_PARA =
  'The settlement agent confirmed the contract is signed by both parties. The next step is the building inspection, booked for Tuesday morning. If it passes, finance goes unconditional within five business days and the deposit moves to the trust account.'

const LIVING_DOC = JSON.stringify({
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Where Ridge St stands' }] },
    { type: 'paragraph', content: [{ type: 'text', text: LONG_PARA }] },
    {
      type: 'bulletList',
      content: ['Inspection booked for Tuesday', 'Deposit release confirmed by the bank', 'Rates adjustment being reissued', 'Insurance starts on settlement day'].map((t) => ({
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }]
      }))
    },
    { type: 'paragraph', content: [{ type: 'text', text: LONG_PARA }] },
    { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Still open' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'The council reply about the permit needs the plans again in PDF before Friday.' }] }
  ]
})

const CUSTOM_CODE = `<!doctype html><html><head><style>
  body { font: 13px/1.45 -apple-system, sans-serif; margin: 12px; color: #1c1917; }
  h3 { margin: 0 0 8px; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; }
  td, th { padding: 4px 6px; border-bottom: 1px solid #e7e5e4; text-align: left; }
  .bar { height: 6px; background: #e7e5e4; border-radius: 3px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: #6366f1; }
  button, input { font: inherit; }
</style></head><body>
  <h3>Retainer tracker (test data)</h3>
  <table>
    <tr><th>Client</th><th>Used</th><th>Bought</th><th></th></tr>
    <tr><td>Northshore Conveyancing</td><td>18</td><td>20</td><td><div class="bar"><i style="width:90%"></i></div></td></tr>
    <tr><td>Studio 9 Architects</td><td>7</td><td>30</td><td><div class="bar"><i style="width:23%"></i></div></td></tr>
    <tr><td>Willis Build Group</td><td>12</td><td>12</td><td><div class="bar"><i style="width:100%"></i></div></td></tr>
  </table>
  <p><input id="h" placeholder="Hours" size="6"> <button id="add">Log time</button></p>
  <script>document.getElementById('add').onclick = function () { document.getElementById('h').value = '' }</script>
</body></html>`

const DIAGRAM = JSON.stringify({
  nodes: [
    ['a', 'Lead comes in', 60, 40, 'box', '#2563eb'],
    ['b', 'Qualify', 280, 40, 'box', '#2563eb'],
    ['c', 'Send proposal', 500, 40, 'box', '#16a34a'],
    ['d', 'Negotiate terms', 500, 180, 'box', '#d97706'],
    ['e', 'Contract signed', 280, 180, 'circle', '#16a34a'],
    ['f', 'Handover to delivery', 60, 180, 'box', '#7c3aed'],
    ['g', 'Lost: note why', 280, 320, 'box', '#dc2626']
  ].map(([id, label, x, y, shape, color]) => ({ id, type: 'shape', position: { x, y }, data: { label, shape, color } })),
  edges: [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'f'], ['b', 'g']].map(([s, t]) => ({
    id: `${s}-${t}`,
    source: s,
    target: t,
    markerEnd: { type: 'arrowclosed' }
  }))
})

const BLOCK_FIELDS = (() => {
  // Test data. Two columns, the shape people arrange a record into.
  const left = 16
  const right = 212
  return [
    { id: 'f1', type: 'heading', label: 'Client intake', x: left, y: 8, w: 376, h: 30 },
    { id: 'f2', type: 'text', label: 'Client name', x: left, y: 44, w: 180, h: 58, value: 'Sarah Chen' },
    { id: 'f3', type: 'email', label: 'Email', x: right, y: 44, w: 180, h: 58, value: 'sarah@northshore.example' },
    { id: 'f4', type: 'select', label: 'Stage', x: left, y: 108, w: 180, h: 58, options: ['Lead', 'Proposal', 'Won'], value: 'Proposal' },
    { id: 'f5', type: 'date', label: 'Follow up', x: right, y: 108, w: 180, h: 58, value: '2026-11-20' },
    { id: 'f6', type: 'number', label: 'Value', x: left, y: 172, w: 180, h: 58, value: '48200' },
    { id: 'f7', type: 'url', label: 'Website', x: right, y: 172, w: 180, h: 58, value: 'https://northshore.example' },
    { id: 'f8', type: 'textarea', label: 'Notes', x: left, y: 236, w: 376, h: 96, value: LONG_PARA },
    { id: 'f9', type: 'checkbox', label: 'Signed the agreement', x: left, y: 338, w: 180, h: 34, value: true }
  ]
})()

// The remote-page kinds load a website. The net guard only refuses Plexii's own
// hosts, so a real Google URL would genuinely be fetched: these point at a closed
// loopback port instead, which fails locally and instantly, the way FB_SIGNAL_URL
// does in _netGuard.ts.
const REMOTE_PATH = (s: string): string => `http://127.0.0.1:9/${s}`
const REMOTE_NOTE = 'remote page, content not checkable: this test points it at a closed loopback port (nothing leaves the machine), so only the widget frame and its toolbar are checked'
// A pdf widget holding a local file id: the page never reaches its webview here
// (and, on the evidence, anywhere). `protocol.handle('fb-file', ...)` is
// registered only on the default session (src/main/index.ts), and the widget's
// guest runs in the persist:webview-default partition, so the request stalls: the
// guest fires did-start-loading and never navigates. Adding the same handler to
// that partition in a throwaway diagnostic made the page load and render, and a
// loopback page in the same partition navigates normally, so this is not the
// hidden test window. Until that is fixed there is no PDF page to measure.
const PDF_NOTE = 'content not checkable: the page never loads into the webview (fb-file has no handler on the persist:webview-default partition), so only the widget frame and its toolbar are checked'

// ── The kinds ────────────────────────────────────────────────────────────────

interface Case {
  /** Shown on the test; the kind, or the kind and its state. */
  name: string
  kind: string
  /** Why this kind's real content cannot be checked here, or absent if it can. */
  notCheckable?: string
  /** A widget that sizes itself to its content by design: measured where it lands. */
  autoFit?: boolean
  /** Selectors inside the frame whose content is canvas/preview, not chrome. */
  ignore?: string[]
  /** Prepares the test data and places the widget; returns its id. */
  build: (size: { width: number; height: number }) => Promise<string>
  /** Throws until the real content is on screen. */
  ready: (id: string) => Promise<void>
  cleanup?: (id: string) => Promise<void>
  describe: string
}

const inFrame = (id: string): ReturnType<Page['locator']> => page.locator(`[data-widget-id="${id}"]`)

const CASES: Case[] = [
  {
    name: 'inbox',
    kind: 'inbox',
    describe: '14 messages, rule on, long subjects',
    build: (size) => place('inbox', JSON.stringify({ rules: { subject: ['ridge st'], sinceDays: 30 } }), size, 'Ridge St mail'),
    ready: async (id) => {
      await expect(inFrame(id)).toContainText('14 matching', { timeout: 10_000 })
      await expect(inFrame(id)).toContainText('of 14 scanned')
    }
  },
  {
    name: 'inbox (filter editor open)',
    kind: 'inbox',
    describe: 'rule editor, filled in',
    build: (size) =>
      place(
        'inbox',
        JSON.stringify({ rules: { from: ['sarah', '@okaforlaw.example'], subject: ['ridge st', 'settlement'], unreadOnly: true, sinceDays: 30 }, editing: true }),
        size,
        'Ridge St mail'
      ),
    ready: async (id) => {
      await expect(inFrame(id).getByText('Subject contains')).toBeVisible({ timeout: 10_000 })
      await expect(inFrame(id).getByRole('button', { name: 'Done' })).toBeVisible()
    }
  },
  {
    name: 'chat-thread',
    kind: 'chat-thread',
    describe: '18 messages, composer',
    build: async (size) => {
      await signInWithFakeSignal(page, {
        conversation: { id: 'conv-ridge', kind: 'space', title: 'Ridge St settlement team' },
        messages: CHAT_MESSAGES,
        name: { firstName: 'Test', lastName: 'Person' }
      })
      return place('chat-thread', JSON.stringify({ conversationId: 'conv-ridge', channelName: 'Ridge St settlement team' }), size, 'Ridge St chat')
    },
    ready: async (id) => {
      await expect(inFrame(id).locator('[data-testid="message-composer"]')).toBeVisible({ timeout: 10_000 })
      await expect(inFrame(id)).toContainText('See you Tuesday.')
    }
  },
  {
    name: 'drive',
    kind: 'drive',
    describe: 'folder with a subfolder and 11 long-named files',
    build: async (size) => {
      const folderId = await page.evaluate(async () => {
        const api = (window as unknown as W).api
        const folder = await api.fileManager.createFolder(null, 'Ridge St settlement contracts and reports')
        await api.fileManager.createFolder(folder.id, 'Inspections 2026')
        const names = [
          'Contract of sale signed counterparts final v3.pdf',
          'Building inspection report by Willis Build Group, November.pdf',
          'Pest inspection.pdf',
          'Strata records and minutes of the last three meetings.pdf',
          'Settlement statement revised.pdf',
          'Title search results.pdf',
          'Council permit plans redrawn.pdf',
          'Bank deposit release letter.pdf',
          'Rates and water adjustments.xlsx',
          'Insurance certificate of currency.pdf',
          'Keys and access on the day checklist.docx'
        ]
        for (const name of names) {
          await api.files.ingestBuffer({ buffer: new TextEncoder().encode('Test file for the e2e sizing check').buffer, originalName: name, mimeType: 'application/octet-stream', parentId: folder.id })
        }
        return folder.id
      })
      return place('drive', folderId, size, 'Ridge St settlement contracts and reports')
    },
    ready: async (id) => {
      await expect.poll(() => inFrame(id).locator('[data-testid^="drive-entry-"]').count(), { timeout: 10_000 }).toBe(12)
    }
  },
  {
    name: 'living-doc',
    kind: 'living-doc',
    describe: 'brief and a generated summary',
    build: async (size) => {
      const id = await place('living-doc', LIVING_DOC, size, 'Living doc')
      await resize(id, { livingQuery: 'A running summary of the Ridge St settlement for the whole team', livingPaused: true, livingGeneratedAt: Date.now() })
      return id
    },
    ready: async (id) => {
      await expect(inFrame(id).locator('[data-testid="livingdoc-body"]')).toContainText('Where Ridge St stands', { timeout: 10_000 })
      await expect(inFrame(id).locator('[data-testid="livingdoc-brief"]')).toContainText('running summary')
    }
  },
  {
    name: 'custom',
    kind: 'custom',
    autoFit: true,
    describe: 'built retainer tracker (generated page in its sandbox)',
    build: (size) =>
      place('custom', JSON.stringify({ spec: 'A retainer tracker: hours used against hours bought for each client', code: CUSTOM_CODE }), size, 'Retainer tracker'),
    ready: async (id) => {
      await expect(inFrame(id).locator('iframe')).toBeVisible({ timeout: 10_000 })
      await expect(inFrame(id).locator('[data-testid="custom-widget-refine"]')).toBeVisible()
      await expect
        .poll(
          async () => {
            const f = await inFrame(id).locator('iframe').elementHandle().then((h) => h?.contentFrame())
            return f ? f.evaluate(() => document.body?.innerText ?? '') : ''
          },
          { timeout: 15_000 }
        )
        .toContain('Retainer tracker')
      // The page inside the sandbox is a separate document the frame probe cannot see into.
      const inner = await inFrame(id).locator('iframe').elementHandle().then((h) => h?.contentFrame())
      const sideways = await inner!.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(sideways, 'the generated page has no sideways scrollbar').toBeLessThanOrEqual(2)
    }
  },
  {
    name: 'gallery',
    kind: 'gallery',
    describe: '9 pictures',
    build: async (size) => {
      const ids: string[] = []
      for (let i = 0; i < 9; i++) ids.push(await seedPicture(`Site photo ${i + 1}.png`, 800, 600, i * 40))
      return place('gallery', JSON.stringify({ fileIds: ids }), size, 'Site photos')
    },
    ready: async (id) => {
      await expect
        .poll(
          () =>
            inFrame(id)
              .locator('button img')
              .evaluateAll((els) => els.filter((e) => (e as HTMLImageElement).naturalWidth > 0).length),
          { timeout: 15_000 }
        )
        // The picture grid lazy-loads, so tiles below the fold are not asked for
        // yet; the first rows are what has to be real.
        .toBeGreaterThan(3)
      expect(await inFrame(id).locator('button img').count()).toBe(9)
    }
  },
  {
    name: 'image-gen',
    kind: 'image-gen',
    describe: 'a finished image and its prompt',
    build: async (size) => {
      const fileId = await seedPicture('Generated hero image.png', 1024, 1024, 200)
      return place('image-gen', JSON.stringify({ prompt: 'A calm desk workspace at golden hour, soft focus, warm light across a stack of contracts and a laptop, photographic', fileId }), size, 'Generated image')
    },
    ready: async (id) => {
      await expect
        .poll(() => inFrame(id).locator('[data-testid="image-gen-result"]').evaluate((e) => (e as HTMLImageElement).naturalWidth), { timeout: 10_000 })
        .toBeGreaterThan(0)
      await expect(inFrame(id).locator('[data-testid="image-gen-place"]')).toBeVisible()
      await expect(inFrame(id).locator('[data-testid="image-gen-go"]')).toBeVisible()
    }
  },
  {
    name: 'custom-block',
    kind: 'custom-block',
    autoFit: true,
    describe: 'filled two-column record (9 fields, use mode)',
    build: (size) => place('custom-block', JSON.stringify({ title: 'Client intake', fields: BLOCK_FIELDS }), size, 'Client intake'),
    ready: async (id) => {
      await expect(inFrame(id).locator('input[value="Sarah Chen"]')).toBeVisible({ timeout: 10_000 })
    }
  },
  {
    name: 'custom-block (design mode)',
    kind: 'custom-block',
    autoFit: true,
    describe: 'the same record in design mode (field palette and handles)',
    build: async (size) => {
      const id = await place('custom-block', JSON.stringify({ title: 'Client intake', fields: BLOCK_FIELDS }), size, 'Client intake')
      await inFrame(id).getByRole('button', { name: 'design' }).first().click()
      return id
    },
    ready: async (id) => {
      await expect(inFrame(id).locator('button[title="Add Checkbox"]')).toBeVisible({ timeout: 10_000 })
    }
  },
  {
    name: 'portal',
    kind: 'portal',
    describe: 'window onto a desk with 4 widgets',
    build: (size) => place('portal', JSON.stringify({ targetTaskId: portalDeskId }), size, 'Ridge St desk'),
    ready: async (id) => {
      await expect(inFrame(id).locator('[data-testid="portal-title"]')).toContainText('Ridge St settlement', { timeout: 10_000 })
      await expect(inFrame(id).locator('[data-testid="portal-widget"]')).toContainText('Book the inspection', { timeout: 10_000 })
    }
  },
  {
    name: 'file',
    kind: 'file',
    describe: 'a document with a long name',
    build: async (size) => {
      const fileId = await seedTextFile('Ridge St contract of sale signed counterparts final v3.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Test file for the e2e sizing check')
      return place('file', fileId, size, 'Ridge St contract of sale signed counterparts final v3.docx')
    },
    ready: async (id) => {
      await expect(inFrame(id).locator('[data-testid="file-open-local"]')).toContainText('Ridge St contract', { timeout: 15_000 })
    }
  },
  {
    name: 'file (picture)',
    kind: 'file',
    autoFit: true,
    describe: 'a local picture (the widget fits itself to it)',
    build: async (size) => {
      const fileId = await seedPicture('Site photo wide.png', 1600, 700, 120)
      return place('file', fileId, size, 'Site photo wide.png')
    },
    ready: async (id) => {
      await expect
        .poll(() => inFrame(id).locator('img[alt="Site photo wide.png"]').evaluate((e) => (e as HTMLImageElement).naturalWidth), { timeout: 10_000 })
        .toBeGreaterThan(0)
    }
  },
  {
    name: 'section',
    kind: 'section',
    describe: 'two small work widgets side by side',
    build: async (size) => {
      const ids = await page.evaluate(
        async ({ deskId, size, para }) => {
          const s = (window as unknown as Win).__fbWidgets.getState()
          s.resetView()
          const section = await s.create({ taskId: deskId, kind: 'section', title: 'Ridge St', content: '', x: 40, y: 60, ...size })
          // A child of exactly half the section's standard inner width, so the
          // section frame computes to the standard 740 x 340 (the section sizes
          // itself from its children; see the empty-section note in the report).
          const each = { width: 335, height: 284 }
          const a = await s.create({ taskId: deskId, kind: 'card', title: 'Deposit release', content: JSON.stringify({ title: 'Deposit release', body: para, accent: '#6366f1' }), x: 0, y: 0, ...each })
          const b = await s.create({ taskId: deskId, kind: 'card', title: 'Inspection', content: JSON.stringify({ title: 'Inspection', body: para, accent: '#16a34a' }), x: 349, y: 0, ...each })
          await s.update(a.id, { parentSectionId: section.id })
          await s.update(b.id, { parentSectionId: section.id })
          return { section: section.id, a: a.id, b: b.id }
        },
        { deskId, size, para: LONG_PARA }
      )
      sectionChildren.set(ids.section, [ids.a, ids.b])
      await page.waitForSelector(`[data-widget-id="${ids.section}"]`, { timeout: 15_000 })
      return ids.section
    },
    ready: async (id) => {
      for (const child of sectionChildren.get(id) ?? []) {
        await expect(page.locator(`[data-widget-id="${child}"]`)).toContainText('settlement agent', { timeout: 10_000 })
      }
    },
    cleanup: async (id) => {
      for (const child of sectionChildren.get(id) ?? []) await removeWidget(child)
    }
  },
  {
    name: 'mail-thread',
    kind: 'mail-thread',
    describe: 'a 3-message thread with quoted history and attachments',
    build: (size) =>
      place(
        'mail-thread',
        JSON.stringify({ mode: 'thread', uids: [3001, 3002, 3003], rootMessageId: '<ridge-root@example.test>', subject: 'Ridge St settlement: final figures', fromName: 'Sarah Chen' }),
        size,
        'Ridge St settlement: final figures'
      ),
    ready: async (id) => {
      await expect(inFrame(id)).toContainText('3 messages in this thread', { timeout: 10_000 })
      await expect(inFrame(id)).toContainText('It is the quarter to September')
      await expect(inFrame(id).getByText('Show the whole thread').or(inFrame(id).getByText('Show just this message')).first()).toBeVisible()
    }
  },
  {
    name: 'pdf',
    kind: 'pdf',
    notCheckable: PDF_NOTE,
    describe: 'a real two-page local PDF by file id; the webview never loads it (see PDF_NOTE), so frame and toolbar only',
    build: async (size) => {
      const fileId = await page.evaluate(async (pdf) => {
        const api = (window as unknown as W).api
        return (await api.files.ingestBuffer({ buffer: new TextEncoder().encode(pdf).buffer, originalName: 'Contract of sale.pdf', mimeType: 'application/pdf', parentId: null })).id
      }, pdfText())
      pdfFiles.set('current', fileId)
      return place('pdf', fileId, size, 'Contract of sale')
    },
    ready: async (id) => {
      await expect(inFrame(id).locator('[data-testid="browser-toolbar"]')).toBeVisible({ timeout: 15_000 })
      const fileId = pdfFiles.get('current')!
      await expect
        .poll(
          () =>
            page.evaluate((i) => {
              const el = (document.querySelector(`[data-web-for="${i}"] webview`) ??
                document.querySelector(`[data-widget-id="${i}"] webview`)) as { src?: string } | null
              return el?.src ?? ''
            }, id),
          { timeout: 10_000 }
        )
        .toContain(fileId)
    }
  },
  ...(['gdoc', 'gsheet', 'gslide', 'email'] as const).map(
    (kind): Case => ({
      name: kind,
      kind,
      notCheckable: REMOTE_NOTE,
      describe: 'remote page (closed loopback address, frame and toolbar only)',
      build: (size) => place(kind, REMOTE_PATH(`sample-${kind}/document/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ/edit?usp=sharing`), size, `Remote ${kind}`),
      ready: async (id) => {
        await expect(inFrame(id).locator('[data-testid="browser-toolbar"]')).toBeVisible({ timeout: 15_000 })
        await expect(inFrame(id).locator('[data-testid="browser-address"]')).toHaveValue(/127\.0\.0\.1/, { timeout: 10_000 })
      }
    })
  ),
  {
    name: 'image',
    kind: 'image',
    describe: 'a local landscape photo',
    build: async (size) => {
      const fileId = await seedPicture('Front elevation.png', 1600, 1000, 30)
      return place('image', `fb-file://${fileId}`, size, 'Front elevation')
    },
    ready: async (id) => {
      await expect
        .poll(() => inFrame(id).locator('[data-testid="image-widget-body"] img').evaluate((e) => (e as HTMLImageElement).naturalWidth), { timeout: 10_000 })
        .toBeGreaterThan(0)
    }
  },
  {
    name: 'video',
    kind: 'video',
    describe: 'a local WebM recorded in the test',
    build: async (size) => {
      const fileId = await seedVideo('Site walkthrough.webm')
      return place('video', `fb-file://${fileId}`, size, 'Site walkthrough')
    },
    ready: async (id) => {
      await expect
        .poll(() => inFrame(id).locator('video').evaluate((e) => (e as HTMLVideoElement).videoWidth), { timeout: 15_000 })
        .toBeGreaterThan(0)
    }
  },
  {
    name: 'diagram',
    kind: 'diagram',
    // Nodes sit on a pannable canvas: a node past the edge is not cut off, it is panned to.
    ignore: ['.react-flow__viewport'],
    describe: '7 nodes and 6 connectors',
    build: (size) => place('diagram', DIAGRAM, size, 'Sales flow'),
    ready: async (id) => {
      await expect.poll(() => inFrame(id).locator('.react-flow__node').count(), { timeout: 10_000 }).toBe(7)
      await expect(inFrame(id).locator('.react-flow__controls')).toBeVisible()
    }
  }
]

const sectionChildren = new Map<string, string[]>()
const pdfFiles = new Map<string, string>()

// ── The tests ────────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  test.setTimeout(120_000)
  if (OUT) mkdirSync(OUT, { recursive: true })
  launched = await launchApp()
  page = launched.window
  app = launched.app
  await waitForReady(page)
  await suppressFeatureSpotlights(page)
  await stubMail(app)
  await app.evaluate(({ BrowserWindow }, s) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())!
    win.setMinimumSize(800, 600)
    win.setContentSize(s.width, s.height)
    win.webContents.setZoomFactor(1)
  }, WINDOW)
  const seeded = await page.evaluate(async () => {
    const api = (window as unknown as W).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Sizing desk (e2e test data)' })
    const other = await api.nodes.create({ parentId: null, kind: 'task', title: 'Ridge St settlement' })
    const stickies = ['Book the inspection', 'Chase signed contract from agent', 'Send updated budget to Sarah', 'Renew insurance before handover']
    for (let i = 0; i < stickies.length; i++) {
      await api.widgets.create({ taskId: other.id, kind: 'sticky', title: 'note', content: stickies[i], x: 40 + i * 240, y: 40 + (i % 2) * 120, width: 220, height: 180 })
    }
    return { desk: desk.id, other: other.id }
  })
  deskId = seeded.desk
  portalDeskId = seeded.other
  await page.evaluate(async () => {
    await (window as unknown as { __fbNodes: { getState: () => { refresh: () => Promise<void> } } }).__fbNodes.getState().refresh()
  })
  await page.evaluate(
    (id) => (window as unknown as { __fbView: { getState: () => { goTask: (x: string) => void } } }).__fbView.getState().goTask(id),
    deskId
  )
  await page.waitForSelector('[data-canvas-surface="true"]', { timeout: 15_000 })
  await page.waitForTimeout(800)
})

test.afterAll(async () => {
  await launched?.dispose()
  launched = null
})

for (const c of CASES) {
  const size = WIDGET_START_SIZES[c.kind]
  const tag = c.notCheckable ? ' [frame and controls only: content not checkable]' : ''
  test(`${c.name} works at ${size.width}x${size.height} with real content${tag}`, async () => {
    test.setTimeout(90_000)
    expect(size, `${c.kind} is in the starting-sizes table`).toBeTruthy()
    if (c.notCheckable) test.info().annotations.push({ type: 'content-not-checkable', description: c.notCheckable })

    const id = await c.build(size)
    await c.ready(id)
    await settle()
    const ignore = c.ignore ?? []
    const atStart = await measure(id, ignore)
    if (c.autoFit) {
      expect(atStart.width, `${c.name} keeps the standard width`).toBeGreaterThanOrEqual(size.width - 1)
    } else {
      // Within a pixel: a frame's rendered edge can round either way (the section
      // takes its frame from its children, who may sit a pixel apart).
      expect(Math.abs(atStart.width - size.width), `${c.name} is at its standard width (rendered ${atStart.width})`).toBeLessThanOrEqual(1)
      expect(Math.abs(atStart.height - size.height), `${c.name} is at its standard height (rendered ${atStart.height})`).toBeLessThanOrEqual(1)
    }
    expect(atStart.controls.length, `${c.name} has controls to measure`).toBeGreaterThan(0)
    await shot(id, c.name.replace(/\W+/g, '-'))

    // The large baseline: anything cut here too is not the starting size's doing.
    let big: Measured
    if (c.kind === 'section') {
      const kids = sectionChildren.get(id) ?? []
      await resize(kids[0], { width: 640, height: 540 })
      await resize(kids[1], { x: 654, width: 640, height: 540 })
    } else {
      await resize(id, BIG)
    }
    await settle()
    await page.waitForTimeout(300)
    big = await measure(id, ignore)
    if (c.kind !== 'section') {
      expect(big.width, `${c.name} really reached the large size`).toBeGreaterThanOrEqual(BIG.width - 1)
    }

    const newlyCut = newlyIn([...atStart.cutControls, ...atStart.cutText], [...big.cutControls, ...big.cutText])
    const newlySideways = newlyIn(atStart.sideways, big.sideways)
    const lost = newlyIn(big.controls, atStart.controls)
    const covered = newlyIn(atStart.covered, big.covered)
    const crushed = newlyIn(atStart.crushedBoxes, big.crushedBoxes)

    console.log(
      `[start-size] ${JSON.stringify({
        case: c.name,
        kind: c.kind,
        std: `${size.width}x${size.height}`,
        landed: `${atStart.width}x${atStart.height}`,
        content: c.describe,
        controls: atStart.controls.length,
        newlyCut,
        sidewaysAtStd: atStart.sidewaysDetail,
        sidewaysAtBig: big.sidewaysDetail,
        newlySideways,
        lostAtStd: lost,
        newlyCovered: covered,
        crushedBoxes: crushed,
        truncatedControls: atStart.truncatedControls,
        cutAtBoth: [...big.cutControls, ...big.cutText].slice(0, 6),
        note: c.notCheckable ?? null
      })}`
    )
    if (OUT) appendFileSync(join(OUT, 'results.jsonl'), JSON.stringify({ case: c.name, atStart, big, newlyCut, newlySideways, lost, covered, crushed }) + '\n')

    await c.cleanup?.(id)
    await removeWidget(id)

    expect(newlyCut, `${c.name} at ${size.width}x${size.height}: newly cut off`).toEqual([])
    expect(newlySideways, `${c.name} at ${size.width}x${size.height}: horizontal scrollbar`).toEqual([])
    expect(covered, `${c.name} at ${size.width}x${size.height}: controls covered`).toEqual([])
    expect(crushed, `${c.name} at ${size.width}x${size.height}: a text box too narrow for its own placeholder`).toEqual([])
  })
}
