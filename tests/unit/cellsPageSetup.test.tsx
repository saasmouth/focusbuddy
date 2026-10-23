// GUARD for PlexiiCells' Page setup — what goes on paper.
//
// Driven through the real SheetEditor and its real File menu, because the point
// of the dialog is that it reads and writes the SHEET: it holds no state of its
// own, so it cannot disagree with what will print, and a structural edit that
// moves the ranges (the remap inside fixFormulas, see cellsPageSetupRemap) is
// reflected the next time it opens.
//
// The empty states are asserted on purpose. "Whole sheet" and "None" are the
// honest readings of an unset print area and unset repeat rows; a blank field
// there would read as a value the user had chosen.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { SheetBody } from '../../src/shared/types'
import { cellsCommandsFor } from './_cellsCommands'
import { READ_ONLY_REASON } from '../../src/renderer/src/components/office/shell'

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

const body = (setup: Record<string, unknown> = {}): SheetBody =>
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

async function mount(b: SheetBody, onChange: (x: SheetBody) => void, readOnly = false): Promise<void> {
  const { default: SheetEditor } = await import('../../src/renderer/src/components/documents/SheetEditor')
  act(() => root.render(<SheetEditor body={b} title="Workbook" onChange={onChange} readOnly={readOnly} />))
  await act(async () => {
    await Promise.resolve()
  })
}

const q = (id: string): HTMLElement | null => host.querySelector(`[data-testid="${id}"]`)
const text = (id: string): string => q(id)?.textContent?.trim() ?? '(absent)'

/** Open File and click a row by the text it shows (the Icon renders its ligature first). */
async function fileRow(label: string): Promise<HTMLElement | undefined> {
  const btn = q('sheet-menubar-file')
  if (!btn) throw new Error('no File menu')
  await act(async () => btn.click())
  return Array.from(host.querySelectorAll('[data-testid="sheet-menubar-file-list"] button')).find((b) =>
    b.textContent?.includes(label)
  ) as HTMLElement | undefined
}

async function openPageSetup(): Promise<void> {
  const row = await fileRow('Page setup…')
  if (!row) throw new Error('no "Page setup…" row in File')
  await act(async () => row.click())
}

const emitted = (onChange: ReturnType<typeof vi.fn>, n = 0): Record<string, unknown> =>
  (onChange.mock.calls[n]?.[0] as unknown as { sheets: Record<string, unknown>[] }).sheets[0]

describe('the command', () => {
  it('is in the registry, and a viewer is told why it is off', () => {
    const live = cellsCommandsFor()
    const viewer = cellsCommandsFor({ readOnly: true })
    expect(live['sheet-page-setup']?.label).toBe('Page setup…')
    expect(viewer['sheet-page-setup']?.enabled?.()).toBe(false)
    expect(viewer['sheet-page-setup']?.reason?.()).toBe(READ_ONLY_REASON)
    // Positive control from the same pair: it is live for an editor, so the
    // assertion above is about view-only access.
    expect(live['sheet-page-setup']?.enabled?.()).toBe(true)
  })
})

describe('File ▸ Page setup…', () => {
  it('opens the dialog and says what is set now', async () => {
    const onChange = vi.fn()
    await mount(body({ printArea: 'A2:B3', repeatRows: '1:1' }), onChange)
    await openPageSetup()
    expect(q('sheet-pagesetup-dialog'), 'the dialog is open').toBeTruthy()
    expect(text('pagesetup-area-value')).toBe('A2:B3')
    expect(text('pagesetup-repeat-value')).toBe('1:1')
  })

  it('reads an unset sheet honestly, not as a blank', async () => {
    const onChange = vi.fn()
    await mount(body(), onChange)
    await openPageSetup()
    expect(text('pagesetup-area-value'), 'no print area means the whole sheet prints').toBe('Whole sheet')
    expect(text('pagesetup-repeat-value')).toBe('None')
    // Gridlines print by default.
    expect(q('pagesetup-gridlines-input') as HTMLInputElement | null).toBeTruthy()
    expect((q('pagesetup-gridlines-input') as HTMLInputElement).checked).toBe(true)
  })

  it('sets the print area from the selection, and clears it again', async () => {
    const onChange = vi.fn()
    await mount(body(), onChange)
    // Select B2:B3 so the written range is not the default single cell.
    const from = q('cell-1-1')
    expect(from, 'the grid is really rendered').toBeTruthy()
    act(() => from!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    act(() =>
      q('cell-2-1')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, shiftKey: true }))
    )
    await openPageSetup()

    const set = q('pagesetup-area-set')
    expect(set?.textContent, 'the button names the range it will use').toContain('B2:B3')
    await act(async () => set!.click())
    expect(emitted(onChange).printArea).toBe('B2:B3')

    await act(async () => q('pagesetup-area-clear')!.click())
    // Cleared means the field is GONE, not an empty string that would parse as
    // a range nobody chose.
    expect(emitted(onChange, 1).printArea).toBeUndefined()
  })

  it('turns the printed gridlines off', async () => {
    const onChange = vi.fn()
    await mount(body(), onChange)
    await openPageSetup()
    const box = q('pagesetup-gridlines-input') as HTMLInputElement
    expect(box.checked, 'they print by default, so this click turns them off').toBe(true)
    // click(), not a synthetic 'change': React maps a checkbox's onChange to the
    // click, so setting .checked by hand and firing change reaches nothing.
    await act(async () => box.click())
    expect(emitted(onChange).showGridlines).toBe(false)
  })

  it('sets the rows to repeat from the selection', async () => {
    const onChange = vi.fn()
    await mount(body(), onChange)
    await openPageSetup()
    const set = q('pagesetup-repeat-set')
    expect(set?.textContent).toContain('1:1')
    await act(async () => set!.click())
    expect(emitted(onChange).repeatRows).toBe('1:1')
  })

  it('offers a viewer the row with a reason, and never the dialog', async () => {
    const onChange = vi.fn()
    await mount(body({ printArea: 'A2:B3' }), onChange, true)
    const row = await fileRow('Page setup…')
    expect(row, 'the row is still listed — it is disabled, not hidden').toBeTruthy()
    expect((row as HTMLButtonElement).disabled).toBe(true)
    expect(row?.getAttribute('title') ?? row?.textContent).toContain(READ_ONLY_REASON)
    await act(async () => row!.click())
    expect(q('sheet-pagesetup-dialog'), 'a disabled row opens nothing').toBeNull()
    expect(onChange, 'and writes nothing').not.toHaveBeenCalled()
  })
})
