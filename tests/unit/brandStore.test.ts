// The brand store survives a malformed brand.get reply.
//
// PlexiiDesign reads `kit.fontHeading` on its first render, so a kit of
// `undefined` is a crash, not a missing colour. The IPC answers
// { kit, isSet }; anything else (an empty array from a catch-all test stub was
// how this was found, a null from a broken handler) must leave the kit the
// store already had and say so in the log, rather than replace it with nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BRAND_KIT, type OrgBrandKit } from '../../src/shared/brandKit'
import { useBrandStore } from '../../src/renderer/src/stores/brand'

const CUSTOM: OrgBrandKit = { colorPrimary: '#0f766e', fontHeading: 'Lora, serif', fontBody: 'Inter, sans-serif' }

function answer(reply: unknown): void {
  ;(window as unknown as { api: unknown }).api = { brand: { get: vi.fn().mockResolvedValue(reply), set: vi.fn() } }
}

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  useBrandStore.setState({ kit: DEFAULT_BRAND_KIT, isSet: false, loaded: false })
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
})

describe('brand store load: a well-formed reply', () => {
  it('takes the kit and isSet', async () => {
    answer({ kit: CUSTOM, isSet: true })
    await useBrandStore.getState().load()
    expect(useBrandStore.getState().kit).toEqual(CUSTOM)
    expect(useBrandStore.getState().isSet).toBe(true)
    expect(useBrandStore.getState().loaded).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('brand store load: a malformed reply keeps the kit it had', () => {
  const MALFORMED: Array<[string, unknown]> = [
    ['an empty array', []],
    ['null', null],
    ['an object with no kit', { isSet: true }],
    ['a kit that is not an object', { kit: 'blue', isSet: true }],
    ['a kit missing its fonts', { kit: { colorPrimary: '#000' }, isSet: true }]
  ]

  for (const [what, reply] of MALFORMED) {
    it(`${what}: the default stays, never undefined`, async () => {
      answer(reply)
      await useBrandStore.getState().load()
      expect(useBrandStore.getState().kit).toEqual(DEFAULT_BRAND_KIT)
      expect(useBrandStore.getState().loaded).toBe(true)
    })

    it(`${what}: a kit loaded earlier is kept, not replaced by the default`, async () => {
      useBrandStore.setState({ kit: CUSTOM, isSet: true, loaded: true })
      answer(reply)
      await useBrandStore.getState().load()
      expect(useBrandStore.getState().kit).toEqual(CUSTOM)
      expect(useBrandStore.getState().isSet).toBe(true)
    })

    it(`${what}: the bad reply is logged`, async () => {
      answer(reply)
      await useBrandStore.getState().load()
      expect(warn).toHaveBeenCalled()
      expect(String(warn.mock.calls[0]?.[0])).toContain('brand')
    })
  }
})
