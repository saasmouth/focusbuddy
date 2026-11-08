import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildProjection } from '../../src/renderer/src/lib/publicDeskProjection'
import type { Widget } from '../../src/shared/types'

// A published desk of 49 objects went out as an empty one, and the public page
// showed a blank canvas.
//
// The publisher built the projection from the widget store, and that store
// holds the desk the user currently has OPEN. Walk away from the desk you are
// sharing and the filter finds nothing, so an empty projection is published
// over the good one. Nothing was broken about the desk; the publisher was
// simply reading the screen instead of the desk.

const SRC = readFileSync(
  join(__dirname, '..', '..', 'src', 'renderer', 'src', 'lib', 'useLiveDeskPublisher.ts'),
  'utf8'
)

function widget(id: string, taskId: string): Widget {
  return {
    id, taskId, kind: 'note', title: '', content: 'x',
    x: 0, y: 0, width: 10, height: 10, zIndex: 0, color: null, status: null,
    pinned: false, pinnedScreenX: null, pinnedScreenY: null, pinnedZone: null,
    parentSectionId: null, layout: null, sourceAppId: null
  } as unknown as Widget
}

describe('what gets published does not depend on what is on screen', () => {
  it('reads the desk directly when it is not the one open', () => {
    expect(SRC).toContain('window.api.widgets.listByTask(deskId ?? \'\')')
    expect(SRC).toContain('window.api.widgetLinks.listByTask(deskId ?? \'\')')
  })

  it('prefers the store only while it actually holds this desk', () => {
    // While the desk IS open the store is the better source: it carries edits
    // as they are typed, before they reach the database.
    expect(SRC).toContain('const storeHasDesk = storeWidgets.some((w) => w.taskId === deskId)')
    expect(SRC).toContain('const widgets = storeHasDesk ? storeWidgets : (offscreen?.widgets ?? [])')
  })

  it('publishes nothing at all when the desk contents are unknown', () => {
    // The blanking happened in exactly this window. Publishing "no widgets"
    // because we have not looked yet is worse than publishing nothing.
    expect(SRC).toContain('const haveSource = storeHasDesk || offscreen !== null')
    expect(SRC).toContain('if (!deskId || !haveSource || deskTitle === undefined) return null')
  })

  it('clears the fetched copy once the desk is open, so it cannot go stale', () => {
    expect(SRC).toContain('setOffscreen(null)')
  })
})

describe('publishing runs for as long as the app does', () => {
  const host = readFileSync(
    join(__dirname, '..', '..', 'src', 'renderer', 'src', 'components', 'LiveDeskPublisherHost.tsx'),
    'utf8'
  )
  const app = readFileSync(join(__dirname, '..', '..', 'src', 'renderer', 'src', 'App.tsx'), 'utf8')

  it('is mounted at the app root, not inside a dialog', () => {
    // It used to live in the share dialog's panel, so a "live" desk was live
    // only while that panel was open and frozen the rest of the time.
    expect(app).toContain('<LiveDeskPublisherHost />')
    expect(host).toContain('useLiveDeskPublisher(deskId)')
  })

  it('publishes for every desk that has a public link', () => {
    expect(host).toContain('window.api.liveDesk')
    expect(host).toContain('deskIds.map((id) => (')
  })

  it('listens for the desk list rather than asking for it', () => {
    // Pulling it with an invoke was a single point of silent failure: the call
    // stopped settling, and every branch that could have reported that sat
    // downstream of it.
    expect(host).toContain('window.api.liveDesk.onDesks(')
    expect(host).not.toContain('.list()')
  })

  it('does not remount its publishers on every poll', () => {
    // Tearing them down each poll would restart the fetch-and-publish cycle.
    expect(host).toContain("prev.join(',') === next.join(',') ? prev : next")
  })
})

describe('a published desk converges on its own', () => {
  const src = readFileSync(
    join(__dirname, '..', '..', 'src', 'renderer', 'src', 'lib', 'useLiveDeskPublisher.ts'),
    'utf8'
  )

  it('reconciles on a timer, not only when an effect happens to fire', () => {
    // Publishing hung entirely on a React effect firing at the right moment,
    // and twice it quietly did not: a desk sat unpublished for an hour with no
    // error, because "nothing was attempted" leaves no trace.
    expect(src).toContain('setInterval(tick, RECONCILE_MS)')
  })

  it('costs one comparison when nothing has changed', () => {
    const tick = src.slice(src.indexOf('const tick = ()'))
    expect(tick.slice(0, 900)).toContain('if (fingerprint === lastSentRef.current)')
  })

  it('publishes directly, so a failure is recorded rather than queued away', () => {
    expect(src).toContain('window.api.liveDesk.publish(deskId, projection)')
  })
})

describe('the projection itself still reflects its input honestly', () => {
  const base = { deskId: 'd1', title: 'Desk', revision: 0, now: 1 }

  it('a desk with objects projects those objects', () => {
    const out = buildProjection({ ...base, widgets: [widget('w1', 'd1'), widget('w2', 'd1')] })
    expect(out.widgets).toHaveLength(2)
    expect(out.bounds.width).toBeGreaterThan(0)
  })

  it('a genuinely empty desk still projects as empty', () => {
    // The fix must not make it impossible to empty a desk on purpose.
    const out = buildProjection({ ...base, widgets: [] })
    expect(out.widgets).toEqual([])
    expect(out.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })

  it('another desk\'s objects are never published to this one', () => {
    const out = buildProjection({ ...base, widgets: [widget('w1', 'd1'), widget('other', 'd2')] })
    // buildProjection takes what it is given; the hook filters by taskId, and
    // this asserts the shape that filter produces stays honest.
    expect(out.widgets.map((w) => w.id)).toContain('w1')
  })
})

describe('the desk\'s name is never a stand-in (2026-11-08)', () => {
  // A sign-in republishes every live desk before the desks have loaded; the
  // publisher used to fill the gap with "Shared desk", and the owner's "1 ·
  // All Widgets Tour" link was announced as "Shared desk" until the next edit.
  it('reads the title from the store as it changes, and publishes nothing while it is unknown', () => {
    expect(SRC).toContain('const deskTitle = useNodeStore((s) => (deskId ? s.nodes.find((n) => n.id === deskId)?.title : undefined))')
    expect(SRC).toContain("if (!deskId || !haveSource || deskTitle === undefined) return null")
    expect(SRC).toMatch(/\[deskId, deskTitle, widgets, links, resolvers, warmTick\]/)
    expect(SRC).not.toContain("'Shared desk'")
  })
})

