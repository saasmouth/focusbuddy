// AI fill panel — a two-step flow that mirrors the Tables assistant: first
// design the COLUMNS, then generate ROWS that fit them. Step one proposes a
// clean set of header names from the user's description (editable before they
// commit); step two fills rows against those exact headers. Everything is
// previewed before it touches the sheet, and any formula the model returns is
// run through the real engine on apply, so the AI cannot smuggle in a fake
// number — a bad formula shows #ERR like any other.

import { useState } from 'react'
import Icon from '../../Icon'
import { useAiBusyLabel } from '../../../lib/localAiEngine'

interface Props {
  headers: string[]
  rangeRows: number
  // Writes the chosen header names into the sheet (step one). Returns the names
  // actually applied so step two can generate rows against them.
  onApplyColumns: (columns: string[]) => void
  // Writes the generated row matrix into the sheet (step two).
  onApply: (matrix: string[][]) => void
  onClose: () => void
}

// A header is "real" (user-named) rather than a default A/B/C grid label.
function hasNamedColumns(headers: string[]): boolean {
  return headers.some((h, i) => h.trim() && h.trim() !== defaultLabel(i))
}
function defaultLabel(i: number): string {
  let s = ''
  let n = i
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

export default function SheetAiFill({
  headers,
  rangeRows,
  onApplyColumns,
  onApply,
  onClose
}: Props): JSX.Element {
  const warmLabel = useAiBusyLabel()
  const [step, setStep] = useState<'columns' | 'rows'>('columns')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Step one state: the editable list of proposed columns.
  const [cols, setCols] = useState<string[] | null>(null)
  // Step two state: the headers locked in, and the previewed row matrix.
  const [activeHeaders, setActiveHeaders] = useState<string[]>([])
  // 'auto' = let the AI generate as many rows as the task actually needs (a full
  // project plan, not a 5-row sample). 'exact' = a specific number.
  const [rowMode, setRowMode] = useState<'auto' | 'exact'>('auto')
  const [rowCount, setRowCount] = useState(Math.max(1, rangeRows))
  const [rows, setRows] = useState<string[][] | null>(null)

  async function suggestColumns(): Promise<void> {
    if (!prompt.trim()) return
    setBusy(true)
    setError(null)
    setCols(null)
    try {
      const existing = headers.filter((h, i) => h.trim() && h.trim() !== defaultLabel(i))
      const res = await window.api.sheet.aiColumns({ prompt, existing })
      if (!res.ok || !res.columns) {
        setError(res.error || (res.needsApiKey ? 'No Anthropic API key set.' : 'The AI returned nothing.'))
        return
      }
      setCols(res.columns)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Lock the columns in (write them to the sheet) and move to the rows step.
  function commitColumns(list: string[]): void {
    const clean = list.map((c) => c.trim()).filter(Boolean)
    if (!clean.length) {
      setError('Add at least one column first.')
      return
    }
    onApplyColumns(clean)
    setActiveHeaders(clean)
    setError(null)
    setRows(null)
    setStep('rows')
  }

  async function generateRows(): Promise<void> {
    if (!prompt.trim()) return
    setBusy(true)
    setError(null)
    setRows(null)
    try {
      const res = await window.api.sheet.aiFill({
        prompt,
        headers: activeHeaders,
        rangeRows: rowMode === 'exact' ? rowCount : 0,
        auto: rowMode === 'auto'
      })
      if (!res.ok || !res.rows) {
        setError(res.error || (res.needsApiKey ? 'No Anthropic API key set.' : 'The AI returned nothing.'))
        return
      }
      setRows(res.rows)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-accent/30 bg-accent/[0.04] p-3 mb-2" data-testid="sheet-ai-fill">
      <div className="flex items-center gap-1.5 mb-2">
        <Icon name="auto_awesome" size={13} className="text-accent" />
        <span className="text-[11px] uppercase tracking-wider font-semibold text-accent">
          {step === 'columns' ? 'AI · Step 1 of 2 · Columns' : 'AI · Step 2 of 2 · Rows'}
        </span>
        <button onClick={onClose} className="ml-auto icon-btn" aria-label="Close">
          <Icon name="close" size={13} />
        </button>
      </div>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            if (step === 'columns') void suggestColumns()
            else void generateRows()
          }
        }}
        placeholder={'Describe the data. e.g. "A project plan for a Loop ERP marketing launch with tasks, owners, start and end dates, and status"'}
        rows={2}
        autoFocus
        className="fb-field w-full bg-[var(--surface-raised)] px-3 py-2 text-[13px] resize-none"
      />
      {error && <div className="text-[12px] text-red-600 dark:text-red-400 mt-1">{error}</div>}

      {/* ── Step 1: columns ───────────────────────────────────────────────── */}
      {step === 'columns' && (
        <>
          {cols && (
            <div className="mt-2" data-testid="sheet-ai-columns">
              <div className="text-[11px] text-[var(--ink-50)] mb-1">
                Proposed columns — edit, add, or remove, then create them.
              </div>
              <div className="space-y-1.5 max-h-48 overflow-auto">
                {cols.map((col, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <span className="text-[11px] font-mono text-[var(--ink-40)] w-5 text-right shrink-0">{i + 1}</span>
                    <input
                      value={col}
                      onChange={(e) =>
                        setCols((cur) => (cur ? cur.map((c, j) => (j === i ? e.target.value : c)) : cur))
                      }
                      className="fb-field flex-1 bg-[var(--surface-raised)] px-2 py-1 text-[12px]"
                    />
                    <button
                      onClick={() => setCols((cur) => (cur ? cur.filter((_, j) => j !== i) : cur))}
                      className="icon-btn"
                      aria-label="Remove column"
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </div>
                ))}
              </div>
              <button
                onClick={() => setCols((cur) => [...(cur ?? []), ''])}
                className="mt-1.5 text-[12px] text-accent hover:underline flex items-center gap-1"
              >
                <Icon name="add" size={12} /> Add column
              </button>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 mt-2">
            {cols == null ? (
              <button
                onClick={() => void suggestColumns()}
                disabled={busy || !prompt.trim()}
                className="btn-primary text-[12px] px-3 py-1.5"
              >
                {busy ? warmLabel('Thinking…') : 'Suggest columns'}
              </button>
            ) : (
              <>
                <button
                  onClick={() => commitColumns(cols)}
                  data-testid="sheet-ai-create-columns"
                  className="btn-primary text-[12px] px-3 py-1.5"
                >
                  Create {cols.filter((c) => c.trim()).length} columns
                </button>
                <button
                  onClick={() => void suggestColumns()}
                  disabled={busy}
                  className="fb-btn-surface text-[12px] px-3 py-1.5 hover:bg-[var(--surface-sunken)]"
                >
                  Re-suggest
                </button>
              </>
            )}
            {hasNamedColumns(headers) && (
              <button
                onClick={() => commitColumns(headers.filter((h, i) => h.trim() && h.trim() !== defaultLabel(i)))}
                className="fb-btn-surface text-[12px] px-3 py-1.5 hover:bg-[var(--surface-sunken)]"
              >
                Use existing columns
              </button>
            )}
            <span className="text-[11px] text-[var(--ink-40)]">Cmd+Enter</span>
          </div>
        </>
      )}

      {/* ── Step 2: rows ──────────────────────────────────────────────────── */}
      {step === 'rows' && (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="sheet-ai-active-headers">
            {activeHeaders.map((h, i) => (
              <span
                key={i}
                className="text-[11px] px-2 py-0.5 rounded-full bg-[color-mix(in_oklab,var(--surface-sunken)_70%,transparent)] text-[var(--ink-70)]"
              >
                {h}
              </span>
            ))}
            <button
              onClick={() => {
                setStep('columns')
                setRows(null)
                setError(null)
              }}
              className="text-[11px] text-accent hover:underline ml-1"
            >
              Edit columns
            </button>
          </div>

          <div className="mt-2 flex items-center gap-2" data-testid="sheet-ai-row-mode">
            <label className="text-[12px] text-[var(--ink-50)]">Rows</label>
            <div className="inline-flex rounded-md bg-[var(--surface-sunken)] overflow-hidden text-[12px]">
              <button
                onClick={() => setRowMode('auto')}
                data-testid="sheet-ai-rowmode-auto"
                className={`px-2.5 py-1 ${rowMode === 'auto' ? 'bg-accent text-white' : 'hover:bg-[var(--surface-sunken)]'}`}
              >
                As many as needed
              </button>
              <button
                onClick={() => setRowMode('exact')}
                className={`px-2.5 py-1 border-l border-[var(--edge-firm)] ${rowMode === 'exact' ? 'bg-accent text-white' : 'hover:bg-[var(--surface-sunken)]'}`}
              >
                Exact
              </button>
            </div>
            {rowMode === 'exact' && (
              <input
                type="number"
                min={1}
                value={rowCount}
                onChange={(e) => setRowCount(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                className="fb-field w-20 bg-[var(--surface-raised)] px-2 py-1 text-[12px]"
              />
            )}
            {rowMode === 'auto' && (
              <span className="text-[11px] text-[var(--ink-40)]">The AI decides how many rows the task needs.</span>
            )}
          </div>

          {rows && (
            <div className="mt-2 max-h-48 overflow-auto rounded-lg border border-[var(--edge-soft)]">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-[var(--edge-soft)] bg-[var(--surface-sunken)]">
                    {activeHeaders.map((h, j) => (
                      <th
                        key={j}
                        className="px-2 py-1 border-r border-[var(--edge-soft)] text-left font-semibold truncate max-w-[160px]"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 30).map((row, i) => (
                    <tr key={i} className="border-b border-[var(--edge-soft)]">
                      {row.map((cell, j) => (
                        <td
                          key={j}
                          className="px-2 py-1 border-r border-[var(--edge-soft)] truncate max-w-[160px]"
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center gap-2 mt-2">
            {rows == null ? (
              <button
                onClick={() => void generateRows()}
                disabled={busy || !prompt.trim()}
                className="btn-primary text-[12px] px-3 py-1.5"
              >
                {busy ? warmLabel('Generating…') : 'Generate rows'}
              </button>
            ) : (
              <>
                <button
                  onClick={() => onApply(rows)}
                  data-testid="sheet-ai-apply"
                  className="btn-primary text-[12px] px-3 py-1.5"
                >
                  Insert {rows.length} rows
                </button>
                <button
                  onClick={() => void generateRows()}
                  disabled={busy}
                  className="fb-btn-surface text-[12px] px-3 py-1.5 hover:bg-[var(--surface-sunken)]"
                >
                  Regenerate
                </button>
              </>
            )}
            <span className="text-[11px] text-[var(--ink-40)]">Previewed before it writes. Cmd+Enter</span>
          </div>
        </>
      )}
    </div>
  )
}
