// @vitest-environment node
// The web right-click menu, built from the click's params (webContextMenu.ts).
import { describe, it, expect, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: {}, Menu: class {}, MenuItem: class {}, clipboard: {}, shell: {}, app: {}, ipcMain: { handle: () => undefined } }))
import { buildWebMenu, flattenWebMenu, deskCommandFor, DESKS_LISTED, type WebMenuParams, type WebMenuContext } from '../../src/main/webContextMenu'

const flags = { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: false }
const base: WebMenuParams = { x: 1, y: 2, linkURL: '', srcURL: '', mediaType: 'none', selectionText: '', isEditable: false, editFlags: flags, misspelledWord: '', dictionarySuggestions: [] }
const ctx = (surface: WebMenuContext['surface'], extra: Partial<WebMenuContext> = {}): WebMenuContext => ({ surface, canGoBack: true, canGoForward: false, dev: false, ...extra })
const labels = (e: ReturnType<typeof buildWebMenu>) => e.map((x) => ('type' in x ? '—' : x.label))
const desks = (n: number): NonNullable<WebMenuContext['desks']> => {
  const all = Array.from({ length: n }, (_, i) => ({ id: `d${i}`, title: i === 1 ? '' : `Desk ${i}` }))
  return { listed: all.slice(0, DESKS_LISTED), more: all.length > DESKS_LISTED }
}

