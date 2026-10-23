// PlexiiCells gets a real readOnly. It had none: CellsChrome already carried
// the machinery and SheetEditor hard-coded `readOnly={false}` into it, so a
// VIEWER of a shared spreadsheet was handed a full editor. They could type, the
// server dropped it, and nothing told them — the app pretending an edit landed,
// which is the failure mode worth more than the missing feature.
//
// A read-only sheet NEVER calls onChange. Every write goes through `commit`, so
// the guard is central; the four paths that reach onChange without it — undo,
// redo, switching sheet and import — are guarded where they are. The cell
// editor refuses to open at all, because a caret that accepts typing and then
// discards it is the same pretence in miniature.
//
// The control case mounts the SAME editor editable and makes the same edit,
// proving the harness sees an emit when there is one.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SheetBody } from '../../src/shared/types'

beforeAll(() => {
  class RO {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
  ;(window as unknown as { api: unknown }).api = new Proxy(
    {},
    { get: () => new Proxy(() => Promise.resolve([]), { get: () => () => Promise.resolve([]) }) }
  )
})

const body = (): SheetBody =>
  ({
    version: 2,
    activeSheet: 0,
    sheets: [
      {
        id: 's1',
        name: 'Figures',
        columns: ['A', 'B'],
        rows: [
          ['Revenue', '1200'],
          ['Costs', '800']
        ]
      },
      { id: 's2', name: 'Notes', columns: ['A'], rows: [['Second sheet']] }
    ]
  }) as unknown as SheetBody

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function mount(readOnly: boolean, onChange: (b: SheetBody) => void): Promise<void> {
  const { default: SheetEditor } = await import('../../src/renderer/src/components/documents/SheetEditor')
  act(() => root.render(<SheetEditor body={body()} title="Workbook" onChange={onChange} readOnly={readOnly} />))
  await act(async () => {
    await Promise.resolve()
  })
}

const cell = (r: number, c: number): HTMLElement => host.querySelector(`[data-testid="cell-${r}-${c}"]`)!
const dblClick = (el: HTMLElement): void =>
  act(() => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
const key = (k: string, mod = false): void =>
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: k, metaKey: mod, ctrlKey: mod, bubbles: true }))
  })

describe('SheetEditor readOnly never emits', () => {
  it('the cell editor does not open, by double-click or by typing', async () => {
    const onChange = vi.fn()
    await mount(true, onChange)
    expect(cell(0, 0), 'the grid is really rendered').toBeTruthy()
    dblClick(cell(0, 0))
    expect(cell(0, 0).querySelector('input'), 'no caret in a read-only cell').toBeNull()
    // Typing over a cell is how Excel starts an edit ("enter mode").
    act(() => cell(0, 1).dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    key('5')
    key('Enter')
    key('F2')
    expect(cell(0, 1).querySelector('input'), 'nor by typing over a cell').toBeNull()
    // The column-header rename input IS always mounted — it is the grid's one
    // permanent input, not a cell editor. So the property to assert is that
    // NOTHING in the grid is writable, which also catches a future input added
    // without a thought for readers.
    const inputs = Array.from(host.querySelectorAll<HTMLInputElement>('[data-testid="sheet-grid"] input'))
    expect(inputs.length, 'the header inputs are there to be checked').toBeGreaterThan(0)
    expect(inputs.filter((i) => !i.readOnly && !i.disabled).map((i) => i.value)).toEqual([])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('Delete, Backspace, undo and redo write nothing', async () => {
    const onChange = vi.fn()
    await mount(true, onChange)
    act(() => cell(0, 0).dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    key('Delete')
    key('Backspace')
    key('z', true)
    key('y', true)
    await act(async () => {
      await Promise.resolve()
    })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('switching sheet still WORKS and still writes nothing', async () => {
    const onChange = vi.fn()
    await mount(true, onChange)
    const tabs = host.querySelectorAll<HTMLElement>('[data-testid="sheet-tab-strip"] > div')
    expect(tabs.length, 'two sheets in the strip').toBe(2)
    act(() => tabs[1]!.click())
    await act(async () => {
      await Promise.resolve()
    })
    // The second sheet's content is on screen: a reader may look around.
    expect(host.textContent).toContain('Second sheet')
    // But activeSheet lives in the BODY, so remembering it would be a write.
    expect(onChange).not.toHaveBeenCalled()
  })

  it('pressing every enabled control in the ribbon and menu writes nothing', async () => {
    const onChange = vi.fn()
    await mount(true, onChange)
    for (const b of Array.from(host.querySelectorAll<HTMLButtonElement>('button'))) {
      const id = b.getAttribute('data-testid') ?? ''
      // Skip pane toggles and navigation: they are readOnlySafe by design.
      if (b.disabled || /sidepane|panel|toggle|names|ai|tab/i.test(id)) continue
      act(() => b.click())
    }
    await act(async () => {
      await Promise.resolve()
    })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('control: the same cell edit in an editable sheet DOES emit', async () => {
    const onChange = vi.fn()
    await mount(false, onChange)
    dblClick(cell(0, 0))
    const input = cell(0, 0).querySelector('input') as HTMLInputElement | null
    expect(input, 'an editable sheet opens a caret on double-click').not.toBeNull()
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      set.call(input!, 'Turnover')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await act(async () => {
      await Promise.resolve()
    })
    expect(onChange).toHaveBeenCalled()
    const last = onChange.mock.calls.at(-1)![0] as { sheets: { rows: string[][] }[] }
    expect(last.sheets[0]!.rows[0]![0]).toBe('Turnover')
  })

  it('control: switching sheet in an editable workbook DOES record it', async () => {
    const onChange = vi.fn()
    await mount(false, onChange)
    const tabs = host.querySelectorAll<HTMLElement>('[data-testid="sheet-tab-strip"] > div')
    act(() => tabs[1]!.click())
    await act(async () => {
      await Promise.resolve()
    })
    expect(onChange).toHaveBeenCalled()
    expect((onChange.mock.calls.at(-1)![0] as { activeSheet?: number }).activeSheet).toBe(1)
  })
})
