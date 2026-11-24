// One run in the Runs list. The whole row is a button: Enter or a click opens
// the inspector. Status is icon + text; "Status unavailable" carries the last
// confirmed step and its time, never a guess at progress (§1, §5).

import { forwardRef, type FocusEvent } from 'react'
import type { RunSummary } from '@shared/aispace/api'
import { StatusBadge } from '../ui'
import { isActiveStatus, lastConfirmedLine, modelLabel, paidByLine, safeText, timing } from './runText'

export interface RunRowProps {
  run: RunSummary
  selected: boolean
  flash: boolean
  tabIndex: 0 | -1
  onOpen: (runId: string) => void
  onFocusRow: (runId: string) => void
}

const RunRow = forwardRef<HTMLButtonElement, RunRowProps>(function RunRow({ run: r, selected, flash, tabIndex, onOpen, onFocusRow }, ref) {
  const t = timing(r)
  const confirmed = isActiveStatus(r.status) ? lastConfirmedLine(r) : null
  // An active run with nothing confirmed yet says so instead of implying progress.
  const activeNote = isActiveStatus(r.status) && !confirmed ? 'Nothing confirmed yet' : null
  return (
    <li>
      <button
        ref={ref}
        type="button"
        tabIndex={tabIndex}
        aria-current={selected ? 'true' : undefined}
        data-testid={`ais-run-row-${r.id}`}
        data-run-id={r.id}
        data-status={r.status}
        onClick={() => onOpen(r.id)}
        onFocus={(e: FocusEvent<HTMLButtonElement>) => {
          if (e.target === e.currentTarget) onFocusRow(r.id)
        }}
        className={`ais-run-grid w-full text-left px-4 py-3 border-b border-[var(--edge-hairline)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[rgb(var(--accent))] motion-safe:transition-colors motion-safe:duration-150 ${
          selected ? 'bg-[rgb(var(--accent)/0.08)] shadow-[inset_2px_0_0_rgb(var(--accent))]' : 'hover:bg-[var(--surface-sunken)]'
        } ${flash ? 'ais-flash' : ''}`}
      >
        <span className="ais-run-status pt-0.5">
          <StatusBadge status={r.status} />
        </span>
        <span className="ais-run-main min-w-0">
          <span className="block text-[14.5px] font-medium text-[var(--ink-100)] truncate" data-testid="ais-run-title">
            {safeText(r.title) || 'Untitled run'}
          </span>
          <span className="block text-[12px] text-[var(--ink-60)] truncate">{r.projectTitle || 'Untitled project'}</span>
          {(confirmed || activeNote) && (
            <span className="block mt-0.5 text-[12px] text-[var(--ink-70)] truncate" data-testid="ais-run-confirmed" title={confirmed ?? undefined}>
              {confirmed ?? activeNote}
            </span>
          )}
        </span>
        <span className="ais-run-conn min-w-0">
          <span className="block text-[13px] text-[var(--ink-90)] truncate">{r.connectionAlias ?? 'No connection'}</span>
          <span className="block text-[12px] text-[var(--ink-60)] truncate" data-testid="ais-run-row-payer">
            {paidByLine(r.billedTo)}
          </span>
        </span>
        <span className="ais-run-model min-w-0 text-[13px] text-[var(--ink-80)] truncate" title={r.model ?? undefined}>
          {modelLabel(r.provider, r.model, r.modelLabel)}
        </span>
        <span className="ais-run-time fb-tabular text-[12px] text-[var(--ink-60)] whitespace-nowrap" title={t.title}>
          <span className="block">{t.primary}</span>
          {t.secondary && <span className="block">{t.secondary}</span>}
        </span>
      </button>
    </li>
  )
})

export default RunRow
