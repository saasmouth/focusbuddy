// The local-AI utility process. Electron forks this (engineHost.ts) the first
// time an on-device request arrives and kills it after a few idle minutes, so:
//   - nothing about the model touches app start-up;
//   - a crash or out-of-memory inside llama.cpp takes down this process, not
//     PlexiiDesk — the host reports it and the next request starts a fresh one;
//   - unloading returns ALL of the model's memory (including GPU buffers) to
//     the system, which freeing objects inside a long-lived process does not
//     reliably do.
//
// Protocol: see WorkerRequest / WorkerReply below. One generation runs at a
// time (EngineCore queues), streamed back as 'text' messages.

import { EngineCore, EmbedCore, type EngineGenerateRequest, type EmbedKind } from './engineCore'

export type WorkerRequest =
  | { id: number; type: 'load'; modelPath: string; contextSize: number; gpu?: 'auto' | false; kvCache?: 'f16' | 'q8_0' }
  | { id: number; type: 'generate'; req: EngineGenerateRequest }
  | { id: number; type: 'abort'; target: number }
  | { id: number; type: 'embed'; modelPath: string; texts: string[]; kind: EmbedKind }
  | { id: number; type: 'unload' }

export type WorkerReply =
  | { id: number; type: 'text'; delta: string }
  | { id: number; type: 'done'; ok: true; value: unknown }
  | { id: number; type: 'done'; ok: false; error: string }

interface ParentPort {
  on(event: 'message', fn: (e: { data: WorkerRequest }) => void): void
  postMessage(msg: WorkerReply): void
}

const port = (process as unknown as { parentPort?: ParentPort }).parentPort
const engine = new EngineCore()
const embedder = new EmbedCore()
const aborts = new Map<number, AbortController>()

function reply(msg: WorkerReply): void {
  port?.postMessage(msg)
}

async function handle(m: WorkerRequest): Promise<void> {
  try {
    switch (m.type) {
      case 'load': {
        const st = await engine.load({ modelPath: m.modelPath, contextSize: m.contextSize, gpu: m.gpu, kvCache: m.kvCache })
        reply({ id: m.id, type: 'done', ok: true, value: st })
        return
      }
      case 'generate': {
        const ctrl = new AbortController()
        aborts.set(m.id, ctrl)
        try {
          const r = await engine.generate(m.req, {
            signal: ctrl.signal,
            onText: (delta) => reply({ id: m.id, type: 'text', delta })
          })
          reply({ id: m.id, type: 'done', ok: true, value: r })
        } finally {
          aborts.delete(m.id)
        }
        return
      }
      case 'abort': {
        aborts.get(m.target)?.abort()
        reply({ id: m.id, type: 'done', ok: true, value: null })
        return
      }
      case 'embed': {
        await embedder.load(m.modelPath)
        const vectors = await embedder.embed(m.texts, m.kind)
        reply({ id: m.id, type: 'done', ok: true, value: vectors })
        return
      }
      case 'unload': {
        await engine.unload()
        await embedder.unload()
        reply({ id: m.id, type: 'done', ok: true, value: null })
        return
      }
    }
  } catch (e) {
    reply({ id: m.id, type: 'done', ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}

port?.on('message', (e) => {
  void handle(e.data)
})
