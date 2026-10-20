// Main-process side of the local-AI utility process (localWorker.ts).
//
// Lifecycle, as the product promises it:
//   - lazy: no process exists until the first on-device request;
//   - load once: the model loads on that first request and stays loaded while
//     it is being used;
//   - unload on idle: after IDLE_MS with nothing running, the process is
//     killed and every byte of the model's memory goes back to the system;
//   - cancel: aborting a request stops generation in the worker;
//   - honest crashes: if the process dies mid-request, that request fails with
//     a plain message, and the next request starts a fresh process.
//
// Electron is injected (fork) so the lifecycle is unit-testable.

import type { EngineGenerateRequest, EngineGenerateResult, EngineStatus, LocalEngine, EmbedKind } from './engineCore'
import type { WorkerReply, WorkerRequest } from './localWorker'

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never

export interface WorkerHandle {
  postMessage(msg: WorkerRequest): void
  on(event: 'message', fn: (msg: WorkerReply) => void): void
  on(event: 'exit', fn: (code: number) => void): void
  kill(): boolean
}

export interface EngineHostDeps {
  fork: () => WorkerHandle
  /** Kill the worker after this long with nothing running. */
  idleMs: number
  log?: (msg: string) => void
  /** Hears every state change, and how many requests are waiting on a load. */
  onState?: (s: { state: HostState; waiting: number; lastLoadMs: number | null; error: string | null }) => void
}

export type HostState = 'idle' | 'loading' | 'ready' | 'error'

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  onText?: (d: string) => void
}

export class EngineHost implements LocalEngine {
  private worker: WorkerHandle | null = null
  private seq = 0
  private pending = new Map<number, Pending>()
  private loadedModel: { path: string; ctx: number } | null = null
  private loading: Promise<EngineStatus> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private active = 0
  private _state: HostState = 'idle'
  /** Requests waiting for the model to finish loading (a cold start in front of them). */
  private waiting = 0
  /** How long the last load took, ms. */
  lastLoadMs: number | null = null
  lastError: string | null = null
  get waitingCount(): number {
    return this.waiting
  }
  get state(): HostState {
    return this._state
  }
  set state(s: HostState) {
    this._state = s
    this.emit()
  }
  private emit(): void {
    this.deps.onState?.({ state: this._state, waiting: this.waiting, lastLoadMs: this.lastLoadMs, error: this.lastError })
  }
  gpu: string | false | null = null
  /** The model + context the next generate() must have loaded. */
  private want: { path: string; ctx: number; gpu?: 'auto' | false; kvCache?: 'f16' | 'q8_0' } | null = null

  constructor(private readonly deps: EngineHostDeps) {}

  /** Point the host at a model. Takes effect lazily on the next request. */
  setModel(path: string | null, contextSize: number, gpu?: 'auto' | false, kvCache?: 'f16' | 'q8_0'): void {
    this.want = path ? { path, ctx: contextSize, gpu, kvCache } : null
    if (!path) void this.stop()
  }

  running(): boolean {
    return this.worker !== null
  }

