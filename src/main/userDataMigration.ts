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
  /**
   * Leave a pointer at `at` that resolves to `target` (a symlink, in practice).
   *
   * OPTIONAL and best-effort: a failure here must never change the outcome,
   * because the data is already safely at `target` by the time it is called.
   */
  linkBack?(target: string, at: string): void
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
  /**
   * The directory to use. ALWAYS a concrete path, never null.
   *
   * It used to return null to mean "leave Electron's default alone", and that
   * default is derived from `name` in package.json — which is how a rename of
   * that field moved everyone's workspace. There is no case where this should
   * defer to a value that can change for unrelated reasons.
   */
  dir: string
  outcome: UserDataOutcome
}

/**
 * Every directory name this app has kept its workspace under, oldest first.
 *
 * It is a CHAIN rather than one name because an install can be sitting on any
 * of them: someone who last ran the Haptyx build has never seen 'focusbuddy',
 * and both must end up at the current name.
 */
export const LEGACY_DIR_NAMES = ['Haptyx', 'focusbuddy'] as const

/** @deprecated Use LEGACY_DIR_NAMES. Kept so older callers still resolve. */
export const LEGACY_DIR_NAME = LEGACY_DIR_NAMES[0]

/**
 * The directory the standard build keeps its workspace in.
 *
 * PINNED, and deliberately not inherited from the app's name.
 *
 * Electron derives the default userData path from `app.getName()`, which comes
 * from `name` in package.json. That made a field nobody thinks of as
 * load-bearing — it is never shown to a user — silently decide where every
 * user's database, vault and files live.
 *
 * Renaming it from 'focusbuddy' to 'plexidesk' as part of an earlier rebrand
 * did exactly that: 4.3.11 started against an empty directory, and a workspace
 * with five months of work in it was still on disk but no longer opened. That
 * is why the path is stated here instead of inherited, and why `name` in
 * package.json belongs with appId on the list of identifiers that look
 * cosmetic and are not.
 *
 * It is now 'plexii', moved deliberately and once, with the operator's explicit
 * go-ahead — not as a side effect of renaming a field. The move is verified
 * before it is trusted (see below), nothing is deleted, and a pointer is left
 * at the old name so a DOWNGRADE still works: an older build pins its own
 * current name, so without that pointer it would find nothing and present an
 * empty workspace — the same accident in the other direction. Versioned
 * bundles are kept side by side for testing here, so that is a real path, not
 * a hypothetical one.
 */
export const CURRENT_DIR_NAME = 'plexii'

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
  const current = join(appData, CURRENT_DIR_NAME)

  // Newest legacy name first: an install that has both 'Haptyx' and
  // 'focusbuddy' on disk was last used as 'focusbuddy', so that is the one
  // holding the live workspace.
  const legacy = [...LEGACY_DIR_NAMES]
    .reverse()
    .map((name) => join(appData, name))
    .find((dir) => fs.exists(dir))

  if (legacy === undefined) return { dir: current, outcome: 'default' }

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
  if (fs.isNonEmpty(current)) {
    // The data is safely at `current` now. Leave a pointer behind at the old
    // name so an older build — which pins that name — still opens this
    // workspace instead of a new, empty one. Best-effort on purpose: if it
    // cannot be created, the current build is still correct.
    try {
      fs.linkBack?.(current, legacy)
    } catch {
      /* a downgrade would start empty; this build is unaffected */
    }
    return { dir: current, outcome: 'migrated' }
  }

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
