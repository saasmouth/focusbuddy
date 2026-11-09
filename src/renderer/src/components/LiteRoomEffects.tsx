import { useEffect, useRef, useState } from 'react'
import { useAccountStore } from '../stores/account'
import { countDesks, useNodeStore } from '../stores/nodes'
import { useViewStore } from '../stores/view'
import { useNoticeStore } from '../stores/notice'
import { useDeskViewStore } from '../stores/deskView'
import { useCapabilityStore } from '../stores/capabilities'
import { promptUpgrade } from '../stores/upgradePrompt'
import { canCreateMore, limitFor } from '../lib/gating'
import { crdtEmitNodeCreate, crdtEmitWidgetCreate } from '../lib/crdtBridge'
import { nudgeSync } from '../lib/syncNudge'
import { currentDeviceClass } from '../lib/deviceClass'

// "Open This Room in Plexii", the window's end (main/liteRoomReceiver.ts;
// shared/liteRoom.ts has the contract with PlexiiLite).
//
// A plexii://lite-room?id=<id> link names a room PlexiiLite described. Main
// keeps the id until someone is signed in -- the account comes first, as for a
// desk handed over by a share page (DeskHandoffEffects) -- and then, once, this
// asks main to begin: main reads the room and ASKS the person itself (a native
// sheet), then brings it in on yes. What comes back is a new desk: told to the
// sync engine as every create from this window is, its Workcentre kept with this
// person's layout, opened, and summed up in a notice.
//
// Mounted once in App. Renders nothing. Not in the browser runtime, which has no
// PlexiiLite to hand anything over.
type Pending = { id: string; at: number }

const isWebRuntime = (): boolean => Boolean((globalThis as { __PLEXII_WEB__?: boolean }).__PLEXII_WEB__)

export default function LiteRoomEffects(): null {
  const account = useAccountStore((s) => s.account)
  const [pending, setPending] = useState<Pending | null>(null)
  // One at a time, and not again for the same link in the same session unless it arrives again.
  const busy = useRef(false)
  const tried = useRef<string | null>(null)

  useEffect(() => {
    const api = window.api?.liteRoom
    if (isWebRuntime() || !api) return
    void api
      .pending()
      .then((p) => {
        if (p) setPending(p)
      })
      .catch(() => {})
    return api.onIncoming((p) => {
      tried.current = null
      setPending({ ...p })
    })
  }, [])

  useEffect(() => {
    const api = window.api?.liteRoom
    if (!api || !pending || !account?.id) return
    if (busy.current || tried.current === `${pending.id}:${pending.at}`) return
    busy.current = true
    tried.current = `${pending.id}:${pending.at}`
    const notice = useNoticeStore.getState()
    void (async () => {
      try {
        // The free plan's desk limit holds here as for any new desk (stores/nodes.ts create):
        // nothing is asked or copied when the desk could not be made.
        const caps = useCapabilityStore.getState().capabilities
        if (!canCreateMore(caps, 'multiple_desks', countDesks(useNodeStore.getState().nodes))) {
          await api.clear(pending.id)
          setPending(null)
          promptUpgrade(`You've reached your ${limitFor(caps, 'multiple_desks')}-desk limit on the Free plan. Upgrade for unlimited desks, then send the room again from PlexiiLite.`, 'pro')
          return
        }
        const result = await api.begin(pending.id)
        setPending(null)
        if (!result.ok) {
          if (result.stop !== 'busy' && result.message) notice.show({ text: result.message, icon: result.stop === 'declined' ? 'info' : 'error' }, 9000)
          return
        }
        // Every create from this window tells the sync engine; these were made in main.
        crdtEmitNodeCreate(result.node)
        for (const w of result.widgets) crdtEmitWidgetCreate(w)
        nudgeSync()
        const deskId = result.node.id
        if (result.workcentre) {
          await window.api.deskLayout
            .saveWorkcentre(useAccountStore.getState().account?.id ?? 'local', deskId, currentDeviceClass(), result.workcentre)
            .catch(() => undefined)
        }
        if (result.view !== 'canvas') useDeskViewStore.getState().set(deskId, result.view)
        await useNodeStore.getState().refresh()
        useNodeStore.getState().setActive(deskId)
        useViewStore.getState().goTask(deskId)
        notice.show({ text: result.summary, icon: 'check_circle' }, 12000)
      } catch (err) {
        notice.show({ text: `The room from PlexiiLite could not be brought in: ${(err as Error).message}.`, icon: 'error' }, 12000)
      } finally {
        busy.current = false
      }
    })()
  }, [pending, account?.id])

  return null
}
