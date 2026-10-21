// The app menu's Edit › Cut / Copy / Paste (Electron roles, which fire DOM
// clipboard events) drive PlexiiDraw's own commands, and never double up with
// the keys.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  setDrawClipboardBackend,
  type ClipboardReadResult,
  type ClipboardWriteInput,
  type DrawClipboardBackend
} from '../../../src/renderer/src/components/documents/draw/editor/clipboard'
import { clipboardEventInfo, handleClipboardEvent } from '../../../src/renderer/src/components/documents/draw/editor/menuClipboard'
import { blank, harness, rect } from './harness'

class Clip implements DrawClipboardBackend {
  written: ClipboardWriteInput[] = []
  next: ClipboardReadResult = {}
  async write(input: ClipboardWriteInput): Promise<{ ok: boolean }> {
    this.written.push(input)
    this.next = { native: input.json }
    return { ok: true }
  }
  async read(): Promise<ClipboardReadResult> {
    return this.next
  }
  async rasterize(): Promise<string | null> {
    return null
  }
}

let cb: Clip
beforeEach(() => {
  cb = new Clip()
  setDrawClipboardBackend(cb)
})
afterEach(() => {
  setDrawClipboardBackend(null)
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
})

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

function ev(over: Partial<{ inField: boolean; textSelected: boolean }> = {}): { inField: boolean; textSelected: boolean; preventDefault: () => void; prevented: boolean } {
  const e = { inField: false, textSelected: false, prevented: false, preventDefault: () => (e.prevented = true), ...over }
  return e
}

describe('Edit menu (app menu bar) → Draw commands', () => {
  it('menu Copy, Cut and Paste run Draw’s commands: one write each, one undo step each', async () => {
    const h = harness(blank([rect('a', 10, 10, 20, 20)]))
    h.ed.ctx.select(['a'])
    const c = ev()
    expect(handleClipboardEvent(h.ed.ctx, 'copy', c)).toBe(true)
    await settle()
    expect(c.prevented).toBe(true)
    expect(cb.written).toHaveLength(1)
    expect(handleClipboardEvent(h.ed.ctx, 'paste', ev())).toBe(true)
    await settle()
    expect(h.objects()).toHaveLength(2)
    expect(handleClipboardEvent(h.ed.ctx, 'cut', ev())).toBe(true)
    await settle()
    expect(cb.written).toHaveLength(2)
    expect(h.objects()).toHaveLength(1)
    expect(h.state().past.map((p) => p.label)).toEqual(['Paste', 'Cut'])
  })

  it('the browser keeps the event when a field has focus, page text is selected, a dialog is open, or there is nothing to copy', () => {
    const h = harness(blank([rect('a', 10, 10, 20, 20)]))
    const none = ev()
    expect(handleClipboardEvent(h.ed.ctx, 'copy', none)).toBe(false)
    expect(none.prevented).toBe(false)
    h.ed.ctx.select(['a'])
    for (const e of [ev({ inField: true }), ev({ textSelected: true })]) {
      expect(handleClipboardEvent(h.ed.ctx, 'copy', e)).toBe(false)
      expect(e.prevented).toBe(false)
    }
    h.ed.ctx.set({ dialog: { id: 'help' } })
    expect(handleClipboardEvent(h.ed.ctx, 'paste', ev())).toBe(false)
    expect(cb.written).toHaveLength(0)
  })

  it('read-only: menu Copy still copies; Cut and Paste are left alone', async () => {
    const h = harness({ ...blank([rect('a', 0, 0, 10, 10)]), schemaVersion: 3 })
    h.ed.ctx.select(['a'])
    expect(handleClipboardEvent(h.ed.ctx, 'copy', ev())).toBe(true)
    await settle()
    expect(cb.written).toHaveLength(1)
    expect(handleClipboardEvent(h.ed.ctx, 'cut', ev())).toBe(false)
    expect(handleClipboardEvent(h.ed.ctx, 'paste', ev())).toBe(false)
  })

  it('no double firing: ⌘C / ⌘X / ⌘V that Draw handles are prevented on keydown, so Chromium sends neither the menu accelerator nor a clipboard event', async () => {
    const h = harness(blank([rect('a', 10, 10, 20, 20)]))
    h.ed.ctx.select(['a'])
    expect(h.key('c', { meta: true }).prevented).toBe(true)
    expect(h.key('v', { meta: true }).prevented).toBe(true)
    expect(h.key('x', { meta: true }).prevented).toBe(true)
    await settle()
    // ⌘C with nothing selected is NOT prevented: it goes on to the menu, whose
    // copy event Draw then declines (nothing to copy), so the browser copies.
    h.ed.ctx.select([])
    expect(h.key('c', { meta: true }).prevented).toBe(false)
    expect(handleClipboardEvent(h.ed.ctx, 'copy', ev())).toBe(false)
  })

  it('reads the DOM: a field target, a selection of page text, or neither', () => {
    document.body.innerHTML = '<input id="f"><p id="p">some page text</p><div id="d"></div>'
    const at = (id: string): Event => {
      const e = new Event('copy', { bubbles: true, cancelable: true })
      document.getElementById(id)!.dispatchEvent(e)
      return e
    }
    expect(clipboardEventInfo(at('f'))).toMatchObject({ inField: true, textSelected: false })
    expect(clipboardEventInfo(at('d'))).toMatchObject({ inField: false, textSelected: false })
    const r = document.createRange()
    r.selectNodeContents(document.getElementById('p')!)
    window.getSelection()!.addRange(r)
    expect(clipboardEventInfo(at('d'))).toMatchObject({ textSelected: true })
    const e = at('d')
    clipboardEventInfo(e).preventDefault()
    expect(e.defaultPrevented).toBe(true)
  })
})
