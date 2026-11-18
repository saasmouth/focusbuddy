// Two places that name the same thing must say the same words (4.3.50).
//
// Seen capturing 4.3.48 screens on 2026-11-17:
//  - PlexiFlow's trigger picker said "When a task is completed" while the flow
//    list said "When a desk is completed". SPEC-044 (vocabulary quarantine,
//    2026-08-25) moved the label map to "desk"; the picker kept its own copy.
//    The picker now renders the label map, so the two cannot drift again.
//  - The side menu and the Office shell called PlexiiSign "Sign", while the
//    screen itself is titled PlexiiSign, like PlexiiChat, PlexiiCall and
//    PlexiiVault beside it.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FLOW_EVENT_LABELS, type FlowEventName } from '../../src/shared/flows'
import { SEGMENT_APPS } from '../../src/renderer/src/lib/segmentApps'

const src = (p: string): string => readFileSync(join(__dirname, '../../src/renderer/src', p), 'utf8')

describe('PlexiFlow trigger wording', () => {
  const view = src('components/views/PlexiFlowView.tsx')
  for (const [event, label] of Object.entries(FLOW_EVENT_LABELS) as [FlowEventName, string][]) {
    it(`the picker offers "${event}" in the label map's words (${label})`, () => {
      const option = new RegExp(`<option value="${event}">([^<]*)</option>`).exec(view)
      expect(option, `<option value="${event}"> in PlexiFlowView.tsx`).not.toBeNull()
      const shown = option![1].trim()
      // Rendered from the map, or (if ever written out) the map's exact words.
      expect([`{FLOW_EVENT_LABELS['${event}']}`, label]).toContain(shown)
    })
  }
})

describe('PlexiiSign is called PlexiiSign everywhere it is listed', () => {
  const title = /title="([^"]+)"/.exec(src('components/views/PlexiSignView.tsx'))?.[1]

  it('the screen is titled PlexiiSign', () => {
    expect(title).toBe('PlexiiSign')
  })

  it('the side menu tile uses the screen’s name', () => {
    const tile = SEGMENT_APPS.office.find((a) => a.key === 'sign')
    expect(tile?.label).toBe(title)
  })

  it('the Office shell’s app list uses the screen’s name', () => {
    const entry = /\{ key: 'sign', label: '([^']+)'/.exec(src('components/office/PlexiOfficeShell.tsx'))
    expect(entry?.[1]).toBe(title)
  })
})
