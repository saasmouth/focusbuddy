// Whether an e2e launch may see the on-device AI models a worktree staged in
// resources/models.
//
// A verified bundled model makes a fresh profile start on "Local on this
// device" (src/main/settingsStore.ts:46-52), which changes what every no-key
// spec sees: AI answers come from the on-device model, and the "Local AI is now
// built in" card sits over the bottom-right controls. So a run's result used to
// depend on whether the worktree had staged the 2.5 GB models (the 4.3.42 RC
// ran in one that had, and most of its 18 reds came from that).
//
// Every launch (launchGuarded) therefore points PLEXII_BUNDLED_MODELS_DIR, the
// dev/test-only stand-in for the bundle (localAiService.bundleModelsDir; a
// packaged app ignores it), at an empty folder: the app behaves as an install
// that came without the model, whatever the worktree holds. A spec that really
// needs the staged model is named here with the reason; a single launch can opt
// in with launchApp({ bundledModels: true }) (localAiMigration MIG-4 does). A spec that passes its
// own PLEXII_BUNDLED_MODELS_DIR (localAiMigration, localAiSettings) still wins.

import { mkdirSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export const BUNDLED_MODEL_SPECS: Record<string, string> = {
  'localAiBrainAnswer.spec.ts': 'Answers on the real on-device model; skips when none is staged.',
  'localAiBrainPassage.spec.ts': 'Retrieval feeding the real on-device model; skips when none is staged.',
  'localAiTableRows.spec.ts': 'Table rows from the real on-device model; skips when none is staged.',
  'aiCreditsSection.spec.ts': 'Asserts the default source both ways: Local when a verified model is here, credits when not.'
}

/** An empty folder standing in for "this install has no bundled model". */
export function noBundledModelsDir(): string {
  const dir = join(tmpdir(), 'plexii-e2e-no-bundled-models')
  mkdirSync(dir, { recursive: true })
  if (readdirSync(dir).length > 0) throw new Error(`[e2e] ${dir} must stay empty: it stands in for an install without the model`)
  return dir
}

/** The env a launch gets: hide the staged models unless the spec is named above (or asked explicitly). */
export function bundledModelsEnv(spec: string, explicit?: boolean): Record<string, string> {
  const see = explicit ?? spec in BUNDLED_MODEL_SPECS
  return see ? {} : { PLEXII_BUNDLED_MODELS_DIR: noBundledModelsDir() }
}
