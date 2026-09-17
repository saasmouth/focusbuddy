import { test, expect } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { launchApp } from './_helpers'

// The Custom widget executes code the model wrote seconds earlier, so the two
// claims underneath the whole feature have to be true in the REAL app, not in
// principle:
//
//   1. The generated code RUNS. The obvious implementation -- <iframe srcdoc> --
//      silently does not: about:srcdoc inherits the embedder's CSP, this
//      renderer runs under `script-src 'self'`, and the widget rendered its
//      markup with every line of its script refused. That is why the document is
//      served from its own `fb-widget:` scheme instead.
//
//   2. It STAYS contained. Running is only acceptable while the frame cannot
//      reach the app's DOM, its preload bridge, or any storage.
//
// Both were reasoned about and both were wrong at least once, so both are
// asserted here against a booted application rather than a mock.

const PROBE = `<p id="p">markup</p><script>
  var r = {};
  function t(n, f) { try { r[n] = 'REACHED:' + String(f()).slice(0, 30) } catch (e) { r[n] = 'BLOCKED:' + e.name } }
  t('parent.document', function () { return parent.document.body.innerHTML });
  t('parent.api', function () { return typeof parent.api });
  t('localStorage', function () { return localStorage.length });
  t('document.cookie', function () { return document.cookie });
  t('top.location', function () { return top.location.href });
  t('plexi.getState', function () { return JSON.stringify(window.plexi.getState()) });
  document.documentElement.setAttribute('data-probe', JSON.stringify(r));
  document.documentElement.setAttribute('data-ran', '1');
<\/script>`

function seedCustomWidget(userDataDir: string, code: string): string {
  const db = new DatabaseSync(join(userDataDir, 'focusbuddy.db'))
  const now = Date.now()
  const deskId = randomUUID()
  const widgetId = randomUUID()
  db.exec('BEGIN')
  db.prepare(
    `INSERT INTO nodes (id,parent_id,kind,title,description,status,priority,interest,importance,
                        sort_order,created_at,updated_at,org_id)
     VALUES (?,NULL,'task','custom-widget-probe','','open',3,3,3,0,?,?,'personal')`
  ).run(deskId, now, now)
  db.prepare(
    `INSERT INTO widgets (id,task_id,kind,title,content,x,y,width,height,z_index,color,created_at,updated_at)
     VALUES (?,?,'custom','Probe',?,0,0,400,300,1,NULL,?,?)`
  ).run(
    widgetId,
    deskId,
    JSON.stringify({ spec: 'probe', code, state: { hello: 'world' }, net: false }),
    now,
    now
  )
  db.exec('COMMIT')
  db.close()
  return widgetId
}

test('a generated widget runs its own code and cannot reach the app around it', async () => {
  const { window, userDataDir, dispose } = await launchApp()
  try {
    await window.waitForTimeout(4000)
    const widgetId = seedCustomWidget(userDataDir, PROBE)

    const loaded = await window.evaluate(async (id) => {
      const f = document.createElement('iframe')
      // Exactly what CustomWidget.tsx renders.
      f.setAttribute('sandbox', 'allow-scripts')
      f.src = `fb-widget://${id}/?v=probe&dark=0`
      f.style.cssText = 'position:fixed;bottom:0;right:0;width:400px;height:300px'
      document.body.appendChild(f)
      return await new Promise<boolean>((res) => {
        f.addEventListener('load', () => res(true))
        setTimeout(() => res(false), 10000)
      })
    }, widgetId)
    expect(loaded, 'the fb-widget: document should load into the frame').toBe(true)

    await window.waitForTimeout(1200)
    const frame = window.frames().find((fr) => fr.url().startsWith('fb-widget://'))
    expect(frame, 'a frame served from fb-widget: should exist').toBeTruthy()

    // 1. It runs. This is the assertion srcdoc failed.
    const ran = await frame!.evaluate(() => document.documentElement.getAttribute('data-ran'))
    expect(ran, 'the generated script must execute').toBe('1')

    const probe = JSON.parse(
      (await frame!.evaluate(() => document.documentElement.getAttribute('data-probe'))) ?? '{}'
    ) as Record<string, string>

    // 2. It stays contained.
    expect(probe['parent.document'], 'must not read the app DOM').toMatch(/^BLOCKED/)
    expect(probe['parent.api'], 'must not reach the preload bridge').toMatch(/^BLOCKED/)
    expect(probe['localStorage'], 'opaque origin means no storage').toMatch(/^BLOCKED/)
    expect(probe['document.cookie'], 'no cookies on an opaque origin').toMatch(/^BLOCKED/)
    expect(probe['top.location'], 'must not read the top frame location').toMatch(/^BLOCKED/)

    // 3. The bridge is present and carries the widget's saved state in.
    expect(probe['plexi.getState']).toContain('hello')
  } finally {
    await dispose()
  }
})

