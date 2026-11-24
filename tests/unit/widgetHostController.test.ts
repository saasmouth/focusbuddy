// @vitest-environment node
// The widget host's life: ready -> load -> shown -> saves -> flush (F2).
//
// PlexiiLite sends one file's text; the host imports it with Plexii's own
// importer, shows it, and hands the text back only when the person changed
// something. These tests drive the controller with fakes for the embedder (the
// preload relay), the Worker transport, the view (React) and the input guard,
// so each rule is pinned on its own.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { startWidgetHost } from '../../src/web/widgetHost/controller'
import { observeTransport } from '../../src/web/widgetHost/hostTransport'
import { EMBEDDER_TYPES, type HostMessage, type EmbedderMessage } from '../../src/web/widgetHost/protocol'

const sticky = (content = 'milk'): string =>
  JSON.stringify({ type: 'plexii.widget.sticky', version: 1, title: 'Shopping', kind: 'sticky', content, color: null, exportedAt: '2026-11-20T00:00:00.000Z' }, null, 2)
const docText = JSON.stringify({ type: 'plexii.document.doc', version: 1, title: 'Letter', docType: 'doc', body: { type: 'doc', content: [] }, exportedAt: '' })

function setup(opts: { readOnlyFromUrl?: boolean; importResult?: unknown; importThrows?: string; exportFails?: string; createResult?: unknown } = {}) {
  const posted: HostMessage[] = []
  let deliver: (m: EmbedderMessage) => void = () => {}
  const embedder = { post: (m: HostMessage) => void posted.push(m), listen: (cb: (m: EmbedderMessage) => void) => { deliver = cb; return () => {} } }
  let current = sticky()
  const calls: Array<{ channel: string; args: unknown[] }> = []
  let pushCb: (e: string) => void = () => {}
  const raw = {
    call: vi.fn(async (channel: string, args: unknown[]) => {
      calls.push({ channel, args })
      // A write lands when it lands: the text changes only once it has.
      if (channel === 'widgetFiles:update' && typeof args[2] === 'string') {
        if (Number(args[3] ?? 0) > 0) await new Promise((r) => setTimeout(r, Number(args[3])))
        current = args[2]
        return { ok: true }
      }
      if (channel === 'widgetFiles:import') {
        if (opts.importThrows) throw new Error(opts.importThrows)
        return opts.importResult ?? { ok: true, kind: 'widget', file: { id: 'f1', kind: 'sticky', title: 'Shopping' } }
      }
      if (channel === 'widgetFiles:exportText') return opts.exportFails ? { ok: false, error: opts.exportFails } : { ok: true, name: 'Shopping.plexii-sticky', text: current }
      return { ok: true }
    }),
    subscribe: () => () => {},
    onPush: (cb: (e: string) => void) => { pushCb = cb; return () => {} },
    unserved: () => []
  }
  const transport = observeTransport(raw)
  const view = { show: vi.fn(), showProblem: vi.fn() }
  let guardOpts: { readOnly: boolean; onTouch: () => void } | null = null
  const guard = vi.fn((o: { readOnly: boolean; onTouch: () => void }) => { guardOpts = o; return () => {} })
  const flushDocuments = vi.fn()
  const create = vi.fn(async (kind: string) => opts.createResult ?? { ok: true, text: `{"type":"plexii.widget.${kind}","kind":"${kind}"}` })
  startWidgetHost({ embedder, transport, view, readOnlyFromUrl: opts.readOnlyFromUrl ?? false, guard, flushDocuments, create, debounceMs: 300 })
  return {
    posted, calls, view, guard, flushDocuments, transport, create,
    load: (text: string, readOnly = false) => deliver({ type: EMBEDDER_TYPES.load, text, readOnly }),
    make: (kind: string) => deliver({ type: EMBEDDER_TYPES.create, kind }),
    flush: () => deliver({ type: EMBEDDER_TYPES.flush }),
    touch: () => guardOpts!.onTouch(),
    edit: async (next: string, landsAfterMs = 0) => { await transport.call('widgetFiles:update', ['f1', { content: 'x' }, next, landsAfterMs]) },
    push: (e: string) => pushCb(e),
    types: () => posted.map((m) => m.type.replace('plexii-widget-host:', ''))
  }
}

