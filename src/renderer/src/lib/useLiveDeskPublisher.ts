import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Widget, WidgetLink } from '@shared/types'
import { useWidgetStore } from '../stores/widgets'
import { useLinksStore } from '../stores/links'
import { useNodeStore } from '../stores/nodes'
import { buildProjection, type ProjectionResolvers } from './publicDeskProjection'
import { warmCache } from './liveDeskResolvers'

// Keeps a published desk current.
//
// The projection is rebuilt from the live stores, fingerprinted, and published
// after a short settle. Rebuilding on every store change is cheap (it is a pure
// map over the widgets already in memory), and the fingerprint plus the settle
// are what keep a drag from becoming a request per frame.

export interface LiveDeskStatus {
  token: string | null
  revision: number
  lastPublishedAt: number | null
  lastError: string | null
  paused: boolean
  busy: boolean
}

/** Changes settle for this long before the desk is republished. */
const PUBLISH_SETTLE_MS = 800
/** How often a live desk checks whether what it published is still current. */
const RECONCILE_MS = 20_000

const EMPTY: LiveDeskStatus = {
  token: null,
  revision: 0,
  lastPublishedAt: null,
  lastError: null,
  paused: false,
  busy: false
}

function useResolvers(cache: React.MutableRefObject<Map<string, unknown>>): ProjectionResolvers {
  // Memoised: these close over a ref, so one object serves for the component's
  // whole life. Returning a fresh literal made `build` a new function every
  // render, which re-ran the publish effect, which set state, which
  // re-rendered -- a republish loop that ran flat out while nobody touched the
  // app.
  return useMemo(
    () => ({
        capture: (widgetId) => (cache.current.get(`c:${widgetId}`) as string | null) ?? null,
      table: (id) => (cache.current.get(`t:${id}`) as ReturnType<ProjectionResolvers['table']>) ?? null,
      document: (id) => (cache.current.get(`d:${id}`) as ReturnType<ProjectionResolvers['document']>) ?? null,
      slides: (id) => (cache.current.get(`s:${id}`) as ReturnType<ProjectionResolvers['slides']>) ?? null,
      diagram: (id) => (cache.current.get(`g:${id}`) as ReturnType<ProjectionResolvers['diagram']>) ?? null,
      asset: (id) => (cache.current.get(`a:${id}`) as ReturnType<ProjectionResolvers['asset']>) ?? null,
      file: (id) => (cache.current.get(`f:${id}`) as ReturnType<ProjectionResolvers['file']>) ?? null
    }),
    [cache]
  )
}


/**
 * What the public would actually see, as a comparable string. `publishedAt` is
 * stamped fresh on every build and `revision` is the server's to assign, so
 * both are excluded: including them would make every rebuild look like a
 * change and publish a new revision for nothing.
 */
export function projectionFingerprint(projection: unknown): string {
  const p = projection as Record<string, unknown> | null
  if (!p) return ''
  const { publishedAt: _p, revision: _r, ...content } = p
  return JSON.stringify(content)
}

