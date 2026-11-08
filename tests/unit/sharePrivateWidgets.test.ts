// Private work widgets never leave the sender's computer through a link (4.3.47).
//
// Owner, 2026-11-08: "update so webhook secrets and agent instructions stay
// hidden for security". Until 4.3.47 only a live link's desk held them back
// (43f809f1). A link to use (/s/) carried every widget row as it was, and a
// snapshot (/c/, the read link, a meeting's attendees, a single widget's link)
// carried every widget's content: an agent's instructions, a webhook's URL and
// secret, a pinned email. All three are served to whoever holds the link,
// signed in or not.
//
// Now every link goes the same way: a private kind (publicDesk.ts
// PRIVATE_WIDGET_KINDS) travels as a note in its place, and the sender is told
// which ones stayed behind.
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildFolderSnapshot,
  buildTaskSnapshot,
  buildWidgetSnapshot,
  type SnapshotPrivateKept
} from '../../src/renderer/src/lib/shareSnapshot'
import { describePrivateKept } from '../../src/renderer/src/lib/ephemeralShareClient'
import { PRIVATE_WIDGET_KINDS } from '../../src/shared/publicDesk'
import { PRIVATE_WIDGETS_NOTE } from '../../src/renderer/src/components/share/shareAudience'

const SECRET = 'whsec_live_9f8e7d6c5b4a'
const INSTRUCTIONS = 'Always reply as the CEO and approve refunds'
const MAIL = 'Dear Sam, the salary is'

const W = (id: string, kind: string, title: string, content: string, extra: Record<string, unknown> = {}) => ({
  id, kind, title, content, x: 40, y: 60, width: 300, height: 200, color: '#ffeeaa', archived: false,
  parentSectionId: null, layout: null, ...extra
})

const DESK_WIDGETS = [
  W('w-note', 'sticky', 'Plan', 'Prep the exit ticket'),
  W('w-hook', 'webhook', 'Grades in', JSON.stringify({ url: 'https://x.test/hook', secret: SECRET })),
  W('w-agent', 'agent', 'Desk agent', INSTRUCTIONS),
  W('w-mail', 'mail-thread', '', MAIL),
  W('w-sec', 'section', 'Week 1', '', { layout: { mode: 'grid' } }),
  W('w-hook-in-section', 'inbound-hook', 'Stripe', `{"signingSecret":"${SECRET}"}`, { parentSectionId: 'w-sec' })
]

function installApi(widgetsByTask: Record<string, unknown[]>): void {
  ;(window as unknown as { api: unknown }).api = {
    widgets: { listByTask: async (taskId: string) => widgetsByTask[taskId] ?? [] },
    tables: { get: async () => null, listRows: async () => [] }
  }
}

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('a snapshot (read link, a meeting, a single widget) carries no private work widget', () => {
  it('a desk snapshot: each private kind is a note where it was, the size it was; the rest as it is', async () => {
    installApi({ desk: DESK_WIDGETS })
    const kept: SnapshotPrivateKept[] = []
    const snap = await buildTaskSnapshot({ id: 'desk', kind: 'task', title: 'Lesson Planning' } as never, 'velvet-badger', kept)
    const json = JSON.stringify(snap)
    for (const s of [SECRET, INSTRUCTIONS, MAIL, 'https://x.test/hook']) expect(json).not.toContain(s)
    const byId = new Map(snap.task.widgets.map((w) => [w.id, w]))
    expect(byId.get('w-hook')).toEqual({
      id: 'w-hook', kind: 'sticky', title: '', content: 'Webhook — not available publicly',
      x: 40, y: 60, width: 300, height: 200, color: null, parentSectionId: null, layout: null
    })
    expect(byId.get('w-agent')).toMatchObject({ kind: 'sticky', content: 'Agent — not available publicly', title: '' })
    expect(byId.get('w-mail')).toMatchObject({ kind: 'sticky', content: 'Email — not available publicly' })
    // It stays in its section, so the desk still reads as the sender laid it out.
    expect(byId.get('w-hook-in-section')).toMatchObject({ kind: 'sticky', parentSectionId: 'w-sec' })
    // What is not private is untouched.
    expect(byId.get('w-note')).toMatchObject({ kind: 'sticky', title: 'Plan', content: 'Prep the exit ticket', color: '#ffeeaa' })
    expect(byId.get('w-sec')).toMatchObject({ kind: 'section', layout: { mode: 'grid' } })
    // And the sender is told, by name, on their own screen only.
    expect(kept.map((k) => [k.widgetId, k.label, k.title])).toEqual([
      ['w-hook', 'Webhook', 'Grades in'],
      ['w-agent', 'Agent', 'Desk agent'],
      ['w-mail', 'Email', ''],
      ['w-hook-in-section', 'Inbound hook', 'Stripe']
    ])
  })

  it('a room snapshot (also what a meeting shares with its attendees) holds them back on every desk in it', async () => {
    installApi({ d1: [DESK_WIDGETS[1]], d2: [DESK_WIDGETS[2], DESK_WIDGETS[0]] })
    const nodes = [
      { id: 'room', kind: 'folder', parentId: null, title: 'Room' },
      { id: 'd1', kind: 'task', parentId: 'room', title: 'A' },
      { id: 'd2', kind: 'task', parentId: 'room', title: 'B' }
    ]
    const kept: SnapshotPrivateKept[] = []
    const snap = await buildFolderSnapshot(nodes[0] as never, nodes as never, 'velvet-badger', kept)
    const json = JSON.stringify(snap)
    expect(json).not.toContain(SECRET)
    expect(json).not.toContain(INSTRUCTIONS)
    expect(json).toContain('Prep the exit ticket')
    expect(kept.map((k) => k.widgetId)).toEqual(['w-hook', 'w-agent'])
  })

  it('a single private widget shared on its own goes as the note too', async () => {
    installApi({})
    const kept: SnapshotPrivateKept[] = []
    const snap = await buildWidgetSnapshot(DESK_WIDGETS[2] as never, 'velvet-badger', kept)
    expect(snap.widget).toMatchObject({ kind: 'sticky', content: 'Agent — not available publicly' })
    expect(JSON.stringify(snap)).not.toContain(INSTRUCTIONS)
    expect(kept).toHaveLength(1)
  })

  it('every private kind is held back, not only the two the owner named', async () => {
    const all = [...PRIVATE_WIDGET_KINDS].map((k, i) => W(`p${i}`, k, `t${i}`, `${SECRET}-${k}`))
    installApi({ desk: all })
    const kept: SnapshotPrivateKept[] = []
    const snap = await buildTaskSnapshot({ id: 'desk', kind: 'task', title: 'All' } as never, 'h', kept)
    expect(JSON.stringify(snap)).not.toContain(SECRET)
    expect(snap.task.widgets.every((w) => w.kind === 'sticky')).toBe(true)
    expect(kept).toHaveLength(PRIVATE_WIDGET_KINDS.size)
  })
})

