import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// Whether the assistant can actually READ a widget, answered end-to-end.
//
// Thirteen widget kinds held real content that no AI surface could see: the
// extractor had no case for them, so they rendered to a bare "(kind)" label and
// were absent from the attachable set, which meant they never rode as context
// however plainly the user pointed at them. The unit tests pin the extractor;
// this pins the whole path — a real widget in the real store, assembled by the
// real attachment gathering the assistant uses.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

interface SeedWidget {
  kind: string
  title: string
  content: string
}

async function seedDesk(window: LaunchedApp['window'], widgets: SeedWidget[]): Promise<string> {
  return window.evaluate(async (ws) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'AI context desk' })
    let x = 80
    for (const w of ws) {
      await api.widgets.create({
        taskId: desk.id,
        kind: w.kind as never,
        title: w.title,
        content: w.content,
        x,
        y: 80,
        width: 300,
        height: 220,
        color: null
      })
      x += 40
    }
    return desk.id as string
  }, widgets)
}

// Open the seeded desk. The attachment gathering reads the RENDERER's widget
// store, which only holds the desk the app actually has open — seeding straight
// into the DB over IPC leaves that store empty, so this step is what makes the
// assembled context real rather than vacuous.
async function openDesk(window: LaunchedApp['window'], deskId: string): Promise<void> {
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, deskId)
  await window.waitForTimeout(600)
}

// Assemble the attachment set exactly as the assistant does.
async function attachmentsFor(
  window: LaunchedApp['window'],
  deskId: string
): Promise<Array<{ kind: string; title: string; text: string }>> {
  return window.evaluate(async (id) => {
    const gather = (window as unknown as { __fbCanvasContext?: (t: string | null) => Promise<any[]> })
      .__fbCanvasContext
    if (!gather) throw new Error('__fbCanvasContext handle missing')
    const out = await gather(id)
    return out.map((a) => ({ kind: String(a.kind ?? ''), title: String(a.title ?? ''), text: String(a.text ?? '') }))
  }, deskId)
}

// The label the assistant is given for each kind (canvasContent.labelForKind).
const LABEL: Record<string, string> = {
  'voice-recorder': 'voice note',
  'stat-card': 'stat card',
  metrics: 'metrics',
  'location-map': 'location map',
  note: 'note',
  draw: 'drawing'
}

const SEEDS: SeedWidget[] = [
  {
    kind: 'voice-recorder',
    title: 'Supplier call',
    content: JSON.stringify({ transcript: 'Chase the March invoice with Dolan Freight.', durationSec: 9 })
  },
  {
    kind: 'stat-card',
    title: 'Pipeline',
    content: JSON.stringify({ title: 'Pipeline', series: [{ label: 'Open deals', value: 17 }] })
  },
  {
    kind: 'metrics',
    title: 'September',
    content: JSON.stringify({ title: 'September', cells: [{ label: 'Signups', value: 240 }], source: 'Stripe' })
  },
  {
    kind: 'location-map',
    title: 'Studio',
    content: JSON.stringify({ query: 'adelaide studio', label: 'Adelaide SA 5000, Australia' })
  },
  { kind: 'note', title: 'Control note', content: 'A plain note that always rode as context.' }
]

test('widget kinds that were unreadable now ride as assistant context', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const deskId = await seedDesk(window, SEEDS)
  await openDesk(window, deskId)
  const attached = await attachmentsFor(window, deskId)
  const kinds = attached.map((a) => a.kind)

  // The control proves the harness itself works.
  expect(kinds).toContain('note')

  // Each kind must arrive under its OWN label. Before the labels existed they
  // all defaulted to "note", so the model was told a stat card was a note.
  for (const seed of SEEDS) {
    expect(kinds, `${seed.kind} should ride as context`).toContain(LABEL[seed.kind])
  }
  expect(attached.length).toBe(SEEDS.length)
})

test('the assistant receives the actual content, not a placeholder', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const deskId = await seedDesk(window, SEEDS)
  await openDesk(window, deskId)
  const attached = await attachmentsFor(window, deskId)
  const textFor = (kind: string): string => attached.find((a) => a.kind === LABEL[kind])?.text ?? ''

  // The transcript is the whole value of a voice note and it was invisible.
  expect(textFor('voice-recorder')).toContain('Chase the March invoice with Dolan Freight.')
  expect(textFor('stat-card')).toContain('Open deals: 17')
  expect(textFor('metrics')).toContain('Signups: 240')
  expect(textFor('location-map')).toContain('Adelaide SA 5000')

  // None may be a bare placeholder — canvasContent drops those entirely, so an
  // empty string here means the widget never rode at all.
  for (const seed of SEEDS) {
    expect(textFor(seed.kind), `${seed.kind} carried no text`).not.toBe('')
  }
})

test('a PlexiDraw artwork is readable through its document', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const deskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Drawing desk' })
    const doc = await api.documents.create({
      title: 'Poster',
      docType: 'draw',
      body: {
        schemaVersion: 1,
        width: 800,
        height: 600,
        background: { type: 'none' },
        layers: [
          {
            id: 'l1',
            name: 'Type',
            kind: 'vector',
            visible: true,
            locked: false,
            opacity: 1,
            blend: 'normal',
            objects: [{ id: 'o1', type: 'text', x: 10, y: 10, w: 400, text: 'Grand Opening', fontSize: 48 }]
          }
        ]
      }
    })
    await api.widgets.create({
      taskId: desk.id,
      kind: 'draw',
      title: 'Poster',
      content: doc.id,
      x: 80,
      y: 80,
      width: 320,
      height: 240,
      color: null
    })
    return desk.id as string
  })

  await openDesk(window, deskId)
  const attached = await attachmentsFor(window, deskId)
  const draw = attached.find((a) => a.kind === 'drawing')
  expect(draw, 'a draw widget should ride as context').toBeTruthy()
  expect(draw!.text).toContain('Grand Opening')
})
