import type { SheetNumberFormat } from '@shared/types'
import { READ_ONLY_REASON } from '../../office/shell'
import { sharedCommand, type OfficeCommand } from '../../../lib/menus/officeCommand'
import type { SheetMenuActions } from '../editor/SheetMenuBar'

// PlexiiCells' command registry: ONE definition per action (SPEC §9, "no
// repeats"), the twin of writeCommands.ts. The menu bar, the ContextBar ribbon
// and the Cmd+K palette all render from it.
//
// What the two copies had drifted on before this existed:
//
//   menu bar                        ribbon
//   "Center"                        "Align center"   (now "Align centre" / "Centre")
//   "Row above"                     "Insert row above"
//   "Save selection as snippet…"    "Save as snippet"
//   "Import (.xlsx / .csv)"         "Import .xlsx / .csv"
//   "Microsoft Excel (.xlsx)"       "Export .xlsx"
//
// And two things that were simply untrue:
//
//   - Format ▸ Text ▸ Bold / Italic / Underline each advertised ⌘B / ⌘I / ⌘U,
//     and Clear formatting advertised ⌘\, but PlexiiCells bound none of those
//     keys. The hints come from here now, and cellsKeys.ts binds them.
//   - The ribbon's Import button was marked `readOnlySafe`, so a viewer could
//     press it — and `importFile` returns early when readOnly, so nothing
//     happened. It is an edit, and it is now off with a reason (SPEC §9.5).
//
// Ids are `sheet-*`, matching the testids PlexiiCells already uses.

/** Everything the commands need. SheetEditor owns every one of these. */
export interface CellsCommandDeps {
  a: SheetMenuActions
  /** A viewer's sheet. Every command that would change it is disabled WITH a reason. */
  readOnly: boolean
  isMerged: boolean
  mergeCells: () => void
  insertLookup: () => void
  macros: () => void
  query: () => void
  shortcuts: () => void
  /** Open Page setup — print area, repeat rows, printed gridlines. */
  pageSetup: () => void
  /**
   * Download ▸ PDF, where the host can really produce one. Read structurally
   * from the document ops, as `print` is: the export engine adds the op, and
   * the row is ABSENT rather than dead where it is missing.
   */
  exportPdf?: () => void
}

export type CellsCommands = Record<string, OfficeCommand>

const NUMBER_FORMATS: Array<[id: string, label: string, shortLabel: string, kind: string, fmt: SheetNumberFormat]> = [
  ['sheet-numfmt-general', 'Number format: automatic', 'Automatic', 'general', { kind: 'general' }],
  ['sheet-numfmt-number', 'Number format: number', 'Number', 'number', { kind: 'number', decimals: 2, thousands: true }],
  ['sheet-numfmt-percent', 'Number format: percent', 'Percent', 'percent', { kind: 'percent', decimals: 0 }],
  ['sheet-numfmt-currency', 'Number format: currency', 'Currency', 'currency', { kind: 'currency', decimals: 2, symbol: '$' }],
  ['sheet-numfmt-date', 'Number format: date', 'Date', 'date', { kind: 'date', pattern: 'yyyy-MM-dd' }]
]

