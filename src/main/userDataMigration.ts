// Deciding which directory holds the user's workspace, as a pure function.
//
// Split out of index.ts for the same reason as updaterInstall.ts: the decision
// is the dangerous part, and it cannot be tested while it is tangled up with
// `app.getPath` and the real filesystem. Getting it wrong does not throw — it
// silently presents the user with an app that has forgotten everything — so it
// is exactly the logic that should be exercised branch by branch.
//
// The app was renamed Haptyx -> PlexiDesk. The previous approach pinned
// userData to ".../Application Support/Haptyx" forever whenever that directory
// existed: safe, but it meant anyone who had ever run Haptyx kept their data
// under the old brand permanently. This moves it once instead.

/** The filesystem operations this needs, so a test can supply its own. */
export interface UserDataFs {
  exists(path: string): boolean
  /** Throws on failure, like fs.renameSync. */
  rename(from: string, to: string): void
  /** True if the directory exists and has at least one entry. */
  isNonEmpty(path: string): boolean
}

export type UserDataOutcome =
  /** No legacy directory: a fresh install, or one that already migrated. */
  | 'default'
  /** The legacy directory was moved to the current name. */
  | 'migrated'
  /** Both names exist. Ambiguous, so nothing was touched. */
  | 'both-exist'
  /** The rename threw; still on the legacy directory. */
  | 'rename-failed'
  /** The rename appeared to work but landed nothing, so it was undone. */
  | 'rolled-back'

export interface UserDataDecision {
  /** The directory to use, or null to leave Electron's default alone. */
  dir: string | null
  outcome: UserDataOutcome
}

export const LEGACY_DIR_NAME = 'Haptyx'
export const CURRENT_DIR_NAME = 'PlexiDesk'

/**
 * Where the workspace lives, and whether it had to move to get there.
 *
 * Every branch returns a directory that holds the real data. The failure mode
 * is "still called Haptyx", never "cannot find my workspace".
 */
export function resolveUserDataDir(
  appData: string,
  fs: UserDataFs,
  join: (...parts: string[]) => string
): UserDataDecision {
  const legacy = join(appData, LEGACY_DIR_NAME)
  const current = join(appData, CURRENT_DIR_NAME)

  if (!fs.exists(legacy)) return { dir: null, outcome: 'default' }

  // Ambiguous: a fresh install plus a restored backup, say. Merging two
  // databases is how data actually gets lost, so leave it for a human.
  if (fs.exists(current)) return { dir: legacy, outcome: 'both-exist' }

  try {
    fs.rename(legacy, current)
  } catch {
    // Windows refuses to rename a directory holding an open file, which is
    // precisely the case not to force: a second instance starting while the
    // first has the database open. The single-instance lock is taken later than
    // this runs, so that race is real, and this is what makes it harmless.
    return { dir: legacy, outcome: 'rename-failed' }
  }

  // Trust the filesystem only after looking.
  if (fs.isNonEmpty(current)) return { dir: current, outcome: 'migrated' }

  try {
    fs.rename(current, legacy)
  } catch {
    // Cannot undo it either. The data is at `current` whatever its state, so
    // that is where to point: going back to `legacy` would name a directory
    // the rename already emptied.
    return { dir: current, outcome: 'rolled-back' }
  }
  return { dir: legacy, outcome: 'rolled-back' }
}