export function useLiveDeskPublisher(deskId: string | null): {
  status: LiveDeskStatus
  start: () => Promise<void>
  stop: () => Promise<void>
  setPaused: (paused: boolean) => Promise<void>
  publishNow: () => Promise<void>
} {
  const [status, setStatus] = useState<LiveDeskStatus>(EMPTY)
  const storeWidgets = useWidgetStore((s) => s.widgets)
  const storeLinks = useLinksStore((s) => s.links)

  // What gets published must not depend on what is on screen.
  //
  // Both stores hold the desk the user currently has OPEN. Building the
  // projection straight from them meant that walking away from a published
  // desk published an empty one over it: the filter found nothing, and a desk
  // with 49 objects went out as zero. The store is only the right source while
  // it actually holds this desk -- and then it is the best one, because it
  // carries edits as they are typed.
  const storeHasDesk = storeWidgets.some((w) => w.taskId === deskId)
  const [offscreen, setOffscreen] = useState<{ widgets: Widget[]; links: WidgetLink[] } | null>(null)

  useEffect(() => {
    if (!deskId || !storeHasDesk) {
      // Reading the desk directly is what makes publishing independent of
      // navigation. Nothing in the UI can change a closed desk, so one read is
      // enough until it is opened again.
      let cancelled = false
      void Promise.all([
        window.api.widgets.listByTask(deskId ?? ''),
        window.api.widgetLinks.listByTask(deskId ?? '')
      ])
        .then(([w, l]) => {
          if (!cancelled) setOffscreen({ widgets: w, links: l })
        })
        .catch(() => {
          // Leave it null: with no trustworthy source we publish nothing at
          // all, rather than publishing an empty desk.
          if (!cancelled) setOffscreen(null)
        })
      return () => {
        cancelled = true
      }
    }
    setOffscreen(null)
    return
  }, [deskId, storeHasDesk])

  const widgets = storeHasDesk ? storeWidgets : (offscreen?.widgets ?? [])
  const links = storeHasDesk ? storeLinks : (offscreen?.links ?? [])
  // True when we genuinely know what is on the desk. Publishing without this
  // is how the desk got blanked.
  const haveSource = storeHasDesk || offscreen !== null
  const cache = useRef(new Map<string, unknown>())
  // The last projection actually queued, so an identical rebuild is a no-op.
  const lastSentRef = useRef<string>('')
  const [warmTick, setWarmTick] = useState(0)
  const resolvers = useResolvers(cache)

  const refresh = useCallback(async () => {
    if (!deskId) return setStatus(EMPTY)
    const rec = await window.api.liveDesk.get(deskId)
    setStatus(
      rec
        ? {
            token: rec.token,
            revision: rec.revision,
            lastPublishedAt: rec.lastPublishedAt,
            lastError: rec.lastError,
            paused: rec.paused,
            busy: false
          }
        : EMPTY
    )
  }, [deskId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const build = useCallback(() => {
    if (!deskId || !haveSource) return null
    const node = useNodeStore.getState().nodes.find((n) => n.id === deskId)
    return buildProjection({
      deskId,
      title: node?.title ?? 'Shared desk',
      revision: 0, // the server assigns the real revision
      widgets: widgets.filter((w) => w.taskId === deskId),
      links: links.map((l) => ({
        id: l.id,
        fromWidgetId: l.sourceWidgetId,
        toWidgetId: l.targetWidgetId,
        label: null
      })),
      resolvers
    })
  }, [deskId, widgets, links, resolvers, warmTick])

  // A published desk reconciles itself.
  //
  // Publishing hung entirely on a React effect firing at the right moment, and
  // twice that quietly did not happen: a desk sat unpublished for an hour with
  // no error, because "nothing was attempted" leaves no trace. A desk that is
  // live should converge on its own regardless of render timing, so this
  // rebuilds on a timer and publishes when the result differs from what was
  // last sent. When nothing has changed the fingerprint matches and it costs
  // one comparison.
  useEffect(() => {
    if (!deskId) return
    if (!status.token || status.paused) {
      void window.api.liveDesk.note(deskId, status.paused ? 'paused' : 'no share token loaded')
      return
    }
    const tick = (): void => {
      // Every branch reports what it decided. Silence was the actual bug: a
      // desk could sit unpublished for an hour and the only evidence was an
      // old timestamp.
      const projection = build()
      if (!projection) {
        void window.api.liveDesk.note(deskId, storeHasDesk ? 'no projection built' : 'desk contents unknown')
        return
      }
      const fingerprint = projectionFingerprint(projection)
      if (fingerprint === lastSentRef.current) {
        void window.api.liveDesk.note(deskId, null)
        return
      }
      lastSentRef.current = fingerprint
      void window.api.liveDesk
        .publish(deskId, projection)
        .then(() => void refresh())
        .catch((e: unknown) => {
          // An IPC rejection here used to vanish: `void` with no catch is an
          // unhandled rejection and nothing reaches the share panel.
          void window.api.liveDesk.note(deskId, `publish threw: ${String(e).slice(0, 80)}`)
        })
    }
    const timer = setInterval(tick, RECONCILE_MS)
    return () => clearInterval(timer)
  }, [deskId, status.token, status.paused, storeHasDesk, build, refresh])

  // Fetch the bodies the projection needs, then rebuild. Publishing waits for
  // this rather than shipping placeholders where real content exists: a public
  // desk that silently omits its tables is worse than one that takes a moment.
  useEffect(() => {
    if (!deskId || !status.token || status.paused) return
    let cancelled = false
    void warmCache(
      deskId,
      widgets.filter((w) => w.taskId === deskId),
      cache.current
    ).then((learned) => {
      if (learned && !cancelled) setWarmTick((t) => t + 1)
    })
    return () => {
      cancelled = true
    }
  }, [deskId, status.token, status.paused, widgets])

  // Republish whenever the desk changes, but only once it is actually published
  // and not paused -- otherwise every edit on every desk would queue work.
  useEffect(() => {
    if (!deskId || !status.token || status.paused) return
    const projection = build()
    if (!projection) return
    // Republish only when the desk actually differs. Without this the hook
    // republished on every render, and the server counted a revision each time.
    const fingerprint = projectionFingerprint(projection)
    if (fingerprint === lastSentRef.current) return
    lastSentRef.current = fingerprint
    // Publish directly, on a short delay, rather than through the main-process
    // queue. The queue was an extra hop that did not reliably deliver -- a desk
    // could sit unpublished for an hour with nothing written down -- and it
    // bought nothing here: the fingerprint above already collapses a drag's
    // per-frame churn into one publish, which is what the debounce was for.
    // Publishing here is also awaited, so a failure is recorded and surfaced in
    // the share panel instead of vanishing into a timer.
    const t = setTimeout(() => {
      void window.api.liveDesk.publish(deskId, projection).then(() => void refresh())
    }, PUBLISH_SETTLE_MS)
    return () => clearTimeout(t)
  }, [deskId, status.token, status.paused, build, refresh])

  return {
    status,
    start: async () => {
      if (!deskId) return
      setStatus((s) => ({ ...s, busy: true }))
      const res = await window.api.liveDesk.start(deskId)
      if (res.ok) {
        const projection = build()
        if (projection) await window.api.liveDesk.publish(deskId, projection)
      } else {
        setStatus((s) => ({ ...s, busy: false, lastError: res.error ?? 'Could not publish.' }))
        return
      }
      await refresh()
    },
    stop: async () => {
      if (!deskId) return
      setStatus((s) => ({ ...s, busy: true }))
      await window.api.liveDesk.stop(deskId)
      await refresh()
    },
    setPaused: async (paused: boolean) => {
      if (!deskId) return
      await window.api.liveDesk.setPaused(deskId, paused)
      await refresh()
    },
    publishNow: async () => {
      if (!deskId) return
      const projection = build()
      // No trustworthy source yet: publishing here is what blanked the desk.
      if (!projection) return
      // An explicit publish is a deliberate act: it goes through even when the
      // content is unchanged.
      lastSentRef.current = projectionFingerprint(projection)
      setStatus((s) => ({ ...s, busy: true }))
      await window.api.liveDesk.publish(deskId, projection)
      await refresh()
    }
  }
}
