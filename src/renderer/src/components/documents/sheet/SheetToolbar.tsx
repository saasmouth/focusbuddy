// The spreadsheet toolbar: undo/redo, cell formatting (bold/italic/underline,
// colour, fill, align), number formats, structural row/column ops, sort, charts,
// Office import/export and AI fill. All actions are callbacks owned by
// SheetEditor; this component only renders controls.

import { useEffect, useRef, useState } from 'react'
import type { SheetCellFormat, SheetNumberFormat } from '@shared/types'
import Icon from '../../Icon'
import FontPicker from '../editor/FontPicker'

interface Props {
  activeFont?: string
  onFormat: (patch: Partial<SheetCellFormat>) => void
  onNumberFormat: (fmt: SheetNumberFormat) => void
  onInsertRow: () => void
  onDeleteRow: () => void
  onInsertCol: () => void
  onDeleteCol: () => void
  onSort: (dir: 'asc' | 'desc') => void
  onConditionalFormat: () => void
  onDataValidation: () => void
  onMergeCells: () => void
  isMerged: boolean
  filterActive: boolean
  onToggleFilter: () => void
  onInsertPivot: () => void
  onInsertSparkline: () => void
  onInsertLookup: () => void
  onMacros: () => void
  onQuery: () => void
  onInsertChart: (type: 'bar' | 'line' | 'pie' | 'area' | 'scatter') => void
  onImport: () => void
  onExport: (format: 'xlsx' | 'csv') => void
  onAiFill: () => void
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
}

const NUMBER_FORMATS: Array<{ label: string; fmt: SheetNumberFormat }> = [
  { label: 'General', fmt: { kind: 'general' } },
  { label: 'Number (1,234.50)', fmt: { kind: 'number', decimals: 2, thousands: true } },
  { label: 'Integer (1,234)', fmt: { kind: 'number', decimals: 0, thousands: true } },
  { label: 'Currency ($)', fmt: { kind: 'currency', decimals: 2, symbol: '$' } },
  { label: 'Percent (%)', fmt: { kind: 'percent', decimals: 1 } },
  { label: 'Date (YYYY-MM-DD)', fmt: { kind: 'date', pattern: 'YYYY-MM-DD' } }
]

