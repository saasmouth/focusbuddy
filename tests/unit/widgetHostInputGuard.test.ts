// What the person does in the widget host: noticed for saving, refused when
// read-only (signed out in PlexiiLite). Capture listeners on the window, so they
// run before React's handlers and any widget's.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { guardInput } from '../../src/web/widgetHost/inputGuard'

let touches = 0
let undo: () => void
let reached: string[]
const listen = (e: Event): void => void reached.push(e.type)

beforeEach(() => {
  touches = 0
  reached = []
  document.body.innerHTML = '<textarea id="t"></textarea><a id="a" href="https://example.com/">x</a><button id="b">b</button>'
  for (const t of ['keydown', 'pointerdown', 'click', 'wheel', 'paste', 'drop', 'beforeinput', 'contextmenu']) document.addEventListener(t, listen)
})
afterEach(() => {
  undo?.()
  for (const t of ['keydown', 'pointerdown', 'click', 'wheel', 'paste', 'drop', 'beforeinput', 'contextmenu']) document.removeEventListener(t, listen)
})

const fire = (el: Element, e: Event): boolean => el.dispatchEvent(e)
const key = (k: string): KeyboardEvent => new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })

describe('read-only', () => {
  beforeEach(() => { undo = guardInput({ readOnly: true, onTouch: () => touches++ }) })

  it('keys, pointers, clicks, pastes, drops, typing and menus never reach the widget', () => {
    const t = document.getElementById('t')!
    expect(fire(t, key('a'))).toBe(false)
    expect(fire(t, new Event('pointerdown', { bubbles: true, cancelable: true }))).toBe(false)
    expect(fire(document.getElementById('b')!, new MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(false)
    expect(fire(t, new Event('paste', { bubbles: true, cancelable: true }))).toBe(false)
    expect(fire(t, new Event('drop', { bubbles: true, cancelable: true }))).toBe(false)
    expect(fire(t, new Event('beforeinput', { bubbles: true, cancelable: true }))).toBe(false)
    expect(fire(t, new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))).toBe(false)
    expect(reached).toEqual([])
    expect(touches).toBe(0)
  })

  it('reading still works: scrolling, Tab, and following a link', () => {
    fire(document.getElementById('t')!, new WheelEvent('wheel', { bubbles: true, cancelable: true }))
    fire(document.getElementById('t')!, key('Tab'))
    fire(document.getElementById('a')!, new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(reached).toEqual(['wheel', 'keydown', 'click'])
  })

  it('a reading control (copy, switch slide) is pressed by click or Enter or Space; anything else on it is refused', () => {
    document.body.insertAdjacentHTML('beforeend', '<div data-reading-control id="r"><span id="inner">Slide 2</span></div>')
    const inner = document.getElementById('inner')!
    expect(fire(inner, new Event('pointerdown', { bubbles: true, cancelable: true }))).toBe(true)
    expect(fire(inner, new MouseEvent('mousedown', { bubbles: true, cancelable: true }))).toBe(true)
    expect(fire(inner, new MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(true)
    expect(fire(inner, key('Enter'))).toBe(true)
    expect(fire(inner, key(' '))).toBe(true)
    expect(reached).toEqual(['pointerdown', 'click', 'keydown', 'keydown'])
    reached = []
    // Typing, a paste, a drop, a menu or a double-click on it is still editing.
    expect(fire(inner, key('a'))).toBe(false)
    expect(fire(inner, key('Backspace'))).toBe(false)
    expect(fire(inner, new Event('paste', { bubbles: true, cancelable: true }))).toBe(false)
    expect(fire(inner, new Event('drop', { bubbles: true, cancelable: true }))).toBe(false)
    expect(fire(inner, new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))).toBe(false)
    expect(fire(inner, new MouseEvent('dblclick', { bubbles: true, cancelable: true }))).toBe(false)
    expect(reached).toEqual([])
    // And a click beside it is refused as before.
    expect(fire(document.getElementById('b')!, new MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(false)
    expect(touches).toBe(0)
  })
})

describe('editing', () => {
  beforeEach(() => { undo = guardInput({ readOnly: false, onTouch: () => touches++ }) })

  it('a key, a pointer, a paste or a drop is the person doing something; nothing is refused', () => {
    const t = document.getElementById('t')!
    expect(fire(t, key('a'))).toBe(true)
    fire(t, new Event('pointerdown', { bubbles: true, cancelable: true }))
    fire(t, new Event('paste', { bubbles: true, cancelable: true }))
    fire(t, new Event('drop', { bubbles: true, cancelable: true }))
    expect(touches).toBe(4)
    expect(reached).toEqual(['keydown', 'pointerdown', 'paste', 'drop'])
  })

  it('a modifier on its own, or a scroll, is not', () => {
    const t = document.getElementById('t')!
    fire(t, key('Shift'))
    fire(t, key('Meta'))
    fire(t, new WheelEvent('wheel', { bubbles: true }))
    expect(touches).toBe(0)
  })
})