describe('web right-click menu', () => {
  it('empty page: Back / Forward / Reload, history-aware', () => {
    const m = buildWebMenu(base, ctx('browser'))
    expect(labels(m)).toEqual(['Back', 'Forward', 'Reload', '—', 'Select all'])
    expect(m.find((x) => 'id' in x && x.id === 'forward')).toMatchObject({ enabled: false })
  })

  it('a link: open here in the standalone browser, as a new work widget on a desk', () => {
    const p = { ...base, linkURL: 'https://example.com/a' }
    expect(labels(buildWebMenu(p, ctx('browser')))).toEqual(['Open link', 'Open link in default browser', 'Copy link address'])
    expect(labels(buildWebMenu(p, ctx('desk')))).toEqual([
      'Open link as a new browser work widget',
      'Open link in default browser',
      'Copy link address',
      '—',
      'More work widget actions…'
    ])
  })

  it('an image', () => {
    const p = { ...base, mediaType: 'image' as const, srcURL: 'https://example.com/i.png' }
    expect(labels(buildWebMenu(p, ctx('connected-app')))).toEqual(['Save image as…', 'Copy image', 'Copy image address'])
  })

  it('an image inside a link gets both', () => {
    const p = { ...base, linkURL: 'https://example.com/a', mediaType: 'image' as const, srcURL: 'https://example.com/i.png' }
    expect(labels(buildWebMenu(p, ctx('popup')))).toEqual(['Open link', 'Open link in default browser', 'Copy link address', '—', 'Save image as…', 'Copy image', 'Copy image address'])
  })

  it('selected text: Copy, then PlexiiAssist and AI Assist on the browser surfaces only', () => {
    const p = { ...base, selectionText: 'hello' }
    expect(labels(buildWebMenu(p, ctx('browser')))).toEqual(['Copy', '—', 'Ask PlexiiAssist about this', 'AI Assist'])
    for (const s of ['connected-app', 'popup'] as const) expect(labels(buildWebMenu(p, ctx(s)))).toEqual(['Copy'])
    const ai = flattenWebMenu(buildWebMenu(p, ctx('browser'))).filter((e) => e.path[0] === 'AI Assist')
    expect(ai.filter((e) => e.path.length === 1).map((e) => e.label)).toEqual(['Summarise', 'Explain', 'Simplify', 'Rewrite', 'Custom Prompt…'])
    expect(ai.find((e) => e.id === 'ai:translate:French')?.path).toEqual(['AI Assist', 'Translate'])
    expect(ai.find((e) => e.id === 'ai:tone:Formal')?.path).toEqual(['AI Assist', 'Change Tone'])
  })

  it('Add to desk: one submenu per thing clicked, New desk… first, then recent desks', () => {
    const p = { ...base, selectionText: 'hello', linkURL: 'https://e.x/a', mediaType: 'image' as const, srcURL: 'https://e.x/i.png' }
    const m = buildWebMenu(p, ctx('browser', { desks: desks(3) }))
    expect(labels(m).slice(-3)).toEqual(['Add selection to desk', 'Add link to desk', 'Add image to desk'])
    const sub = m.find((e) => 'submenu' in e && e.label === 'Add image to desk') as { submenu: ReturnType<typeof buildWebMenu> }
    expect(labels(sub.submenu)).toEqual(['New desk…', '—', 'Desk 0', 'Untitled desk', 'Desk 2'])
    expect(flattenWebMenu(sub.submenu).map((e) => e.id)).toEqual(['desk:image:new', 'desk:image:d0', 'desk:image:d1', 'desk:image:d2'])
  })

  it('Add to desk: many desks list the most recent and offer the searchable picker', () => {
    const m = buildWebMenu(base, ctx('desk', { desks: desks(20) }))
    const sub = m.find((e) => 'submenu' in e && e.label === 'Add page to desk') as { submenu: ReturnType<typeof buildWebMenu> }
    const l = labels(sub.submenu)
    expect(l.filter((x) => x.startsWith('Desk '))).toHaveLength(DESKS_LISTED - 1) // one is Untitled
    expect(l.at(-1)).toBe('Choose a desk…')
    // The desk's own work widget actions still close the menu.
    expect(labels(m).at(-1)).toBe('More work widget actions…')
  })

  it('a video: Add video to desk, and its address only when it has one', () => {
    const streamed = buildWebMenu({ ...base, mediaType: 'video', srcURL: 'blob:https://e.x/1' }, ctx('browser', { desks: desks(1) }))
    expect(labels(streamed)).toEqual(['Add video to desk'])
    const file = buildWebMenu({ ...base, mediaType: 'video', srcURL: 'https://e.x/v.mp4' }, ctx('browser', { desks: desks(1) }))
    expect(labels(file)).toEqual(['Copy video address', '—', 'Add video to desk'])
  })

  it('Add to desk never reaches connected apps, pop-ups or editable fields', () => {
    for (const s of ['connected-app', 'popup'] as const) {
      expect(labels(buildWebMenu({ ...base, selectionText: 'x' }, ctx(s, { desks: desks(2) }))).join('|')).not.toMatch(/desk|PlexiiAssist|AI Assist/)
    }
    expect(labels(buildWebMenu({ ...base, isEditable: true, selectionText: 'x' }, ctx('browser', { desks: desks(2) }))).join('|')).not.toMatch(/desk|AI Assist/)
  })

  it('an Add to desk item becomes the command for what was clicked', () => {
    const page = { url: 'https://e.x/page', title: 'Page' }
    const p = { selectionText: '  quoted words ', linkURL: 'https://e.x/l', srcURL: 'blob:https://e.x/v', mediaType: 'video' as const }
    expect(deskCommandFor('desk:selection:d1', p, page)).toMatchObject({ command: 'add-to-desk', target: 'selection', desk: 'd1', text: 'quoted words', pageUrl: page.url })
    expect(deskCommandFor('desk:link:new', p, page)).toMatchObject({ target: 'link', desk: 'new', url: 'https://e.x/l' })
    // A streamed video has no fetchable address: the page goes on the desk instead.
    expect(deskCommandFor('desk:video:choose', p, page)).toMatchObject({ target: 'video', desk: 'choose', url: undefined })
    expect(deskCommandFor('desk:page:d2', p, page)).toMatchObject({ target: 'page', url: page.url })
    expect(deskCommandFor('desk:page:d2', p, { url: 'about:blank', title: '' })).toBeNull()
  })

  it('an editable field: spelling first, then edit items enabled by editFlags', () => {
    const p = { ...base, isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten'] }
    const m = buildWebMenu(p, ctx('browser'))
    expect(labels(m)).toEqual(['the', 'ten', 'Add to dictionary', '—', 'Undo', 'Redo', '—', 'Cut', 'Copy', 'Paste', 'Select all'])
    expect(m.find((x) => 'id' in x && x.id === 'redo')).toMatchObject({ enabled: false })
    expect(m.find((x) => 'id' in x && x.id === 'spelling:the')).toBeTruthy()
  })

  it('desk-only items never leak to other surfaces; Inspect only in development', () => {
    for (const s of ['browser', 'connected-app', 'popup'] as const) {
      expect(labels(buildWebMenu(base, ctx(s))).join('|')).not.toMatch(/work widget/)
    }
    expect(labels(buildWebMenu(base, ctx('browser')))).not.toContain('Inspect element')
    expect(labels(buildWebMenu(base, ctx('browser', { dev: true })))).toContain('Inspect element')
  })

  it('never a bare separator at either end, never two in a row', () => {
    for (const p of [base, { ...base, linkURL: 'https://x.y' }, { ...base, isEditable: true }, { ...base, selectionText: 'a' }, { ...base, mediaType: 'video' as const }]) {
      for (const s of ['desk', 'browser'] as const) {
        const l = labels(buildWebMenu(p, ctx(s, { dev: true, desks: desks(2) })))
        expect(l[0]).not.toBe('—')
        expect(l.at(-1)).not.toBe('—')
        expect(l.join('|')).not.toContain('—|—')
      }
    }
  })
})
