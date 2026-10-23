// The PlexiiBrain / PlexiiPeople / PlexiiDesk shells' test id is their kind.
// It was the lowercased display wordmark, so the Plexi -> Plexii rename turned
// segment-plexibrain into segment-plexiibrain and three e2e specs (brainIngest,
// brainSyncPrune, plexiPeople) waited on an id that no longer existed.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('segment shell test id', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'src', 'renderer', 'src', 'components', 'segment', 'SegmentShell.tsx'), 'utf8')
  it('comes from the segment kind, never from display text', () => {
    expect(src).toContain('data-testid={`segment-${def.kind}`}')
    expect(src).not.toMatch(/data-testid=\{`segment-\$\{def\.(wordmark|title)/)
  })
})
