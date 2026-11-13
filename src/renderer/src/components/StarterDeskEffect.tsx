import { useEffect, useState } from 'react'
import { useAccountStore } from '../stores/account'
import { useNodeStore } from '../stores/nodes'
import { useOnboarding } from '../stores/onboarding'
import { useSyncStatus } from '../stores/syncStatus'
import { useViewStore } from '../stores/view'
import { localOnlyMode } from '../lib/localOnlyMode'
import { previewSyncBlocked } from '../lib/previewGuard'

// Opens the ADHD Starter Desk for a brand-new install once we know the
// workspace is actually empty. Sync has to settle first: a second computer
// starts with an empty local database and then downloads the person's real
// desks, and those must not gain a starter desk on top.
//
// Renders nothing. Mounted once, next to the other growth effects.

const SYNC_FLAG = 'fb.workspace.sync'

function syncWillRun(token: string | null): boolean {
  if (!token) return false
  if (previewSyncBlocked()) return false
  if (localOnlyMode()) return false
  try {
    if (localStorage.getItem(SYNC_FLAG) === '0') return false
  } catch {
    /* unreadable store: sync's own default is on */
  }
  return true
}

export default function StarterDeskEffect(): null {
  const token = useAccountStore((s) => s.sessionToken)
  const sync = useSyncStatus((s) => s.state)
  const onboardingStatus = useOnboarding((s) => s.status)
  const willRun = syncWillRun(token)
  // Start unsettled so a signed-in install waits for the first sync cycle.
  // When sync will not run (local-only, signed out, sync turned off) the
  // effect below settles immediately.
  const [settled, setSettled] = useState(false)

  useEffect(() => {
    if (!willRun) {
      setSettled(true)
      return
    }
    if (sync === 'ok' || sync === 'offline' || sync === 'error') setSettled(true)
  }, [sync, willRun])

  useEffect(() => {
    const api = window.api.starterDesk
    if (!api?.consider) return
    let cancelled = false
    void (async () => {
      try {
        const result = await api.consider({ syncSettled: settled })
        if (cancelled || !result?.deskId) return
        // 'open' is "the starter is already there". Only jump to it while the
        // first-run tour is up, so a later launch does not pull someone off
        // whatever desk they were using.
        const show = result.action === 'provision' || (result.action === 'open' && onboardingStatus === 'active')
        if (!show) return
        await useNodeStore.getState().refresh()
        if (cancelled) return
        useNodeStore.getState().setActive(result.deskId)
        useViewStore.getState().goTask(result.deskId)
      } catch {
        /* a starter desk is a welcome, never a reason to break launch */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [settled, onboardingStatus])

  return null
}
