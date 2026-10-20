// A synchronous read of the work-items capability for call sites that cannot
// await (context-menu builders run during a click). Probed once at load and
// refreshed on the Settings toggle — the same pattern the mention picker uses.

import { useSyncExternalStore } from 'react'

let enabled = false
// Until the first probe answers, nothing is known: callers must not tell the
// person the feature is off (it reads false for a moment at boot).
let loaded = false
const listeners = new Set<() => void>()

function probe(): void {
  window.api?.workItems
    ?.enabled?.()
    .then((v: boolean) => {
      enabled = v
      loaded = true
      for (const l of listeners) l()
    })
    .catch(() => {})
}

probe()
window.addEventListener('fb:workitems-toggled', probe)

export function workItemsEnabled(): boolean {
  return enabled
}

/**
 * The capability for UI that offers to create work items: 'loading' until the
 * first probe answers (show nothing either way), then 'on' or 'off'. Entry
 * points show the "turn on Attention" state on 'off' before anyone tries; the
 * store's refusal translation stays as the safety net.
 */
export function useWorkItemsCapability(): 'loading' | 'on' | 'off' {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => (!loaded ? 'loading' : enabled ? 'on' : 'off')
  )
}