export function buildCellsCommands(d: CellsCommandDeps): CellsCommands {
  const { a, readOnly } = d
  const fmt = a.activeFormat
  const numFmtKind = fmt?.numFmt?.kind ?? 'general'

  /** A command that changes the sheet: off for a viewer, and it says why. */
  const edits = (): Pick<OfficeCommand, 'enabled' | 'reason'> => ({
    enabled: () => !readOnly,
    reason: () => (readOnly ? READ_ONLY_REASON : undefined)
  })

  const cs: OfficeCommand[] = [
    // ── Edit ───────────────────────────────────────────────────────────────
    sharedCommand('sheet-undo', 'undo', a.undo, {
      icon: 'undo',
      group: 'Edit',
      enabled: () => !readOnly && a.canUndo,
      reason: () => (readOnly ? READ_ONLY_REASON : 'Nothing to undo.')
    }),
    sharedCommand('sheet-redo', 'redo', a.redo, {
      icon: 'redo',
      group: 'Edit',
      enabled: () => !readOnly && a.canRedo,
      reason: () => (readOnly ? READ_ONLY_REASON : 'Nothing to redo.')
    }),
    sharedCommand('sheet-cut', 'cut', a.cut, { group: 'Edit', ...edits() }),
    sharedCommand('sheet-copy', 'copy', a.copy, { group: 'Edit' }),
    sharedCommand('sheet-paste', 'paste', a.paste, { group: 'Edit', ...edits() }),
    sharedCommand('sheet-delete', 'delete', a.deleteSelection, { icon: 'backspace', group: 'Edit', keywords: 'clear empty cells', ...edits() }),
    // Selecting changes nothing, so a viewer keeps ⌘A.
    sharedCommand('sheet-select-all', 'selectAll', a.selectAll, { group: 'Edit', keywords: 'every used cell' }),
    sharedCommand('sheet-find', 'find', a.find, { icon: 'search', group: 'Edit', keywords: 'search' }),
    sharedCommand('sheet-find-replace', 'findAndReplace', a.findAndReplace, { icon: 'find_replace', group: 'Edit', keywords: 'search replace', ...edits() }),
    // Reading the range out changes nothing in this sheet.
    sharedCommand('sheet-save-snippet', 'saveAsSnippet', a.saveSnippet, { group: 'Insert', keywords: 'reuse template range' }),

    // ── Format ─────────────────────────────────────────────────────────────
    {
      id: 'sheet-bold',
      label: 'Bold',
      keys: ['mod', 'b'],
      icon: 'format_bold',
      group: 'Format',
      keywords: 'strong',
      checked: () => !!fmt?.bold,
      run: () => a.format({ bold: !fmt?.bold }),
      ...edits()
    },
    {
      id: 'sheet-italic',
      label: 'Italic',
      keys: ['mod', 'i'],
      icon: 'format_italic',
      group: 'Format',
      keywords: 'emphasis',
      checked: () => !!fmt?.italic,
      run: () => a.format({ italic: !fmt?.italic }),
      ...edits()
    },
    {
      id: 'sheet-underline',
      label: 'Underline',
      keys: ['mod', 'u'],
      icon: 'format_underlined',
      group: 'Format',
      checked: () => !!fmt?.underline,
      run: () => a.format({ underline: !fmt?.underline }),
      ...edits()
    },
    // British in display, American in the id and the stored attribute.
    ...(
      [
        ['left', 'Align left', 'Left', 'format_align_left'],
        ['center', 'Align centre', 'Centre', 'format_align_center'],
        ['right', 'Align right', 'Right', 'format_align_right']
      ] as const
    ).map(
      ([value, label, shortLabel, icon]): OfficeCommand => ({
        id: `sheet-align-${value}`,
        label,
        shortLabel,
        icon,
        group: 'Align',
        ...(value === 'center' ? { keywords: 'center' } : {}),
        // Left is the default, so an unset cell reads as left-aligned — which
        // is what the menu already showed.
        checked: () => fmt?.align === value || (value === 'left' && fmt?.align == null),
        run: () => a.format({ align: value }),
        ...edits()
      })
    ),
    ...NUMBER_FORMATS.map(
      ([id, label, shortLabel, kind, f]): OfficeCommand => ({
        id,
        label,
        shortLabel,
        group: 'Format',
        keywords: 'number format cells',
        checked: () => numFmtKind === kind,
        run: () => a.numberFormat(f),
        ...edits()
      })
    ),
    {
      id: 'sheet-merge',
      // The one control whose label depends on state, so it says what pressing
      // it will DO, in every surface at once.
      label: d.isMerged ? 'Unmerge cells' : 'Merge the selected cells',
      icon: d.isMerged ? 'call_split' : 'call_merge',
      group: 'Format',
      keywords: 'merge unmerge span combine',
      checked: () => d.isMerged,
      run: d.mergeCells,
      ...edits()
    },
    { id: 'sheet-cond-format', label: 'Conditional formatting', barLabel: 'Conditional formatting for the selection', icon: 'palette', group: 'Format', keywords: 'rules colour scale highlight', run: a.conditionalFormat, ...edits() },
    // The one shared clear-formatting action (lexicon `clearFormatting`):
    // PlexiiWrite binds the same label and the same ⌘\ to its own reset.
    sharedCommand('sheet-clear-format', 'clearFormatting', () => a.format({ bold: false, italic: false, underline: false, numFmt: { kind: 'general' } }), {
      group: 'Format',
      keywords: 'remove strip reset',
      ...edits()
    }),

    // ── Insert ─────────────────────────────────────────────────────────────
    { id: 'sheet-row-above', label: 'Insert row above', shortLabel: 'Row above', icon: 'add_row_above', group: 'Insert', run: a.insertRowAbove, ...edits() },
    { id: 'sheet-row-below', label: 'Insert row below', shortLabel: 'Row below', icon: 'add_row_below', group: 'Insert', run: a.insertRowBelow, ...edits() },
    { id: 'sheet-col-left', label: 'Insert column left', shortLabel: 'Column left', icon: 'add_column_left', group: 'Insert', run: a.insertColLeft, ...edits() },
    { id: 'sheet-col-right', label: 'Insert column right', shortLabel: 'Column right', icon: 'add_column_right', group: 'Insert', run: a.insertColRight, ...edits() },
    { id: 'sheet-delete-row', label: 'Delete row', icon: 'delete', group: 'Insert', run: a.deleteRow, ...edits() },
    { id: 'sheet-delete-col', label: 'Delete column', icon: 'delete_sweep', group: 'Insert', run: a.deleteCol, ...edits() },
    ...(
      [
        // All five kinds insertChart accepts. The menu bar offered three and
        // the ribbon five, for no reason beyond the two lists being written
        // separately.
        ['bar', 'Insert bar chart', 'Bar chart'],
        ['line', 'Insert line chart', 'Line chart'],
        ['pie', 'Insert pie chart', 'Pie chart'],
        ['area', 'Insert area chart', 'Area chart'],
        ['scatter', 'Insert scatter chart', 'Scatter chart']
      ] as const
    ).map(
      ([kind, label, shortLabel]): OfficeCommand => ({
        id: `sheet-chart-${kind}`,
        label,
        shortLabel,
        icon: 'bar_chart',
        group: 'Insert',
        keywords: 'chart graph plot',
        run: () => a.insertChart(kind),
        ...edits()
      })
    ),
    { id: 'sheet-pivot', label: 'Pivot table', barLabel: 'Pivot table from the selection', icon: 'pivot_table_chart', group: 'Insert', keywords: 'summarise group', run: a.insertPivot, ...edits() },
    { id: 'sheet-sparkline', label: 'Sparkline', barLabel: 'Sparkline of the selection, into the next cell', icon: 'show_chart', group: 'Insert', keywords: 'inline chart trend', run: a.insertSparkline, ...edits() },
    { id: 'sheet-lookup', label: 'Insert a lookup (XLOOKUP)', barLabel: 'Insert a lookup (XLOOKUP) into the active cell', icon: 'search', group: 'Insert', keywords: 'xlookup vlookup match', run: d.insertLookup, ...edits() },
    { id: 'sheet-add-sheet', label: 'Add a sheet', shortLabel: 'Sheet', icon: 'add', group: 'Insert', keywords: 'tab new', run: a.addSheet, ...edits() },
    // ONE named-ranges command. The menu bar listed it twice, under two
    // labels — Insert ▸ "Named range" and Data ▸ "Named ranges" — both running
    // `a.namedRanges`. It belongs in Data, which is where the row stays.
    { id: 'sheet-named-ranges', label: 'Named ranges', icon: 'label', group: 'Data', keywords: 'name reference', run: a.namedRanges },
    sharedCommand('sheet-insert-snippet', 'insertSnippet', a.insertSnippet, { group: 'Insert', keywords: 'saved reusable range template', ...edits() }),

    // ── Data ───────────────────────────────────────────────────────────────
    { id: 'sheet-sort-asc', label: 'Sort sheet A → Z', barLabel: 'Sort ascending', icon: 'arrow_upward', group: 'Data', keywords: 'sort ascending', run: () => a.sort('asc'), ...edits() },
    { id: 'sheet-sort-desc', label: 'Sort sheet Z → A', barLabel: 'Sort descending', icon: 'arrow_downward', group: 'Data', keywords: 'sort descending', run: () => a.sort('desc'), ...edits() },
    {
      id: 'sheet-filter',
      label: a.filterActive ? 'Remove filter' : 'Create a filter',
      icon: 'filter_alt',
      group: 'Data',
      barLabel: a.filterActive ? 'Remove the filter (funnels on the headers)' : 'Create a filter (funnels on the headers)',
      keywords: 'filter funnel headers',
      checked: () => a.filterActive,
      run: a.toggleFilter,
      ...edits()
    },
    { id: 'sheet-validation', label: 'Data validation', barLabel: 'Data validation for the selection', icon: 'rule', group: 'Data', keywords: 'rules allowed values dropdown', run: a.dataValidation, ...edits() },
    { id: 'sheet-query', label: 'Query — shape data with refreshable transform steps', icon: 'account_tree', group: 'Data', keywords: 'transform steps refresh', run: d.query, ...edits() },

    // ── Tools ──────────────────────────────────────────────────────────────
    { id: 'sheet-ai-fill', label: 'AI fill', icon: 'auto_awesome', group: 'AI', keywords: 'generate complete pattern', run: a.aiFill, ...edits() },
    { id: 'sheet-macros', label: 'Macros — automate the sheet with a script', icon: 'code', group: 'Tools', keywords: 'script automate', run: d.macros, ...edits() },

    // ── File ───────────────────────────────────────────────────────────────
    // What goes on paper. An edit, like any other setting stored in the
    // workbook, so a viewer gets the row with a reason rather than a dialog
    // whose Clear button would do nothing.
    {
      id: 'sheet-page-setup',
      label: 'Page setup…',
      icon: 'print',
      group: 'File',
      keywords: 'print area gridlines repeat rows header paper page',
      run: d.pageSetup,
      ...edits()
    },
    // Import REPLACES the body, so it is an edit: the ribbon used to mark it
    // read-only safe, which left a viewer a button that did nothing.
    { id: 'sheet-import', label: 'Import (.xlsx / .csv)', barLabel: 'Import .xlsx / .csv', icon: 'upload_file', group: 'File', keywords: 'open excel csv', run: a.importFile, ...edits() },
    { id: 'sheet-export-xlsx', label: 'Download Excel (.xlsx)…', shortLabel: 'Microsoft Excel (.xlsx)', barLabel: 'Export .xlsx', icon: 'table_chart', group: 'File', keywords: 'save export excel xlsx', run: () => a.exportFile('xlsx') },
    { id: 'sheet-export-csv', label: 'Download CSV (.csv)…', shortLabel: 'Comma-separated values (.csv)', barLabel: 'Export .csv', icon: 'description', group: 'File', keywords: 'save export csv', run: () => a.exportFile('csv') },
    ...(d.exportPdf
      ? [
          {
            id: 'sheet-export-pdf',
            label: 'Download PDF…',
            shortLabel: 'PDF document (.pdf)',
            icon: 'picture_as_pdf',
            group: 'File',
            keywords: 'save export pdf print',
            run: d.exportPdf
          } as OfficeCommand
        ]
      : []),

    // ── Help ───────────────────────────────────────────────────────────────
    sharedCommand('sheet-shortcuts', 'keyboardShortcuts', d.shortcuts, { icon: 'keyboard', group: 'Help' })
  ]

  const map: CellsCommands = {}
  for (const c of cs) {
    if (map[c.id]) throw new Error(`buildCellsCommands: duplicate id "${c.id}"`)
    map[c.id] = c
  }
  return map
}
