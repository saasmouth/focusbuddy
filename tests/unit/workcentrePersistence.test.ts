// @vitest-environment node
// The Workcentre dashboard is stored beside the canvas overlay in desk_layouts
// (per user, Desk, device class; device-local). Two writers share the row, so
// each must keep the other's part: the canvas saves its whole overlay without a
// workcentre field on every camera move, and must never wipe a dashboard someone
// sized by hand; the Workcentre writes only its own field.

import { describe, expect, it } from 'vitest'
import { memSqlDb } from './_memdb'
import { createDeskLayoutStore } from '../../src/main/db/deskLayoutStore'
import type { DeskLayout, WorkcentreLayout } from '../../src/shared/deskLayout'

const AT = '2026-10-23T10:00:00.000Z'
const canvas = (over: Partial<DeskLayout> = {}): DeskLayout => ({
  userId: 'u1',
  deskId: 'd1',
  deviceClass: 'desktop',
  objects: [],
  scroll: { x: 10, y: 20 },
  selectedObjectIds: [],
  zoom: 1.5,
  ...over
})
const dash: WorkcentreLayout = { cols: 12, items: { w1: { x: 0, y: 0, w: 6, h: 8 }, w2: { x: 6, y: 0, w: 6, h: 4 } } }

describe('Workcentre persistence in desk_layouts', () => {
  it('saveWorkcentre on a Desk with no row creates a minimal one holding the dashboard', () => {
    const s = createDeskLayoutStore(memSqlDb())
    s.saveWorkcentre('u1', 'd1', 'desktop', dash, AT)
    const got = s.load('u1', 'd1', 'desktop')!
    expect(got.workcentre).toEqual(dash)
    expect(got.zoom).toBe(1)
    expect(got.objects).toEqual([])
  })

  it('a canvas save (camera move) keeps the stored dashboard', () => {
    const s = createDeskLayoutStore(memSqlDb())
    s.saveWorkcentre('u1', 'd1', 'desktop', dash, AT)
    s.save(canvas({ zoom: 2, scroll: { x: 99, y: 1 } }), AT)
    const got = s.load('u1', 'd1', 'desktop')!
    expect(got.zoom).toBe(2) // the canvas part updated
    expect(got.workcentre).toEqual(dash) // the dashboard survived
  })

  it('saveWorkcentre keeps the canvas overlay (camera, selection, custom layout)', () => {
    const s = createDeskLayoutStore(memSqlDb())
    s.save(canvas({ customLayout: true, selectedObjectIds: ['w1'], objects: [{ objectId: 'w1', x: 1, y: 2, width: 300, height: 200, zIndex: 3 }] }), AT)
    s.saveWorkcentre('u1', 'd1', 'desktop', dash, AT)
    const got = s.load('u1', 'd1', 'desktop')!
    expect(got.customLayout).toBe(true)
    expect(got.selectedObjectIds).toEqual(['w1'])
    expect(got.objects[0]!.width).toBe(300)
    expect(got.workcentre).toEqual(dash)
  })

  it('is per device class and per Desk: a tablet dashboard never overwrites the desktop one', () => {
    const s = createDeskLayoutStore(memSqlDb())
    s.saveWorkcentre('u1', 'd1', 'desktop', dash, AT)
    s.saveWorkcentre('u1', 'd1', 'tablet', { cols: 6, items: { w1: { x: 0, y: 0, w: 6, h: 4 } } }, AT)
    s.saveWorkcentre('u1', 'd2', 'desktop', { cols: 8, items: {} }, AT)
    expect(s.load('u1', 'd1', 'desktop')!.workcentre).toEqual(dash)
    expect(s.load('u1', 'd1', 'tablet')!.workcentre!.cols).toBe(6)
    expect(s.load('u1', 'd2', 'desktop')!.workcentre!.cols).toBe(8)
  })

  it('a later dashboard replaces the earlier one (not merged tile by tile)', () => {
    const s = createDeskLayoutStore(memSqlDb())
    s.saveWorkcentre('u1', 'd1', 'desktop', dash, AT)
    const next: WorkcentreLayout = { cols: 12, items: { w2: { x: 0, y: 0, w: 12, h: 6 } } }
    s.saveWorkcentre('u1', 'd1', 'desktop', next, AT)
    expect(s.load('u1', 'd1', 'desktop')!.workcentre).toEqual(next)
  })
})
