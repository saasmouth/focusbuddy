import { useState } from 'react'
import { openDocHistory } from '../DocHistoryPanel'
import { confirmDialog, promptText } from '../../plexi/PromptDialog'
import type { SheetCellFormat, SheetNumberFormat, FbDocument } from '@shared/types'
import { useDocumentsStore } from '../../../stores/documents'
import { useViewStore } from '../../../stores/view'
import { launchMeeting } from '../../../lib/startMeeting'
import { MenuBarShell, MenuModal, type MenuDef } from './menuBarKit'

// A Google-Sheets-style menu bar for the spreadsheet editor. Every item maps to a
// real SheetEditor operation (passed in as `actions`) or a documents-store action.
// Capabilities the editor does not have (merge, freeze, cell find/replace) are
// simply not listed rather than shown as dead items.

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
}

export default function SheetMenuBar({ actions }: { actions: SheetMenuActions }): JSX.Element {
  const a = actions
  const fmt = a.activeFormat
  const createBlank = useDocumentsStore((s) => s.createBlank)
  const active = useDocumentsStore((s) => s.active)
  const rename = useDocumentsStore((s) => s.rename)
  const remove = useDocumentsStore((s) => s.remove)
  const goDocument = useViewStore((s) => s.goDocument)
  const goDocuments = useViewStore((s) => s.goDocuments)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  async function newSheet(): Promise<void> {
    const doc = await createBlank('sheet')
    goDocument(doc.id)
  }
  async function makeCopy(): Promise<void> {
    const body = (active?.body ?? undefined) as FbDocument['body'] | undefined
    const copy = await window.api.documents.create({
      docType: 'sheet',
      title: `Copy of ${a.title || 'Untitled sheet'}`,
      body
    })
    goDocument(copy.id)
  }
  async function doRename(): Promise<void> {
    const next = await promptText({ title: 'Rename spreadsheet', initial: a.title, confirmLabel: 'Rename' })
    if (next != null && next.trim()) void rename(next.trim())
  }
  async function moveToTrash(): Promise<void> {
    if (!active) return
    const ok = await confirmDialog({
      title: `Move "${a.title || 'Untitled sheet'}" to trash?`,
      body: 'You can restore it from the Documents trash.',
      confirmLabel: 'Move to trash'
    })
    if (!ok) return
    await remove(active.id)
    goDocuments()
  }

  const numFmtKind = fmt?.numFmt?.kind ?? 'general'

  const menus: MenuDef[] = [
    {
      id: 'file',
      label: 'File',
      build: () => [
        { kind: 'item', label: 'New spreadsheet', icon: 'note_add', run: () => void newSheet() },
        { kind: 'item', label: 'Make a copy', icon: 'file_copy', run: () => void makeCopy() },
        { kind: 'sep' },
        { kind: 'item', label: 'Rename', icon: 'edit', run: doRename },
        { kind: 'item', label: 'Version history', icon: 'history', run: () => { if (active) openDocHistory(active.id) } },
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
        { kind: 'sep' },
        { kind: 'item', label: 'Move to trash', icon: 'delete', run: () => void moveToTrash() }
      ]
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
        { kind: 'item', label: 'Meeting', icon: 'videocam', run: () => void launchMeeting({ kind: 'sheet', id: active?.id ?? '', title: a.title || 'Spreadsheet meeting' }) }
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
