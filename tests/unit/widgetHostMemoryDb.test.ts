// The widget host's database lives in memory only (d0's F2 item 3).
//
// The browser runtime keeps one workspace in OPFS (plexii.db) and elects one
// tab per origin to hold it. A widget host page is not a workspace: it shows
// ONE file, and the file on disk (owned by PlexiiLite) is the only truth. Two
// tiles from the same origin sharing that OPFS database would mix their rows
// and keep a copy of every file a person ever opened in the browser's storage.
// So a Worker started for the host asks for memory by its name, and the
// database never touches OPFS at all -- not even to try.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const openDatabase = vi.fn(async () => { throw new Error('OPFS must not be touched') })
vi.mock('../../src/web/worker/sqlite', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/web/worker/sqlite')>()
  return { ...real, openDatabase }
})
vi.mock('../../src/web/worker/schemaInit', () => ({ applyBrowserSchema: () => {} }))

import { WIDGET_HOST_WORKER_NAME, storageForWorker } from '../../src/web/worker/hostMode'

beforeEach(() => { vi.resetModules(); openDatabase.mockClear() })

describe('the widget host database', () => {
  it('a Worker named for the widget host asks for memory; any other name keeps the workspace', () => {
    expect(storageForWorker(WIDGET_HOST_WORKER_NAME)).toBe('memory')
    expect(storageForWorker('')).toBe('workspace')
    expect(storageForWorker(undefined)).toBe('workspace')
    expect(storageForWorker('plexii-widget-host-not-quite')).toBe('workspace')
  })

  it('the host page starts its Worker under exactly that name', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/web/widgetHost/main.tsx', 'utf8')
    const m = /new Worker\(new URL\('\.\.\/worker\/index\.ts', import\.meta\.url\), \{ type: 'module', name: '([^']+)' \}\)/.exec(src)
    expect(m?.[1]).toBe(WIDGET_HOST_WORKER_NAME)
  })

  it('memory-only opens in memory without asking OPFS, and says why', async () => {
    const { openWorkspaceDatabase, getDb, storageMode } = await import('../../src/web/worker/database')
    await openWorkspaceDatabase({ memoryOnly: true })
    expect(openDatabase).not.toHaveBeenCalled()
    expect(storageMode()).toEqual({ mode: 'memory', reason: 'widget host: the file is the only copy' })
    const db = getDb()
    db.exec('CREATE TABLE probe (x TEXT)')
    db.prepare('INSERT INTO probe (x) VALUES (?)').run('sticky')
    expect(db.prepare('SELECT x FROM probe').get()).toEqual({ x: 'sticky' })
  })

  it('without the option the workspace still tries OPFS first (unchanged for the share app)', async () => {
    const { openWorkspaceDatabase, storageMode } = await import('../../src/web/worker/database')
    await openWorkspaceDatabase()
    expect(openDatabase).toHaveBeenCalledTimes(1)
    expect(storageMode().mode).toBe('memory')   // this mock refuses, so it falls back as before
    expect(storageMode().reason).toBe('OPFS must not be touched')
  })
})