test('the scheme refuses to render a widget that is not a custom widget', async () => {
  const { window, userDataDir, dispose } = await launchApp()
  try {
    await window.waitForTimeout(4000)
    // A sticky whose "content" is markup. Serving this as a live document would
    // turn every note on the desk into an execution surface.
    const db = new DatabaseSync(join(userDataDir, 'focusbuddy.db'))
    const now = Date.now()
    const deskId = randomUUID()
    const stickyId = randomUUID()
    db.exec('BEGIN')
    db.prepare(
      `INSERT INTO nodes (id,parent_id,kind,title,description,status,priority,interest,importance,
                          sort_order,created_at,updated_at,org_id)
       VALUES (?,NULL,'task','probe2','','open',3,3,3,0,?,?,'personal')`
    ).run(deskId, now, now)
    db.prepare(
      `INSERT INTO widgets (id,task_id,kind,title,content,x,y,width,height,z_index,color,created_at,updated_at)
       VALUES (?,?,'sticky','Note',?,0,0,200,200,1,NULL,?,?)`
    ).run(stickyId, deskId, '<script>document.documentElement.setAttribute("data-ran","1")<\/script>', now, now)
    db.exec('COMMIT')
    db.close()

    const status = await window.evaluate(async (id) => {
      const f = document.createElement('iframe')
      f.setAttribute('sandbox', 'allow-scripts')
      f.src = `fb-widget://${id}/?v=x&dark=0`
      document.body.appendChild(f)
      await new Promise((res) => {
        f.addEventListener('load', () => res(null))
        setTimeout(() => res(null), 6000)
      })
      return 'settled'
    }, stickyId)
    expect(status).toBe('settled')

    const frame = window.frames().find((fr) => fr.url().includes(stickyId))
    if (frame) {
      const ran = await frame
        .evaluate(() => document.documentElement.getAttribute('data-ran'))
        .catch(() => null)
      expect(ran, "a sticky's content must never execute").not.toBe('1')
    }
  } finally {
    await dispose()
  }
})

test('a widget with network off cannot reach the network', async () => {
  // "Internet access: off" is a promise made in the UI and in the save dialog.
  // It is enforced by connect-src 'none' in the served policy, so it is worth
  // proving that a fetch from inside a generated widget actually fails rather
  // than trusting the header is present.
  const { window, userDataDir, dispose } = await launchApp()
  try {
    await window.waitForTimeout(4000)
    const code = `<p>x</p><script>
      fetch('https://example.com/')
        .then(function () { document.documentElement.setAttribute('data-net', 'REACHED') })
        .catch(function (e) { document.documentElement.setAttribute('data-net', 'BLOCKED:' + e.name) });
    <\/script>`
    const widgetId = seedCustomWidget(userDataDir, code)
    await window.evaluate(async (id) => {
      const f = document.createElement('iframe')
      f.setAttribute('sandbox', 'allow-scripts')
      f.src = `fb-widget://${id}/?v=net&dark=0`
      document.body.appendChild(f)
      await new Promise((res) => {
        f.addEventListener('load', () => res(null))
        setTimeout(() => res(null), 8000)
      })
    }, widgetId)
    await window.waitForTimeout(2500)
    const frame = window.frames().find((fr) => fr.url().startsWith('fb-widget://'))
    expect(frame).toBeTruthy()
    const net = await frame!.evaluate(() => document.documentElement.getAttribute('data-net'))
    expect(net, 'an offline widget must not be able to fetch').toMatch(/^BLOCKED/)
  } finally {
    await dispose()
  }
})
