// Workspace path resolution for the agent system.
//
// Why this exists: in dev mode the Electron main process boots with
// `process.cwd()` pointing at the plexii project — walking up 6
// directories conveniently lands inside `agentic-starter-kit-main`
// and finds `.claude/agents/`. In a packaged build (or anything
// launched via Finder / Spotlight / Dock), `process.cwd()` is the
// OS root `/`, so the walk finds nothing and the original fallback
// tried to mkdirSync('/.claude/agents') — which fails with ENOENT
// or EACCES.
//
// The fix is a layered probe: settings override (user-set path) →
// well-known workspace paths → userData fallback. The last layer
// always works because userData is owned by Electron.
//
// One pair of functions:
//   findAgentsDirectory()    — returns the FIRST existing .claude/agents
//                              under any of the probed roots, or null
//                              if none exist.
//   ensureAgentsDirectory()  — same probe order, but if none exist it
//                              CREATES one under userData and returns
//                              that path. Never returns null.

import { mkdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { app } from 'electron'
import { getWorkspaceOverride } from './workspacePref'

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Build the ordered list of workspace roots to probe. Caller iterates
 * looking for `.claude/agents/` under each; whichever exists wins.
 *
 * Probe order (highest priority first):
 *   1. User-configured override (Settings → Advanced → Workspace path)
 *   2. cwd-walk (for dev mode)
 *   3. Well-known operator paths (~/Applications, /Applications, etc.)
 *   4. Electron resourcesPath (for packaged-app embedded agents — not
 *      used yet but reserved)
 *   5. userData fallback (always works)
 *
 * The userData entry is appended last so an installed PlexiDesk without
 * a discovered operator workspace still has SOMEWHERE to put agents.
 */
export function candidateWorkspaceRoots(): string[] {
  const roots: string[] = []

  const override = getWorkspaceOverride()
  if (override) roots.push(override)

  // cwd walk (dev mode lands here)
  let cur = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (!roots.includes(cur)) roots.push(cur)
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }

  // Well-known operator workspace paths. The starter-kit is a public
  // template; users commonly clone it into one of these locations.
  const home = homedir()
  const wellKnown = [
    join('/Applications', 'agentic-starter-kit-main'),
    join(home, 'Applications', 'agentic-starter-kit-main'),
    join(home, 'agentic-starter-kit-main'),
    join(home, 'Documents', 'agentic-starter-kit-main'),
    join(home, 'Projects', 'agentic-starter-kit-main'),
    join(home, 'Code', 'agentic-starter-kit-main')
  ]
  for (const p of wellKnown) {
    if (!roots.includes(p)) roots.push(p)
  }

  // Electron resources (reserved — we can ship a starter agents
  // directory inside the app one day for first-run experience).
  if (typeof app.getAppPath === 'function') {
    roots.push(app.getAppPath())
  }

  // userData fallback. ALWAYS writable — installed by Electron with
  // appropriate perms.
  if (typeof app.getPath === 'function') {
    roots.push(app.getPath('userData'))
  }

  return roots
}

export interface ResolvedAgentsDir {
  // Absolute path to the .claude/agents directory.
  path: string
  // The workspace root that contains it (so the UI can show "agents
  // are sourced from <root>" instead of the deeper agents path).
  workspaceRoot: string
  // Whether this directory was created by ensureAgentsDirectory because
  // none of the probed locations existed. False means "we found an
  // existing one"; true means "we just made one in userData".
  createdJustNow: boolean
  // Which probe layer matched. Useful for diagnostics.
  source: 'override' | 'workspace' | 'userData-existing' | 'userData-new'
}

export function findAgentsDirectory(): ResolvedAgentsDir | null {
  const userData =
    typeof app.getPath === 'function' ? app.getPath('userData') : null
  for (const root of candidateWorkspaceRoots()) {
    const candidate = join(root, '.claude', 'agents')
    if (isDir(candidate)) {
      return {
        path: candidate,
        workspaceRoot: root,
        createdJustNow: false,
        source:
          getWorkspaceOverride() === root
            ? 'override'
            : userData && root === userData
              ? 'userData-existing'
              : 'workspace'
      }
    }
  }
  return null
}

/**
 * Like findAgentsDirectory() but never returns null — falls through
 * to creating `<userData>/.claude/agents/` if nothing exists.
 */
export function ensureAgentsDirectory(): ResolvedAgentsDir {
  const found = findAgentsDirectory()
  if (found) return found

  // Cold-start case. Create under userData — guaranteed writable.
  const userDataRoot =
    typeof app.getPath === 'function' ? app.getPath('userData') : process.cwd()
  const path = join(userDataRoot, '.claude', 'agents')
  mkdirSync(path, { recursive: true })
  return {
    path,
    workspaceRoot: userDataRoot,
    createdJustNow: true,
    source: 'userData-new'
  }
}

// Re-export so callers that already had the `existsSync`/`statSync`
// style probe can drop in without an extra import.
export { isDir as isDirectory }
