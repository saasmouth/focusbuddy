// View › Hide Artboards / Show Artboards (⇧⌘H, 4.3.41): a per-person view
// preference that never touches the drawing, its menu wording, its key, and
// the studio drawing no page fill or edge while it is on.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildMenu } from '../../../src/renderer/src/components/documents/editor/DrawStudioMenuBar'
import { ILLUSTRATOR_SHORTCUTS } from '../../../src/renderer/src/components/documents/draw/commands/illustratorKeys'
import { setKeyPlatform } from '../../../src/renderer/src/components/documents/draw/commands/keys'
import { KEYMAP } from '../../../src/renderer/src/components/documents/draw/commands/keymap'
import { keyBinding } from '../../../src/renderer/src/components/documents/draw/commands/registry'
import { resetShellPrefs, shellPrefs } from '../../../src/renderer/src/components/documents/draw/editor/shellPrefs'
import { drawDocToSvg } from '../../../src/shared/draw/svg'
import { blank, harness, rect } from './harness'

beforeEach(() => {
  setKeyPlatform('mac')
  resetShellPrefs()
})
afterEach(() => resetShellPrefs())

const viewItem = (h: ReturnType<typeof harness>) =>
  buildMenu(h.ed.ctx, 'view').find((i) => i.kind === 'item' && /Artboards$/.test(i.label) && /^(Hide|Show) /.test(i.label)) as { label: string; shortcut?: string } | undefined

describe('Hide Artboards / Show Artboards', () => {
  it('⇧⌘H is Illustrator’s key for it, bound to it and to nothing else', () => {
    expect(KEYMAP['mod+shift+h']).toEqual(['view.artboards', 'prevent'])
    expect(ILLUSTRATOR_SHORTCUTS.find((r) => r.key === 'mod+shift+h')).toMatchObject({ action: 'Show/Hide artboards', target: 'cmd:view.artboards' })
    expect(Object.entries(KEYMAP).filter(([, [id]]) => id === 'view.artboards').map(([k]) => k)).toEqual(['mod+shift+h'])
    expect(keyBinding({ key: 'H', code: 'KeyH', metaKey: true, ctrlKey: false, shiftKey: true })?.command).toBe('view.artboards')
  })

  it('the View menu says Hide, then Show, with the key; the key toggles it; the drawing is never edited or saved', () => {
    const h = harness(blank([rect('a', 10, 10, 40, 40)]))
    expect(viewItem(h)).toMatchObject({ label: 'Hide Artboards', shortcut: '⇧⌘H' })
    h.key('h', { meta: true, shift: true, code: 'KeyH' })
    expect(shellPrefs.getState().hideArtboards).toBe(true)
    expect(viewItem(h)!.label).toBe('Show Artboards')
    expect(h.state().status).toMatch(/Artboards hidden/)
    h.run('view.artboards')
    expect(shellPrefs.getState().hideArtboards).toBe(false)
    expect(viewItem(h)!.label).toBe('Hide Artboards')
    expect(h.state().past).toHaveLength(0)
    expect(h.emitted).toHaveLength(0)
  })

  it('works on a read-only drawing (it only changes the view)', () => {
    const h = harness(blank([rect('a', 10, 10, 40, 40)]))
    h.ed.store.setState({ readOnly: true })
    h.run('view.artboards')
    expect(shellPrefs.getState().hideArtboards).toBe(true)
  })

  it('export is unaffected: the page background is still written', () => {
    const h = harness(blank([rect('a', 10, 10, 40, 40)]))
    const before = drawDocToSvg(h.doc())
    h.run('view.artboards')
    expect(drawDocToSvg(h.doc())).toBe(before)
    expect(before).toContain('#ffffff')
  })

  it('is remembered for the person (localStorage), not in the drawing', () => {
    const h = harness(blank([rect('a', 10, 10, 40, 40)]))
    h.run('view.artboards')
    expect(JSON.parse(localStorage.getItem('plexii.draw.shell') ?? '{}').hideArtboards).toBe(true)
    expect(JSON.stringify(h.doc())).not.toContain('hideArtboards')
  })
})

