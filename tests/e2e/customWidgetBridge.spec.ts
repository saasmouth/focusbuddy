import { test, expect } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { launchApp } from './_helpers'

// A generated widget can now READ what the user wired into it and ASK the host
// to do things. Both are additions to the bridge, not to the sandbox — ADR-0009's
// boundary is unchanged and the last assertion here exists to prove that, because
// "we widened the bridge, not the sandbox" is a claim and not a fact until the
// booted app says so.
//
// The rule that makes the feature safe is scope: a widget may only act on a
// source the user wired INTO it. That is asserted here against the real protocol
// handler and the real database, not against the policy function in isolation —
// the unit tests already cover the policy, and a correct policy wired to the
// wrong table id would still be a hole.

interface Seeded {
  widgetId: string
  wiredTableId: string
  otherTableId: string
}

function seed(userDataDir: string, code: string): Seeded {
  const db = new DatabaseSync(join(userDataDir, 'focusbuddy.db'))
  const now = Date.now()
  const deskId = randomUUID()
  const widgetId = randomUUID()
  const tableWidgetId = randomUUID()
  const wiredTableId = randomUUID()
  const otherTableId = randomUUID()

  db.exec('BEGIN')
  db.prepare(
    `INSERT INTO nodes (id,parent_id,kind,title,description,status,priority,interest,importance,
                        sort_order,created_at,updated_at,org_id)
     VALUES (?,NULL,'task','bridge-probe','','open',3,3,3,0,?,?,'personal')`
  ).run(deskId, now, now)

  const schema = JSON.stringify({
    columns: [
      { id: 'c-client', type: 'text-short', label: 'Client', config: {} },
      { id: 'c-hours', type: 'number', label: 'Hours', config: {} }
    ]
  })
  for (const [id, title] of [
    [wiredTableId, 'Retainers'],
    [otherTableId, 'Somewhere else']
  ] as const) {
    db.prepare(
      `INSERT INTO fb_tables (id,task_id,title,schema_json,created_at,updated_at,org_id)
       VALUES (?,?,?,?,?,?,'personal')`
    ).run(id, deskId, title, schema, now, now)
  }
  db.prepare(
    `INSERT INTO fb_rows (id,table_id,cells_json,sort_order,created_at,updated_at)
     VALUES (?,?,?,0,?,?)`
  ).run(randomUUID(), wiredTableId, JSON.stringify({ 'c-client': 'Acme', 'c-hours': 12 }), now, now)

  // The table widget (the source), and the custom widget (the target).
  db.prepare(
    `INSERT INTO widgets (id,task_id,kind,title,content,x,y,width,height,z_index,color,created_at,updated_at)
     VALUES (?,?,'table','Retainers',?,0,0,400,300,1,NULL,?,?)`
  ).run(tableWidgetId, deskId, wiredTableId, now, now)
  db.prepare(
    `INSERT INTO widgets (id,task_id,kind,title,content,x,y,width,height,z_index,color,created_at,updated_at)
     VALUES (?,?,'custom','Probe',?,0,0,400,300,1,NULL,?,?)`
  ).run(widgetId, deskId, JSON.stringify({ spec: 'probe', code, state: {}, net: false }), now, now)

  // The wire. This IS the grant.
  db.prepare(
    `INSERT INTO widget_links (id,source_widget_id,target_widget_id,task_id,created_at,type,verb,enabled)
     VALUES (?,?,?,?,?,'context','',1)`
  ).run(randomUUID(), tableWidgetId, widgetId, deskId, now)
  db.exec('COMMIT')
  db.close()
  return { widgetId, wiredTableId, otherTableId }
}

const PROBE = `<p>probe</p><script>
  var r = {};
  function t(n, f) { try { r[n] = 'REACHED:' + String(f()).slice(0, 40) } catch (e) { r[n] = 'BLOCKED:' + e.name } }
  // The wired-in sources, inlined by the host at compose time.
  try { r.inputs = JSON.stringify(window.plexi.getInputs()); } catch (e) { r.inputs = 'ERR:' + e.message }
  // The new surface must not have opened any old doors.
  t('parent.document', function () { return parent.document.body.innerHTML });
  t('parent.api', function () { return typeof parent.api });
  t('localStorage', function () { return localStorage.length });
  r.hasAct = typeof window.plexi.act;
  r.hasOnInput = typeof window.plexi.onInput;
  document.documentElement.setAttribute('data-probe', JSON.stringify(r));
  document.documentElement.setAttribute('data-ran', '1');
<\/script>`

