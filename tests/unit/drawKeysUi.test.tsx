// WP-KEYS on screen: the studio mounted with the real keyboard listener. The
// one-time notice (what moved, See all shortcuts, dismissed per profile), the
// Keyboard shortcuts dialog (grouped, searchable, remapping with clash
// checks), and typing into text never firing a shortcut.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))
vi.mock('../../src/renderer/src/lib/googleFonts', () => ({
  loadGoogleFont: vi.fn(),
  familyLabel: (v: string | undefined) => v ?? 'Default',
  fontFamilyValue: (v: string) => v,
  GOOGLE_FONTS: []
}))
vi.mock('../../src/renderer/src/components/documents/draw/raster', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../src/renderer/src/components/documents/draw/raster')
  >()),
  loadIntoCanvas: vi.fn(async () => {})
}))

import DrawStudio from '../../src/renderer/src/components/documents/DrawStudio'
import { NOTICE_STORAGE_KEY } from '../../src/renderer/src/components/documents/draw/commands/keyChanges'
import {
  keyOverrides,
  OVERRIDES_STORAGE_KEY,
  reloadKeyOverrides,
  setKeyOverrides,
  setKeyPlatform
} from '../../src/renderer/src/components/documents/draw/commands/keys'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  ;(HTMLElement.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture =
    () => {}
  localStorage.clear()
  reloadKeyOverrides()
  setKeyPlatform('mac')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setKeyOverrides({ commands: {}, tools: {} })
})

const body = (objects: unknown[] = []): Record<string, unknown> => ({
  schemaVersion: 1,
  width: 400,
  height: 300,
  background: { type: 'solid', color: '#ffffff' },
  activeLayerId: 'L1',
  layers: [
    {
      id: 'L1',
      kind: 'vector',
      name: 'Layer 1',
      visible: true,
      locked: false,
      opacity: 1,
      blend: 'normal',
      objects
    }
  ]
})

async function mount(content: unknown = body()): Promise<void> {
  await act(async () => {
    root.render(<DrawStudio content={content} title="t" onChange={() => {}} />)
  })
}

const $ = (sel: string): HTMLElement | null => host.querySelector(sel)
const testid = (id: string): HTMLElement | null => $(`[data-testid="${id}"]`)

async function key(
  k: string,
  init: KeyboardEventInit = {},
  target: EventTarget = window
): Promise<KeyboardEvent> {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })
  await act(async () => {
    target.dispatchEvent(e)
  })
  return e
}

