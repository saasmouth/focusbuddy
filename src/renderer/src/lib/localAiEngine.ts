// The on-device engine's live state, for every surface that runs AI.
//
// Loading the model from cold takes seconds. While it does, a surface that
// would show "Generating…" says what is really happening instead
// (LOCAL_WARMING_COPY), so the wait reads as a one-time start-up, not a hang.
// One subscription for the whole renderer; components read it with a hook.
import { useSyncExternalStore } from 'react'
import { LOCAL_WARMING_COPY, type LocalEngineState } from '@shared/localAi'

let current: LocalEngineState = { state: 'idle', waiting: 0, lastLoadMs: null, error: null }
const listeners = new Set<() => void>()
let started = false

function start(): void {
  if (started) return
  started = true
  const api = (window as unknown as { api?: { localAi?: { getEngine?: () => Promise<LocalEngineState>; onEngine?: (cb: (s: LocalEngineState) => void) => () => void } } }).api?.localAi
  if (!api?.onEngine) return
  api.onEngine((s) => {
    current = s
    for (const l of listeners) l()
  })
  void api
    .getEngine?.()
    .then((s) => {
      current = { state: s.state, waiting: s.waiting, lastLoadMs: s.lastLoadMs, error: s.error }
      for (const l of listeners) l()
    })
    .catch(() => undefined)
}

function subscribe(fn: () => void): () => void {
  start()
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useLocalAiEngine(): LocalEngineState {
  return useSyncExternalStore(subscribe, () => current)
}

/** True while the on-device model is loading. */
export function useLocalAiWarming(): boolean {
  return useLocalAiEngine().state === 'loading'
}

/**
 * The label for a busy AI control: the control's own word ("Generating…")
 * normally, the start-up message while the model is loading.
 */
export function useAiBusyLabel(): (label: string) => string {
  const warming = useLocalAiWarming()
  return (label) => (warming ? LOCAL_WARMING_COPY : label)
}

export { LOCAL_WARMING_COPY }