async function mount(window: import('@playwright/test').Page, id: string): Promise<void> {
  const loaded = await window.evaluate(async (wid) => {
    const f = document.createElement('iframe')
    f.setAttribute('sandbox', 'allow-scripts')
    f.src = `fb-widget://${wid}/?v=probe&dark=0`
    f.style.cssText = 'position:fixed;bottom:0;right:0;width:400px;height:300px'
    document.body.appendChild(f)
    return await new Promise<boolean>((res) => {
      f.addEventListener('load', () => res(true))
      setTimeout(() => res(false), 10000)
    })
  }, id)
  expect(loaded, 'the fb-widget: document should load').toBe(true)
  await window.waitForTimeout(1200)
}

test('a widget reads the table wired into it, with real rows', async () => {
  const { window, userDataDir, dispose } = await launchApp()
  try {
    await window.waitForTimeout(4000)
    const { widgetId, wiredTableId } = seed(userDataDir, PROBE)
    await mount(window, widgetId)

    const frame = window.frames().find((fr) => fr.url().startsWith('fb-widget://'))
    expect(frame).toBeTruthy()
    expect(await frame!.evaluate(() => document.documentElement.getAttribute('data-ran'))).toBe('1')

    const probe = JSON.parse(
      (await frame!.evaluate(() => document.documentElement.getAttribute('data-probe'))) ?? '{}'
    ) as Record<string, string>

    const inputs = JSON.parse(probe.inputs) as Array<{
      kind: string
      title: string
      table?: { id: string; columns: Array<{ id: string }>; rows: Array<{ cells: Record<string, unknown> }> }
    }>
    expect(inputs).toHaveLength(1)
    expect(inputs[0].kind).toBe('table')
    // Structured, not flattened: this is what lets a widget total a column
    // rather than scrape a rendering of one.
    expect(inputs[0].table?.id).toBe(wiredTableId)
    expect(inputs[0].table?.columns.map((c) => c.id)).toContain('c-hours')
    expect(inputs[0].table?.rows[0].cells['c-client']).toBe('Acme')

    expect(probe.hasAct).toBe('function')
    expect(probe.hasOnInput).toBe('function')

    // ADR-0009 unchanged. The widened bridge must not have widened anything else.
    expect(probe['parent.document'], 'must still not read the app DOM').toMatch(/^BLOCKED/)
    expect(probe['parent.api'], 'must still not reach the preload bridge').toMatch(/^BLOCKED/)
    expect(probe['localStorage'], 'must still have no storage').toMatch(/^BLOCKED/)
  } finally {
    await dispose()
  }
})

test('a widget with no wires sees nothing', async () => {
  const { window, userDataDir, dispose } = await launchApp()
  try {
    await window.waitForTimeout(4000)
    // Same seed, then cut the wire: the grant is the line, so removing it
    // removes the access.
    const { widgetId } = seed(userDataDir, PROBE)
    const db = new DatabaseSync(join(userDataDir, 'focusbuddy.db'))
    db.prepare('DELETE FROM widget_links WHERE target_widget_id = ?').run(widgetId)
    db.close()

    await mount(window, widgetId)
    const frame = window.frames().find((fr) => fr.url().startsWith('fb-widget://'))
    const probe = JSON.parse(
      (await frame!.evaluate(() => document.documentElement.getAttribute('data-probe'))) ?? '{}'
    ) as Record<string, string>
    expect(JSON.parse(probe.inputs)).toEqual([])
  } finally {
    await dispose()
  }
})

test('the scope rule holds against the real database', async () => {
  const { window, userDataDir, dispose } = await launchApp()
  try {
    await window.waitForTimeout(4000)
    const { widgetId, wiredTableId, otherTableId } = seed(userDataDir, PROBE)

    // What the host would hand the policy for this widget.
    const scope = await window.evaluate(
      (id) =>
        (window as unknown as {
          api: { customWidgetInputs: { scope: (i: string) => Promise<{ tableIds: string[] }> } }
        }).api.customWidgetInputs.scope(id),
      widgetId
    )
    expect(scope.tableIds).toEqual([wiredTableId])
    // The table on the other side of the desk is NOT in scope — which is what
    // stops one consent from becoming consent to the whole workspace.
    expect(scope.tableIds).not.toContain(otherTableId)
  } finally {
    await dispose()
  }
})
