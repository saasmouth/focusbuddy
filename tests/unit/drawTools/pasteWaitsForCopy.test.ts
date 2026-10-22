// ⌘C then ⌘V at once: the paste must wait for the copy to reach the system
// clipboard. A copy draws the art as a picture first (slow with photos or on
// a busy machine); a paste read in that gap used to get the clipboard as it
// was before the copy -- the old contents, or nothing -- and silently paste
// nothing (d8's PP-3 red, 4.3.41).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  setDrawClipboardBackend,
  type ClipboardReadResult,
  type ClipboardWriteInput,
  type DrawClipboardBackend
} from '../../../src/renderer/src/components/documents/draw/editor/clipboard'
import { blank, harness, rect } from './harness'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** A clipboard whose picture takes a while to draw, holding something else until the copy lands. */
class SlowClipboard implements DrawClipboardBackend {
  current: ClipboardReadResult = { text: 'something another app copied earlier' }
  release: (() => void) | null = null
  reads = 0
  async rasterize(): Promise<string | null> {
    await new Promise<void>((r) => (this.release = r))
    return PNG
  }
  async write(input: ClipboardWriteInput): Promise<{ ok: boolean }> {
    this.current = { native: input.json, svg: input.svg, text: input.svg }
    return { ok: true }
  }
  async read(): Promise<ClipboardReadResult> {
    this.reads += 1
    return this.current
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

let cb: SlowClipboard
beforeEach(() => {
  cb = new SlowClipboard()
  setDrawClipboardBackend(cb)
})
afterEach(() => setDrawClipboardBackend(null))

describe('Paste right after Copy', () => {
  it('waits for the copy, then pastes the copied art (not what the clipboard held before)', async () => {
    const h = harness(blank([rect('a', 10, 10, 40, 40)]))
    h.ed.ctx.select(['a'])
    h.run('edit.copy')
    h.run('edit.paste')
    await settle()
    // The copy is still drawing its picture: the paste has not read yet, and nothing was pasted.
    expect(cb.reads).toBe(0)
    expect(h.objects()).toHaveLength(1)
    cb.release!()
    await settle()
    expect(cb.reads).toBe(1)
    expect(h.objects()).toHaveLength(2)
    expect(h.state().past.map((p) => p.label)).toEqual(['Paste'])
  })

  it('a paste with no copy in flight reads straight away', async () => {
    const h = harness(blank([rect('a', 10, 10, 40, 40)]))
    h.run('edit.paste')
    await settle()
    expect(cb.reads).toBe(1)
  })
})