const settle = async (ms = 0): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); for (let i = 0; i < 5; i++) await Promise.resolve() }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('ready and load', () => {
  it('says ready first, with the protocol, before anything is loaded', () => {
    const h = setup()
    expect(h.posted).toEqual([{ type: 'plexii-widget-host:ready', protocol: 1 }])
  })

  it('imports the text with Plexii\'s importer, shows the widget, then says loaded', async () => {
    const h = setup()
    h.load(sticky())
    await settle()
    expect(h.calls[0]).toEqual({ channel: 'widgetFiles:import', args: [{ text: sticky() }] })
    expect(h.view.show).toHaveBeenCalledWith({ family: 'widget', kind: 'sticky', fileId: 'f1', documentId: null, title: 'Shopping', readOnly: false })
    expect(h.posted.at(-1)).toEqual({ type: 'plexii-widget-host:loaded', protocol: 1, family: 'widget', kind: 'sticky', title: 'Shopping', readOnly: false })
  })

  it('an Office document shows by its document id', async () => {
    const h = setup({ importResult: { ok: true, kind: 'document', document: { id: 'd1', docType: 'doc', title: 'Letter' } } })
    h.load(docText)
    await settle()
    expect(h.view.show).toHaveBeenCalledWith({ family: 'document', kind: 'doc', fileId: null, documentId: 'd1', title: 'Letter', readOnly: false })
  })

  it('a second load while the first is still importing is refused too', async () => {
    const h = setup()
    h.load(sticky())
    h.load(sticky('other'))
    await settle()
    expect(h.calls.filter((c) => c.channel === 'widgetFiles:import')).toHaveLength(1)
    expect(h.posted.some((m) => m.type === 'plexii-widget-host:error' && (m as { code?: string }).code === 'already-loaded')).toBe(true)
  })

  it('a second load is refused: one file per page', async () => {
    const h = setup()
    h.load(sticky())
    await settle()
    h.load(sticky('other'))
    await settle()
    expect(h.calls.filter((c) => c.channel === 'widgetFiles:import')).toHaveLength(1)
    expect(h.posted.at(-1)).toMatchObject({ type: 'plexii-widget-host:error', code: 'already-loaded' })
  })
})

describe('a file the host cannot show gets an honest state', () => {
  const cases: Array<[string, string, Record<string, unknown>, string]> = [
    ['not a Plexii file', 'hello', {}, 'not-a-plexii-file'],
    ['a kind that needs Plexii', JSON.stringify({ type: 'plexii.widget.voice-note', kind: 'voice-recorder', version: 1 }), {}, 'needs-plexii'],
    ['a newer Plexii\'s kind', JSON.stringify({ type: 'plexii.widget.hologram', kind: 'hologram', version: 1 }), {}, 'newer-than-host'],
    ['an import that refuses', sticky(), { importResult: { ok: false, error: 'This file is damaged' } }, 'import-failed'],
    ['a database that would not open', sticky(), { importThrows: 'workspace database unavailable: no wasm' }, 'database-unavailable']
  ]
  for (const [name, text, opts, code] of cases) {
    it(name, async () => {
      const h = setup(opts as never)
      h.load(text)
      await settle()
      const err = h.posted.find((m) => m.type === 'plexii-widget-host:error') as Extract<HostMessage, { code: string }>
      expect(err.code).toBe(code)
      expect(h.view.showProblem).toHaveBeenCalledWith(err.message)
      expect(h.view.show).not.toHaveBeenCalled()
      if (code !== 'import-failed' && code !== 'database-unavailable') expect(h.calls).toHaveLength(0)
    })
  }

  it('the refusal says the importer\'s own reason', async () => {
    const h = setup({ importResult: { ok: false, error: 'This file is damaged.' } })
    h.load(sticky())
    await settle()
    expect(h.posted.at(-1)).toMatchObject({ code: 'import-failed', message: "Plexii couldn't open this file: This file is damaged." })
  })
})

describe('saving', () => {
  it('opening a file never writes it, even when the widget writes on mount', async () => {
    const h = setup()
    h.load(sticky())
    await settle()
    await h.edit(sticky('milk\n'))   // a tidy-up nobody asked for
    await settle(1000)
    expect(h.types()).not.toContain('save')
  })

  it('after the person does something, a changed file is posted once, debounced', async () => {
    const h = setup()
    h.load(sticky())
    await settle()
    h.touch()
    await h.edit(sticky('milk, eggs'))
    await settle(100)
    await h.edit(sticky('milk, eggs, bread'))
    await settle(100)
    expect(h.types()).not.toContain('save')
    await settle(400)
    const saves = h.posted.filter((m) => m.type === 'plexii-widget-host:save')
    expect(saves).toEqual([{ type: 'plexii-widget-host:save', protocol: 1, text: sticky('milk, eggs, bread') }])
  })

  it('a change pushed by the data layer (a table row, a document body) is noticed too', async () => {
    const h = setup()
    h.load(sticky())
    await settle()
    h.touch()
    h.calls.length = 0
    h.push('tables:rowsChanged')
    await settle(400)
    expect(h.calls.map((c) => c.channel)).toEqual(['widgetFiles:exportText'])
  })

  it('an export that fails says so; it is never silent', async () => {
    const h = setup({ exportFails: 'That widget file no longer exists.' })
    h.load(sticky())
    await settle()
    h.touch()
    await h.edit(sticky('milk, eggs'))
    await settle(400)
    expect(h.posted.at(-1)).toMatchObject({ code: 'save-failed', message: "Plexii couldn't save the last change: That widget file no longer exists." })
  })

  it('read-only (from the page address or the load) never saves, and the guard refuses input', async () => {
    for (const how of ['url', 'message'] as const) {
      const h = setup({ readOnlyFromUrl: how === 'url' })
      h.load(sticky(), how === 'message')
      await settle()
      expect(h.guard).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }))
      expect(h.posted.find((m) => m.type === 'plexii-widget-host:loaded')).toMatchObject({ readOnly: true })
      h.touch()
      await h.edit(sticky('changed'))
      await settle(1000)
      h.flush()
      await settle(1000)
      expect(h.types()).not.toContain('save')
      expect(h.types()).toContain('flushed')
    }
  })
})

