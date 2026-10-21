import { useMemo } from 'react'
import Icon from '../../Icon'
import { preflight, preflightSummary, type PreflightItem, type PreflightSeverity } from '@shared/designPreflight'
import type { DesignBody } from '@shared/design'

// The print check, as a panel rather than a dialog: every row names an element
// on a page, and clicking it goes there and selects it. A modal would make you
// read the list, close it, and remember what it said.
//
// Everything here is measured from the open document by src/shared/designPreflight.ts
// — resolution from the image's own pixel size against the box it is drawn in,
// stroke weights and type sizes converted to points, live content against the
// trim and bleed. No model call, no network, nothing that can invent a problem.
//
// What it does NOT check is stated in the panel, not hidden: this document model
// is RGB with no colour profiles, no ink limits and no embedded fonts, so a
// panel claiming to have checked separations or font licensing would be lying.
// A person taking a job to a commercial press needs to know which checks they
// still have to do themselves.

interface Props {
  design: DesignBody
  /** Go to a page and select the element a finding is about. */
  onReveal: (page: number, elementId?: string) => void
}

const ICONS: Record<PreflightSeverity, string> = {
  error: 'error',
  warning: 'warning',
  info: 'info'
}

const TONES: Record<PreflightSeverity, string> = {
  error: 'text-rose-600 dark:text-rose-400',
  warning: 'text-amber-600 dark:text-amber-400',
  info: 'text-[var(--ink-50)]'
}

const ORDER: PreflightSeverity[] = ['error', 'warning', 'info']

export default function PreflightPanel({ design, onReveal }: Props): JSX.Element {
  // Arithmetic over the document, so it is cheap enough to redo whenever the
  // document changes — the report is never stale while the panel is open.
  const items = useMemo(() => preflight(design), [design])
  const summary = preflightSummary(items)
  const errors = items.filter((i) => i.severity === 'error').length

  const grouped = ORDER.map((sev) => ({ sev, rows: items.filter((i) => i.severity === sev) })).filter(
    (g) => g.rows.length > 0
  )

  return (
    <div className="text-[12px]" data-testid="design-preflight-panel">
      <div className="flex items-center gap-2 mb-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 fb-t-caption ${
            errors
              ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300'
              : items.length
                ? 'bg-amber-400/10 text-amber-700 dark:text-amber-300'
                : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          }`}
          data-testid="design-preflight-summary"
        >
          <Icon name={errors ? 'error' : items.length ? 'warning' : 'check_circle'} size={13} />
          {summary}
        </span>
        <span className="fb-t-caption text-[var(--ink-40)]">
          {items.length === 0
            ? 'Checked resolution, stroke weights, type sizes, bleed and the trim edge.'
            : 'Click a line to go to it.'}
        </span>
      </div>

      {items.length === 0 ? (
        <p className="fb-t-caption text-[var(--ink-50)] leading-snug" data-testid="design-preflight-clear">
          Nothing to fix. Every image is sharp enough for print, no rule is thinner than a hairline, no type is
          too small to read, and nothing live sits outside the trim.
        </p>
      ) : (
        <div className="max-h-56 overflow-auto pr-1 flex flex-col gap-2">
          {grouped.map((g) => (
            <section key={g.sev}>
              <h4 className="fb-t-caption uppercase tracking-wide text-[var(--ink-40)] mb-1">
                {g.sev === 'error' ? 'Must fix' : g.sev === 'warning' ? 'Worth fixing' : 'For information'}
              </h4>
              <ul className="flex flex-col gap-0.5">
                {g.rows.map((it) => (
                  <PreflightRow key={it.id} item={it} onReveal={onReveal} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <p className="mt-2 pt-2 border-t border-[var(--edge-soft)] fb-t-caption text-[var(--ink-40)] leading-snug">
        Not checked here: colour separations, total ink coverage and font embedding. This document is RGB and
        carries no colour profiles, so those belong to whoever makes the plates. Ask your printer for a proof.
      </p>
    </div>
  )
}

function PreflightRow({ item, onReveal }: { item: PreflightItem; onReveal: Props['onReveal'] }): JSX.Element {
  const where = typeof item.page === 'number' ? `Page ${item.page + 1}` : null
  // A finding about the document as a whole has no element and no page; it is
  // reported, but there is nowhere to go, so it is not a button.
  const canReveal = typeof item.page === 'number'
  const body = (
    <>
      <Icon name={ICONS[item.severity]} size={13} className={`mt-0.5 shrink-0 ${TONES[item.severity]}`} />
      <span className="min-w-0">
        <span className="block text-[12px] leading-snug text-[var(--ink-90)]">
          {item.title}
          {where && <span className="text-[var(--ink-40)]"> · {where}</span>}
        </span>
        <span className="block fb-t-caption leading-snug text-[var(--ink-50)]">{item.detail}</span>
      </span>
    </>
  )
  return (
    <li>
      {canReveal ? (
        <button
          type="button"
          onClick={() => onReveal(item.page as number, item.elementId)}
          className="flex w-full items-start gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-[var(--surface-base)]"
          data-testid={`preflight-${item.rule}`}
        >
          {body}
        </button>
      ) : (
        <div className="flex items-start gap-1.5 px-1.5 py-1" data-testid={`preflight-${item.rule}`}>
          {body}
        </div>
      )}
    </li>
  )
}
