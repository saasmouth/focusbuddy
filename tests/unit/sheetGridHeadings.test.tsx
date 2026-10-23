// rails-tabs-41 shots (Cells-home.png): every column heading of a new sheet read
// twice, "A A", "B B" … "O O" — the small grey letter, then the column's name,
// which a new sheet sets to that same letter. The letter is the heading; a name
// shows beside it only when the user has given the column one.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SheetGrid from '../../src/renderer/src/components/documents/sheet/SheetGrid'
import { columnName, emptyTab } from '../../src/renderer/src/lib/sheetBody'
import type { SheetTab } from '../../src/shared/types'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const noop = (): void => undefined

function mount(tab: SheetTab): void {
  act(() =>
    root.render(
      <SheetGrid
        tab={tab}
        selection={null}
        active={null}
        editing={null}
        editValue=""
        colWidthOf={() => 100}
        onEditValue={noop}
        onCellMouseDown={noop}
        onCellMouseEnter={noop}
        onCellDoubleClick={noop}
        onCommitEdit={noop}
        onCancelEdit={noop}
        onHeaderRename={noop}
        onColResizeStart={noop}
        onHeaderContextMenu={noop}
      />
    )
  )
}

/** What a person reads in heading c: the letter, plus the name field's text. */
function heading(c: number): string {
  const th = host.querySelector(`[data-testid="col-header-${c}"]`)!
  const letter = th.querySelector(`[data-testid="col-select-${c}"]`)!.textContent ?? ''
  const name = (th.querySelector('input') as HTMLInputElement).value
  return [letter, name].filter(Boolean).join(' ')
}

describe('Cells column headings', () => {
  it('a new sheet shows each letter once', () => {
    mount(emptyTab('Sheet 1', 4, 3))
    expect([0, 1, 2, 3].map(heading)).toEqual(['A', 'B', 'C', 'D'])
  })

  it('a column the user named shows its letter and its name', () => {
    const t = emptyTab('Sheet 1', 3, 2)
    mount({ ...t, columns: ['A', 'Revenue', 'C'] })
    expect([0, 1, 2].map(heading)).toEqual(['A', 'B Revenue', 'C'])
  })

  it('columnName: a column called by its own letter has no name', () => {
    expect(columnName('A', 0)).toBe('')
    expect(columnName('AA', 26)).toBe('')
    expect(columnName('B', 0)).toBe('B') // a real name that happens to be a letter
    expect(columnName('Revenue', 1)).toBe('Revenue')
  })
})
