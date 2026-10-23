import { vi } from 'vitest'
import type { SheetMenuActions } from '../../src/renderer/src/components/documents/editor/SheetMenuBar'
import {
  buildCellsCommands,
  type CellsCommandDeps,
  type CellsCommands
} from '../../src/renderer/src/components/documents/sheet/cellsCommands'

// PlexiiCells' REAL command registry over stub actions, for the tests that
// render a Cells surface or press a Cells key. Every action is a spy, so a test
// can assert which one a label, a row or a key actually reached.

export type SheetActionSpies = { [K in keyof SheetMenuActions]: SheetMenuActions[K] }

export function sheetActionSpies(over: Partial<SheetMenuActions> = {}): SheetMenuActions {
  return {
    title: 'A sheet',
    activeFormat: undefined,
    undo: vi.fn(),
    redo: vi.fn(),
    canUndo: true,
    canRedo: true,
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    deleteSelection: vi.fn(),
    find: vi.fn(),
    findAndReplace: vi.fn(),
    format: vi.fn(),
    numberFormat: vi.fn(),
    insertRowAbove: vi.fn(),
    insertRowBelow: vi.fn(),
    insertColLeft: vi.fn(),
    insertColRight: vi.fn(),
    deleteRow: vi.fn(),
    deleteCol: vi.fn(),
    sort: vi.fn(),
    toggleFilter: vi.fn(),
    filterActive: false,
    insertChart: vi.fn(),
    insertSparkline: vi.fn(),
    insertPivot: vi.fn(),
    conditionalFormat: vi.fn(),
    dataValidation: vi.fn(),
    addSheet: vi.fn(),
    namedRanges: vi.fn(),
    importFile: vi.fn(),
    exportFile: vi.fn(),
    aiFill: vi.fn(),
    saveSnippet: vi.fn(),
    insertSnippet: vi.fn(),
    ...over
  }
}

export function cellsCommandsFor(over: Partial<CellsCommandDeps> = {}): CellsCommands {
  const deps: CellsCommandDeps = {
    a: over.a ?? sheetActionSpies(),
    readOnly: false,
    isMerged: false,
    mergeCells: vi.fn(),
    insertLookup: vi.fn(),
    macros: vi.fn(),
    query: vi.fn(),
    shortcuts: vi.fn(),
    ...over
  }
  return buildCellsCommands(deps)
}
