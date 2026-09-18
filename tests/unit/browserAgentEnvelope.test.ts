import { describe, expect, test } from 'vitest'

// The browser-agent envelope (A6/B2): the R30-harvested sanitiser must
// refuse everything that is not explicitly lawful — unknown kinds,
// hallucinated element indices, coordinate actions outside screenshot mode,
// dangerous URL schemes — and the parser must survive prose-wrapped JSON.

import {
  parseBrowserEnvelope,
  sanitiseBrowserAction,
  MUTATING_KINDS
} from '../../src/main/ai/browserAgentEnvelope'

const known = new Set([0, 3, 7])
const dom = { knownIndices: known, coordinateMode: false }
const shot = { knownIndices: new Set<number>(), coordinateMode: true }

describe('parseBrowserEnvelope', () => {
  test('a clean envelope parses', () => {
    const env = parseBrowserEnvelope(
      '{"narration":"Clicking the button","status":"working","blocker":null,"action":{"kind":"click","elementIndex":3}}'
    )
    expect(env).toMatchObject({ narration: 'Clicking the button', status: 'working', blocker: null })
    expect(env!.action).toMatchObject({ kind: 'click', elementIndex: 3 })
  })
  test('JSON wrapped in prose still parses (extractJson)', () => {
    const env = parseBrowserEnvelope('Sure! Here is my step:\n{"narration":"n","status":"done","action":null}\nDone.')
    expect(env!.status).toBe('done')
  })
  test('an unknown status coerces to working, an empty blocker normalises to null', () => {
    const env = parseBrowserEnvelope('{"narration":"n","status":"pondering","blocker":"  ","action":null}')
    expect(env!.status).toBe('working')
    expect(env!.blocker).toBeNull()
  })
  test('non-JSON returns null', () => {
    expect(parseBrowserEnvelope('I will now click the button.')).toBeNull()
  })
})

describe('sanitiseBrowserAction — the R30 whitelist', () => {
  test('an unknown kind refuses', () => {
    expect(sanitiseBrowserAction({ kind: 'submit_form' }, dom)).toBeNull()
    expect(sanitiseBrowserAction({ kind: 'solve_captcha' }, dom)).toBeNull()
  })
  test('a click on a known index passes; a hallucinated index refuses', () => {
    expect(sanitiseBrowserAction({ kind: 'click', elementIndex: 3 }, dom)).toEqual({
      kind: 'click',
      elementIndex: 3
    })
    expect(sanitiseBrowserAction({ kind: 'click', elementIndex: 12 }, dom)).toBeNull()
    expect(sanitiseBrowserAction({ kind: 'click', elementIndex: '3' }, dom)).toBeNull()
  })
  test('type requires a known index and a string; text caps at 2000', () => {
    const a = sanitiseBrowserAction({ kind: 'type', elementIndex: 0, text: 'x'.repeat(5000) }, dom)
    expect(a).toMatchObject({ kind: 'type', elementIndex: 0 })
    expect((a as { text: string }).text.length).toBe(2000)
    expect(sanitiseBrowserAction({ kind: 'type', elementIndex: 0 }, dom)).toBeNull()
  })
  test('open_url refuses javascript:, data: and file: schemes', () => {
    expect(sanitiseBrowserAction({ kind: 'open_url', url: 'javascript:alert(1)' }, dom)).toBeNull()
    expect(sanitiseBrowserAction({ kind: 'open_url', url: ' data:text/html,x' }, dom)).toBeNull()
    expect(sanitiseBrowserAction({ kind: 'open_url', url: 'file:///etc/passwd' }, dom)).toBeNull()
    expect(sanitiseBrowserAction({ kind: 'open_url', url: 'https://example.com' }, dom)).toEqual({
      kind: 'open_url',
      url: 'https://example.com'
    })
  })
  test('wait clamps to the bridge cap', () => {
    expect(sanitiseBrowserAction({ kind: 'wait', ms: 60000 }, dom)).toEqual({ kind: 'wait', ms: 5000 })
  })
  test('press_key allows only the four keys', () => {
    expect(sanitiseBrowserAction({ kind: 'press_key', key: 'Enter' }, dom)).toEqual({
      kind: 'press_key',
      key: 'Enter'
    })
    expect(sanitiseBrowserAction({ kind: 'press_key', key: 'F12' }, dom)).toBeNull()
  })
  test('coordinate actions are lawful ONLY in screenshot mode', () => {
    expect(sanitiseBrowserAction({ kind: 'click_at', x: 10, y: 10 }, dom)).toBeNull()
    expect(sanitiseBrowserAction({ kind: 'type_text', text: 'hi' }, dom)).toBeNull()
    expect(sanitiseBrowserAction({ kind: 'click_at', x: 10, y: 10 }, shot)).toEqual({
      kind: 'click_at',
      x: 10,
      y: 10
    })
    expect(sanitiseBrowserAction({ kind: 'type_text', text: 'hi' }, shot)).toEqual({
      kind: 'type_text',
      text: 'hi'
    })
    expect(sanitiseBrowserAction({ kind: 'click_at', x: -5, y: 10 }, shot)).toBeNull()
  })
  test('null and garbage refuse', () => {
    expect(sanitiseBrowserAction(null, dom)).toBeNull()
    expect(sanitiseBrowserAction({ notEven: 'aKind' }, dom)).toBeNull()
  })
})

