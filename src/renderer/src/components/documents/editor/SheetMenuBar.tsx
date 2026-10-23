import type { SheetCellFormat, SheetNumberFormat } from '@shared/types'
import type { DocumentOps } from './documentOps'
import { MenuBarShell, type MenuDef, type MenuItem } from './menuBarKit'
import { menuItemOf, menuRow, type DocumentCommands, type OfficeCommand } from '../../../lib/menus/officeCommand'
import type { CellsCommands } from '../sheet/cellsCommands'

// A Google-Sheets-style menu bar for the spreadsheet editor. It declares the
// SHAPE of the menus — which rows, in what order, under which separators — and
// nothing else: every row's label, key hint, icon, enabled state, reason and
// behaviour comes from the command registry (sheet/cellsCommands.ts), which the
// ribbon and the Cmd+K palette render from too. So a row cannot say one thing
// here and another there, and this file holds no state at all.
//
// This file does not read the documents store, and must not: it used to act on
// the store's `active` document, which in a desk widget is not the spreadsheet
// on screen (see documentOps). Enforced by tests/unit/documentOpsGuard.test.ts.

/**
 * The chart kinds SheetEditor.insertChart actually accepts. This was declared
 * as the three the Format menu offers, which under-typed the operation: the
 * toolbar has always passed area and scatter too.
 */
export type SheetChartType = 'bar' | 'line' | 'pie' | 'area' | 'scatter'

export interface SheetMenuActions {
  title: string
  activeFormat: SheetCellFormat | undefined
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
  /**
   * Cut, copy and paste the selection: the same as ⌘X, ⌘C and ⌘V, so the
   * menu writes the TSV and PlexiiCells' own flavour in one clipboard entry
   * (sheet/cellsClipboard.ts).
   */
  cut: () => void
  copy: () => void
  paste: () => void
  /** Select every used cell (SPEC §9.2: every app that selects has Select all; ⌘A). */
  selectAll: () => void
  /** Empty the selected cells (⌫). */
  deleteSelection: () => void
  /** Open Find and replace over this sheet. */
  /** Open Find… over this sheet. */
  find: () => void
  findAndReplace: () => void
  format: (patch: Partial<SheetCellFormat>) => void
  numberFormat: (f: SheetNumberFormat) => void
  insertRowAbove: () => void
  insertRowBelow: () => void
  insertColLeft: () => void
  insertColRight: () => void
  deleteRow: () => void
  deleteCol: () => void
  sort: (dir: 'asc' | 'desc') => void
  toggleFilter: () => void
  filterActive: boolean
  insertChart: (t: SheetChartType) => void
  insertSparkline: () => void
  insertPivot: () => void
  conditionalFormat: () => void
  dataValidation: () => void
  addSheet: () => void
  namedRanges: () => void
  importFile: () => void
  exportFile: (f: 'xlsx' | 'csv') => void
  aiFill: () => void
  /** Save the selected range as a snippet (docs/saved-snippets.md). */
  saveSnippet: () => void
  /** Open the snippet library aimed at this spreadsheet. */
  insertSnippet: () => void
  /**
   * The document on screen, bound to its id by whichever host mounted this
   * editor. Absent where there is no document — a snippet session — and then
   * none of the document items are shown at all.
   */
  documentOps?: DocumentOps
}

