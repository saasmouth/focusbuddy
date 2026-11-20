// The widget host's life: ready -> load -> shown -> saves -> flush.
//
// Kept apart from React so each rule can be tested with fakes
// (tests/unit/widgetHostController.test.ts): the embedder is PlexiiLite's
// preload relay, the transport is this page's private Worker, the view mounts
// the widget, and the guard watches (or, read-only, refuses) input.
import { classifyFileText } from './classify'
import { EMBEDDER_TYPES, HOST_TYPES, hostError, hostMessage, type HostErrorCode } from './protocol'
import { createSaveGate, type SaveGate } from './saveGate'
import type { Embedder } from './embedder'
import type { ObservedTransport } from './hostTransport'

/** What is on show: the file's family and kind, and the row it was imported into. */
export interface Shown {
  family: 'widget' | 'document'
  kind: string
  fileId: string | null
  documentId: string | null
  title: string
  readOnly: boolean
}

export interface HostView {
  /** Mount the widget (or document) that was imported. */
  show(shown: Shown): void
  /** Show a sentence in place of the widget: the honest state for a file that cannot be shown. */
  showProblem(message: string): void
}

export interface HostOptions {
  embedder: Embedder
  transport: ObservedTransport
  view: HostView
  /** ?readonly=1 on the page's address; a load can also ask, and either wins. */
  readOnlyFromUrl: boolean
  guard: (opts: { readOnly: boolean; onTouch: () => void }) => () => void
  /** Office editors debounce body writes; this writes them now (stores/documents). */
  flushDocuments: () => void
  debounceMs?: number
  /** How long a flush waits for writes in flight before exporting anyway. */
  settleTimeoutMs?: number
  /**
   * How long nothing must happen before a flush counts the page as settled.
   * Longer than any host kind's save debounce (sticky, note and markdown 600
   * ms; Office 500; the rest 400 or less), so a write the person's last edit
   * left pending fires and lands before the file is written out.
   */
  quietMs?: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function startWidgetHost(o: HostOptions): void {
  const debounceMs = o.debounceMs ?? 300
  const settleTimeoutMs = o.settleTimeoutMs ?? 3000
  const quietMs = o.quietMs ?? 750
  let loading = false
  let shown: Shown | null = null
  let gate: SaveGate | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let exporting: Promise<void> | null = null
  let lastSaveError: string | null = null
  // Something the person did since the last flush. Only an edit can leave a
  // widget holding a debounced write, so a flush without one need not wait.
  let touchedSinceFlush = false

  const fail = (code: HostErrorCode, info: { label?: string; detail?: string } = {}): void => {
    const msg = hostError(code, info)
    o.embedder.post(msg)
    if (msg.type === HOST_TYPES.error && code !== 'already-loaded' && code !== 'save-failed') o.view.showProblem(msg.message)
  }

  async function exportAndOffer(): Promise<void> {
    if (!shown || !gate || shown.readOnly) return
    const which = shown.family === 'widget' ? { fileId: shown.fileId } : { documentId: shown.documentId }
    let r: { ok?: boolean; text?: string; error?: string }
    try {
      r = (await o.transport.call('widgetFiles:exportText', [which])) as typeof r
    } catch (e) {
      r = { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    if (!r?.ok || typeof r.text !== 'string') {
      const why = r?.error ?? 'the file could not be written out'
      // Said once per distinct reason, so a broken save is never silent and never spams.
      if (why !== lastSaveError) fail('save-failed', { detail: why })
      lastSaveError = why
      return
    }
    lastSaveError = null
    if (gate.offer(r.text)) o.embedder.post(hostMessage({ type: HOST_TYPES.save, text: r.text }))
  }

  /** One export at a time; a request during one runs after it. */
  function runExport(): Promise<void> {
    const next = (exporting ?? Promise.resolve()).then(exportAndOffer)
    exporting = next.finally(() => {
      if (exporting === next) exporting = null
    })
    return next
  }

  function schedule(): void {
    if (!shown || shown.readOnly) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void runExport()
    }, debounceMs)
  }

  /**
   * Wait until the writes the person's last edit left pending have landed.
   * Widgets debounce their writes and some start them only when the timer
   * fires, so "nothing in flight right now" is not enough. The page is settled
   * when nothing is in flight AND nothing has started or finished for a quiet
   * window longer than any debounce; never longer than settleTimeoutMs.
   *
   * The widget is never remounted to force its writes: several kinds clear a
   * pending save when they unmount (Page, Card, Calculator, Colour, Shape,
   * Form block), so a remount would drop the very edit a flush is for.
   */
  async function settleWrites(): Promise<void> {
    const until = Date.now() + settleTimeoutMs
    const startedAt = Date.now()
    for (;;) {
      await sleep(10)
      if (Date.now() >= until) return
      const quietSince = Math.max(startedAt, o.transport.lastActivity())
      if (o.transport.inFlight() === 0 && Date.now() - quietSince >= quietMs) return
    }
  }

  async function flush(): Promise<void> {
    if (shown && !shown.readOnly) {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      o.flushDocuments()
      if (touchedSinceFlush) {
        touchedSinceFlush = false
        await settleWrites()
      }
      await runExport()
    }
    o.embedder.post(hostMessage({ type: HOST_TYPES.flushed }))
  }

  async function load(text: string, readOnlyAsked: boolean): Promise<void> {
    if (loading || shown) return fail('already-loaded')
    loading = true
    const readOnly = o.readOnlyFromUrl || readOnlyAsked
    const c = classifyFileText(text)
    if ('error' in c) return fail(c.error, { label: c.label })
    let r: { ok?: boolean; kind?: string; error?: string; file?: { id: string; title?: string }; document?: { id: string; title?: string } }
    try {
      r = (await o.transport.call('widgetFiles:import', [{ text }])) as typeof r
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      const db = /workspace database unavailable:\s*/.exec(why)
      return db ? fail('database-unavailable', { detail: why.slice(db.index + db[0].length) }) : fail('import-failed', { detail: why })
    }
    if (!r?.ok) return fail('import-failed', { detail: r?.error })
    const row = c.family === 'widget' ? r.file : r.document
    if (!row || r.kind !== c.family) return fail('import-failed', { detail: 'the importer read it as something else' })
    gate = createSaveGate(text, { readOnly })
    o.guard({
      readOnly,
      onTouch: () => {
        touchedSinceFlush = true
        gate?.touched()
      }
    })
    shown = {
      family: c.family,
      kind: c.kind,
      fileId: c.family === 'widget' ? row.id : null,
      documentId: c.family === 'document' ? row.id : null,
      title: row.title ?? '',
      readOnly
    }
    o.view.show(shown)
    o.embedder.post(hostMessage({ type: HOST_TYPES.loaded, family: shown.family, kind: shown.kind, title: shown.title, readOnly }))
  }

  o.transport.onWrite(schedule)
  o.transport.onPush(schedule)
  o.embedder.listen((msg) => {
    if (msg.type === EMBEDDER_TYPES.load) void load(msg.text, msg.readOnly)
    else if (msg.type === EMBEDDER_TYPES.flush) void flush()
  })
  o.embedder.post(hostMessage({ type: HOST_TYPES.ready }))
}
