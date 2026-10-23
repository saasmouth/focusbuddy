// Desk layout persistence (spec §21, PLX-APP-010 / PLX-PRD-002). A Desk persists its
// complete visual layout — object positions, sizes, z-order, scroll, selection and
// zoom — per (user, Desk, device class), and restores it exactly on reopen. Keyed on
// device class so a user's desktop arrangement is never overwritten by their tablet
// (PLX-UX-032).

import type { SqlDb } from './eventStore'
import type { DeskLayout, DeviceClass, WorkcentreLayout } from '../../shared/deskLayout'

export function ensureDeskLayoutSchema(db: SqlDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS desk_layouts (
      user_id TEXT NOT NULL,
      desk_id TEXT NOT NULL,
      device_class TEXT NOT NULL,
      layout_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, desk_id, device_class)
    );
  `)
}

export interface DeskLayoutStore {
  save: (layout: DeskLayout, at: string) => void
  /** Write just the Workcentre dashboard, keeping the rest of the row (or creating a minimal one). */
  saveWorkcentre: (userId: string, deskId: string, deviceClass: DeviceClass, workcentre: WorkcentreLayout, at: string) => void
  load: (userId: string, deskId: string, deviceClass: DeviceClass) => DeskLayout | null
  db: SqlDb
}

export function createDeskLayoutStore(db: SqlDb): DeskLayoutStore {
  ensureDeskLayoutSchema(db)

  const write = (layout: DeskLayout, at: string): void => {
    db.prepare(
      `INSERT INTO desk_layouts (user_id, desk_id, device_class, layout_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, desk_id, device_class) DO UPDATE SET layout_json = excluded.layout_json, updated_at = excluded.updated_at`
    ).run(layout.userId, layout.deskId, layout.deviceClass, JSON.stringify(layout), at)
  }

  // The canvas saves its whole overlay (camera, selection, objects) without a
  // workcentre field; keep the stored dashboard, or every camera move would wipe it.
  const save: DeskLayoutStore['save'] = (layout, at) => {
    if (layout.workcentre === undefined) {
      const prev = load(layout.userId, layout.deskId, layout.deviceClass)
      if (prev?.workcentre) {
        write({ ...layout, workcentre: prev.workcentre }, at)
        return
      }
    }
    write(layout, at)
  }

  const saveWorkcentre: DeskLayoutStore['saveWorkcentre'] = (userId, deskId, deviceClass, workcentre, at) => {
    const prev = load(userId, deskId, deviceClass)
    const base: DeskLayout = prev ?? { userId, deskId, deviceClass, objects: [], scroll: { x: 0, y: 0 }, selectedObjectIds: [], zoom: 1 }
    write({ ...base, workcentre }, at)
  }

  const load: DeskLayoutStore['load'] = (userId, deskId, deviceClass) => {
    const row = db
      .prepare('SELECT layout_json FROM desk_layouts WHERE user_id = ? AND desk_id = ? AND device_class = ?')
      .get(userId, deskId, deviceClass) as { layout_json: string } | undefined
    return row ? (JSON.parse(row.layout_json) as DeskLayout) : null
  }

  return { save, saveWorkcentre, load, db }
}
