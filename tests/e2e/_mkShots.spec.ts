// Marketing capture, stage 2: real screenshots of PlexiiDesk at its most
// demoable, light theme, from a private capture profile seeded with the persona
// desks (stage 1 + scripts/persona-demos) plus the content below.
// Sweep only (underscore): never part of the suite.
import { test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, waitForReady, suppressFeatureSpotlights, chooseCloudAiSource, type LaunchedApp } from './_helpers'
import { blankDrawBody, DRAW_SIZES, shapePath, solid, vectorLayer } from '../../src/shared/draw'

const OUT = process.env.MK_OUT!
const PROFILE = process.env.MK_PROFILE!
// One folder (owner); each kind is a file-name prefix instead of a subfolder.
const DIRS = { full: '', desks: '', views: '', widgets: '', office: '', embeds: '', tools: '' }
const PREFIX: Record<string, string> = { full: 'Screen - ', office: 'App - ', tools: 'Tool - ' }
const log: string[] = []
type Api = typeof window.api

test.setTimeout(30 * 60_000)

async function settle(w: Page, ms = 1800): Promise<void> {
  await w.waitForTimeout(ms)
}

async function tidy(w: Page): Promise<void> {
  // Real UI, but not what a marketing shot is about: the workload pill and the
  // one-line desk suggestion. Hidden for the capture only.
  await w.addStyleTag({ content: '[data-testid="load-meter"],[data-testid="desk-suggestion"]{display:none!important}' }).catch(() => {})
}

async function full(w: Page, dir: keyof typeof DIRS, name: string): Promise<void> {
  try {
    await tidy(w)
    // The window's content is 1600 x 1000; the capture surface is larger and
    // grey beyond it, so clip to the app itself.
    await w.screenshot({ path: join(OUT, `${PREFIX[dir] ?? ''}${name}.png`), clip: { x: 0, y: 0, width: 1600, height: 1000 } })
    log.push(`ok    ${DIRS[dir]}/${name}.png`)
  } catch (e) {
    log.push(`SKIP  ${DIRS[dir]}/${name}: ${(e as Error).message.split('\n')[0]}`)
  }
}

async function go(w: Page, fn: string, arg?: string): Promise<void> {
  // One open item in the bottom tray, not every place visited before.
  await w.evaluate(() => (window as unknown as { __fbOpenTray?: { setState: (s: { entries: unknown[] }) => void } }).__fbOpenTray?.setState({ entries: [] }))
  await w.evaluate(
    ([f, a]) => {
      const s = (window as unknown as { __fbView: { getState: () => Record<string, (x?: string) => void> } }).__fbView.getState()
      s[f](a)
    },
    [fn, arg] as const
  )
}

async function openDesk(w: Page, id: string): Promise<void> {
  await go(w, 'goTask', id)
  await w.waitForSelector('[data-canvas-surface="true"]', { timeout: 15_000 })
  // Start the desk clear of the side menu that floats over the canvas.
  await w.evaluate(() => {
    const s = (window as unknown as { __fbWidgets: { getState: () => { dockInset?: number }; setState: (s: Record<string, number>) => void } }).__fbWidgets
    s.setState({ zoom: 1, panX: (s.getState().dockInset ?? 280) + 8, panY: 8 })
  })
  await settle(w, 2500)
}

let launched: LaunchedApp

