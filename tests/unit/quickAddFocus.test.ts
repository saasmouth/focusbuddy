import { describe, it, expect, beforeEach } from 'vitest'
import { focusBlocksQuickAdd, quickAddAllowed, deepActiveElement, insideWorkWidget, keyEventTarget } from '../../src/renderer/src/lib/quickAddFocus'
import { focusNewWidget, primaryInputOf } from '../../src/renderer/src/lib/focusNewWidget'

// Single-key quick-add (S=sticky, T=table, …) turned ordinary typing into
// object creation. The reported repro: click a sticky, start typing before its
// editor has focus, and a sticky, a table and a timer appear.
//
// The old guard was a deny-list over document.activeElement -- INPUT, TEXTAREA,
// contenteditable. Everything below is a case that list waved through.

function el(html: string): Element {
  const host = document.createElement('div')
  host.innerHTML = html
  return host.firstElementChild!
}

const ON_DESK = { activeTaskId: 'desk_1', activeWidgetId: null, focusedWidgetId: null }

describe('focusBlocksQuickAdd — what counts as typing', () => {
  it.each([
    ['<input />', 'a text input'],
    ['<textarea></textarea>', 'a textarea'],
    ['<select><option>a</option></select>', 'a select'],
    ['<button>Save</button>', 'a button'],
    ['<a href="#">link</a>', 'a link'],
    ['<div contenteditable="true">x</div>', 'a contenteditable'],
    ['<div role="textbox">x</div>', 'an ARIA textbox'],
    ['<div role="combobox">x</div>', 'an ARIA combobox'],
    ['<div role="dialog">x</div>', 'anything inside a dialog'],
    ['<div data-no-shortcuts>x</div>', 'an explicit opt-out']
  ])('blocks on %s (%s)', (html) => {
    expect(focusBlocksQuickAdd(el(html))).toBe(true)
  })

  it('blocks inside a webview, whose contents we cannot inspect', () => {
    // A user typing into an embedded browser is invisible to us; treating that
    // as "not typing" is how letters leaked through to the canvas.
    expect(focusBlocksQuickAdd(el('<webview></webview>'))).toBe(true)
    expect(focusBlocksQuickAdd(el('<iframe></iframe>'))).toBe(true)
  })

  it('blocks a plain element nested inside an editor', () => {
    const editor = el('<div contenteditable="true"><span id="inner">word</span></div>')
    document.body.appendChild(editor)
    const inner = editor.querySelector('#inner')!
    // jsdom does not implement isContentEditable, so the ancestor walk is what
    // actually carries this case -- and it is the common one in TipTap.
    expect(focusBlocksQuickAdd(inner)).toBe(true)
    editor.remove()
  })

  it('allows the bare canvas surface', () => {
    expect(focusBlocksQuickAdd(el('<div data-bare-canvas></div>'))).toBe(false)
    expect(focusBlocksQuickAdd(null)).toBe(false)
  })
})

describe('quickAddAllowed — the whole decision', () => {
  it('fires on a desk with nothing engaged', () => {
    expect(quickAddAllowed({ ...ON_DESK, focusedElement: null })).toBe(true)
  })

  it('does not fire without a desk open', () => {
    expect(
      quickAddAllowed({ activeTaskId: null, activeWidgetId: null, focusedWidgetId: null, focusedElement: null })
    ).toBe(false)
  })

  it('does not fire while a widget is activated, even with focus still on the body', () => {
    // This is the reported bug. Clicking into a sticky activates it well before
    // its editor wins focus; during that window activeElement is the body, so
    // the old guard saw "not typing" and created objects.
    expect(
      quickAddAllowed({
        activeTaskId: 'desk_1',
        activeWidgetId: 'w_sticky',
        focusedWidgetId: null,
        focusedElement: document.body
      })
    ).toBe(false)
  })

  it('does not fire in focus mode', () => {
    expect(
      quickAddAllowed({
        activeTaskId: 'desk_1',
        activeWidgetId: null,
        focusedWidgetId: 'w_doc',
        focusedElement: null
      })
    ).toBe(false)
  })

  it('does not fire while a control has focus', () => {
    expect(quickAddAllowed({ ...ON_DESK, focusedElement: el('<input />') })).toBe(false)
  })
})

