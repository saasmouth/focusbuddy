// A frame may not take focus by itself (src/renderer/src/lib/frameFocusGuard.ts):
// Chromium's PDF viewer focused itself on load, and every key went into it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { guardFrameFocus, isSelfFocus, SELF_FOCUS_WINDOW_MS, TAB_WINDOW_MS } from '../../src/renderer/src/lib/frameFocusGuard'

describe('whose focus move it was', () => {
  it('right after the frame loads: its own (the PDF viewer grabs focus 134 to 150 ms after load)', () => {
    expect(isSelfFocus({ msSinceLoad: 150, msSinceTab: Infinity })).toBe(true)
  })
  it('later: the person’s, a click (no pointer event reaches the page over the PDF viewer, so time decides)', () => {
    expect(isSelfFocus({ msSinceLoad: SELF_FOCUS_WINDOW_MS + 1, msSinceTab: Infinity })).toBe(false)
  })
  it('just after a Tab: the person’s', () => {
    expect(isSelfFocus({ msSinceLoad: 150, msSinceTab: TAB_WINDOW_MS - 1 })).toBe(false)
  })
})

describe('the guard', () => {
  let clock = 0
  let stop: () => void = () => undefined
  let frame: HTMLIFrameElement
  let note: HTMLTextAreaElement
  const now = (): number => clock

  beforeEach(() => {
    clock = 1000
    document.body.innerHTML = '<textarea id="note"></textarea><iframe id="pdf"></iframe>'
    frame = document.getElementById('pdf') as HTMLIFrameElement
    note = document.getElementById('note') as HTMLTextAreaElement
    stop = guardFrameFocus(frame, now)
    frame.dispatchEvent(new Event('load'))
  })
  afterEach(() => stop())

  /**
   * Focus moves into the frame the way Chromium reports it: what had focus
   * loses it, the frame becomes active, then the window blurs. The guard puts
   * focus back once that task is over.
   */
  async function frameTakesFocus(): Promise<void> {
    frame.focus()
    window.dispatchEvent(new Event('blur'))
    await new Promise((r) => setTimeout(r, 5))
  }

  it('a frame that focuses itself as it loads hands focus back to the note being typed in', async () => {
    note.focus()
    clock += 150
    await frameTakesFocus()
    expect(document.activeElement).toBe(note)
  })

  it('focus does not go back to something that lost it earlier to a click elsewhere', async () => {
    note.focus()
    note.blur() // the person clicked the desk: focus is on the page
    await new Promise((r) => setTimeout(r, 5))
    clock += 150
    await frameTakesFocus()
    expect(document.activeElement).not.toBe(frame)
    expect(document.activeElement).not.toBe(note)
  })

  it('with nothing focused before, focus goes back to the page', async () => {
    clock += 150
    await frameTakesFocus()
    expect(document.activeElement).not.toBe(frame)
  })

  it('a click into the frame after it loaded keeps focus there, with no pointer event at all (as over the PDF viewer)', async () => {
    clock += SELF_FOCUS_WINDOW_MS + 500
    await frameTakesFocus()
    expect(document.activeElement).toBe(frame)
    // The app losing focus while the frame holds it is not a move: left alone.
    window.dispatchEvent(new Event('blur'))
    await new Promise((r) => setTimeout(r, 5))
    expect(document.activeElement).toBe(frame)
  })

  it('the frame loading again (a new file) is watched again', async () => {
    clock += SELF_FOCUS_WINDOW_MS + 5_000
    frame.dispatchEvent(new Event('load'))
    note.focus()
    clock += 150
    await frameTakesFocus()
    expect(document.activeElement).toBe(note)
  })

  it('Tab into the frame keeps focus there', async () => {
    note.focus()
    clock += 150
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
    clock += 50
    await frameTakesFocus()
    expect(document.activeElement).toBe(frame)
  })

  it('stopped, it no longer interferes', async () => {
    stop()
    note.focus()
    clock += 150
    await frameTakesFocus()
    expect(document.activeElement).toBe(frame)
  })
})