describe('MUTATING_KINDS — what the consent gate covers', () => {
  test('acting kinds are mutating; navigation and reading are not', () => {
    for (const k of ['click', 'type', 'select', 'press_key', 'click_at', 'type_text']) {
      expect(MUTATING_KINDS.has(k)).toBe(true)
    }
    for (const k of ['open_url', 'scroll', 'wait', 'read_page', 'snapshot', 'screenshot']) {
      expect(MUTATING_KINDS.has(k)).toBe(false)
    }
  })
})

// Harvesting links and images.
//
// "Collect the images on this page" was impossible before: the element walker
// only reports things you can ACT on, and an <img> is not one of them, so the
// model never saw a single image URL. `collect` is the door — and being a new
// door, it has to refuse everything it is not.
describe('the collect action', () => {
  const ok = { knownIndices: new Set<number>(), coordinateMode: false }

  test('accepts exactly the two things it can harvest', () => {
    expect(sanitiseBrowserAction({ kind: 'collect', what: 'links' }, ok)).toEqual({
      kind: 'collect',
      what: 'links'
    })
    expect(sanitiseBrowserAction({ kind: 'collect', what: 'images' }, ok)).toEqual({
      kind: 'collect',
      what: 'images'
    })
  })

  test('refuses anything else it is asked to collect', () => {
    // No open-ended selector here: a `what` the executor does not implement
    // must die at the door rather than reach it.
    for (const what of ['scripts', 'cookies', 'passwords', '', 'LINKS', null, 42, undefined]) {
      expect(sanitiseBrowserAction({ kind: 'collect', what }, ok)).toBeNull()
    }
    expect(sanitiseBrowserAction({ kind: 'collect' }, ok)).toBeNull()
  })

  test('needs no element index, so it works on a page with no observation', () => {
    // It reads the whole document rather than one element — an empty
    // knownIndices set must not block it the way it blocks click/type.
    expect(
      sanitiseBrowserAction(
        { kind: 'collect', what: 'links' },
        { knownIndices: new Set(), coordinateMode: false }
      )
    ).not.toBeNull()
  })

  test('is lawful in screenshot mode too', () => {
    // Unlike click/type it is not an indexed action, so the coordinate-mode
    // restriction has nothing to do with it.
    expect(
      sanitiseBrowserAction(
        { kind: 'collect', what: 'images' },
        { knownIndices: new Set(), coordinateMode: true }
      )
    ).toEqual({ kind: 'collect', what: 'images' })
  })

  test('does not count as mutating, so it never asks for site consent', () => {
    // Reading what a page points at changes nothing on it. Gating this behind
    // the R26 consent prompt would make "summarise this page" ask permission.
    expect(MUTATING_KINDS.has('collect')).toBe(false)
  })
})
