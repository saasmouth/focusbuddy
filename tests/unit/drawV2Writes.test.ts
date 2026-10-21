// v2 writes are on (4.3.39-local.8): what that means for a drawing.
//
//   - Opening a v1 drawing without editing it never rewrites it.
//   - The first edit saves it as v2 (minWriterVersion 2), with everything kept.
//   - A live session with someone whose build does not say it reads v2 keeps
//     the drawing v1 for that session; once they leave, the next edit is v2.
//   - A drawing that is already v2 stays v2 in any session.

import { describe, expect, it } from 'vitest'
import { DRAW_V2_WRITES } from '../../src/shared/draw/compat'
import { normalizeDrawBody } from '../../src/shared/draw'
import { DRAW_V2_AWARENESS_FIELD, liveRoomReadsDrawV2 } from '../../src/renderer/src/lib/drawLiveSchema'
import { blank, harness, rect, withOlderPeer } from './drawTools/harness'

type Stored = { schemaVersion: number; minWriterVersion?: number }
const last = (h: ReturnType<typeof harness>): Stored => h.emitted.at(-1) as Stored

describe('v2 writes on', () => {
  it('is the product default', () => {
    expect(DRAW_V2_WRITES).toBe(true)
  })

  it('opening a v1 drawing and looking around (select, tools, zoom, view keys) never rewrites it', () => {
    const h = harness(blank([rect('a', 10, 10, 40, 40), rect('b', 100, 10, 40, 40)]))
    h.ed.ctx.select(['a'])
    h.key('a', { meta: true })
    h.tool('ellipse')
    h.tool('select')
    h.key('=', { meta: true, code: 'Equal' })
    h.key('0', { meta: true, code: 'Digit0' })
    h.key('Escape')
    expect(h.emitted).toHaveLength(0)
  })

  it('the first edit saves it as v2 with minWriterVersion 2, and nothing it held is lost', () => {
    const before = blank([rect('a', 10, 10, 40, 40), rect('b', 100, 10, 40, 40)])
    const h = harness(before)
    h.tool('rect')
    h.drag([200, 200], [260, 260])
    const out = last(h)
    expect(out.schemaVersion).toBe(2)
    expect(out.minWriterVersion).toBe(2)
    const objects = (out as unknown as { layers: Array<{ objects?: Array<{ id: string; fill?: unknown }> }> }).layers.flatMap((l) => l.objects ?? [])
    expect(objects.map((o) => o.id).slice(0, 2)).toEqual(['a', 'b'])
    expect(objects).toHaveLength(3)
    // The first two are what the v1 drawing held, paint and all.
    const v1 = normalizeDrawBody(before)
    const v1Objects = v1.layers.flatMap((l) => (l.kind === 'vector' ? l.objects : []))
    expect(objects[0].fill).toEqual((v1Objects[0] as { fill: unknown }).fill)
  })

  it('in a live session with someone on an older version the drawing stays v1; once they leave the next edit is v2', () => {
    const h = withOlderPeer(harness(blank([rect('a', 10, 10, 40, 40)])))
    h.tool('rect')
    h.drag([100, 100], [150, 150])
    expect(last(h).schemaVersion).toBe(1)
    // They leave: DrawStudio turns v2 writes back on.
    h.ed.ctx.set({ v2Writes: true, v2Blocked: null })
    h.tool('rect')
    h.drag([200, 100], [250, 150])
    expect(last(h).schemaVersion).toBe(2)
  })

  it('a drawing that is already v2 stays v2 even in a v1-only live session', () => {
    const v2 = {
      schemaVersion: 2,
      minWriterVersion: 2,
      artboards: [{ id: 'ab1', name: 'Artboard 1', x: 0, y: 0, w: 400, h: 300, background: { type: 'solid', color: '#ffffff' } }],
      activeLayerId: 'L1',
      layers: [{ id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects: [] }],
      assets: {},
      swatches: [],
      guides: [],
      settings: {}
    }
    const h = withOlderPeer(harness(v2))
    h.tool('rect')
    h.drag([10, 10], [60, 60])
    expect(last(h).schemaVersion).toBe(2)
  })
})

describe('a live session reads v2 only when every client says so', () => {
  const states = (...xs: Array<[number, unknown]>): Map<number, unknown> => new Map(xs)
  it('alone, or with clients that all advertise it: yes', () => {
    expect(liveRoomReadsDrawV2(states([1, { [DRAW_V2_AWARENESS_FIELD]: true }]), 1)).toBe(true)
    expect(liveRoomReadsDrawV2(states([1, {}], [2, { account: 'b', [DRAW_V2_AWARENESS_FIELD]: true }]), 1)).toBe(true)
  })
  it('any client that does not say it (an older build), or says anything but true: no', () => {
    expect(liveRoomReadsDrawV2(states([1, { [DRAW_V2_AWARENESS_FIELD]: true }], [2, { account: 'b' }]), 1)).toBe(false)
    expect(liveRoomReadsDrawV2(states([1, {}], [2, { [DRAW_V2_AWARENESS_FIELD]: 'yes' }]), 1)).toBe(false)
    expect(liveRoomReadsDrawV2(states([1, {}], [2, null]), 1)).toBe(false)
  })
})
