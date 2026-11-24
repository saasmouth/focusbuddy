import { useCallback, useRef } from 'react'

// A streaming run reports progress every second or so, and every status change
// also arrives as an activity event. Refreshing once per signal would stack
// requests; this keeps at most one in flight and one queued behind it, so the
// last signal always gets a fresh read and none is lost.
export function useCoalescedRefresh(run: () => Promise<void>): () => void {
  const latest = useRef(run)
  latest.current = run
  const state = useRef({ inflight: false, again: false })
  return useCallback(() => {
    const s = state.current
    if (s.inflight) {
      s.again = true
      return
    }
    s.inflight = true
    void (async () => {
      try {
        do {
          s.again = false
          await latest.current()
        } while (s.again)
      } finally {
        s.inflight = false
      }
    })()
  }, [])
}
