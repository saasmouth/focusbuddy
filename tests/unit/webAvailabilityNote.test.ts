import { describe, it, expect } from 'vitest'
import { webAvailabilityNote } from '../../src/main/ai/anthropic'

// The assistant must not offer what the app will refuse.
//
// Reported 2026-10-30. Asked to fill a table with the top 20 honeymoon
// destinations, the sidebar assistant replied "Would you like me to search
// for this information and populate the table?" — while running on the
// on-device model, where the app never contacts a search engine at all, by
// design. The offer could never be honoured, so the user waited for an answer
// that was never coming.
//
// The cause was silence: the search was skipped without telling the model, so
// it had no way to know. These notes are what it is told instead.

describe('webAvailabilityNote', () => {
  it('says nothing when the web IS available — no noise on the common path', () => {
    expect(webAvailabilityNote(true, false)).toBe('')
  })

  it('on this device: forbids the offer and names the switch that would change it', () => {
    const n = webAvailabilityNote(true, true)
    expect(n).toMatch(/Never offer to search/i)
    expect(n).toMatch(/never ask whether the user would like you to/i)
    // The actionable step, in the words of the control they can see.
    expect(n).toContain('Claude or ChatGPT')
    expect(n).toMatch(/chip under the message box/i)
    // And it must not send them to the globe, which changes nothing here.
    expect(n).not.toMatch(/globe/i)
  })

  it('globe off: forbids the offer and names the globe, which IS their switch', () => {
    const n = webAvailabilityNote(false, false)
    expect(n).toMatch(/Never offer to search/i)
    expect(n).toMatch(/globe button under the message box/i)
    // Not the model chip — their AI is fine; it is the globe that is off.
    expect(n).not.toContain('Claude or ChatGPT')
  })

  it('on-device wins over the globe, because it is the stronger reason', () => {
    // Both off: the globe is beside the point when nothing may leave at all.
    expect(webAvailabilityNote(false, true)).toContain('run on this device')
  })

  it('every unavailable note tells the model it CANNOT, not that it should not', () => {
    for (const n of [webAvailabilityNote(true, true), webAvailabilityNote(false, false)]) {
      expect(n).toMatch(/CANNOT/)
    }
  })
})

describe('the note actually reaches the model', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const SRC = readFileSync(join(__dirname, '../..', 'src/main/ai/anthropic.ts'), 'utf-8')

  it('is part of the chat system prompt, not just an exported function', () => {
    // A note nobody sends is a note that changes nothing.
    expect(SRC).toContain('${webAvailabilityNote(gateWeb, localOnlyActive())}')
  })
})
