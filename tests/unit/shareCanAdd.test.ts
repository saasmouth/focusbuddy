// A shared desk to look at takes nothing dragged on, so it must not invite it:
// the empty-desk hint asks shareCanAdd (renderer lib/shareMode.ts), which the
// share page sets from the link before the app loads (web/boot.tsx).
import { describe, it, expect, beforeEach } from 'vitest'

beforeEach(() => {
  sessionStorage.clear()
})

describe('may this window\'s visitor drag things on?', () => {
  it('the desktop always may, whatever a share page said', async () => {
    const m = await import('../../src/renderer/src/lib/shareMode')
    m.setShareCanAdd(false)
    expect(m.isShareRecipient()).toBe(false)
    expect(m.shareCanAdd()).toBe(true)
  })

  it('a link to use may; a link to look at may not', async () => {
    const m = await import('../../src/renderer/src/lib/shareMode')
    m.markShareRecipient('tok_use')
    m.setShareCanAdd(true)
    expect(m.shareCanAdd()).toBe(true)
    m.setShareCanAdd(false)
    expect(m.shareCanAdd()).toBe(false)
  })
})
