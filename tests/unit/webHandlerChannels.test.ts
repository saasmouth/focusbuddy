// Every channel the browser runtime serves must be a channel that exists.
//
// The handler table is written by hand, mirroring src/main/ipc/index.ts, and
// hand-written mirrors drift. Two ways in particular: serving a channel under a
// name nothing calls (ai:status, where the real one is ai:getStatus) which is
// dead code that looks like coverage; and serving a real channel with the wrong
// argument shape, which fails only when a user reaches that feature.
//
// The first is caught here, against the map generated from the preload -- the
// same source the browser's window.api is built from, so agreement with it is
// exactly agreement with what the renderer can call. Both were real mistakes in
// the commit that added these; this is why the test exists.
import { describe, it, expect } from 'vitest'
import { HANDLERS } from '../../src/web/worker/handlers'
import { INVOKE_CHANNELS } from '../../src/web/api/channelMap.generated'

const realChannels = new Set(Object.values(INVOKE_CHANNELS))

describe('the browser runtime handler table', () => {
  it('serves only channels the preload actually exposes', () => {
    const invented = Object.keys(HANDLERS).filter((c) => !realChannels.has(c))
    expect(invented, `not real channels: ${invented.join(', ')}`).toEqual([])
  })

  it('serves a meaningful share of what the desktop does', () => {
    // Not a target to game -- a floor, so a refactor that quietly unhooks half
    // the table is noticed. It rises as namespaces are ported.
    expect(Object.keys(HANDLERS).length).toBeGreaterThanOrEqual(100)
  })

  it('covers the workspace sync loop completely, since partial sync loses data', () => {
    const syncChannels = [...realChannels].filter((c) => c.startsWith('workspace:'))
    const missing = syncChannels.filter((c) => !(c in HANDLERS))
    // The exceptions, each for its own reason: the file-bytes channels because
    // there are no file bytes in the browser (src/web/worker/main/files.ts says
    // why); export/import because they read and write a file on disk;
    // workspace:ask and workspace:related because they are retrieval over the
    // workspace rather than part of the sync loop.
    expect(missing.sort()).toEqual([
      'workspace:ask',
      'workspace:exportJson',
      'workspace:fileBytesForPush',
      'workspace:hasLocalFileBytes',
      'workspace:importJson',
      'workspace:related',
      'workspace:writeSyncedFileBytes'
    ])
  })
})
