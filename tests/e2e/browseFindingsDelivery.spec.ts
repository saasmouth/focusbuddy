import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// The original complaint, pinned: a browsing run gathered ten businesses and
// the table the user asked for stayed empty. The run's findings had nowhere to
// go — the envelope carried only a narration string.
//
// This drives the delivery path with REAL code end to end: the real run store,
// the real action executor, the real tables store and the real widget store.
// Only the model call itself is stubbed, because it is the one step that needs
// an API key. Everything the proposals touch is genuine, so a table that shows
// up here is a table that would show up for a user.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

const FINDINGS = {
  fields: ['name', 'specialty', 'rating', 'website'],
  records: [
    { name: 'Studio Nine', specialty: 'commercial', rating: '4.9', website: 'https://studionine.test' },
    { name: 'Pixel Perfect', specialty: 'architecture', rating: '4.7', website: 'https://pixelperfect.test' }
  ],
  answer: ''
}

test('the proposals a run’s findings produce build the table and fill it', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const deskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Photographer search' })
    return desk.id as string
  })

  // The proposals below are exactly the shape planFindingsDelivery returns for
  // these findings. The model call that produces them needs an API key and is
  // out of reach here; everything AFTER it is the real executor, real tables
  // store and real widget store.
  const applied = await window.evaluate(
    async ({ id, findings }) => {
      const w = window as unknown as { __fbApplyProposal?: (p: unknown, c: unknown) => Promise<{ ok: boolean; message: string }> }
      if (!w.__fbApplyProposal) throw new Error('__fbApplyProposal handle missing')
      const proposals: Array<Record<string, unknown>> = [
        {
          id: 'tbl-1',
          kind: 'create-table',
          title: 'Adelaide photographers',
          columns: findings.fields.map((f: string) => ({ label: f, type: 'text-short' }))
        },
        ...findings.records.map((r: Record<string, string>, i: number) => ({
          id: `row-${i}`,
          kind: 'add-table-row',
          tableId: '$tbl-1',
          cells: r
        }))
      ]
      const resolvedIds = new Map<string, string>()
      const results: Array<{ ok: boolean; message: string }> = []
      for (const p of proposals) {
        results.push(await w.__fbApplyProposal!(p, { activeTaskId: id, resolvedIds }))
      }
      return results
    },
    { id: deskId, findings: FINDINGS }
  )

  for (const r of applied) expect(r.ok, r.message).toBe(true)

  // The table must actually exist on the desk, with the real rows in it.
  const table = await window.evaluate(async (id) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const widgets = await api.widgets.listByTask(id)
    const w = widgets.find((x: { kind: string }) => x.kind === 'table')
    if (!w) return null
    const t = await api.tables.get(w.content)
    const rows = await api.tables.listRows(w.content)
    return {
      title: w.title as string,
      columns: t.schema.columns.map((c: { label: string }) => c.label),
      rows: rows.map((r: { cells: Record<string, unknown> }) => Object.values(r.cells).map(String))
    }
  }, deskId)

  expect(table, 'no table widget was created on the desk').not.toBeNull()
  expect(table!.columns).toEqual(FINDINGS.fields)
  expect(table!.rows).toHaveLength(FINDINGS.records.length)
  const flat = JSON.stringify(table!.rows)
  expect(flat).toContain('Studio Nine')
  expect(flat).toContain('https://pixelperfect.test')
})

// The no-fakery half: with no API key the delivery must fail out loud and
// leave NOTHING behind. A half-built or invented table would be worse than the
// original bug, because it would look like it worked.
test('with no API key, delivery fails honestly and builds nothing', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const deskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Keyless desk' })
    return desk.id as string
  })
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, deskId)
  await window.waitForTimeout(500)

  const delivery = await window.evaluate(async (findings) => {
    const w = window as unknown as { __fbBrowserAgent?: { getState: () => any; setState: (p: any) => void } }
    const store = w.__fbBrowserAgent
    if (!store) throw new Error('__fbBrowserAgent handle missing')
    const runId = 'keyless-run'
    store.setState({
      runs: {
        [runId]: {
          runId,
          task: 'Find photographers so they can go in a table',
          outcome: 'done',
          summary: 'Done.',
          pendingConsentHost: null,
          events: [],
          cost: null,
          findings,
          delivery: { state: 'idle', message: '' }
        }
      }
    })
    await store.getState().deliver(runId)
    return store.getState().runs[runId].delivery
  }, FINDINGS)

  expect(delivery.state).toBe('error')
  expect(delivery.message).toMatch(/api key/i)

  const widgets = await window.evaluate(async (id) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    return (await api.widgets.listByTask(id)).map((w: { kind: string }) => w.kind)
  }, deskId)
  expect(widgets, 'a failed delivery must not leave a table behind').not.toContain('table')
})

test('a run that found nothing offers no delivery rather than an empty table', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const state = await window.evaluate(async () => {
    const w = window as unknown as { __fbBrowserAgent?: { getState: () => any; setState: (p: any) => void } }
    const store = w.__fbBrowserAgent
    if (!store) throw new Error('__fbBrowserAgent handle missing')
    const runId = 'empty-run'
    store.setState({
      runs: {
        [runId]: {
          runId,
          task: 'Find something',
          outcome: 'done',
          summary: 'Nothing found.',
          pendingConsentHost: null,
          events: [],
          cost: null,
          findings: null,
          delivery: { state: 'idle', message: '' }
        }
      }
    })
    await store.getState().deliver(runId)
    return store.getState().runs[runId].delivery.state
  })

  // No findings means nothing to place — and crucially no fabricated table.
  expect(state).toBe('idle')
})
