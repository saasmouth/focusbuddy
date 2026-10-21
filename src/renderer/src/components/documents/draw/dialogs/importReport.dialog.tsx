// The import report: what Place, Import or Open brought in as editable art,
// and what it could not (and did instead) -- shown whenever there is
// something to say, so nothing is ever lost silently.

import type { DrawDialog } from '../editor/types'

interface ReportProps {
  reports?: Array<{ name: string; lines: string[] }>
  /** An action to finish with (Open: "Open the drawing"). */
  action?: { label: string; run: () => void }
}

const importReport: DrawDialog = {
  id: 'import-report',
  title: 'Import report',
  component: function ImportReportDialog({ props, close }) {
    const { reports = [], action } = (props ?? {}) as ReportProps
    return (
      <div className="space-y-3 text-[13px] max-w-[520px]" data-testid="draw-import-report">
        {reports.map((r, i) => (
          <div key={i} className="space-y-1">
            <div className="font-medium text-[var(--ink-80)]">{r.name}</div>
            <ul className="list-disc pl-5 space-y-0.5 text-[var(--ink-60)]">
              {r.lines.map((l, j) => (
                <li key={j}>{l}</li>
              ))}
            </ul>
          </div>
        ))}
        <div className="flex justify-end gap-2 pt-1">
          {action ? (
            <>
              <button onClick={close} className="fb-btn-surface px-3 py-1.5">
                Cancel
              </button>
              <button
                onClick={() => {
                  close()
                  action.run()
                }}
                data-testid="draw-import-report-action"
                className="btn-primary px-3 py-1.5"
              >
                {action.label}
              </button>
            </>
          ) : (
            <button onClick={close} data-testid="draw-import-report-ok" className="btn-primary px-3 py-1.5">
              OK
            </button>
          )}
        </div>
      </div>
    )
  }
}

export default importReport
