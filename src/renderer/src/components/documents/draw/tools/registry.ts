// The tool registry. Every `*.tool.ts` / `*.tool.tsx` file in this folder is
// picked up automatically (Vite and Vitest both expand import.meta.glob at
// build time), so adding a tool is adding ONE file -- nothing here or anywhere
// else is edited. A tool file default-exports a DrawTool. See README.md.

import type { DrawTool } from '../editor/types'

const modules = import.meta.glob<{ default: DrawTool }>(['./*.tool.ts', './*.tool.tsx'], { eager: true })

const TOOLS: DrawTool[] = Object.entries(modules)
  .map(([file, m]) => {
    if (!m.default || typeof m.default.id !== 'string') throw new Error(`${file} does not default-export a DrawTool`)
    return m.default
  })
  .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))

const BY_ID = new Map(TOOLS.map((t) => [t.id, t]))

/** Every tool, in toolbox order. */
export function drawTools(): DrawTool[] {
  return TOOLS
}

export function toolById(id: string): DrawTool | undefined {
  return BY_ID.get(id)
}

/** Problems with the registered tools (duplicate ids, duplicate or malformed shortcut keys); empty when healthy. */
export function toolRegistryProblems(tools: DrawTool[] = TOOLS): string[] {
  const out: string[] = []
  const ids = new Map<string, number>()
  const keys = new Map<string, string>()
  for (const t of tools) {
    ids.set(t.id, (ids.get(t.id) ?? 0) + 1)
    if (t.key) {
      // 'M', '\\' or 'Shift+E' (see DrawTool.key); the same form keys.ts reads.
      const m = /^(Shift\+)?(.)$/.exec(t.key)
      if (!m) {
        out.push(`shortcut "${t.key}" of ${t.id} is not one key or Shift with one key`)
        continue
      }
      const k = `${m[1] ? 'shift+' : ''}${m[2].toLowerCase()}`
      if (keys.has(k)) out.push(`shortcut "${t.key}" is taken by both ${keys.get(k)} and ${t.id}`)
      else keys.set(k, t.id)
    }
  }
  for (const [id, n] of ids) if (n > 1) out.push(`tool id "${id}" is registered ${n} times`)
  return out
}
