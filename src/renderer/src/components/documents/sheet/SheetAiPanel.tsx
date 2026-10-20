import { useState } from 'react'
import Icon from '../../Icon'
import { sanitizeHtml } from '../../../lib/htmlSanitize'
import WorkspaceAsk from '../editor/WorkspaceAsk'
import type { SheetAi } from './useSheetAi'

// The persistent right-side AI Assistant panel for PlexiSheets. It mirrors the
// PlexiDocs side panel in structure, tokens and quality, but its content is
// grounded in the active sheet's real cells.
//
// What is real here: the Insights and Ask flows both run on the real AI hook
// (useSheetAi -> window.api.ai.suggestDocContent) over the real sheet data. The
// panel never hardcodes an insight string, a metric, or a comparison.
//
// What is honestly empty here: the mockup showed a Recent Activity list with
// named people and a Data Connections list with integration badges. There is no
// real per-sheet activity backend for a PlexiOffice sheet, and there are no real
// data-source integrations, so both sections render honest empty states instead
// of inventing edits, people, or connected sources.

interface Props {
  ai: SheetAi
  onCollapse: () => void
  onImportSource: () => Promise<void>
}

export default function SheetAiPanel({ ai, onCollapse, onImportSource }: Props): JSX.Element {
  const [question, setQuestion] = useState('')
  const [importing, setImporting] = useState(false)

  const submitQuestion = (): void => {
    const q = question.trim()
    if (!q || ai.busy) return
    void ai.ask(q)
  }

  return (
    <aside
      className="flex h-full w-80 shrink-0 flex-col border-l border-[var(--edge-soft)] bg-[var(--surface-raised)]"
      aria-label="Sheet assistant panel"
      data-testid="sheet-ai-panel"
    >
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--edge-soft)] px-3 py-2.5">
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--accent)/0.12)] text-[rgb(var(--accent))]">
          <Icon name="auto_awesome" size={14} />
        </span>
        <span className="text-[13px] font-semibold text-[var(--ink-90)]">PlexiiAssist</span>
        <span className="rounded bg-[rgb(var(--accent)/0.14)] px-1 text-[9px] uppercase tracking-wide text-[rgb(var(--accent))]">
          Beta
        </span>
        <button
          onClick={onCollapse}
          className="ml-auto icon-btn"
          aria-label="Collapse assistant"
          title="Collapse assistant"
          data-testid="sheet-ai-collapse"
        >
          <Icon name="chevron_right" size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex flex-col gap-4 p-3">
          <WorkspaceAsk />
          {/* Insights */}
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h3 className="text-[12.5px] font-semibold text-[var(--ink-90)]">Here are some insights from your data</h3>
              <button
                onClick={() => void ai.generateInsights()}
                disabled={ai.busy}
                className="fb-btn-surface inline-flex items-center gap-1 px-2 py-1 text-[11px] text-[var(--ink-80)] hover:bg-[rgb(var(--accent)/0.06)] disabled:opacity-50 fb-spring-soft"
                data-testid="sheet-ai-insights-run"
              >
                <Icon name="auto_awesome" size={13} className="text-[rgb(var(--accent))]" />
                <span>{ai.insightsHtml ? 'Refresh' : 'Generate'}</span>
              </button>
            </div>

            <div data-testid="sheet-ai-insights">
              {ai.insightsEmpty ? (
                <div
                  className="rounded-lg border border-dashed border-[var(--edge-soft)] p-3 text-[12px] leading-relaxed text-[var(--ink-50)]"
                  data-testid="sheet-ai-insights-empty"
                >
                  Add some data and I can surface insights.
                </div>
              ) : ai.insightsHtml != null ? (
                <div
                  className="prose prose-sm prose-stone dark:prose-invert max-w-none rounded-lg bg-[var(--surface-base)] p-3 text-[12.5px]"
                  data-testid="sheet-ai-insights-result"
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(ai.insightsHtml) }}
                />
              ) : (
                <div className="rounded-lg border border-dashed border-[var(--edge-soft)] p-3 text-[12px] leading-relaxed text-[var(--ink-50)]">
                  Generate insights to read a short, factual summary of the cells in this sheet.
                </div>
              )}
            </div>
          </section>

          {/* Ask a question */}
          <section className="flex flex-col gap-2">
            <h3 className="text-[12.5px] font-semibold text-[var(--ink-90)]">Ask a question about your data</h3>
            <div className="flex items-center gap-1.5">
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitQuestion()
                }}
                placeholder="What was the highest value in column B?"
                className="fb-field flex-1 px-2.5 py-1.5 text-[12px]"
                data-testid="sheet-ai-ask-input"
              />
              <button
                onClick={submitQuestion}
                disabled={ai.busy || !question.trim()}
                className="shrink-0 rounded-lg bg-[rgb(var(--accent))] px-2.5 py-1.5 text-[12px] text-white disabled:opacity-50"
                data-testid="sheet-ai-ask-send"
                aria-label="Send question"
              >
                <Icon name="send" size={13} />
              </button>
            </div>

            {ai.busy && (
              <div className="flex items-center gap-1.5 text-[12px] text-[var(--ink-50)]" data-testid="sheet-ai-busy">
                <Icon name="autorenew" size={14} className="animate-spin" />
                <span>Reading your data.</span>
              </div>
            )}

            {ai.error && (
              <div
                className="rounded-lg border border-red-300/60 bg-red-50/70 px-3 py-2 text-[12px] text-red-600 dark:bg-red-950/30 dark:text-red-300"
                data-testid="sheet-ai-error"
              >
                {ai.error}
              </div>
            )}

            {ai.answerHtml != null && (
              <div className="flex flex-col gap-1.5" data-testid="sheet-ai-result">
                {ai.lastQuestion && (
                  <div className="text-[11px] text-[var(--ink-40)]">You asked: {ai.lastQuestion}</div>
                )}
                <div
                  className="prose prose-sm prose-stone dark:prose-invert max-w-none max-h-72 overflow-auto rounded-lg bg-[var(--surface-base)] p-3 text-[12.5px]"
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(ai.answerHtml) }}
                />
              </div>
            )}
          </section>

          {/* Recent Activity. There is no real per-sheet activity source for a
              PlexiOffice sheet, so this is an honest empty state rather than
              invented edits or people. */}
          <section className="flex flex-col gap-2">
            <h3 className="text-[12.5px] font-semibold text-[var(--ink-90)]">Recent Activity</h3>
            <div
              className="rounded-lg border border-dashed border-[var(--edge-soft)] p-3 text-[12px] leading-relaxed text-[var(--ink-50)]"
              data-testid="sheet-ai-activity-empty"
            >
              No recent activity yet.
            </div>
          </section>

          {/* Snapshot imports use the editor's real XLSX/CSV import path. They
              are deliberately described as imports, not live connections. */}
          <section className="flex flex-col gap-2">
            <h3 className="text-[12.5px] font-semibold text-[var(--ink-90)]">Import data</h3>
            <div
              className="rounded-lg border border-dashed border-[var(--edge-soft)] p-3 text-[12px] leading-relaxed text-[var(--ink-50)]"
              data-testid="sheet-ai-connections-empty"
            >
              Bring in a snapshot from an Excel workbook or CSV file. Importing replaces the current workbook and can
              be undone.
            </div>
            <button
              disabled={importing}
              title="Import an .xlsx or .csv file"
              onClick={async () => {
                setImporting(true)
                try {
                  await onImportSource()
                } finally {
                  setImporting(false)
                }
              }}
              className="fb-btn-surface inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-[12px] text-[var(--ink-70)] disabled:opacity-60"
              data-testid="sheet-ai-connect-source"
            >
              <Icon name={importing ? 'autorenew' : 'upload_file'} size={14} className={importing ? 'animate-spin' : ''} />
              <span>{importing ? 'Importing…' : 'Import CSV or workbook'}</span>
            </button>
          </section>
        </div>
      </div>
    </aside>
  )
}