async function clickEl(el: HTMLElement | null): Promise<void> {
  expect(el).not.toBeNull()
  await act(async () => {
    el!.click()
  })
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const pressed = (id: string): string | null =>
  testid(`draw-tool-${id}`)!.getAttribute('aria-pressed')

describe('the one-time notice', () => {
  it('names itself, lists exactly the ten keys that moved, old → new, and stays gone once dismissed', async () => {
    await mount()
    const notice = testid('draw-keys-notice')!
    expect(notice.textContent).toContain('PlexiiDraw now uses Illustrator’s shortcuts')
    const items = [...notice.querySelectorAll('li')].map((li) =>
      li.textContent!.replace(/\s+/g, ' ').trim()
    )
    expect(items).toEqual([
      'Rectangle R → M (R is Rotate in Illustrator)',
      'Ellipse O → L (O is Reflect)',
      'Line L → \\',
      'Eraser E → ⇧E (E is Free Transform)',
      'Paint bucket G → K (G is the Gradient tool)',
      'Rounded rectangle D → no key (pick it in the toolbox)',
      'Polygon U → no key (pick it in the toolbox)',
      'Star S → no key (pick it in the toolbox; S is Scale)',
      'Duplicate ⌘D → no key (Edit › Duplicate; ⌘D is now Transform again)',
      'Redo ⌘Y → no key (⇧⌘Z still redoes; ⌘Y is Outline view in Illustrator)'
    ])
    await clickEl(testid('draw-keys-notice-dismiss'))
    expect(testid('draw-keys-notice')).toBeNull()
    expect(localStorage.getItem(NOTICE_STORAGE_KEY)).toBe('dismissed')
    // The next time PlexiiDraw opens on this profile, it does not come back.
    act(() => root.unmount())
    root = createRoot(host)
    await mount()
    expect(testid('draw-keys-notice')).toBeNull()
    expect(testid('draw-studio')).not.toBeNull()
  })

  it('on Windows it speaks Ctrl', async () => {
    setKeyPlatform('win')
    await mount()
    expect(testid('draw-keys-notice-change-edit.duplicate')!.textContent).toContain(
      'Ctrl+D → no key (Edit › Duplicate; Ctrl+D is now Transform again)'
    )
    expect(testid('draw-keys-notice-change-eraser')!.textContent).toContain('E → Shift+E')
  })

  it('"See all shortcuts" opens the Keyboard shortcuts dialog, and the notice stays until dismissed', async () => {
    await mount()
    await clickEl(testid('draw-keys-notice-see-all'))
    expect(testid('draw-shortcuts-dialog')).not.toBeNull()
    expect(testid('draw-keys-notice')).not.toBeNull()
    await key('Escape')
    expect(testid('draw-shortcuts-dialog')).toBeNull()
  })
})

describe('the Keyboard shortcuts dialog', () => {
  async function open(): Promise<void> {
    await mount()
    await key('˚', { metaKey: true, altKey: true, shiftKey: true, code: 'KeyK' })
    expect(testid('draw-shortcuts-dialog')).not.toBeNull()
  }
  const rowText = (id: string): string =>
    (testid(`draw-shortcut-row-${id}`)?.textContent ?? '').replace(/\s+/g, ' ').trim()

  it('opens on ⌥⇧⌘K with Tools first, then Menu commands grouped by menu; still-to-come keys say when they arrive', async () => {
    await open()
    expect(testid('draw-shortcuts-set')!.textContent).toBe('Illustrator defaults')
    expect(rowText('tool:rect')).toBe('RectangleM')
    expect(rowText('tool:roundRect')).toBe('Rounded rectanglenone')
    expect(rowText('reserved:tool:gradient')).toBe('Gradient toolArrives with gradients and patternsG')
    await clickEl(testid('draw-shortcuts-group-menu'))
    const heads = [...host.querySelectorAll('[data-testid="draw-shortcuts-list"] h4')].map(
      (h) => h.textContent
    )
    expect(heads.slice(0, 6)).toEqual(['File', 'File › New from preset', 'File › Download', 'Edit', 'Edit › Copy As', 'Object'])
    expect(heads).toContain('Canvas keys')
    expect(heads[heads.length - 1]).toBe('From Illustrator, still to come')
    expect(rowText('command:object.transformAgain')).toBe('Transform Again⌘D')
    expect(rowText('command:edit.undo')).toBe('Undo⌘Z')
  })

  it('search covers both groups, by name or by key, and says when nothing matches', async () => {
    await open()
    const search = testid('draw-shortcuts-search') as HTMLInputElement
    expect(document.activeElement).toBe(search)
    await typeInto(search, '⌘D')
    expect(
      [...host.querySelectorAll('[data-testid^="draw-shortcut-row-"]')].map((r) =>
        r.getAttribute('data-testid')
      )
    ).toEqual(['draw-shortcut-row-command:object.transformAgain'])
    await typeInto(search, 'eraser')
    expect(rowText('tool:eraser')).toBe('Eraser⇧E')
    // Typing in the search box never fires a shortcut: 'm' did not switch tools.
    await key('m', {}, search)
    expect(pressed('select')).toBe('true')
    await typeInto(search, 'xyzzy')
    expect(testid('draw-shortcuts-empty')!.textContent).toContain('No shortcut matches “xyzzy”')
  })

  it('remaps a tool key: refuses a clash, notes an Illustrator key, saves per profile, and resets', async () => {
    await open()
    await clickEl(testid('draw-shortcut-edit-tool:rect'))
    let rec = testid('draw-shortcut-recorder') as HTMLInputElement
    await key('V', { code: 'KeyV' }, rec)
    expect(testid('draw-shortcut-message')!.textContent).toBe(
      'V is already used by the Select tool.'
    )
    expect(keyOverrides().tools).toEqual({})
    await key('G', { code: 'KeyG' }, rec)
    expect(testid('draw-shortcut-message')!.textContent).toBe(
      'Illustrator uses G for Gradient tool, which PlexiiDraw does not have yet.'
    )
    expect(keyOverrides().tools).toEqual({ rect: 'g' })
    expect(JSON.parse(localStorage.getItem(OVERRIDES_STORAGE_KEY)!).tools).toEqual({ rect: 'g' })
    expect(testid('draw-shortcuts-set')!.textContent).toBe('Illustrator defaults, changed')
    expect(rowText('tool:rect')).toContain('G')
    // The canvas answers to the new key once the dialog is closed.
    await key('Escape')
    await key('g')
    expect(pressed('rect')).toBe('true')
    // The rail's tooltip (and accessible name) shows the live key.
    expect(testid('draw-tool-rect')!.getAttribute('aria-label')).toBe('Rectangle (G)')
    // Reset all brings Illustrator's key back.
    await key('˚', { metaKey: true, altKey: true, shiftKey: true, code: 'KeyK' })
    await clickEl(testid('draw-shortcuts-reset-all'))
    expect(keyOverrides()).toEqual({ commands: {}, tools: {} })
    expect(localStorage.getItem(OVERRIDES_STORAGE_KEY)).toBeNull()
    expect(rowText('tool:rect')).toBe('RectangleM')
    // A command: give Duplicate ⌥⌘D, then take it away again with Reset.
    await clickEl(testid('draw-shortcuts-group-menu'))
    await clickEl(testid('draw-shortcut-edit-command:edit.duplicate'))
    rec = testid('draw-shortcut-recorder') as HTMLInputElement
    await key('∂', { metaKey: true, altKey: true, code: 'KeyD' }, rec)
    expect(keyOverrides().commands).toEqual({ 'edit.duplicate': 'mod+alt+d' })
    expect(rowText('command:edit.duplicate')).toContain('⌥⌘D')
    await clickEl(testid('draw-shortcut-reset-command:edit.duplicate'))
    expect(keyOverrides().commands).toEqual({})
  })
})

describe('typing never fires a shortcut', () => {
  it('letters, Delete and ⌘D typed into the text box on the canvas stay in the text', async () => {
    await mount(
      body([
        {
          id: 't',
          type: 'text',
          x: 10,
          y: 10,
          w: 200,
          h: 40,
          text: 'Hi',
          fontSize: 20,
          fill: { type: 'solid', color: '#000000' }
        }
      ])
    )
    await key('t')
    expect(pressed('text')).toBe('true')
    const stage = testid('draw-stage')!
    await act(async () => {
      stage.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          clientX: 300,
          clientY: 200,
          button: 0,
          pointerId: 1
        })
      )
      stage.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          cancelable: true,
          clientX: 300,
          clientY: 200,
          button: 0,
          pointerId: 1
        })
      )
    })
    const box = testid('draw-text-editor') as HTMLTextAreaElement
    expect(box).not.toBeNull()
    // Dropping a box hands back to Select, as the type tool always has.
    expect(pressed('select')).toBe('true')
    for (const k of ['m', 'l', 'k', 'v', 'Delete', 'Backspace']) {
      const e = await key(k, {}, box)
      expect(e.defaultPrevented, k).toBe(false)
    }
    const d = await key('d', { metaKey: true }, box)
    expect(d.defaultPrevented).toBe(false)
    expect(pressed('select')).toBe('true')
    expect(testid('draw-text-editor')).not.toBeNull()
  })
})
