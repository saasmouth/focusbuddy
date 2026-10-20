// The workspace every eval task runs against, seeded through the app's own
// database functions (src/main/db/*) into an in-memory SQLite that has the
// desktop schema and migrations applied. Fixed ids so tasks can check that a
// proposal names the RIGHT desk, table or row, not just any id.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const DESK = 'desk-launch'
export const DESK_HOME = 'desk-home'
export const TABLE = 'tbl-launch'
export const ROWS = {
  press: 'row-press',
  demo: 'row-demo',
  stripe: 'row-stripe',
  podcast: 'row-podcast'
} as const
export const COLS = { task: 'c-task', owner: 'c-owner', status: 'c-status', due: 'c-due' } as const
export const DOCS = {
  board: 'doc-board',
  contract: 'doc-contract',
  hiring: 'doc-hiring',
  untitledA: 'doc-untitled-a',
  untitledB: 'doc-untitled-b'
} as const

const here = __dirname
export const LONG = {
  mailTriage: readFileSync(join(here, 'fixtures', 'MAIL-TRIAGE.md'), 'utf8'),
  performance: readFileSync(join(here, 'fixtures', 'PERFORMANCE-ANALYSIS.md'), 'utf8'),
  desktopVsCloud: readFileSync(join(here, 'fixtures', 'DESKTOP-VS-CLOUD.md'), 'utf8'),
  browserAdr: readFileSync(join(here, 'fixtures', 'BROWSER-ADR-001-in-canvas-browser.md'), 'utf8')
}

function tiptap(paragraphs: Array<string | { h: string }>): { type: 'doc'; content: unknown[] } {
  return {
    type: 'doc',
    content: paragraphs.map((p) =>
      typeof p === 'string'
        ? { type: 'paragraph', content: [{ type: 'text', text: p }] }
        : { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: p.h }] }
    )
  }
}

export const BOARD_TEXT = [
  { h: 'Q3 board update — Plexii Pulse' },
  'Revenue for Q3 was $412,000, up 18% on Q2. Net revenue retention was 104%.',
  'We ended the quarter with 1,240 paying teams. Churn was 2.1% per month, down from 2.9%.',
  'Cash in the bank on 30 September 2026 was $3.8 million, which is 22 months of runway at current burn.',
  { h: 'Decisions requested' },
  'The board is asked to approve hiring two engineers in Q4 and a budget of $60,000 for the November launch.',
  'Marta Kowalski will present the security audit results at the December meeting.'
]

export const CONTRACT_TEXT = [
  { h: 'Supplier agreement — Northwind Traders' },
  'This agreement between Plexii Pty Ltd and Northwind Traders starts on 1 August 2026 and runs for 24 months.',
  'Northwind supplies printed launch kits at $14.50 per kit, minimum order 500 kits per quarter.',
  'Payment terms are net 45 days. Late payments attract interest of 1.5% per month.',
  'Either party may terminate with 90 days written notice. Northwind must give 30 days notice of any price change.',
  'The account manager at Northwind is Daniel Osei (daniel.osei@northwind.example).'
]

export const HIRING_TEXT = [
  { h: 'Hiring plan Q4' },
  'We will hire a senior backend engineer (salary band $150k-$170k) and a product designer ($120k-$135k).',
  'Interviews run in three stages: a 30 minute screen, a take-home task, and a panel with Priya and Sam.',
  'Target start dates are 12 January 2027 for the engineer and 2 February 2027 for the designer.'
]

/** Seed the in-memory workspace. Imports the db modules lazily so mocks apply first. */
export async function seedWorkspace(): Promise<void> {
  const { createNode } = await import('../../src/main/db/nodes')
  const { createWidget } = await import('../../src/main/db/widgets')
  const { createTable, createRow } = await import('../../src/main/db/tables')
  const { createDocument } = await import('../../src/main/db/documents')

  createNode({
    id: DESK,
    parentId: null,
    kind: 'task',
    title: 'Plexii Pulse launch',
    description: 'Ship Plexii Pulse publicly and get the first 200 paying teams.'
  })
  createNode({ id: DESK_HOME, parentId: null, kind: 'task', title: 'Home renovation' })

  createWidget({
    taskId: DESK,
    kind: 'sticky',
    title: 'Launch date',
    content: 'Launch date moved to 14 November 2026 because the payments review slipped. Owner: Priya.'
  })
  createWidget({
    taskId: DESK,
    kind: 'note',
    title: 'Pricing',
    content: 'Pricing decided: Starter $9/month, Team $29/month per seat. Annual plans get a 20% discount.'
  })
  createWidget({
    taskId: DESK,
    kind: 'markdown',
    title: 'Risks',
    content:
      '## Risks\n- App Store review can take up to 5 days\n- Stripe tax setup is not done\n- Only 2 of 6 beta testers have sent feedback'
  })
  createTable({
    id: TABLE,
    taskId: DESK,
    title: 'Launch tasks',
    schema: {
      columns: [
        { id: COLS.task, type: 'text-short', label: 'Task', config: {} },
        { id: COLS.owner, type: 'text-short', label: 'Owner', config: {} },
        {
          id: COLS.status,
          type: 'single-select',
          label: 'Status',
          config: {
            options: [
              { id: 'o-todo', label: 'Todo', color: '#ef4444' },
              { id: 'o-doing', label: 'Doing', color: '#f97316' },
              { id: 'o-done', label: 'Done', color: '#22c55e' }
            ]
          }
        },
        { id: COLS.due, type: 'date', label: 'Due', config: {} }
      ]
    } as never
  })
  const row = (id: string, task: string, owner: string, status: string, due: string): void => {
    createRow({ id, tableId: TABLE, cells: { [COLS.task]: task, [COLS.owner]: owner, [COLS.status]: status, [COLS.due]: due } })
  }
  row(ROWS.press, 'Write press release', 'Sam', 'o-doing', '2026-11-07')
  row(ROWS.demo, 'Record demo video', 'Priya', 'o-todo', '2026-11-05')
  row(ROWS.stripe, 'Set up Stripe tax', 'Alex', 'o-todo', '2026-11-03')
  row(ROWS.podcast, 'Book podcast slots', 'Sam', 'o-done', '2026-10-30')
  createWidget({ taskId: DESK, kind: 'table', title: 'Launch tasks', content: TABLE })

  createWidget({
    taskId: DESK_HOME,
    kind: 'sticky',
    title: 'Kitchen',
    content: 'Kitchen budget: $18,500 cap. Contractor is Delgado Builders. Work starts 3 March.'
  })

  createDocument({ id: DOCS.board, docType: 'doc', title: 'Q3 board update', body: tiptap(BOARD_TEXT) })
  createDocument({ id: DOCS.contract, docType: 'doc', title: 'Northwind supplier agreement', body: tiptap(CONTRACT_TEXT) })
  createDocument({ id: DOCS.hiring, docType: 'doc', title: 'Hiring plan Q4', body: tiptap(HIRING_TEXT) })
}

export function plainText(parts: Array<string | { h: string }>): string {
  return parts.map((p) => (typeof p === 'string' ? p : p.h)).join('\n')
}
