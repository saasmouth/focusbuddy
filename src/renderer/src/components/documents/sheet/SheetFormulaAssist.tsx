// Natural-language formula assistant. You describe what you want ("revenue minus
// cost for this row") and the AI proposes the best A1-style formula for the
// active cell, explains it in a sentence, and — only when the job needs it —
// proposes extra columns or tabs. Quick-insert chips drop real column/cell
// references into your request. Nothing is written until you click Apply, and a
// formula that the engine can't even parse is never offered (honesty gate).

import { useState } from 'react'
import Icon from '../../Icon'
import { isParseableFormula } from '../../../lib/sheetFormula'
import { useAiBusyLabel } from '../../../lib/localAiEngine'

export interface FormulaPlan {
  formula: string
  columnsToAdd?: string[]
  tabsToAdd?: { name: string; purpose: string }[]
}

interface Props {
  headers: string[] // current column labels, in order (index 0 = column A)
  activeRef: string // A1 ref of the active cell
  sample?: string[][] // a few rows of nearby data for context
  onApply: (plan: FormulaPlan) => void
  onClose: () => void
}

interface Preview {
  formula: string
  explanation?: string
  columnsToAdd?: string[]
  tabsToAdd?: { name: string; purpose: string }[]
}

function colLetter(i: number): string {
  let s = ''
  let n = i
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

export default function SheetFormulaAssist({
  headers,
  activeRef,
  sample,
  onApply,
  onClose
}: Props): JSX.Element {
  const warmLabel = useAiBusyLabel()
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)

  function insertChip(text: string): void {
    setPrompt((p) => (p ? `${p} ${text}` : text))
  }

  async function run(): Promise<void> {
    if (!prompt.trim()) return
    setBusy(true)
    setError(null)
    setPreview(null)
    try {
      const res = await window.api.sheet.aiFormula({ prompt, headers, activeRef, sample })
      if (!res.ok || !res.formula) {
        setError(res.error || (res.needsApiKey ? 'No Anthropic API key set.' : 'The AI returned nothing.'))
        return
      }
      if (!isParseableFormula(res.formula)) {
        setError(`The AI proposed a formula this sheet can't run (${res.formula}). Try describing it differently.`)
        return
      }
      setPreview({
        formula: res.formula,
        explanation: res.explanation,
        columnsToAdd: res.columnsToAdd,
        tabsToAdd: res.tabsToAdd
      })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-accent/30 bg-accent/[0.04] p-3 mb-2" data-testid="sheet-formula-assist">
      <div className="flex items-center gap-1.5 mb-2">
        <Icon name="function" size={13} className="text-accent" />
        <span className="text-[11px] uppercase tracking-wider font-semibold text-accent">AI · Write a formula</span>
        <button onClick={onClose} className="ml-auto icon-btn" aria-label="Close">
          <Icon name="close" size={13} />
        </button>
      </div>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void run()
        }}
        placeholder={`Describe the calculation for ${activeRef}. e.g. "gross margin: revenue minus cost, divided by revenue, as a percent"`}
        rows={2}
        autoFocus
        className="fb-field w-full bg-[var(--surface-raised)] px-3 py-2 text-[13px] resize-none"
      />

      {/* Quick-insert reference chips: the active cell and each named column. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1" data-testid="sheet-formula-chips">
        <button
          onClick={() => insertChip(activeRef)}
          className="text-[11px] px-2 py-0.5 rounded-full bg-[color-mix(in_oklab,var(--surface-sunken)_70%,transparent)] hover:bg-accent hover:text-white"
        >
          {activeRef}
        </button>
        {headers.map((h, i) => (
          <button
            key={i}
            onClick={() => insertChip(`${colLetter(i)} (${h || colLetter(i)})`)}
            className="text-[11px] px-2 py-0.5 rounded-full bg-[color-mix(in_oklab,var(--surface-sunken)_70%,transparent)] hover:bg-accent hover:text-white"
            title={`Reference column ${colLetter(i)}`}
          >
            {colLetter(i)}
            {h ? `: ${h}` : ''}
          </button>
        ))}
      </div>

      {error && <div className="text-[12px] text-red-600 dark:text-red-400 mt-1">{error}</div>}

      {preview && (
        <div className="fb-card mt-2 p-2.5" data-testid="sheet-formula-preview">
          <div className="font-mono text-[13px] text-[var(--ink-100)] break-all">{preview.formula}</div>
          {preview.explanation && (
            <div className="text-[12px] text-[var(--ink-50)] mt-1">{preview.explanation}</div>
          )}
          {(preview.columnsToAdd?.length || preview.tabsToAdd?.length) && (
            <div className="mt-2 text-[12px] text-[var(--ink-70)]">
              <div className="font-semibold text-[11px] uppercase tracking-wider text-[var(--ink-40)] mb-0.5">
                Applying will also create
              </div>
              {preview.columnsToAdd?.length ? (
                <div>
                  Columns: {preview.columnsToAdd.join(', ')}
                </div>
              ) : null}
              {preview.tabsToAdd?.length
                ? preview.tabsToAdd.map((t, i) => (
                    <div key={i}>
                      Tab “{t.name}”{t.purpose ? ` — ${t.purpose}` : ''}
                    </div>
                  ))
                : null}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 mt-2">
        {preview == null ? (
          <button onClick={() => void run()} disabled={busy || !prompt.trim()} className="btn-primary text-[12px] px-3 py-1.5">
            {busy ? warmLabel('Thinking…') : 'Suggest formula'}
          </button>
        ) : (
          <>
            <button
              onClick={() =>
                onApply({
                  formula: preview.formula,
                  columnsToAdd: preview.columnsToAdd,
                  tabsToAdd: preview.tabsToAdd
                })
              }
              data-testid="sheet-formula-apply"
              className="btn-primary text-[12px] px-3 py-1.5"
            >
              Apply
            </button>
            <button
              onClick={() => void run()}
              disabled={busy}
              className="fb-btn-surface text-[12px] px-3 py-1.5 hover:bg-[var(--surface-sunken)]"
            >
              Re-suggest
            </button>
          </>
        )}
        <span className="text-[11px] text-[var(--ink-40)]">Previewed before it writes. Cmd+Enter</span>
      </div>
    </div>
  )
}