export default function SheetToolbar(props: Props): JSX.Element {
  const [menu, setMenu] = useState<null | 'chart' | 'io'>(null)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    function onDown(e: MouseEvent): void {
      if (!ref.current?.contains(e.target as Node)) setMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const btn =
    'h-7 min-w-7 px-1 inline-flex items-center justify-center rounded text-[13px] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] disabled:opacity-40'
  const Divider = (): JSX.Element => <div className="w-px h-5 bg-[var(--edge-soft)] mx-0.5" />
  const sel = 'fb-field w-auto h-7 text-[11px] px-1 text-[var(--ink-70)]'

  return (
    <div ref={ref} className="flex items-center gap-0.5 flex-wrap px-2 py-1.5 border-b border-[var(--edge-soft)]" data-testid="sheet-toolbar">
      <button className={btn} title="Undo" onClick={props.onUndo} disabled={!props.canUndo}>
        <Icon name="undo" size={15} />
      </button>
      <button className={btn} title="Redo" onClick={props.onRedo} disabled={!props.canRedo}>
        <Icon name="redo" size={15} />
      </button>
      <Divider />

      <button className={btn} title="Bold" onClick={() => props.onFormat({ bold: true })}>
        <Icon name="format_bold" size={15} />
      </button>
      <button className={btn} title="Italic" onClick={() => props.onFormat({ italic: true })}>
        <Icon name="format_italic" size={15} />
      </button>
      <button className={btn} title="Underline" onClick={() => props.onFormat({ underline: true })}>
        <Icon name="format_underlined" size={15} />
      </button>
      <label className={btn + ' relative cursor-pointer'} title="Text colour">
        <Icon name="format_color_text" size={15} />
        <input type="color" className="absolute inset-0 opacity-0 cursor-pointer" onChange={(e) => props.onFormat({ color: e.target.value })} />
      </label>
      <label className={btn + ' relative cursor-pointer'} title="Fill colour">
        <Icon name="format_color_fill" size={15} />
        <input type="color" className="absolute inset-0 opacity-0 cursor-pointer" onChange={(e) => props.onFormat({ bg: e.target.value })} />
      </label>
      <FontPicker value={props.activeFont} onChange={(v) => props.onFormat({ fontFamily: v })} compact />
      <button className={btn} title="Align left" onClick={() => props.onFormat({ align: 'left' })}>
        <Icon name="format_align_left" size={15} />
      </button>
      <button className={btn} title="Align center" onClick={() => props.onFormat({ align: 'center' })}>
        <Icon name="format_align_center" size={15} />
      </button>
      <button className={btn} title="Align right" onClick={() => props.onFormat({ align: 'right' })}>
        <Icon name="format_align_right" size={15} />
      </button>
      <button
        className={`${btn} ${props.isMerged ? 'bg-accent/15 text-accent' : ''}`}
        title={props.isMerged ? 'Unmerge cells' : 'Merge the selected cells'}
        data-testid="sheet-merge-btn"
        aria-pressed={props.isMerged}
        onClick={props.onMergeCells}
      >
        <Icon name={props.isMerged ? 'call_split' : 'call_merge'} size={15} />
      </button>
      <Divider />

      <select
        className={sel}
        title="Number format"
        data-testid="sheet-number-format"
        defaultValue=""
        onChange={(e) => {
          const idx = Number(e.target.value)
          if (!Number.isNaN(idx) && NUMBER_FORMATS[idx]) props.onNumberFormat(NUMBER_FORMATS[idx].fmt)
          e.target.value = ''
        }}
      >
        <option value="" disabled>
          Format
        </option>
        {NUMBER_FORMATS.map((f, i) => (
          <option key={f.label} value={i}>
            {f.label}
          </option>
        ))}
      </select>
      <Divider />

      <button className={btn} title="Insert row above" onClick={props.onInsertRow}>
        <Icon name="add_row_above" size={15} />
      </button>
      <button className={btn} title="Delete row" onClick={props.onDeleteRow}>
        <Icon name="delete" size={15} />
      </button>
      <button className={btn} title="Insert column left" onClick={props.onInsertCol}>
        <Icon name="add_column_left" size={15} />
      </button>
      <button className={btn} title="Delete column" onClick={props.onDeleteCol}>
        <Icon name="delete_sweep" size={15} />
      </button>
      <button className={btn} title="Sort ascending" onClick={() => props.onSort('asc')}>
        <Icon name="arrow_upward" size={15} />
      </button>
      <button className={btn} title="Sort descending" onClick={() => props.onSort('desc')}>
        <Icon name="arrow_downward" size={15} />
      </button>
      <button
        className={btn}
        title="Conditional formatting for the selection"
        data-testid="sheet-condformat-btn"
        onClick={props.onConditionalFormat}
      >
        <Icon name="palette" size={15} />
      </button>
      <button
        className={btn}
        title="Data validation for the selection"
        data-testid="sheet-validation-btn"
        onClick={props.onDataValidation}
      >
        <Icon name="rule" size={15} />
      </button>
      <button
        className={`${btn} ${props.filterActive ? 'bg-accent/[0.12] text-accent' : ''}`}
        title="Create a filter (funnels on the headers)"
        data-testid="sheet-filter-btn"
        onClick={props.onToggleFilter}
      >
        <Icon name="filter_alt" size={15} />
      </button>
      <button
        className={btn}
        title="Pivot table from the selection"
        data-testid="sheet-pivot-btn"
        onClick={props.onInsertPivot}
      >
        <Icon name="pivot_table_chart" size={15} />
      </button>
      <button
        className={btn}
        title="Insert a sparkline of the selection into the next cell"
        data-testid="sheet-insert-sparkline"
        onClick={props.onInsertSparkline}
      >
        <Icon name="show_chart" size={15} />
      </button>
      <button
        className={btn}
        title="Insert a lookup (XLOOKUP) into the active cell"
        data-testid="sheet-lookup-btn"
        onClick={props.onInsertLookup}
      >
        <Icon name="search" size={15} />
      </button>
      <button
        className={btn}
        title="Macros — automate the sheet with a script"
        data-testid="sheet-macros-btn"
        onClick={props.onMacros}
      >
        <Icon name="code" size={15} />
      </button>
      <button
        className={btn}
        title="Query — shape data with refreshable transform steps"
        data-testid="sheet-query-btn"
        onClick={props.onQuery}
      >
        <Icon name="account_tree" size={15} />
      </button>
      <Divider />

      <div className="relative">
        <button className={btn} title="Insert chart" onClick={() => setMenu(menu === 'chart' ? null : 'chart')}>
          <Icon name="bar_chart" size={15} />
        </button>
        {menu === 'chart' && (
          <div className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute left-0 z-50 mt-1 w-36 py-1 text-[12px]">
            {(['bar', 'line', 'area', 'pie', 'scatter'] as const).map((t) => (
              <button
                key={t}
                onClick={() => {
                  props.onInsertChart(t)
                  setMenu(null)
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-[var(--surface-sunken)] capitalize"
              >
                {t} chart
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="ml-auto flex items-center gap-0.5">
        <div className="relative">
          <button className={btn} title="Import / export" onClick={() => setMenu(menu === 'io' ? null : 'io')}>
            <Icon name="folder_open" size={15} />
          </button>
          {menu === 'io' && (
            <div className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute right-0 z-50 mt-1 w-44 py-1 text-[12px]">
              <button onClick={() => { setMenu(null); props.onImport() }} className="w-full text-left px-3 py-1.5 hover:bg-[var(--surface-sunken)]">
                <Icon name="upload_file" size={14} className="inline mr-1.5 text-[var(--ink-40)]" /> Import .xlsx / .csv
              </button>
              <button onClick={() => { setMenu(null); props.onExport('xlsx') }} className="w-full text-left px-3 py-1.5 hover:bg-[var(--surface-sunken)]">
                <Icon name="table_chart" size={14} className="inline mr-1.5 text-[var(--ink-40)]" /> Export .xlsx
              </button>
              <button onClick={() => { setMenu(null); props.onExport('csv') }} className="w-full text-left px-3 py-1.5 hover:bg-[var(--surface-sunken)]">
                <Icon name="description" size={14} className="inline mr-1.5 text-[var(--ink-40)]" /> Export .csv
              </button>
            </div>
          )}
        </div>
        <button
          onClick={props.onAiFill}
          className="inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-lg bg-accent/10 text-accent hover:bg-accent/20"
        >
          <Icon name="auto_awesome" size={13} /> AI fill
        </button>
      </div>
    </div>
  )
}
