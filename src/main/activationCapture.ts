// Installer / UTM codes from this process: argv, deep links already handled
// elsewhere, and a JSON file an installer may drop next to the profile.
// Kept out of db/activation.ts so the browser worker, which records the same
// events, does not import fs or Electron.

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { attributionFromArgv, attributionFromJson } from '@shared/activationEvents'
import { rememberAttribution } from './db/activation'

export function captureProcessAttribution(argv: readonly string[] = process.argv): void {
  try {
    rememberAttribution(attributionFromArgv(argv))
    const file = join(app.getPath('userData'), 'install-attribution.json')
    if (!existsSync(file)) return
    rememberAttribution(attributionFromJson(readFileSync(file, 'utf8')))
  } catch {
    /* a missing file or an unreadable profile is not an error */
  }
}
