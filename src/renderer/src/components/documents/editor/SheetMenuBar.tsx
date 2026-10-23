import { useState } from 'react'
import type { SheetCellFormat, SheetNumberFormat } from '@shared/types'
import type { DocumentOps } from './documentOps'
import { MenuBarShell, MenuModal, type MenuDef, type MenuItem } from './menuBarKit'

// A Google-Sheets-style menu bar for the spreadsheet editor. Every item maps to a
// real SheetEditor operation (passed in as `actions`) or to the document ops the
// HOST binds. Capabilities the editor does not have (merge, freeze, cell
// find/replace) are simply not listed rather than shown as dead items.
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

export default function SheetMenuBar({ actions }: { actions: SheetMenuActions }): JSX.Element {
  const a = actions
  const fmt = a.activeFormat
  const ops = a.documentOps
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  const numFmtKind = fmt?.numFmt?.kind ?? 'general'

  const menus: MenuDef[] = [
    {
      id: 'file',
      label: 'File',
      build: () => {
        const docGroup: MenuItem[] = ops
          ? [
              { kind: 'item', label: 'New spreadsheet', icon: 'note_add', run: () => void ops.newDocument() },
              { kind: 'item', label: 'Make a copy', icon: 'file_copy', run: () => void ops.makeCopy() },
              { kind: 'sep' },
              { kind: 'item', label: 'Rename', icon: 'edit', run: () => void ops.rename() },
              { kind: 'item', label: 'Version history', icon: 'history', run: () => ops.openHistory() }
            ]
          : []
        const trashGroup: MenuItem[] = ops
          ? [
              { kind: 'sep' },
              { kind: 'item', label: 'Move to trash', icon: 'delete', run: () => void ops.moveToTrash() }
            ]
          : []
        return [
          ...docGroup,
          // Import and Download are NOT document ops, despite living in this
          // menu: Import replaces the editor's body and emits onChange (the
          // host persists it, so it already lands on the right file), and
          // Download reads the body in memory. Both are correct with no
          // document at all, so neither is gated.
          { kind: 'item', label: 'Import (.xlsx / .csv)', icon: 'upload', run: a.importFile },
          {
            kind: 'submenu',
            label: 'Download',
            icon: 'download',
            items: [
              { kind: 'item', label: 'Microsoft Excel (.xlsx)', run: () => a.exportFile('xlsx') },
              { kind: 'item', label: 'Comma-separated values (.csv)', run: () => a.exportFile('csv') }
            ]
          },
          ...trashGroup
        ]
      }
    },
    {
      id: 'edit',
      label: 'Edit',
      build: () => [
        { kind: 'item', label: 'Undo', shortcut: '⌘Z', icon: 'undo', run: a.undo, disabled: !a.canUndo },
        { kind: 'item', label: 'Redo', shortcut: '⌘Y', icon: 'redo', run: a.redo, disabled: !a.canRedo },
        { kind: 'sep' },
        { kind: 'item', label: 'Save selection as snippet…', icon: 'bookmark_add', run: a.saveSnippet }
      ]
    },
    {
      id: 'insert',
      label: 'Insert',
      build: () => [
        { kind: 'item', label: 'Row above', icon: 'add', run: a.insertRowAbove },
        { kind: 'item', label: 'Row below', run: a.insertRowBelow },
        { kind: 'item', label: 'Column left', run: a.insertColLeft },
        { kind: 'item', label: 'Column right', run: a.insertColRight },
        { kind: 'sep' },
        {
          kind: 'submenu',
          label: 'Chart',
          icon: 'bar_chart',
          items: [
            { kind: 'item', label: 'Bar chart', run: () => a.insertChart('bar') },
            { kind: 'item', label: 'Line chart', run: () => a.insertChart('line') },
            { kind: 'item', label: 'Pie chart', run: () => a.insertChart('pie') }
          ]
        },
        { kind: 'item', label: 'Pivot table', icon: 'pivot_table_chart', run: a.insertPivot },
        { kind: 'item', label: 'Sparkline', icon: 'show_chart', run: a.insertSparkline },
        { kind: 'sep' },
        { kind: 'item', label: 'Sheet', icon: 'tab', run: a.addSheet },
        { kind: 'item', label: 'Named range', icon: 'data_object', run: a.namedRanges },
        { kind: 'sep' },
        { kind: 'item', label: 'Insert snippet…', icon: 'bookmarks', run: a.insertSnippet },
        { kind: 'sep' },
        // A meeting reaches other people, so a wrong id invites them to someone
        // else's spreadsheet. It went out with `id: active?.id ?? ''`.
        ...(ops
          ? ([{ kind: 'item', label: 'Meeting', icon: 'videocam', run: () => ops.startMeeting() }] as MenuItem[])
          : [])
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
          items: [
            { kind: 'item', label: 'Bold', shortcut: '⌘B', run: () => a.format({ bold: !fmt?.bold }), active: !!fmt?.bold },
            { kind: 'item', label: 'Italic', shortcut: '⌘I', run: () => a.format({ italic: !fmt?.italic }), active: !!fmt?.italic },
            { kind: 'item', label: 'Underline', shortcut: '⌘U', run: () => a.format({ underline: !fmt?.underline }), active: !!fmt?.underline }
          ]
        },
        {
          kind: 'submenu',
          label: 'Number',
          icon: 'tag',
          items: [
            { kind: 'item', label: 'Automatic', run: () => a.numberFormat({ kind: 'general' }), active: numFmtKind === 'general' },
            { kind: 'item', label: 'Number', run: () => a.numberFormat({ kind: 'number', decimals: 2, thousands: true }), active: numFmtKind === 'number' },
            { kind: 'item', label: 'Percent', run: () => a.numberFormat({ kind: 'percent', decimals: 0 }), active: numFmtKind === 'percent' },
            { kind: 'item', label: 'Currency', run: () => a.numberFormat({ kind: 'currency', decimals: 2, symbol: '$' }), active: numFmtKind === 'currency' },
            { kind: 'item', label: 'Date', run: () => a.numberFormat({ kind: 'date', pattern: 'yyyy-MM-dd' }), active: numFmtKind === 'date' }
          ]
        },
        {
          kind: 'submenu',
          label: 'Alignment',
          icon: 'format_align_left',
          items: [
            { kind: 'item', label: 'Left', run: () => a.format({ align: 'left' }), active: fmt?.align === 'left' || fmt?.align == null },
            { kind: 'item', label: 'Center', run: () => a.format({ align: 'center' }), active: fmt?.align === 'center' },
            { kind: 'item', label: 'Right', run: () => a.format({ align: 'right' }), active: fmt?.align === 'right' }
          ]
        },
        { kind: 'sep' },
        { kind: 'item', label: 'Conditional formatting', icon: 'palette', run: a.conditionalFormat },
        { kind: 'item', label: 'Clear formatting', shortcut: '⌘\\', icon: 'format_clear', run: () => a.format({ bold: false, italic: false, underline: false, numFmt: { kind: 'general' } }) }
      ]
    },
    {
      id: 'data',
      label: 'Data',
      build: () => [
        { kind: 'item', label: 'Sort sheet A → Z', icon: 'sort', run: () => a.sort('asc') },
        { kind: 'item', label: 'Sort sheet Z → A', run: () => a.sort('desc') },
        { kind: 'sep' },
        { kind: 'item', label: a.filterActive ? 'Remove filter' : 'Create a filter', icon: 'filter_alt', run: a.toggleFilter, active: a.filterActive },
        { kind: 'item', label: 'Data validation', icon: 'rule', run: a.dataValidation },
        { kind: 'item', label: 'Named ranges', icon: 'data_object', run: a.namedRanges }
      ]
    },
    {
      id: 'tools',
      label: 'Tools',
      build: () => [{ kind: 'item', label: 'AI fill', icon: 'auto_awesome', run: a.aiFill }]
    },
    {
      id: 'help',
      label: 'Help',
      build: () => [{ kind: 'item', label: 'Keyboard shortcuts', shortcut: '⌘/', icon: 'keyboard', run: () => setShortcutsOpen(true) }]
    }
  ]

  return (
    <>
      <MenuBarShell menus={menus} testid="sheet-menubar" />
      {shortcutsOpen && (
        <MenuModal title="Keyboard shortcuts" onClose={() => setShortcutsOpen(false)}>
          <div className="space-y-1.5">
            {([
              ['Bold', '⌘B'],
              ['Italic', '⌘I'],
              ['Underline', '⌘U'],
              ['Undo', '⌘Z'],
              ['Redo', '⌘Y'],
              ['Clear formatting', '⌘\\']
            ] as [string, string][]).map(([label, keys]) => (
              <div key={label} className="flex items-center justify-between text-[13px]">
                <span className="text-[var(--ink-70)]">{label}</span>
                <span className="text-[var(--ink-40)] fb-tabular">{keys}</span>
              </div>
            ))}
          </div>
        </MenuModal>
      )}
    </>
  )
}
