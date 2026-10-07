import { ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import { isAbsolute, normalize, sep } from 'node:path'

// ws-v-3 suite convergence: edit an EXTERNAL markdown document (an artifact of
// the local agentic ops console) in PlexiDocs, saving straight back to disk.
//
// Trust model: the deep link (plexii://edit-md?path=...) is world-invokable, so
// arbitrary paths must never be readable or writable. The allowed root is not
// hardcoded — it is learned from the local ops console itself (its /api/health
// reports its workspace root), which only answers on localhost. No console
// running → no external markdown access at all. Writes additionally require
// that THIS session already read the same file (no blind protocol writes).

const OPS_HEALTH_URL = 'http://localhost:8765/api/health'
let cachedRoot: string | null = null
let rootFetchedAt = 0
const readThisSession = new Set<string>()

async function allowedRoot(): Promise<string | null> {
  const now = Date.now()
  if (cachedRoot && now - rootFetchedAt < 60_000) return cachedRoot
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 3000)
    const res = await fetch(OPS_HEALTH_URL, { signal: ctrl.signal })
    clearTimeout(t)
    if (!res.ok) return cachedRoot
    const j = (await res.json()) as { workspace_root?: string }
    if (j.workspace_root && isAbsolute(j.workspace_root)) {
      cachedRoot = normalize(j.workspace_root)
      rootFetchedAt = now
    }
  } catch {
    /* console not running — keep any previous root for this session */
  }
  return cachedRoot
}

async function checkPath(path: string): Promise<string | null> {
  if (!path || !isAbsolute(path)) return 'path must be absolute'
  if (!path.endsWith('.md')) return 'only .md files can be edited externally'
  if (path.includes('..')) return 'path traversal refused'
  const root = await allowedRoot()
  if (!root) return 'the ops console is not reachable, so external editing is disabled'
  const norm = normalize(path)
  if (norm !== root && !norm.startsWith(root + sep)) return 'path is outside the ops workspace'
  return null
}

export function registerMdExternal(): void {
  ipcMain.handle('mdext:read', async (_e, path: string) => {
    const err = await checkPath(path)
    if (err) return { ok: false, error: err }
    try {
      const content = await fs.readFile(path, 'utf-8')
      readThisSession.add(normalize(path))
      return { ok: true, content }
    } catch (e) {
      return { ok: false, error: `could not read the file: ${(e as Error).message}` }
    }
  })

  ipcMain.handle('mdext:write', async (_e, path: string, content: string) => {
    const err = await checkPath(path)
    if (err) return { ok: false, error: err }
    if (!readThisSession.has(normalize(path))) {
      return { ok: false, error: 'refusing to write a file this session never read' }
    }
    if (typeof content !== 'string' || content.length > 5_000_000) {
      return { ok: false, error: 'invalid content' }
    }
    try {
      const tmp = `${path}.plexitmp`
      await fs.writeFile(tmp, content, 'utf-8')
      await fs.rename(tmp, path)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: `could not save: ${(e as Error).message}` }
    }
  })
}