test('capture', async () => {
  for (const d of Object.values(DIRS)) mkdirSync(join(OUT, d), { recursive: true })
  launched = await launchApp({ userDataDir: PROFILE })
  const { app, window: w } = launched
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.setContentSize(1600, 1000)
    win.center()
  })
  await w.evaluate(() => {
    localStorage.setItem('fb.theme.mode', 'light')
  })
  await suppressFeatureSpotlights(w)
  await w.reload()
  await waitForReady(w)
  await chooseCloudAiSource(w).catch(() => {})
  // The Pro upsell card is not the product; close it if it is showing.
  await w.locator('text=Upgrade Now').locator('xpath=ancestor::*[.//button][1]').locator('button[aria-label], button:has-text("×")').first().click({ timeout: 2000 }).catch(() => {})

  // ── Content the persona desks do not carry ────────────────────────────────
  const seeded = await w.evaluate(async (drawBody) => {
    const api = (window as unknown as { api: Api }).api
    const t = (text: string, marks?: unknown[]) => ({ type: 'text', text, ...(marks ? { marks } : {}) })
    const p = (...c: unknown[]) => ({ type: 'paragraph', content: c })
    const h = (level: number, text: string) => ({ type: 'heading', attrs: { level }, content: [t(text)] })
    const li = (text: string) => ({ type: 'listItem', content: [p(t(text))] })
    const cell = (text: string, header = false) => ({ type: header ? 'tableHeader' : 'tableCell', content: [p(t(text))] })
    const row = (cells: string[], header = false) => ({ type: 'tableRow', content: cells.map((c) => cell(c, header)) })
    const bold = [{ type: 'bold' }]

    const write = await api.documents.create({
      docType: 'doc',
      title: 'Fernroom 2.0 launch plan',
      body: {
        type: 'doc',
        content: [
          h(1, 'Fernroom 2.0 launch plan'),
          p(t('Launch: ', bold), t('Tuesday 18 November · '), t('Owner: ', bold), t('Priya Raman · '), t('Status: ', bold), t('on track')),
          h(2, 'What we are shipping'),
          p(t('Shared booking calendars for multi-site clinics, a rebuilt waitlist, and SMS reminders that cut no-shows. Every change came out of the 14 discovery calls in September.')),
          h(2, 'Goals for the first 30 days'),
          { type: 'bulletList', content: [li('Move 40 of our 120 clinics onto shared calendars'), li('Cut no-shows from 11% to under 7%'), li('Hold support tickets under 25 a week through the switch')] },
          h(2, 'Timeline'),
          {
            type: 'table',
            content: [
              row(['Week', 'Milestone', 'Owner'], true),
              row(['3 Nov', 'Beta with Harbourside Physio and two Northside sites', 'Marcus']),
              row(['10 Nov', 'Pricing page, help articles and in-app tour', 'Lena']),
              row(['18 Nov', 'Launch email, release notes, webinar', 'Priya']),
              row(['25 Nov', 'First-week review and roadmap call', 'Priya'])
            ]
          },
          h(2, 'Risks we are watching'),
          { type: 'orderedList', content: [li('SMS costs at scale: capped at 4 reminders per booking'), li('Calendar migration for clinics with more than 6 practitioners'), li('Waitlist emails landing in spam during the first send')] }
        ]
      }
    } as never)

    const sheet = await api.documents.create({
      docType: 'sheet',
      title: 'Q4 operating budget',
      body: {
        version: 2,
        activeSheet: 0,
        sheets: [
          {
            id: 't1',
            name: 'Q4 budget',
            columns: ['A', 'B', 'C', 'D', 'E', 'F'],
            colWidths: { 0: 210, 1: 110, 2: 110, 3: 110, 4: 120, 5: 110 },
            rows: [
              ['Line item', 'October', 'November', 'December', 'Q4 total', 'Plan'],
              ['Salaries', '84200', '84200', '91600', '=SUM(B2:D2)', '262000'],
              ['Contractors', '12400', '9800', '6500', '=SUM(B3:D3)', '30000'],
              ['Software and hosting', '6150', '6310', '6480', '=SUM(B4:D4)', '19500'],
              ['Marketing', '9000', '18500', '14000', '=SUM(B5:D5)', '40000'],
              ['Office and travel', '3900', '4400', '5200', '=SUM(B6:D6)', '13000'],
              ['Total', '=SUM(B2:B6)', '=SUM(C2:C6)', '=SUM(D2:D6)', '=SUM(E2:E6)', '=SUM(F2:F6)']
            ]
          }
        ]
      }
    } as never)

    const run = (text: string, size: number, color: string, isBold = false) => ({ text, bold: isBold, color, fontSize: size })
    const text = (id: string, x: number, y: number, w: number, hh: number, runs: unknown[], align = 'left', role = 'body') => ({
      id, type: 'text', x, y, w, h: hh, z: 1, styleRole: role, fontFamily: 'Inter, system-ui, sans-serif', vAlign: 'top', paragraphs: [{ runs, align }]
    })
    const slide = (id: string, bg: string, elements: unknown[]) => ({ id, schemaVersion: 2, layout: 'blank', notes: '', transition: 'fade', background: { type: 'solid', color: bg }, elements })
    const deck = await api.documents.create({
      docType: 'slides',
      title: 'Fernroom — board update Q4',
      body: {
        schemaVersion: 2,
        theme: 'plexi',
        size: { w: 1280, h: 720 },
        slides: [
          slide('s1', '#1e1b4b', [
            text('a', 90, 210, 1100, 120, [run('Fernroom board update', 64, '#ffffff', true)], 'left', 'title'),
            text('b', 90, 340, 1100, 60, [run('Q4 · growth, product and the raise', 30, '#c4b5fd')]),
            text('c', 90, 600, 1100, 40, [run('Priya Raman, CEO · 4 December', 20, '#a5b4fc')])
          ]),
          slide('s2', '#ffffff', [
            text('a', 80, 60, 1100, 80, [run('Where we are', 44, '#1e1b4b', true)], 'left', 'title'),
            text('b', 80, 170, 520, 90, [run('120', 72, '#7c3aed', true)]),
            text('c', 80, 260, 520, 40, [run('clinics live, up from 64 in June', 22, '#334155')]),
            text('d', 680, 170, 520, 90, [run('$41k', 72, '#7c3aed', true)]),
            text('e', 680, 260, 520, 40, [run('monthly recurring revenue', 22, '#334155')]),
            text('f', 80, 400, 1100, 200, [run('Shared calendars launch 18 November. No-shows down 4 points in the beta. Pre-seed of $600k closes in January.', 24, '#334155')])
          ]),
          slide('s3', '#f5f3ff', [
            text('a', 80, 60, 1100, 80, [run('What we need from the board', 44, '#1e1b4b', true)], 'left', 'title'),
            text('b', 80, 180, 1100, 300, [run('1. Two introductions to clinic groups with 10+ sites\n2. A view on the January pricing change\n3. Sign-off on the senior engineering hire', 26, '#334155')])
          ])
        ]
      }
    } as never)

    const n = (id: string, x: number, y: number, label: string, shape: string, color: string) => ({ id, x, y, label, shape, color, width: 190, height: 74 })
    const diagram = await api.documents.create({
      docType: 'map',
      title: 'Clinic onboarding flow',
      body: {
        nodes: [
          n('a', 60, 220, 'Clinic signs up', 'terminator', '#7c3aed'),
          n('b', 320, 220, 'Import practitioners', 'process', '#2563eb'),
          n('c', 580, 210, 'More than 6 sites?', 'decision', '#d97706'),
          n('d', 860, 100, 'Assign onboarding lead', 'process', '#2563eb'),
          n('e', 860, 340, 'Self-serve setup tour', 'process', '#2563eb'),
          n('f', 1120, 220, 'First booking taken', 'terminator', '#059669'),
          n('g', 580, 420, 'Calendars database', 'database', '#64748b')
        ],
        edges: [
          { id: 'e1', source: 'a', target: 'b' },
          { id: 'e2', source: 'b', target: 'c' },
          { id: 'e3', source: 'c', target: 'd', label: 'Yes' },
          { id: 'e4', source: 'c', target: 'e', label: 'No' },
          { id: 'e5', source: 'd', target: 'f' },
          { id: 'e6', source: 'e', target: 'f' },
          { id: 'e7', source: 'b', target: 'g' }
        ]
      }
    } as never)

    const design = await api.documents.create({
      docType: 'design',
      title: 'Cold brew launch poster',
      body: {
        schemaVersion: 1,
        width: 1080,
        height: 1350,
        background: { type: 'solid', color: '#1c1917' },
        elements: [
          text('a', 90, 120, 900, 90, [run('WANDOO HILL ROASTERS', 30, '#d6a96b', true)]),
          text('b', 90, 260, 900, 420, [run('Cold brew,\nslow made.', 120, '#fafaf9', true)], 'left', 'title'),
          text('c', 90, 760, 820, 160, [run('Steeped for 18 hours with our single-origin Ethiopia. Now pouring at every Wandoo Hill café.', 34, '#e7e5e4')]),
          text('d', 90, 1150, 900, 60, [run('From 3 November · $6.50 a bottle', 30, '#d6a96b', true)])
        ]
      }
    } as never)

    const draw = await api.documents.create({ docType: 'draw', title: 'Fernroom brand mark', body: drawBody } as never)

    // A Write document that embeds the live budget, the 4.3.43 headline.
    const embedDoc = await api.documents.create({
      docType: 'doc',
      title: 'Q4 budget review',
      body: {
        type: 'doc',
        content: [
          h(1, 'Q4 budget review'),
          p(t('Marketing runs over plan in November for the launch; contractors come in under as the beta wraps up. The live budget is below, so these numbers are always current.')),
          { type: 'widgetEmbed', attrs: { widgetId: `doc:${(sheet as { id: string }).id}`, display: 'data' } },
          h(2, 'Decisions'),
          { type: 'bulletList', content: [li('Hold December marketing at $14k'), li('Bring the senior engineer start forward to 1 December')] }
        ]
      }
    } as never)

    // A real week on the calendar.
    const monday = new Date()
    monday.setHours(0, 0, 0, 0)
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
    const at = (day: number, hour: number, min = 0) => monday.getTime() + day * 86400000 + (hour * 60 + min) * 60000
    const blocks: Array<[number, number, number, number, string]> = [
      [0, 9, 0, 60, 'Weekly priorities'],
      [0, 10, 30, 90, 'Design review: waitlist'],
      [0, 14, 0, 45, 'Call with Harbourside Physio'],
      [1, 9, 30, 120, 'Deep work: pricing page'],
      [1, 13, 0, 60, 'Investor update draft'],
      [2, 9, 0, 30, 'Stand-up'],
      [2, 11, 0, 90, 'Beta feedback synthesis'],
      [2, 15, 0, 60, '1:1 with Marcus'],
      [3, 10, 0, 120, 'Launch rehearsal'],
      [3, 14, 30, 60, 'Board deck review'],
      [4, 9, 0, 60, 'Support queue review'],
      [4, 13, 30, 90, 'Webinar prep'],
      [4, 16, 0, 30, 'Friday wins']
    ]
    for (const [d, hh, mm, dur, title] of blocks) await api.timeBlocks.create({ title, startMs: at(d, hh, mm), durationMin: dur } as never)

    const people: Array<[string, string, string, string]> = [
      ['Priya Raman', 'Fernroom', 'CEO', 'priya@fernroom.co'],
      ['Marcus Chen', 'Fernroom', 'Head of Engineering', 'marcus@fernroom.co'],
      ['Lena Okafor', 'Fernroom', 'Product Marketing', 'lena@fernroom.co'],
      ['Dr Sarah Whitlock', 'Harbourside Physio', 'Clinical Director', 'sarah@harboursidephysio.com.au'],
      ['Tom Nguyen', 'Northside Health Group', 'Operations Manager', 'tom.nguyen@northsidehealth.com.au'],
      ['Amelia Ross', 'Bluegum Ventures', 'Partner', 'amelia@bluegum.vc'],
      ['James Holt', 'Wandoo Hill Roasters', 'Founder', 'james@wandoohill.com.au'],
      ['Ines Duarte', 'Coastline Dental', 'Practice Manager', 'ines@coastlinedental.com.au']
    ]
    for (const [name, company, role, email] of people) await api.contacts.create({ name, company, role, email } as never)

    const notes: Array<[string, string, string[]]> = [
      ['Pricing: what clinics told us', 'Per-practitioner pricing reads as fair to small clinics and expensive to groups. Groups want a site price with a practitioner cap.', ['pricing', 'research']],
      ['No-show playbook', 'Two reminders (48h and 2h) beat three. SMS outperforms email by 3x for confirmations.', ['product']],
      ['Board meeting cadence', 'Quarterly, first Thursday of the second month. Pack goes out five working days before.', ['company']],
      ['Onboarding: groups over 6 sites', 'Assign a named lead; import practitioners from their payroll export, not by hand.', ['onboarding']],
      ['Hiring bar: senior engineers', 'Has shipped scheduling or payments at scale; can explain a migration they would undo.', ['hiring']],
      ['Launch email checklist', 'Plain-text version, test to Outlook and Gmail, warm the sending domain a week ahead.', ['launch']]
    ]
    for (const [title, body, tags] of notes) await api.knowledge.create({ title, body, tags } as never)

    return {
      write: (write as { id: string }).id,
      sheet: (sheet as { id: string }).id,
      deck: (deck as { id: string }).id,
      diagram: (diagram as { id: string }).id,
      design: (design as { id: string }).id,
      draw: (draw as { id: string }).id,
      embedDoc: (embedDoc as { id: string }).id
    }
  }, makeDrawBody())

  // ── Desks ────────────────────────────────────────────────────────────────
  const desks = await w.evaluate(async () => {
    const api = (window as unknown as { api: Api }).api
    const nodes = await api.nodes.list()
    const byId = new Map(nodes.map((n) => [n.id, n]))
    return nodes
      .filter((n) => n.kind === 'task' && !n.archived)
      .map((n) => ({ id: n.id, title: n.title, room: n.parentId ? byId.get(n.parentId)?.title ?? '' : '' }))
  })
  const clean = (s: string) => s.replace(/[\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim()

  for (const d of desks) {
    try {
      await openDesk(w, d.id)
      await full(w, 'desks', `Desk - ${clean(d.room)} - ${clean(d.title)}`)
    } catch (e) {
      log.push(`SKIP  desk ${d.title}: ${(e as Error).message.split('\n')[0]}`)
    }
  }

  // ── Desk views, on one rich desk ─────────────────────────────────────────
  const hero = desks.find((d) => /Pre-seed raise/.test(d.title)) ?? desks[0]
  for (const mode of ['workcentre', 'columns', 'gallery', 'list', 'table', 'compact']) {
    try {
      await openDesk(w, hero.id)
      await w.locator('[data-testid="view-selector-btn"]').first().click()
      await w.locator(`[data-testid="view-opt-${mode}"]`).click()
      await settle(w, 2500)
      const label = { workcentre: 'Workcentre', columns: 'Columns', gallery: 'Gallery', list: 'List', table: 'Table', compact: 'Compact' }[mode]
      await full(w, 'views', `Desk view - ${label} - ${clean(hero.title)}`)
    } catch (e) {
      log.push(`SKIP  view ${mode}: ${(e as Error).message.split('\n')[0]}`)
    }
  }
  try {
    await w.locator('[data-testid="view-selector-btn"]').first().click()
    await w.locator('[data-testid="view-opt-canvas"]').click()
  } catch {
    /* back to canvas is best-effort */
  }

  // ── Work widget close-ups: the best example of each kind ─────────────────
  const KIND_NAMES: Record<string, string> = {
    table: 'Table', chart: 'Chart', mindmap: 'Mind map', page: 'Page', note: 'Note', sticky: 'Sticky note',
    card: 'Card', markdown: 'Brief', timer: 'Timer', image: 'Picture'
  }
  const picks = await w.evaluate(async (kinds) => {
    const api = (window as unknown as { api: Api }).api
    const nodes = await api.nodes.list()
    const out: Array<{ kind: string; id: string; taskId: string; x: number; y: number; title: string }> = []
    for (const kind of kinds) {
      let best: { id: string; taskId: string; x: number; y: number; title: string; score: number } | null = null
      for (const n of nodes.filter((x) => x.kind === 'task')) {
        for (const wd of await api.widgets.listByTask(n.id)) {
          if (wd.kind !== kind || wd.archived) continue
          const score = (wd.content?.length ?? 0) + wd.width * wd.height / 400
          if (!best || score > best.score) best = { id: wd.id, taskId: n.id, x: wd.x, y: wd.y, title: wd.title, score }
        }
      }
      if (best) out.push({ kind, id: best.id, taskId: best.taskId, x: best.x, y: best.y, title: best.title })
    }
    return out
  }, Object.keys(KIND_NAMES))

  for (const pk of picks) {
    try {
      await openDesk(w, pk.taskId)
      await w.evaluate(([x, y]) => (window as unknown as { __fbWidgets: { setState: (s: Record<string, number>) => void } }).__fbWidgets.setState({ zoom: 1, panX: -x + 360, panY: -y + 90 }), [pk.x, pk.y] as const)
      await settle(w, 1500)
      await tidy(w)
      // Clip by the element's box, like the full-screen shots: the element
      // screenshot mis-frames on this capture surface.
      const box = await w.locator(`[data-widget-id="${pk.id}"]`).first().boundingBox()
      if (!box) throw new Error('widget not on screen')
      // Layout runs at the window's pixel ratio (1.8 here) while the capture
      // surface renders at 2, so clip coordinates are layout x (ratio / 2).
      const k = (await w.evaluate(() => window.devicePixelRatio)) / 2
      const x = Math.max(0, (box.x - 6) * k)
      const y = Math.max(0, (box.y - 6) * k)
      await w.screenshot({ clip: { x, y, width: Math.min((box.width + 12) * k, 1600 - x), height: Math.min((box.height + 12) * k, 1000 - y) }, path: join(OUT, DIRS.widgets, `Work widget - ${KIND_NAMES[pk.kind]} - ${clean(pk.title || '')}.png`.replace(' - .png', '.png')) })
      log.push(`ok    ${DIRS.widgets}/${KIND_NAMES[pk.kind]}`)
    } catch (e) {
      log.push(`SKIP  widget ${pk.kind}: ${(e as Error).message.split('\n')[0]}`)
    }
  }

  // ── Office apps, each with a real document open ──────────────────────────
  const office: Array<[string, string]> = [
    ['PlexiiWrite - Fernroom 2.0 launch plan', seeded.write],
    ['PlexiiCells - Q4 operating budget', seeded.sheet],
    ['PlexiiDeck - Board update', seeded.deck],
    ['PlexiiDiagrams - Clinic onboarding flow', seeded.diagram],
    ['PlexiiDesign - Cold brew launch poster', seeded.design],
    ['PlexiiDraw - Brand mark', seeded.draw]
  ]
  for (const [name, id] of office) {
    try {
      await go(w, 'goDocument', id)
      await settle(w, 3000)
      await full(w, 'office', name)
    } catch (e) {
      log.push(`SKIP  ${name}: ${(e as Error).message.split('\n')[0]}`)
    }
  }
  try {
    await go(w, 'goDocument', seeded.embedDoc)
    await settle(w, 3500)
    await full(w, 'embeds', 'Embed - Live PlexiiCells budget inside a PlexiiWrite document')
  } catch (e) {
    log.push(`SKIP  embed: ${(e as Error).message.split('\n')[0]}`)
  }

  // ── Full-screen places and tools ─────────────────────────────────────────
  const places: Array<[keyof typeof DIRS, string, string]> = [
    ['full', 'Rooms', 'goRooms'],
    ['full', 'Desks', 'goDesks'],
    ['full', 'Documents', 'goDocuments'],
    ['full', 'Files', 'goFiles'],
    ['tools', 'Calendar - this week', 'goCalendar'],
    ['tools', 'PlexiiBrain - knowledge', 'goPlexiBrain'],
    ['tools', 'Focus', 'goAttention'],
    ['tools', 'PlexiiPeople - directory', 'goPlexiPeople']
  ]
  for (const [dir, name, fn] of places) {
    try {
      await go(w, fn)
      await settle(w, 3000)
      // The calendar opens scrolled to the current hour; start the day at 8 AM.
      if (fn === 'goCalendar') {
        await w.evaluate(() => {
          const label = [...document.querySelectorAll('*')].find((e) => e.childElementCount === 0 && /^8\s?AM$/.test((e.textContent ?? '').trim()))
          label?.scrollIntoView({ block: 'start' })
        })
        await settle(w, 800)
      }
      await full(w, dir, name)
    } catch (e) {
      log.push(`SKIP  ${name}: ${(e as Error).message.split('\n')[0]}`)
    }
  }

  writeFileSync(join(OUT, 'capture-log.txt'), log.join('\n') + '\n')
  await app.close()
})