export default function SheetMenuBar({
  commands,
  doc
}: {
  /** PlexiiCells' commands, built by SheetEditor from the live sheet. */
  commands: CellsCommands
  /**
   * File's document actions, built by SheetEditor from the ops the host bound.
   * Null where there is no document — a snippet session — and then none of the
   * document rows are shown at all.
   *
   * Built by the HOST, not here, because the keyboard has to match the very
   * same commands: Print carries ⌘P, and a copy built in this file would show
   * the hint while nothing bound the key.
   */
  doc: DocumentCommands | null
}): JSX.Element {
  // A missing id is a programming error, not an empty menu.
  const c = (id: string): OfficeCommand => {
    const found = commands[id]
    if (!found) throw new Error(`SheetMenuBar: no command "${id}" in the registry`)
    return found
  }
  const item = (id: string): MenuItem => menuItemOf(c(id))
  /** A row under a menu whose title supplies the verb (Download ▸ …, Alignment ▸ Left). */
  const row = (id: string): MenuItem => menuRow(c(id))
  /** A row that is there only where the host added the op (Download ▸ PDF). */
  const maybe = (id: string): MenuItem[] => (commands[id] ? [row(id)] : [])

  const menus: MenuDef[] = [
    {
      id: 'file',
      label: 'File',
      build: () => {
        const docGroup: MenuItem[] = doc
          ? [
              menuItemOf(doc.newDocument),
              menuItemOf(doc.makeCopy),
              { kind: 'sep' },
              menuItemOf(doc.rename),
              menuItemOf(doc.versionHistory)
            ]
          : []
        const trashGroup: MenuItem[] = doc ? [{ kind: 'sep' }, menuItemOf(doc.moveToTrash)] : []
        return [
          ...docGroup,
          // Real printing, only where the host can really print.
          ...(doc?.print ? [menuItemOf(doc.print)] : []),
          // Import and Download are NOT document ops, despite living in this
          // menu: Import replaces the editor's body and emits onChange (the
          // host persists it, so it already lands on the right file), and
          // Download reads the body in memory. Both are correct with no
          // document at all, so neither is gated on ops — Import is gated on
          // view-only access instead, because it writes.
          item('sheet-import'),
          {
            kind: 'submenu',
            label: 'Download',
            icon: 'download',
            items: [row('sheet-export-xlsx'), row('sheet-export-csv'), ...maybe('sheet-export-pdf')]
          },
          ...trashGroup
        ]
      }
    },
    {
      id: 'edit',
      label: 'Edit',
      build: () => [
        item('sheet-undo'),
        item('sheet-redo'),
        { kind: 'sep' },
        item('sheet-cut'),
        item('sheet-copy'),
        item('sheet-paste'),
        item('sheet-delete'),
        { kind: 'sep' },
        item('sheet-select-all'),
        { kind: 'sep' },
        item('sheet-find'),
        item('sheet-find-replace'),
        { kind: 'sep' },
        item('sheet-save-snippet')
      ]
    },
    {
      id: 'insert',
      label: 'Insert',
      build: () => [
        row('sheet-row-above'),
        row('sheet-row-below'),
        row('sheet-col-left'),
        row('sheet-col-right'),
        { kind: 'sep' },
        {
          kind: 'submenu',
          label: 'Chart',
          icon: 'bar_chart',
          items: [
            row('sheet-chart-bar'),
            row('sheet-chart-line'),
            row('sheet-chart-pie'),
            row('sheet-chart-area'),
            row('sheet-chart-scatter')
          ]
        },
        item('sheet-pivot'),
        item('sheet-sparkline'),
        { kind: 'sep' },
        // Named ranges used to be listed here too, under "Named range", and
        // again in Data under "Named ranges" — one action, two labels. It lives
        // in Data.
        row('sheet-add-sheet'),
        { kind: 'sep' },
        item('sheet-insert-snippet'),
        // A meeting reaches other people, so a wrong id invites them to someone
        // else's spreadsheet. It went out with `id: active?.id ?? ''`.
        ...(doc ? ([{ kind: 'sep' }, menuItemOf(doc.meeting)] as MenuItem[]) : [])
      ]
    },
    {
      id: 'format',
      label: 'Format',
      build: () => [
        {
          kind: 'submenu',
          label: 'Text',
          icon: 'format_bold',
          items: [row('sheet-bold'), row('sheet-italic'), row('sheet-underline')]
        },
        {
          kind: 'submenu',
          label: 'Number',
          icon: 'numbers',
          items: [
            row('sheet-numfmt-general'),
            row('sheet-numfmt-number'),
            row('sheet-numfmt-percent'),
            row('sheet-numfmt-currency'),
            row('sheet-numfmt-date')
          ]
        },
        {
          kind: 'submenu',
          label: 'Alignment',
          icon: 'format_align_left',
          items: [row('sheet-align-left'), row('sheet-align-center'), row('sheet-align-right')]
        },
        { kind: 'sep' },
        item('sheet-cond-format'),
        item('sheet-clear-format')
      ]
    },
    {
      id: 'data',
      label: 'Data',
      build: () => [
        item('sheet-sort-asc'),
        item('sheet-sort-desc'),
        { kind: 'sep' },
        item('sheet-filter'),
        item('sheet-validation'),
        item('sheet-named-ranges')
      ]
    },
    {
      id: 'tools',
      label: 'Tools',
      build: () => [item('sheet-ai-fill')]
    },
    {
      id: 'help',
      label: 'Help',
      build: () => [item('sheet-shortcuts')]
    }
  ]

  return <MenuBarShell menus={menus} testid="sheet-menubar" />
}
