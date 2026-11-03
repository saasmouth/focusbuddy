// A phone opening a share link met "workspace database unavailable: The
// operation failed for an unknown transient reason (e.g. out of memory)" and no
// desk. WebKit refuses OPFS sync access handles in in-app browsers (Instagram,
// Facebook, X, LinkedIn), private windows and some Safari builds, and the
// database refused to open at all. It now opens the same engine in memory and
// reports that, so the share page can say the copy lasts only for this visit.
import { describe, it, expect, vi } from 'vitest'

const WEBKIT = 'The operation failed for an unknown transient reason (e.g. out of memory).'

vi.mock('../../src/web/worker/sqlite', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/web/worker/sqlite')>()
  return { ...real, openDatabase: vi.fn(async () => { throw new Error(WEBKIT) }) }
})
vi.mock('../../src/web/worker/schemaInit', () => ({ applyBrowserSchema: () => {} }))

import { openWorkspaceDatabase, getDb, storageMode } from '../../src/web/worker/database'

describe('workspace database when the browser refuses durable storage', () => {
  it('opens in memory instead of failing, and says so', async () => {
    await expect(openWorkspaceDatabase()).resolves.toBeUndefined()
    expect(storageMode()).toEqual({ mode: 'memory', reason: WEBKIT })
    const db = getDb()
    db.exec('CREATE TABLE probe (x TEXT)')
    db.prepare('INSERT INTO probe (x) VALUES (?)').run('desk')
    expect(db.prepare('SELECT x FROM probe').get()).toEqual({ x: 'desk' })
  })
})
