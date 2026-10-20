// @vitest-environment node
// The web right-click menu, built from the click's params (webContextMenu.ts).
import { describe, it, expect, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: {}, Menu: class {}, MenuItem: class {}, clipboard: {}, shell: {}, app: {}, ipcMain: { handle: () => undefined } }))
import { buildWebMenu, type WebMenuParams, type WebMenuContext } from '../../src/main/webContextMenu'

const flags = { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: false }
const base: WebMenuParams = { x: 1, y: 2, linkURL: '', srcURL: '', mediaType: 'none', selectionText: '', isEditable: false, editFlags: flags, misspelledWord: '', dictionarySuggestions: [] }
const ctx = (surface: WebMenuContext['surface'], extra: Partial<WebMenuContext> = {}): WebMenuContext => ({ surface, canGoBack: true, canGoForward: false, dev: false, ...extra })
const labels = (e: ReturnType<typeof buildWebMenu>) => e.map((x) => ('type' in x ? '—' : x.label))

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

  it('selected text: Copy', () => {
    expect(labels(buildWebMenu({ ...base, selectionText: 'hello' }, ctx('browser')))).toEqual(['Copy'])
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
    for (const p of [base, { ...base, linkURL: 'https://x.y' }, { ...base, isEditable: true }, { ...base, selectionText: 'a' }]) {
      for (const s of ['desk', 'browser'] as const) {
        const l = labels(buildWebMenu(p, ctx(s, { dev: true })))
        expect(l[0]).not.toBe('—')
        expect(l.at(-1)).not.toBe('—')
        expect(l.join('|')).not.toContain('—|—')
      }
    }
  })
})
