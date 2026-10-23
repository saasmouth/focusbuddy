// GUARD: a structural edit moves the PAGE SETUP with the data.
//
// tests/unit/sheetPrint.test.ts covers remapPrintArea / remapRepeatRows /
// remapTabPageSetup thoroughly on their own — every direction, and clearing
// rather than repointing when the last line goes. What none of that can show is
// whether anything CALLS them: an engine with no caller is a feature that does
// not exist ([[feature-is-reachable-not-committed]]).
//
// So this drives the real PlexiiCells through the real menu. Insert ▸ Row above
// goes through SheetEditor's insertRowFixed → fixFormulas, which is where the
// remap now lives — one call there rather than at the six wrappers and
// drag-reorder paths, so none of them can be written without it.
//
// Without it, inserting one row above a print area prints the wrong block, and
// the user is given no sign: the printout is simply off by a row.

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

/** A workbook whose first sheet prints A2:B3 and repeats row 1 at the top. */
const body = (setup: { printArea?: string; repeatRows?: string } = { printArea: 'A2:B3', repeatRows: '1:1' }): SheetBody =>
  ({
    version: 2,
    activeSheet: 0,
    sheets: [
      {
        id: 's1',
        name: 'Figures',
        columns: ['A', 'B'],
        rows: [
          ['Header', 'Header'],
          ['Revenue', '1200'],
          ['Costs', '800']
        ],
        ...setup
      }
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

type Emitted = { printArea?: string; repeatRows?: string; rows: string[][] }

async function mount(b: SheetBody, onChange: (x: SheetBody) => void): Promise<void> {
  const { default: SheetEditor } = await import('../../src/renderer/src/components/documents/SheetEditor')
  act(() => root.render(<SheetEditor body={b} title="Workbook" onChange={onChange} />))
  await act(async () => {
    await Promise.resolve()
  })
}

/** Insert ▸ Row above, clicked the way a person does. */
async function insertRowAbove(): Promise<void> {
  const btn = host.querySelector('[data-testid="sheet-menubar-insert"]') as HTMLElement | null
  if (!btn) throw new Error('no Insert menu on the sheet menu bar')
  await act(async () => btn.click())
  // `includes`, not `startsWith`: the real Icon renders its ligature name as
  // text, so each row reads "add_row_aboveRow above".
  const item = Array.from(
    host.querySelectorAll('[data-testid="sheet-menubar-insert-list"] button')
  ).find((b) => b.textContent?.includes('Row above')) as HTMLElement | undefined
  if (!item) throw new Error('no "Row above" row in the Insert menu')
  await act(async () => item.click())
}

const first = (onChange: ReturnType<typeof vi.fn>): Emitted =>
  (onChange.mock.calls[0]?.[0] as unknown as { sheets: Emitted[] }).sheets[0]

describe('inserting a row above', () => {
  it('moves the print area and the repeat rows with the data', async () => {
    const onChange = vi.fn()
    await mount(body(), onChange)
    await insertRowAbove()

    expect(onChange, 'the edit really emitted').toHaveBeenCalled()
    const t = first(onChange)
    // One row inserted at the top, so everything below it shifts by one.
    expect(t.rows.length, 'a row really was inserted').toBe(4)
    expect(t.printArea, 'the print area follows its rows').toBe('A3:B4')
    expect(t.repeatRows, 'the repeat rows follow too').toBe('2:2')
  })

  it('invents no page setup for a sheet that has none', async () => {
    // The control: the remap must leave a tab alone, not write empty fields
    // into every workbook that is ever edited.
    const onChange = vi.fn()
    await mount(body({}), onChange)
    await insertRowAbove()

    expect(onChange).toHaveBeenCalled()
    const t = first(onChange)
    expect(t.rows.length, 'the same edit happened').toBe(4)
    expect(t.printArea).toBeUndefined()
    expect(t.repeatRows).toBeUndefined()
  })

  it('leaves the print area alone when the insert is below it', async () => {
    // Proves the maps are really consulted rather than everything being shifted:
    // an edit under the area changes nothing about it. Row above with the
    // cursor moved down to row 3 inserts beneath A2:B3.
    const onChange = vi.fn()
    await mount(body(), onChange)
    const cell = host.querySelector('[data-testid="cell-2-0"]') as HTMLElement | null
    expect(cell, 'the grid is really rendered').toBeTruthy()
    act(() => cell!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    await insertRowAbove()

    const t = first(onChange)
    expect(t.rows.length).toBe(4)
    // Inserting AT row 2 pushes only the last line of A2:B3 down.
    expect(t.printArea).toBe('A2:B4')
    expect(t.repeatRows, 'row 1 is above the insert, so it does not move').toBe('1:1')
  })
})
