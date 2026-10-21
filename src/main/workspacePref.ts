// Persisted workspace path override for the agent resolver.
//
// A path written to `<userData>/workspace.json` (a tiny JSON blob, same
// pattern as voiceProviderPref) takes priority over all the auto-detected
// candidates. Nothing in the app writes it any more -- the setter had no
// caller and was retired in 4.3.41 -- but an override already on disk, or
// one placed there by hand, is still honoured.
//
// Empty string / missing file = no override. The resolver falls
// through to its other probes.

import { app } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

interface PrefShape {
  workspacePath: string
  v: 1
}

let cache: PrefShape | null = null

function filePath(): string {
  return join(app.getPath('userData'), 'workspace.json')
}

function load(): PrefShape {
  if (cache) return cache
  try {
    if (!existsSync(filePath())) {
      cache = { workspacePath: '', v: 1 }
      return cache
    }
    const raw = readFileSync(filePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PrefShape>
    const workspacePath =
      typeof parsed.workspacePath === 'string' ? parsed.workspacePath : ''
    cache = { workspacePath, v: 1 }
    return cache
  } catch {
    cache = { workspacePath: '', v: 1 }
    return cache
  }
}

/**
 * Returns the user-set workspace override, or null if none is set.
 * The resolver pushes this to the front of its probe list when
 * present.
 */
export function getWorkspaceOverride(): string | null {
  const p = load().workspacePath.trim()
  return p ? p : null
}
