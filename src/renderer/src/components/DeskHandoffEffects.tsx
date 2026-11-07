import { useEffect, useRef, useState } from 'react'
import { useAccountStore } from '../stores/account'
import { useNodeStore } from '../stores/nodes'
import { useViewStore } from '../stores/view'
import { useNoticeStore } from '../stores/notice'
import { claimDeskHandoff } from '../lib/deskHandoffClient'

// "Download this desk on Plexii", the app end (shared/deskHandoff.ts).
//
// A plexii://desk?handoff=<id> link from a public share page names the
// visitor's copy of a desk. Main keeps the id (deskHandoffReceiver.ts) until
// someone is signed in -- the account comes first, always (LaunchSignInModal).
// Then, once: claim it with the session, import it under fresh ids, open it.
//
// Mounted once in App. Renders nothing. Not in the browser runtime, which has
// no visitors' desks to receive.
type Pending = { id: string; at: number }

const isWebRuntime = (): boolean => Boolean((globalThis as { __PLEXII_WEB__?: boolean }).__PLEXII_WEB__)

export default function DeskHandoffEffects(): null {
  const account = useAccountStore((s) => s.account)
  const token = useAccountStore((s) => s.sessionToken)
  const [pending, setPending] = useState<Pending | null>(null)
  // One attempt at a time, and not again for the same id in the same session
  // unless the link arrives again (a retry the person asked for).
  const busy = useRef(false)
  const tried = useRef<string | null>(null)

  useEffect(() => {
    const api = window.api?.deskHandoff
    if (isWebRuntime() || !api) return
    let detach: (() => void) | null = null
    void api
      .pending()
      .then((p) => {
        if (p) setPending(p)
      })
      .catch(() => {})
    detach = api.onIncoming((p) => {
      tried.current = null
      setPending({ ...p })
    })
    return () => detach?.()
  }, [])

  useEffect(() => {
    const api = window.api?.deskHandoff
    if (!api || !pending || !account?.id || !token) return
    if (busy.current || tried.current === `${pending.id}:${pending.at}`) return
    busy.current = true
    tried.current = `${pending.id}:${pending.at}`
    const notice = useNoticeStore.getState()
    void (async () => {
      try {
        const claim = await claimDeskHandoff(pending.id, token)
        if (!claim.ok) {
          if (claim.kind === 'gone') {
            await api.clear(pending.id)
            setPending(null)
            notice.show({ text: 'That shared desk has expired. Ask whoever sent it for a fresh link.', icon: 'info' }, 9000)
          } else if (claim.kind === 'elsewhere') {
            await api.clear(pending.id)
            setPending(null)
            notice.show({ text: 'That desk was already added to a different Plexii account.', icon: 'info' }, 9000)
          } else if (claim.kind === 'unavailable') {
            notice.show({ text: 'Your shared desk could not be fetched just now. Plexii will try again next time you open it.', icon: 'info' }, 9000)
          }
          // offline / unauthorized: kept, quietly; the next sign-in or launch retries.
          return
        }
        const result = await api.import(claim.bundle, account.id)
        if (!result.ok || !result.rootId) {
          notice.show({ text: `Your shared desk could not be added: ${result.reason ?? 'unknown error'}.`, icon: 'error' }, 12000)
          return
        }
        await api.clear(pending.id)
        setPending(null)
        await useNodeStore.getState().refresh()
        if (result.rootKind === 'folder') useViewStore.getState().goRoom(result.rootId)
        else {
          useNodeStore.getState().setActive(result.rootId)
          useViewStore.getState().goTask(result.rootId)
        }
        const title = result.title || claim.title || 'Your desk'
        const left = result.filesOmitted ? ` ${result.filesOmitted} large file${result.filesOmitted === 1 ? ' was' : 's were'} too big to bring along.` : ''
        notice.show({ text: `“${title}” is here, with everything you added.${left}`, icon: 'check_circle' }, 9000)
      } catch (err) {
        notice.show({ text: `Your shared desk could not be added: ${(err as Error).message}.`, icon: 'error' }, 12000)
      } finally {
        busy.current = false
      }
    })()
  }, [pending, account?.id, token])

  return null
}
