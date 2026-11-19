// Files copied in Finder and pasted: the page puts them where the paste was
// aimed (src/renderer/src/lib/pastedFiles.ts).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { deliverPastedFiles, installPastedFilesRouter, PASTE_FILES_EVENT, pastedFilesOf, skippedNote, NOWHERE_NOTE } from '../../src/renderer/src/lib/pastedFiles'
import { useNoticeStore } from '../../src/renderer/src/stores/notice'
import type { PastedFilesPayload } from '../../src/shared/types'

const payload = (names: string[], skipped: PastedFilesPayload['skipped'] = []): PastedFilesPayload => ({
  files: names.map((name) => ({ name, mimeType: name.endsWith('.png') ? 'image/png' : 'application/pdf', bytes: new Uint8Array([1, 2, 3]) })),
  skipped
})

beforeEach(() => {
  document.body.innerHTML = ''
  useNoticeStore.getState().clear()
})

describe('pasted files go where the paste was aimed', () => {
  it('the place with focus that takes files gets them as files', () => {
    document.body.innerHTML = '<div id="tray"><div id="box" tabindex="0"></div></div>'
    const got: File[][] = []
    document.getElementById('tray')!.addEventListener(PASTE_FILES_EVENT, (e) => {
      got.push(pastedFilesOf(e))
      e.preventDefault()
    })
    ;(document.getElementById('box') as HTMLElement).focus()
    expect(deliverPastedFiles(payload(['Report.pdf', 'shot.png']))).toBe('taken')
    expect(got).toHaveLength(1)
    expect(got[0].map((f) => [f.name, f.type, f.size])).toEqual([
      ['Report.pdf', 'application/pdf', 3],
      ['shot.png', 'image/png', 3]
    ])
  })

  it('with nothing focused, the fallback place gets them; a focused place still wins', () => {
    document.body.innerHTML = '<div id="widget"><div id="inner"></div></div><div id="other" tabindex="0"></div>'
    const at: string[] = []
    document.getElementById('widget')!.addEventListener(PASTE_FILES_EVENT, (e) => {
      at.push((e.target as Element).id)
      e.preventDefault()
    })
    const fallback = (): Element | null => document.getElementById('widget')
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(deliverPastedFiles(payload(['shot.png']), document, fallback)).toBe('taken')
    expect(at).toEqual(['widget'])
    // Something focused elsewhere: the paste goes there, not to the active widget.
    ;(document.getElementById('other') as HTMLElement).focus()
    expect(deliverPastedFiles(payload(['shot.png']), document, fallback)).toBe('nowhere')
    expect(at).toEqual(['widget'])
    // No active widget either: the page itself, as before.
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(deliverPastedFiles(payload(['shot.png']), document, () => null)).toBe('nowhere')
  })

  it('the router: with nothing focused, the paste goes where the person last clicked', () => {
    document.body.innerHTML = '<div id="gallery"><div id="pic"></div></div><div id="desk"></div>'
    let deliver: ((p: PastedFilesPayload) => void) | null = null
    const w = window as unknown as { api?: unknown }
    const saved = w.api
    w.api = { pastedFiles: { onPaste: (cb: (p: PastedFilesPayload) => void) => ((deliver = cb), () => undefined) } }
    const stop = installPastedFilesRouter()
    try {
      const got: string[] = []
      document.getElementById('gallery')!.addEventListener(PASTE_FILES_EVENT, (e) => {
        got.push('gallery')
        e.preventDefault()
      })
      ;(document.activeElement as HTMLElement | null)?.blur()
      document.getElementById('pic')!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      deliver!(payload(['shot.png']))
      expect(got).toEqual(['gallery'])
      // A click elsewhere moves the aim.
      document.getElementById('desk')!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      deliver!(payload(['shot.png']))
      expect(got).toEqual(['gallery'])
      expect(useNoticeStore.getState().notice?.text).toBe(NOWHERE_NOTE)
    } finally {
      stop()
      w.api = saved
    }
  })

  it('in a text field nothing takes them: the names are typed in, as the platform pastes them there', () => {
    document.body.innerHTML = '<textarea id="t"></textarea>'
    ;(document.getElementById('t') as HTMLTextAreaElement).focus()
    const exec = vi.fn(() => true)
    document.execCommand = exec as unknown as typeof document.execCommand
    expect(deliverPastedFiles(payload(['Report.pdf', 'shot.png'], [{ name: 'movie.mov', reason: 'larger than 40 MB' }]))).toBe('text')
    expect(exec).toHaveBeenCalledWith('insertText', false, 'Report.pdf\nshot.png\nmovie.mov')
  })

  it('nowhere to put them: a notice says where files can be pasted', () => {
    expect(deliverPastedFiles(payload(['Report.pdf']))).toBe('nowhere')
    expect(useNoticeStore.getState().notice?.text).toBe(NOWHERE_NOTE)
  })

  it('files that could not be read are named, with why', () => {
    document.body.innerHTML = '<div id="tray" tabindex="0"></div>'
    document.getElementById('tray')!.addEventListener(PASTE_FILES_EVENT, (e) => e.preventDefault())
    ;(document.getElementById('tray') as HTMLElement).focus()
    expect(deliverPastedFiles(payload(['a.pdf'], [{ name: 'movie.mov', reason: 'larger than 40 MB' }]))).toBe('taken')
    expect(useNoticeStore.getState().notice?.text).toBe('Not pasted: “movie.mov” (larger than 40 MB).')
    expect(deliverPastedFiles(payload([], [{ name: 'Folder', reason: 'not a file' }]))).toBe('none')
    expect(skippedNote(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, reason: 'x' })))).toMatch(/and 2 more\.$/)
  })
})
