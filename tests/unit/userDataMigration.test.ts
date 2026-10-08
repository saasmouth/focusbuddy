// Every branch of the Haptyx -> PlexiDesk workspace move.
//
// This is the logic that decides where a user's database, vault and settings
// are read from. Getting it wrong does not throw: the app opens, finds nothing,
// and looks like it forgot everything. So each outcome is pinned here, and the
// invariant that matters is asserted separately — whatever happens, the
// directory returned is one that holds the data.
import { describe, expect, it } from 'vitest'
import {
  CURRENT_DIR_NAME,
  LEGACY_DIR_NAME,
  resolveUserDataDir,
  type UserDataFs
} from '../../src/main/userDataMigration'

const APP_DATA = '/Users/x/Library/Application Support'
const LEGACY = `${APP_DATA}/${LEGACY_DIR_NAME}`
const CURRENT = `${APP_DATA}/${CURRENT_DIR_NAME}`
const join = (...p: string[]): string => p.join('/')

/** A filesystem of directory name -> entry count. */
function fakeFs(
  dirs: Record<string, number>,
  opts: { renameThrows?: boolean; landsEmpty?: boolean; reverseThrows?: boolean } = {}
): { fs: UserDataFs; renames: Array<[string, string]>; dirs: Record<string, number> } {
  const renames: Array<[string, string]> = []
  const fs: UserDataFs = {
    exists: (p) => p in dirs,
    rename: (from, to) => {
      renames.push([from, to])
      if (opts.renameThrows && renames.length === 1) throw new Error('EPERM')
      if (opts.reverseThrows && renames.length === 2) throw new Error('EPERM')
      // The move always moves. Entry counts are tracked truthfully, because
      // `landsEmpty` is not "the data vanished" — nothing could recover from
      // that — it is "the rename worked and our emptiness check misreports",
      // which is the case the rollback exists for.
      const n = dirs[from] ?? 0
      delete dirs[from]
      dirs[to] = n
    },
    isNonEmpty: (p) =>
      opts.landsEmpty && p === `${APP_DATA}/${CURRENT_DIR_NAME}` && renames.length === 1
        ? false
        : (dirs[p] ?? 0) > 0
  }
  return { fs, renames, dirs }
}

describe('resolveUserDataDir', () => {
  it('names the pinned directory for a fresh install', () => {
    const { fs, renames } = fakeFs({})
    // A concrete path, never null: returning null meant "use Electron's
    // default", and that default follows `name` in package.json, which is how
    // a rename of that field moved every existing workspace.
    expect(resolveUserDataDir(APP_DATA, fs, join)).toEqual({ dir: CURRENT, outcome: 'default' })
    // A fresh install must not be "migrated" into existence.
    expect(renames).toEqual([])
  })

  it('names the pinned directory for an already-migrated install', () => {
    const { fs, renames } = fakeFs({ [CURRENT]: 12 })
    expect(resolveUserDataDir(APP_DATA, fs, join)).toEqual({ dir: CURRENT, outcome: 'default' })
    expect(renames).toEqual([])
  })

  it('never defers to a path that depends on the app name', () => {
    // The whole point: whatever the starting state, a concrete directory comes
    // back, so nothing downstream can be decided by app.getName().
    for (const start of [{}, { [LEGACY]: 9 }, { [CURRENT]: 3 }, { [LEGACY]: 9, [CURRENT]: 3 }]) {
      const { fs } = fakeFs({ ...start })
      const { dir } = resolveUserDataDir(APP_DATA, fs, join)
      expect(typeof dir, JSON.stringify(start)).toBe('string')
      expect(dir).toMatch(/\/(Haptyx|focusbuddy)$/)
    }
  })

  it('moves the legacy directory once, and reports the new path', () => {
    const { fs, renames, dirs } = fakeFs({ [LEGACY]: 9 })
    expect(resolveUserDataDir(APP_DATA, fs, join)).toEqual({ dir: CURRENT, outcome: 'migrated' })
    expect(renames).toEqual([[LEGACY, CURRENT]])
    // The data moved rather than being copied: the old name no longer exists.
    expect(dirs[LEGACY]).toBeUndefined()
    expect(dirs[CURRENT]).toBe(9)
  })

  it('touches nothing when both names exist, because merging loses data', () => {
    const { fs, renames } = fakeFs({ [LEGACY]: 9, [CURRENT]: 3 })
    expect(resolveUserDataDir(APP_DATA, fs, join)).toEqual({ dir: LEGACY, outcome: 'both-exist' })
    expect(renames).toEqual([])
  })

  it('stays on the legacy directory when the rename is refused', () => {
    // Windows will not rename a directory holding an open file — a second
    // instance starting while the first has the database open.
    const { fs, dirs } = fakeFs({ [LEGACY]: 9 }, { renameThrows: true })
    expect(resolveUserDataDir(APP_DATA, fs, join)).toEqual({ dir: LEGACY, outcome: 'rename-failed' })
    expect(dirs[LEGACY]).toBe(9)
  })

  it('undoes a rename that landed nothing', () => {
    const { fs, renames } = fakeFs({ [LEGACY]: 9 }, { landsEmpty: true })
    expect(resolveUserDataDir(APP_DATA, fs, join)).toEqual({ dir: LEGACY, outcome: 'rolled-back' })
    expect(renames).toEqual([[LEGACY, CURRENT], [CURRENT, LEGACY]])
  })

  it('points at the new path when the rename cannot be undone either', () => {
    // The data is wherever the first rename left it, so naming the directory
    // that rename already emptied would be worse.
    const { fs } = fakeFs({ [LEGACY]: 9 }, { landsEmpty: true, reverseThrows: true })
    expect(resolveUserDataDir(APP_DATA, fs, join)).toEqual({ dir: CURRENT, outcome: 'rolled-back' })
  })

  it('never returns a directory that does not hold the data', () => {
    // The invariant behind all of the above, stated once: for every starting
    // state, the directory handed back is the one with the entries in it.
    const states: Array<Record<string, number>> = [
      { [LEGACY]: 9 },
      { [LEGACY]: 9, [CURRENT]: 3 },
      { [CURRENT]: 3 },
      {}
    ]
    for (const start of states) {
      for (const opts of [{}, { renameThrows: true }, { landsEmpty: true }]) {
        const { fs, dirs } = fakeFs({ ...start }, opts)
        const { dir } = resolveUserDataDir(APP_DATA, fs, join)
        if (!(dir in dirs)) {
          // A fresh install: the pinned directory does not exist yet, which is
          // correct — Electron creates it.
          expect(start[LEGACY]).toBeUndefined()
        } else {
          expect(dirs[dir], `${JSON.stringify(start)} ${JSON.stringify(opts)} -> ${dir}`).toBeGreaterThan(0)
        }
      }
    }
  })
})
