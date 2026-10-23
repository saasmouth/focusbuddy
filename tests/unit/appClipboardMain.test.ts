/**
 * @vitest-environment node
 */
// The main-process reader for a cross-app paste (src/main/appClipboard.ts):
// Chromium's pickled web custom data (the real bytes a renderer copy event
// wrote on macOS, captured from the app), only our own private types handed
// back, HTML read, Draw's flavours through readDrawClipboard, and never
// getType('image/svg+xml') (it never settles on macOS).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ items: [] as Array<{ types: string[]; data: Record<string, Buffer> }>, asked: [] as string[] }))

vi.mock('electron', () => {
  const nativeImage = {
    createFromBuffer: (b: Buffer) => {
      const ok = b.length > 4 && b.subarray(0, 4).toString('hex') === '89504e47'
      return { isEmpty: () => !ok, getSize: () => ({ width: 64, height: 32 }), toPNG: () => b }
    }
  }
  const clipboard = {
    write: async () => undefined,
    read: async () =>
      state.items.map((it) => ({
        types: it.types,
        getType: async (t: string) => {
          state.asked.push(t)
          if (t === 'image/svg+xml') return new Promise(() => {})
          const b = it.data[t]
          if (!b) throw new Error(`The type '${t}' was not found in the ClipboardItem`)
          return new Blob([new Uint8Array(b)])
        }
      }))
  }
  return { clipboard, ClipboardItem: class {}, nativeImage, BrowserWindow: class {}, dialog: {} }
})

import { ourCustomTypes, parseWebCustomData, readAppClipboard, webCustomDataTypeIn } from '../../src/main/appClipboard'
import { DRAW_CLIPBOARD_NATIVE } from '../../src/shared/draw/clipboardFormat'

const raw = (f: string): string => `electron application/osclipboard;format="${f}"`
/** Captured from the app: a copy event setting application/x-plexii-elements to {"kind":"plexii/elements","version":1}. */
const CAPTURED =
  'lAAAAAEAAAAdAAAAYQBwAHAAbABpAGMAYQB0AGkAbwBuAC8AeAAtAHAAbABlAHgAaQBpAC0AZQBsAGUAbQBlAG4AdABzAAAAJgAAAHsAIgBrAGkAbgBkACIAOgAiAHAAbABlAHgAaQBpAC8AZQBsAGUAbQBlAG4AdABzACIALAAiAHYAZQByAHMAaQBvAG4AIgA6ADEAfQA='

/** Build a pickle the way Chromium does, for pairs the capture does not cover. */
function pickle(pairs: Array<[string, string]>): Buffer {
  const parts: Buffer[] = []
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(n)
    return b
  }
  const s16 = (s: string): Buffer => {
    const body = Buffer.from(s, 'utf16le')
    const pad = (4 - (body.length % 4)) % 4
    return Buffer.concat([u32(s.length), body, Buffer.alloc(pad)])
  }
  parts.push(u32(pairs.length))
  for (const [k, v] of pairs) parts.push(s16(k), s16(v))
  const payload = Buffer.concat(parts)
  return Buffer.concat([u32(payload.length), payload])
}

beforeEach(() => {
  state.items = []
  state.asked = []
})

describe('Chromium web custom data', () => {
  it('parses the bytes the app really wrote', () => {
    expect(parseWebCustomData(Buffer.from(CAPTURED, 'base64'))).toEqual({ 'application/x-plexii-elements': '{"kind":"plexii/elements","version":1}' })
  })

  it('parses several pairs, odd lengths padded, and non-ASCII text', () => {
    const pairs: Array<[string, string]> = [['application/x-plexii-diagram', '{"a":1}'], ['text/x-other', 'Café ✓ 中']]
    expect(parseWebCustomData(pickle(pairs))).toEqual(Object.fromEntries(pairs))
  })

  it('a short or corrupt blob gives what was read cleanly, never a throw', () => {
    const full = pickle([['a', 'one'], ['b', 'two']])
    expect(parseWebCustomData(full.subarray(0, full.length - 3))).toEqual({ a: 'one' })
    expect(parseWebCustomData(Buffer.from([1, 2, 3]))).toEqual({})
    const lying = Buffer.from(full)
    lying.writeUInt32LE(0xffffffff, 8) // first string claims to be enormous
    expect(parseWebCustomData(lying)).toEqual({})
  })

  it('hands back only our own private types', () => {
    expect(ourCustomTypes({ 'application/x-plexii-elements': '1', 'application/x-plexii-diagram': '2', 'text/html': 'x', 'application/x-other': 'y' })).toEqual({
      'application/x-plexii-elements': '1',
      'application/x-plexii-diagram': '2'
    })
  })

  it('finds the raw flavour by its name on every platform', () => {
    expect(webCustomDataTypeIn(['text/plain', raw('org.chromium.web-custom-data')])).toBe(raw('org.chromium.web-custom-data'))
    expect(webCustomDataTypeIn([raw('Chromium Web Custom MIME Data Format')])).toBeTruthy()
    expect(webCustomDataTypeIn([raw('chromium/x-web-custom-data')])).toBeTruthy()
    expect(webCustomDataTypeIn(['text/plain'])).toBeUndefined()
  })
})

describe('readAppClipboard', () => {
  it('a Deck copy: our elements, its text and HTML', async () => {
    state.items = [
      {
        types: ['text/plain', 'text/html', raw('org.chromium.web-custom-data')],
        data: { 'text/plain': Buffer.from('Hello'), 'text/html': Buffer.from('<b>Hello</b>'), [raw('org.chromium.web-custom-data')]: Buffer.from(CAPTURED, 'base64') }
      }
    ]
    const r = await readAppClipboard()
    expect(r.custom).toEqual({ 'application/x-plexii-elements': '{"kind":"plexii/elements","version":1}' })
    expect(r.text).toBe('Hello')
    expect(r.html).toBe('<b>Hello</b>')
    expect(r.error).toBeUndefined()
  })

  it('a PlexiiDraw copy: native JSON, SVG through its raw flavour (never image/svg+xml), and the PNG', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    state.items = [
      {
        types: [DRAW_CLIPBOARD_NATIVE, 'image/svg+xml', raw('public.svg-image'), 'image/png'],
        data: { [DRAW_CLIPBOARD_NATIVE]: Buffer.from('{"kind":"plexiidraw/clipboard"}'), [raw('public.svg-image')]: Buffer.from('<svg/>'), 'image/png': png }
      }
    ]
    const r = await readAppClipboard()
    expect(r.drawNative).toBe('{"kind":"plexiidraw/clipboard"}')
    expect(r.svg).toBe('<svg/>')
    expect(r.image?.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(state.asked).not.toContain('image/svg+xml')
  })

  it('an empty clipboard reads as nothing, not an error', async () => {
    expect(await readAppClipboard()).toEqual({})
  })
})