// A brand mark built with Draw's own shape helpers, so it is exactly what Draw makes.
function makeDrawBody(): unknown {
  const size = DRAW_SIZES.find((s) => s.w >= 1000) ?? DRAW_SIZES[0]
  const body = blankDrawBody(size) as unknown as { layers: Array<{ objects: unknown[] }>; width: number; height: number }
  const layer = vectorLayer('Mark') as unknown as { objects: unknown[] }
  const cx = body.width / 2
  const cy = body.height / 2
  const add = (id: string, kind: 'rect' | 'roundRect' | 'ellipse' | 'star' | 'polygon', box: { x: number; y: number; w: number; h: number }, color: string, opts: Record<string, number> = {}) =>
    layer.objects.push({ id, type: 'path', path: shapePath(kind, box, opts), fill: solid(color), shapeKind: kind, ...opts })
  add('bg', 'roundRect', { x: cx - 260, y: cy - 260, w: 520, h: 520 }, '#ede9fe', { cornerRadius: 96 })
  add('leaf1', 'ellipse', { x: cx - 170, y: cy - 190, w: 200, h: 300 }, '#7c3aed')
  add('leaf2', 'ellipse', { x: cx - 30, y: cy - 150, w: 200, h: 300 }, '#a78bfa')
  add('dot', 'ellipse', { x: cx - 50, y: cy + 110, w: 100, h: 100 }, '#4c1d95')
  add('spark', 'star', { x: cx + 120, y: cy - 230, w: 90, h: 90 }, '#f59e0b', { sides: 5, innerRatio: 0.45 })
  body.layers = [layer as never]
  return body
}