  private spawn(): WorkerHandle {
    const w = this.deps.fork()
    w.on('message', (msg: WorkerReply) => {
      const p = this.pending.get(msg.id)
      if (!p) return
      if (msg.type === 'text') {
        p.onText?.(msg.delta)
        return
      }
      this.pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.value)
      else p.reject(new Error(msg.error))
    })
    w.on('exit', (code: number) => {
      if (this.worker !== w) return
      this.worker = null
      this.loadedModel = null
      this.loading = null
      const failed = [...this.pending.values()]
      this.pending.clear()
      if (failed.length > 0) {
        this.state = 'error'
        this.lastError = `The on-device model stopped unexpectedly (exit code ${code}). This usually means it ran out of memory. Try again, or choose the smaller model in Settings → AI.`
        this.deps.log?.(`[local-ai] worker exited with ${code} during ${failed.length} request(s)`)
        for (const p of failed) p.reject(new Error(this.lastError))
      } else if (this.state !== 'error') {
        this.state = 'idle'
      }
    })
    this.worker = w
    return w
  }

  private call<T>(msg: WithoutId<WorkerRequest>, onText?: (d: string) => void): { id: number; done: Promise<T> } {
    const w = this.worker ?? this.spawn()
    const id = ++this.seq
    const done = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onText })
    })
    w.postMessage({ ...msg, id } as WorkerRequest)
    return { id, done }
  }

  private async ensureLoaded(): Promise<void> {
    const want = this.want
    if (!want) throw new Error('No on-device model is selected.')
    if (this.loadedModel && this.loadedModel.path === want.path && this.loadedModel.ctx === want.ctx) return
    if (!this.loading) {
      this.state = 'loading'
      this.loading = this.call<EngineStatus>({ type: 'load', modelPath: want.path, contextSize: want.ctx, gpu: want.gpu, kvCache: want.kvCache }).done
        .then((st) => {
          this.loadedModel = { path: want.path, ctx: want.ctx }
          this.lastError = null
          this.gpu = st.gpu
          this.lastLoadMs = st.loadMs
          this.state = 'ready'
          const b = st.loadBreakdownMs
          this.deps.log?.(
            `[local-ai] model loaded in ${st.loadMs} ms (gpu=${String(st.gpu)}, ctx=${st.contextSize}` +
              (b ? `; runtime ${b.runtime} ms, model ${b.model} ms, context ${b.context} ms, grammars ${b.grammars} ms)` : ')')
          )
          return st
        })
        .catch((e: Error) => {
          this.lastError = `The on-device model could not be loaded: ${e.message}`
          this.state = 'error'
          throw new Error(this.lastError)
        })
        .finally(() => {
          this.loading = null
        })
    }
    await this.loading
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (this.active > 0) return
    this.idleTimer = setTimeout(() => {
      if (this.active === 0) void this.stop()
    }, this.deps.idleMs)
    ;(this.idleTimer as { unref?: () => void }).unref?.()
  }

  async generate(
    req: EngineGenerateRequest,
    opts: { signal?: AbortSignal; onText?: (delta: string) => void } = {}
  ): Promise<EngineGenerateResult> {
    this.active++
    if (this.idleTimer) clearTimeout(this.idleTimer)
    try {
      if (this.state === 'loading' || !this.loadedModel) {
        this.waiting++
        this.emit()
        try {
          await this.ensureLoaded()
        } finally {
          this.waiting--
          this.emit()
        }
      } else await this.ensureLoaded()
      const { id, done } = this.call<EngineGenerateResult>({ type: 'generate', req }, opts.onText)
      const onAbort = (): void => {
        if (this.worker) this.worker.postMessage({ id: ++this.seq, type: 'abort', target: id })
      }
      if (opts.signal?.aborted) onAbort()
      else opts.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        return await done
      } finally {
        opts.signal?.removeEventListener('abort', onAbort)
      }
    } finally {
      this.active--
      this.touch()
    }
  }

  /**
   * Load the model now, ahead of the first request (the background preload at
   * launch). Nothing waits on it; the idle timer applies as after any request.
   */
  async preload(): Promise<number | null> {
    this.active++
    try {
      await this.ensureLoaded()
      return this.lastLoadMs
    } finally {
      this.active--
      this.touch()
    }
  }

  async embed(modelPath: string, texts: string[], kind: EmbedKind): Promise<number[][]> {
    this.active++
    if (this.idleTimer) clearTimeout(this.idleTimer)
    try {
      return await this.call<number[][]>({ type: 'embed', modelPath, texts, kind }).done
    } finally {
      this.active--
      this.touch()
    }
  }

  /** Kill the worker now (idle, model deleted, provider switched, app quit). */
  async stop(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const w = this.worker
    if (!w) return
    this.worker = null
    this.loadedModel = null
    this.loading = null
    for (const p of this.pending.values()) p.reject(new Error('The on-device model was unloaded.'))
    this.pending.clear()
    if (this.state !== 'error') this.state = 'idle'
    w.kill()
    this.deps.log?.('[local-ai] worker stopped')
  }
}