describe('deepActiveElement', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('reports the element inside a shadow root, not its host', () => {
    // activeElement stops at the host, so focus inside a shadow root read as
    // "the host div" -- not an input, therefore not typing, therefore letters
    // became shortcuts.
    const host = document.createElement('div')
    document.body.appendChild(host)
    const shadow = host.attachShadow({ mode: 'open' })
    const input = document.createElement('input')
    shadow.appendChild(input)
    input.focus()
    expect(deepActiveElement()).toBe(input)
    expect(focusBlocksQuickAdd(deepActiveElement())).toBe(true)
  })
})

describe('inside a work widget (4.3.32: typing into a just-added Tasks work widget)', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('a focused element anywhere inside a work widget frame blocks quick-add', () => {
    // A tabbable row or panel is not a control, so focusBlocksQuickAdd lets it
    // through; it is still inside a work widget, so the letter is the widget's.
    const frame = el('<div data-widget-id="w_tasks"><div tabindex="-1" id="row">Send the stats</div></div>')
    document.body.appendChild(frame)
    const row = frame.querySelector('#row')!
    expect(focusBlocksQuickAdd(row)).toBe(false)
    expect(insideWorkWidget(row)).toBe(true)
    expect(quickAddAllowed({ ...ON_DESK, focusedElement: row })).toBe(false)
  })

  it('asks the key event target too, when activeElement still reports the body', () => {
    const frame = el('<div data-widget-id="w_tasks"><input id="add" /></div>')
    document.body.appendChild(frame)
    const input = frame.querySelector('#add')!
    const ev = new KeyboardEvent('keydown', { key: 's' })
    Object.defineProperty(ev, 'target', { value: input })
    expect(keyEventTarget(ev)).toBe(input)
    expect(quickAddAllowed({ ...ON_DESK, focusedElement: document.body, eventTarget: input })).toBe(false)
  })

  it('the bare desk, with nothing engaged, still quick-adds', () => {
    expect(insideWorkWidget(document.body)).toBe(false)
    expect(quickAddAllowed({ ...ON_DESK, focusedElement: document.body, eventTarget: document.body })).toBe(true)
  })
})

describe('focusNewWidget — a placed work widget takes the keyboard', () => {
  beforeEach(() => { document.body.innerHTML = '' })
  const frames = (): Promise<void> => new Promise((r) => setTimeout(r, 60))

  it('focuses the primary input once the frame mounts', async () => {
    focusNewWidget('w_new')
    // The frame mounts a moment after the store adopts the instance.
    await new Promise((r) => setTimeout(r, 20))
    document.body.appendChild(el('<div data-widget-id="w_new"><input id="search" /><input data-primary-input id="add" /></div>'))
    await frames()
    expect(document.activeElement?.id).toBe('add')
    expect(primaryInputOf('w_new')?.id).toBe('add')
  })

  it('never takes focus from somewhere the person already is', async () => {
    const other = el('<input id="elsewhere" />') as HTMLInputElement
    document.body.appendChild(other)
    document.body.appendChild(el('<div data-widget-id="w_new"><input data-primary-input id="add" /></div>'))
    other.focus()
    focusNewWidget('w_new')
    await frames()
    expect(document.activeElement?.id).toBe('elsewhere')
  })

  it('leaves a kind with no primary input alone', async () => {
    document.body.appendChild(el('<div data-widget-id="w_sticky"><textarea id="t"></textarea></div>'))
    focusNewWidget('w_sticky', 50)
    await frames()
    expect(document.activeElement).toBe(document.body)
  })
})
