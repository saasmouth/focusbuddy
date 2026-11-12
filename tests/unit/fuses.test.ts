// @vitest-environment node
// The fuse wire is castLabs' fixed EVS set, exactly (build/fuses.cjs).
//
// castLabs' VMP signing service signs a binary only with the release's default
// fuse wire or this one set; anything else is "Binary signature denied", and
// Netflix can then never play in PlexiiDesk. This pins the app's fuses to the
// list castLabs published (castlabs/electron-releases#152, in @electron/fuses'
// command-line syntax), so a well-meant change to one fuse fails here instead
// of at signing time.
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { FUSES, describeFuses } = require('../../build/fuses.cjs') as {
  FUSES: Record<string, unknown>
  describeFuses: () => string
}
const { FuseV1Options, FuseVersion } = require('@electron/fuses') as {
  FuseV1Options: Record<string, number | string>
  FuseVersion: Record<string, string>
}

// Verbatim from castlabs/electron-releases#152 (and the wiki FAQ).
const CASTLABS_EVS_FUSES = [
  'RunAsNode=off',
  'EnableCookieEncryption=on',
  'EnableNodeOptionsEnvironmentVariable=off',
  'EnableNodeCliInspectArguments=off',
  'EnableEmbeddedAsarIntegrityValidation=on',
  'OnlyLoadAppFromAsar=on',
  'LoadBrowserProcessSpecificV8Snapshot=off',
  'GrantFileProtocolExtraPrivileges=on'
]

describe('the fuse wire', () => {
  it("is castLabs' EVS set: every fuse in it, with its value", () => {
    expect(FUSES.version).toBe(FuseVersion.V1)
    const ours = Object.entries(FUSES)
      .filter(([k]) => k !== 'version')
      .map(([k, v]) => `${FuseV1Options[k]}=${v ? 'on' : 'off'}`)
    expect(ours.sort()).toEqual([...CASTLABS_EVS_FUSES].sort())
  })

  it('names no fuse outside the set (those must keep their defaults)', () => {
    const named = Object.keys(FUSES).filter((k) => k !== 'version').map((k) => String(FuseV1Options[k]))
    expect(named).not.toContain('WasmTrapHandlers')
    expect(named).toHaveLength(CASTLABS_EVS_FUSES.length)
  })

  it('keeps the hardening the app had before ECS (RunAsNode, NODE_OPTIONS, --inspect all off)', () => {
    expect(describeFuses()).toContain('RunAsNode=off')
    expect(describeFuses()).toContain('EnableNodeOptionsEnvironmentVariable=off')
    expect(describeFuses()).toContain('EnableNodeCliInspectArguments=off')
  })
})