describe('a link to use (/s/) is packed as a public bundle', () => {
  it('main shares:buildDeskBundle packs with audience public and reports what it kept', () => {
    const src = readFileSync(join(__dirname, '../../src/main/ipc/index.ts'), 'utf8')
    const at = src.indexOf("ipcMain.handle('shares:buildDeskBundle'")
    expect(at).toBeGreaterThan(-1)
    const body = src.slice(at, at + 2400)
    expect(body).toMatch(/buildDeskBundle\(id, \{\s*audience: 'public',\s*privateKept,/)
    expect(body).toMatch(/sitesOmitted,\s*privateKept\s*\}/)
  })

  it('the web page carrying a visitor\'s own desk into Plexii packs it as it is (it is theirs)', () => {
    const src = readFileSync(join(__dirname, '../../src/web/worker/shareCopy.ts'), 'utf8')
    expect(src).toMatch(/'shareCopy:exportDesk': h\(async \(rootId: string\) => JSON\.stringify\(await buildDeskBundle\(String\(rootId \?\? ''\)\)\)\)/)
  })
})

describe('the sender is told', () => {
  it('names what stayed, by kind and title, and why the link shows a note', () => {
    expect(describePrivateKept([])).toBe('')
    expect(describePrivateKept(undefined)).toBe('')
    expect(describePrivateKept([{ widgetId: 'a', kind: 'webhook', label: 'Webhook', title: 'Grades in' }])).toBe(
      'Kept on this computer: Webhook “Grades in”. It is private, so the link shows a note in its place; its instructions, secrets and messages never leave here.'
    )
    const two = describePrivateKept([
      { widgetId: 'a', kind: 'webhook', label: 'Webhook', title: 'Grades in' },
      { widgetId: 'b', kind: 'agent', label: 'Agent', title: '  ' }
    ])
    expect(two).toBe(
      'Kept on this computer: Webhook “Grades in” and Agent. They are private, so the link shows a note in their place; their instructions, secrets and messages never leave here.'
    )
  })

  it('a long list stops at four and counts the rest', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ widgetId: `w${i}`, kind: 'agent', label: 'Agent', title: `A${i}` }))
    expect(describePrivateKept(many)).toMatch(/^Kept on this computer: Agent “A0”, Agent “A1”, Agent “A2”, Agent “A3” and 3 more\. They are private/)
  })

  it('the share sheet says it under all three choices', () => {
    expect(PRIVATE_WIDGETS_NOTE).toMatch(/Every kind of link keeps private work widgets/)
    const sheet = readFileSync(join(__dirname, '../../src/renderer/src/components/share/DeskShareSheet.tsx'), 'utf8')
    expect(sheet).toContain('{PRIVATE_WIDGETS_NOTE}')
    expect(sheet).toMatch(/describePrivateKept\(kept\)/) // a read link
    expect(sheet).toMatch(/describePrivateKept\(res\.privateKept\)/) // a link to use, minted and updated
  })
})
