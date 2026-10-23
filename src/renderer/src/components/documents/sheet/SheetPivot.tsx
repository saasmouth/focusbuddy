import type { SheetPivotFilter, SheetPivotSpec, SheetTab } from '@shared/types'
import { displayCell } from '../../../lib/sheetFormula'
import { computePivot } from '../../../lib/sheetPivot'
import Icon from '../../Icon'

// Renders a pivot summary from a spec, resolving its source range against the
// live tab. Values come from displayCell so computed formulas are summarised
// honestly (a number that can't be computed shows #ERR upstream and is skipped).
// Slicers let the reader hide row/column field values interactively; the hidden
// set is persisted on spec.filters via onUpdateSpec so it survives a reload.

interface Props {
  spec: SheetPivotSpec
  tab: SheetTab
  onRemove: () => void
  onUpdateSpec: (next: SheetPivotSpec) => void
}

// Exported for paper: a printed pivot shows its numbers exactly as this table does.
export function fmt(n: number | null): string {
  if (n === null) return ''
  return Number.isInteger(n) ? String(n) : (Math.round(n * 100) / 100).toString()
}

// Toggle a single value's visibility for a slicer field, returning the next spec.
function toggleValue(spec: SheetPivotSpec, field: number, value: string): SheetPivotSpec {
  const filters = [...(spec.filters ?? [])]
  const idx = filters.findIndex((f) => f.field === field)
  const current = idx >= 0 ? filters[idx].exclude : []
  const exclude = current.includes(value) ? current.filter((v) => v !== value) : [...current, value]
  const next: SheetPivotFilter = { field, exclude }
  if (idx >= 0) filters[idx] = next
  else filters.push(next)
  // Drop empty filter entries so a fully-included field leaves no residue.
  return { ...spec, filters: filters.filter((f) => f.exclude.length > 0) }
}

export default function SheetPivot({ spec, tab, onRemove, onUpdateSpec }: Props): JSX.Element {
  const grid = { columns: tab.columns, rows: tab.rows }
  const result = computePivot((r, c) => displayCell(grid, r, c), spec)
  const excludedFor = (field: number): Set<string> =>
    new Set((spec.filters ?? []).find((f) => f.field === field)?.exclude ?? [])

  return (
    <div
      className="fb-card p-3"
      data-testid="sheet-pivot"
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[12px] font-semibold text-[var(--ink-70)]">
          {spec.title || (result ? `${spec.agg} of ${result.valueFieldLabel}` : 'Pivot')}
        </span>
        <button onClick={onRemove} className="icon-btn" title="Remove pivot">
          <Icon name="close" size={13} />
        </button>
      </div>
      {result && (result.rowFieldValues.length > 1 || result.colFieldValues.length > 1) && (
        <div className="flex flex-wrap gap-3 mb-2" data-testid="sheet-pivot-slicers">
          <Slicer
            label={result.rowFieldLabel}
            field={spec.rowField}
            values={result.rowFieldValues}
            excluded={excludedFor(spec.rowField)}
            onToggle={(v) => onUpdateSpec(toggleValue(spec, spec.rowField, v))}
          />
          {spec.colField != null && result.colFieldValues.length > 1 && (
            <Slicer
              label={result.colFieldLabel ?? 'Columns'}
              field={spec.colField}
              values={result.colFieldValues}
              excluded={excludedFor(spec.colField)}
              onToggle={(v) => onUpdateSpec(toggleValue(spec, spec.colField!, v))}
            />
          )}
        </div>
      )}
      {!result ? (
        <div className="text-[12px] text-[var(--ink-40)]">Could not read the pivot's source range.</div>
      ) : (
        <div className="overflow-auto">
          <table className="text-[11px] border-collapse">
            <thead>
              <tr className="border-b border-[var(--edge-soft)]">
                <th className="text-left px-2 py-1 text-[var(--ink-50)] font-medium">{result.rowFieldLabel}</th>
                {result.colFieldLabel != null &&
                  result.colKeys.map((ck) => (
                    <th key={ck} className="text-right px-2 py-1 text-[var(--ink-50)] font-medium">
                      {ck || '(blank)'}
                    </th>
                  ))}
                <th className="text-right px-2 py-1 text-[var(--ink-50)] font-medium">
                  {result.agg === 'count' ? 'Count' : 'Total'}
                </th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => (
                <tr key={row.key} className="border-b border-[var(--edge-soft)]">
                  <td className="px-2 py-1 text-[var(--ink-70)]">{row.key || '(blank)'}</td>
                  {result.colFieldLabel != null &&
                    row.cells.map((c, i) => (
                      <td key={i} className="px-2 py-1 text-right text-[var(--ink-70)]">
                        {fmt(c)}
                      </td>
                    ))}
                  <td className="px-2 py-1 text-right font-medium text-[var(--ink-90)]">
                    {fmt(row.total)}
                  </td>
                </tr>
              ))}
              <tr className="border-t-2 border-[var(--edge-firm)]">
                <td className="px-2 py-1 font-semibold text-[var(--ink-70)]">Grand total</td>
                {result.colFieldLabel != null && result.colKeys.map((ck) => <td key={ck} />)}
                <td className="px-2 py-1 text-right font-semibold text-[var(--ink-90)]">
                  {fmt(result.grandTotal)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// A compact slicer: a labelled set of value checkboxes. A checked box means the
// value is visible; unchecking it hides that value from the pivot.
function Slicer({
  label,
  field,
  values,
  excluded,
  onToggle
}: {
  label: string
  field: number
  values: string[]
  excluded: Set<string>
  onToggle: (value: string) => void
}): JSX.Element {
  return (
    <div
      className="rounded-md bg-[var(--surface-base)] p-1.5 min-w-[120px]"
      data-testid={`sheet-pivot-slicer-${field}`}
    >
      <div className="text-[10px] uppercase tracking-wide text-[var(--ink-40)] px-1 pb-1">{label}</div>
      <div className="flex flex-col gap-0.5 max-h-[140px] overflow-auto">
        {values.map((v) => (
          <label
            key={v}
            className="flex items-center gap-1.5 px-1 py-0.5 text-[11px] text-[var(--ink-70)] cursor-pointer hover:bg-[var(--surface-raised)] rounded"
            data-testid={`sheet-pivot-slicer-${field}-item`}
          >
            <input
              type="checkbox"
              checked={!excluded.has(v)}
              onChange={() => onToggle(v)}
              className="accent-[var(--accent)]"
            />
            <span className="truncate">{v || '(blank)'}</span>
          </label>
        ))}
      </div>
    </div>
  )
}
