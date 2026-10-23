import { describe, it, expect, beforeEach, vi } from 'vitest'

// The keyed browsing store: 'main' (the full Files view) and 'panel' (Files
// beside your work) each keep their own folder, selection, search and type
// filter; file operations and their undo are shared.

type Entry = { id: string; parentId: string | null; kind: 'folder' | 'file'; name: string; createdAt: number; updatedAt: number }
const db = new Map<string, Entry>()
const mk = (id: string, parentId: string | null, kind: Entry['kind'] = 'folder'): void => {
  db.set(id, { id, parentId, kind, name: id, createdAt: 1, updatedAt: 1 })
}

function installApi(): Record<string, ReturnType<typeof vi.fn>> {
  const fm = {
    list: vi.fn(async (p: string | null) => [...db.values()].filter((e) => e.parentId === p)),
    path: vi.fn(async (id: string | null) => {
      const out: Array<{ id: string; name: string }> = []
      let cur = id ? db.get(id) : undefined
      while (cur) {
        out.unshift({ id: cur.id, name: cur.name })
        cur = cur.parentId ? db.get(cur.parentId) : undefined
      }
      return out
    }),
    get: vi.fn(async (id: string) => db.get(id) ?? null),
    search: vi.fn(async (q: string) => [...db.values()].filter((e) => e.name.includes(q))),
    move: vi.fn(async (id: string, to: string | null) => {
      // refuse into itself or a descendant, as main does
      let cur: string | null = to
      while (cur) {
        if (cur === id) return false
        cur = db.get(cur)?.parentId ?? null
      }
      db.get(id)!.parentId = to
      return true
    }),
    createFolder: vi.fn(async (parent: string | null, name: string) => {
      const id = `new-${name}-${db.size}`
      mk(id, parent)
      return db.get(id)
    })
  }
  ;(window as unknown as { api: unknown }).api = { fileManager: fm, brain: { ingestWorkspace: vi.fn(async () => undefined) } }
  return fm
}

describe('keyed Files browsing store', () => {
  beforeEach(() => {
    vi.resetModules()
    db.clear()
    mk('A', null)
    mk('B', null)
    mk('A1', 'A')
    mk('f1', 'A', 'file')
  })

  it("the panel's folder is untouched by the full view's filter and folder changes", async () => {
    installApi()
    const { useFileManagerStore, useFilesPanelBrowser } = await import('../../src/renderer/src/stores/fileManager')
    await useFilesPanelBrowser.getState().openFolder('A')
    useFilesPanelBrowser.getState().select('A1')
    // What the Work widgets heading and a Drive work widget do to the full view:
    useFileManagerStore.getState().setTypeFilter('widgets')
    await useFileManagerStore.getState().openFolder('B')
    expect(useFilesPanelBrowser.getState().cwd).toBe('A')
    expect(useFilesPanelBrowser.getState().typeFilter).toBe('all')
    expect(useFilesPanelBrowser.getState().selectedIds).toEqual(['A1'])
    expect(useFileManagerStore.getState().cwd).toBe('B')
    expect(useFileManagerStore.getState().typeFilter).toBe('widgets')
    // And the reverse: the panel's search never reaches the full view.
    await useFilesPanelBrowser.getState().runSearch('A1')
    expect(useFileManagerStore.getState().search).toBe('')
  })

  it('a refresh after a change re-reads every surface that is showing a listing', async () => {
    const fm = installApi()
    const { useFileManagerStore, useFilesPanelBrowser } = await import('../../src/renderer/src/stores/fileManager')
    await useFileManagerStore.getState().refresh()
    expect(fm.list).toHaveBeenCalledTimes(1) // the panel has not started: not listed
    await useFilesPanelBrowser.getState().openFolder('A')
    fm.list.mockClear()
    await useFileManagerStore.getState().refresh()
    expect(fm.list.mock.calls.map((c) => c[0]).sort()).toEqual([null, 'A'].sort())
  })

  it('moveMany is one undo step, skips what is already there, and refuses a folder into itself', async () => {
    installApi()
    const { useFileManagerStore, useFilesPanelBrowser } = await import('../../src/renderer/src/stores/fileManager')
    await useFilesPanelBrowser.getState().openFolder(null)
    const moved = await useFileManagerStore.getState().moveMany(['B', 'f1', 'A'], 'A')
    // B moves, f1 is already in A, A cannot go inside itself.
    expect(moved).toBe(1)
    expect(db.get('B')!.parentId).toBe('A')
    expect(useFileManagerStore.getState().past).toHaveLength(1)
    await useFileManagerStore.getState().undo()
    expect(db.get('B')!.parentId).toBeNull()
    // A folder into its own descendant is refused by the DB and not recorded.
    expect(await useFileManagerStore.getState().moveMany(['A'], 'A1')).toBe(0)
  })

  it('operations can target the panel’s folder rather than the full view’s', async () => {
    const fm = installApi()
    const { useFileManagerStore } = await import('../../src/renderer/src/stores/fileManager')
    await useFileManagerStore.getState().openFolder('B')
    await useFileManagerStore.getState().createFolder('Fresh', 'A')
    expect(fm.createFolder).toHaveBeenLastCalledWith('A', 'Fresh')
    await useFileManagerStore.getState().createFolder('Here')
    expect(fm.createFolder).toHaveBeenLastCalledWith('B', 'Here')
  })

  it('move finds the item’s current folder even when only the panel lists it (correct undo)', async () => {
    installApi()
    const { useFileManagerStore, useFilesPanelBrowser } = await import('../../src/renderer/src/stores/fileManager')
    await useFileManagerStore.getState().openFolder('B') // full view elsewhere
    await useFilesPanelBrowser.getState().openFolder('A')
    await useFileManagerStore.getState().move('f1', 'B')
    expect(db.get('f1')!.parentId).toBe('B')
    await useFileManagerStore.getState().undo()
    expect(db.get('f1')!.parentId).toBe('A')
  })
})