describe('create (a new file, made by Plexii\'s own code)', () => {
  it('answers with the new file as a save, at once: asking for it is the person\'s action', async () => {
    const h = setup()
    h.make('sticky')
    await settle()
    expect(h.create).toHaveBeenCalledWith('sticky')
    expect(h.posted.at(-1)).toEqual({ type: 'plexii-widget-host:save', protocol: 1, text: '{"type":"plexii.widget.sticky","kind":"sticky"}' })
  })

  it('every kind the host shows can be made, documents too; it needs no load', async () => {
    const h = setup()
    for (const kind of ['table', 'task-list', 'doc', 'draw']) h.make(kind)
    await settle()
    expect(h.create.mock.calls.map((c) => c[0])).toEqual(['table', 'task-list', 'doc', 'draw'])
    expect(h.types().filter((t) => t === 'save')).toHaveLength(4)
  })

  it('a kind it cannot make is refused, named, and the page is not replaced by the refusal', async () => {
    const h = setup()
    h.make('voice-recorder')
    h.make('hologram')
    await settle()
    expect(h.create).not.toHaveBeenCalled()
    expect(h.posted.filter((m) => m.type === 'plexii-widget-host:error')).toEqual([
      { type: 'plexii-widget-host:error', protocol: 1, code: 'cannot-create', message: "Plexii can't make a Voice note here." },
      { type: 'plexii-widget-host:error', protocol: 1, code: 'cannot-create', message: "Plexii can't make a hologram here." }
    ])
    expect(h.view.showProblem).not.toHaveBeenCalled()
  })

  it('a create that fails says why, and posts no save', async () => {
    const h = setup({ createResult: { ok: false, error: 'the table could not be made' } })
    h.make('table')
    await settle()
    expect(h.types()).not.toContain('save')
    expect(h.posted.at(-1)).toMatchObject({ code: 'cannot-create', message: "Plexii can't make a Table here: the table could not be made." })
  })
})

describe('flush', () => {
  // A widget debounces its write and starts it only when its timer fires (a
  // sticky 600 ms after the last key, an Office document 500). Flush must wait
  // for that write, never remount to force it: several kinds clear a pending
  // save when they unmount, so a remount would drop the very edit.
  it('waits for the write the last edit left pending, posts the save, then flushed', async () => {
    const h = setup()
    h.load(sticky())
    await settle()
    h.touch()
    setTimeout(() => void h.edit(sticky('typed just now'), 50), 600)
    h.flush()
    await settle(500)
    expect(h.types()).not.toContain('flushed')
    await settle(2000)
    expect(h.flushDocuments).toHaveBeenCalledTimes(1)
    expect(h.types().slice(-2)).toEqual(['save', 'flushed'])
    expect(h.posted.at(-2)).toMatchObject({ text: sticky('typed just now') })
  })

  it('never remounts the widget to force its writes', () => {
    expect('remount' in setup().view).toBe(false)
  })

  it('nothing done since the last flush: no wait, flushed straight away', async () => {
    const h = setup()
    h.load(sticky())
    await settle()
    h.flush()
    await settle(20)
    expect(h.types().slice(-1)).toEqual(['flushed'])
    h.touch()
    h.flush()
    await settle(20)
    expect(h.types().filter((t) => t === 'flushed')).toHaveLength(1)
    await settle(1000)
    expect(h.types().filter((t) => t === 'flushed')).toHaveLength(2)
    h.flush()
    await settle(20)
    expect(h.types().filter((t) => t === 'flushed')).toHaveLength(3)
  })

  it('with nothing changed, only flushed', async () => {
    const h = setup()
    h.load(sticky())
    await settle()
    h.flush()
    await settle(1000)
    expect(h.types().slice(-1)).toEqual(['flushed'])
    expect(h.types()).not.toContain('save')
  })

  it('before anything was loaded, flushed straight away', async () => {
    const h = setup()
    h.flush()
    await settle()
    expect(h.types()).toEqual(['ready', 'flushed'])
  })
})
