import Icon from '../../Icon'

// What PlexiiCells puts on paper: the print area, whether the gridlines print,
// and the rows repeated at the top of every page.
//
// Each setting reads and writes through src/renderer/src/lib/sheetPageSetup.ts,
// so the dialog holds no state of its own — the sheet is the state, which is
// what lets a structural edit move these settings with the data (the remap
// inside fixFormulas) without the dialog ever going stale.
//
// Nothing here is silently lost: a print area whose rows are all deleted is
// CLEARED rather than repointed at whatever slid into its place, and the line
// under each field says what is set now in A1 terms, so what will print is
// readable before printing it.

export interface PageSetupDialogProps {
  /** What is set now, from pageSetupOf(tab). */
  printArea: string | null
  repeatRows: string | null
  showGridlines: boolean
  /** The current selection in A1 terms, for the two "use the selection" buttons. */
  selectionA1: string
  /** The selection's row span in A1 terms ("2:4"). Any selection has one. */
  selectionRowsA1: string
  onSetPrintArea: (a1: string | null) => void
  onSetRepeatRows: (a1: string | null) => void
  onSetShowGridlines: (show: boolean) => void
  onClose: () => void
}

/** One setting: what it is, what it is set to, and the two ways to change it. */
function Row({
  icon,
  title,
  hint,
  value,
  empty,
  setLabel,
  onSet,
  onClear,
  testid
}: {
  icon: string
  title: string
  hint: string
  value: string | null
  empty: string
  setLabel: string
  onSet: () => void
  onClear: () => void
  testid: string
}): JSX.Element {
  return (
    <div className="space-y-1" data-testid={testid}>
      <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--ink-80)]">
        <Icon name={icon} size={14} className="text-accent" />
        {title}
      </div>
      <p className="text-[11px] text-[var(--ink-50)]">{hint}</p>
      <div className="flex items-center gap-2 flex-wrap">
        {/* The honest empty state: "Whole sheet" / "None", never a blank that
            could be read as a value. */}
        <span className="font-mono text-[12px] text-[var(--ink-70)]" data-testid={`${testid}-value`}>
          {value ?? empty}
        </span>
        <button onClick={onSet} className="fb-btn-surface text-[12px] px-2 py-1 ml-auto" data-testid={`${testid}-set`}>
          {setLabel}
        </button>
        <button
          onClick={onClear}
          disabled={value === null}
          className="fb-btn-surface text-[12px] px-2 py-1 disabled:opacity-40"
          data-testid={`${testid}-clear`}
        >
          Clear
        </button>
      </div>
    </div>
  )
}

export default function PageSetupDialog({
  printArea,
  repeatRows,
  showGridlines,
  selectionA1,
  selectionRowsA1,
  onSetPrintArea,
  onSetRepeatRows,
  onSetShowGridlines,
  onClose
}: PageSetupDialogProps): JSX.Element {
  return (
    <div className="fb-scrim absolute inset-0 z-40 flex items-center justify-center" onMouseDown={onClose}>
      <div
        data-testid="sheet-pagesetup-dialog"
        className="fb-card w-[460px] max-w-[92%] p-4 space-y-3"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <Icon name="print" size={15} className="text-accent" />
          Page setup
          <button onClick={onClose} className="ml-auto icon-btn" aria-label="Close">
            <Icon name="close" size={14} />
          </button>
        </div>

        <Row
          testid="pagesetup-area"
          icon="crop"
          title="Print area"
          hint="The block that prints. Everything outside it is left off the page."
          value={printArea}
          empty="Whole sheet"
          setLabel={`Use selection (${selectionA1})`}
          onSet={() => onSetPrintArea(selectionA1)}
          onClear={() => onSetPrintArea(null)}
        />

        <div className="border-t border-[var(--edge-soft)]" />

        <Row
          testid="pagesetup-repeat"
          icon="table_rows"
          title="Rows to repeat"
          hint="Printed at the top of every page, page one included, and not printed again in place."
          value={repeatRows}
          empty="None"
          setLabel={`Use selection (${selectionRowsA1})`}
          onSet={() => onSetRepeatRows(selectionRowsA1)}
          onClear={() => onSetRepeatRows(null)}
        />

        <div className="border-t border-[var(--edge-soft)]" />

        <label className="flex items-center gap-2 text-[12px] text-[var(--ink-80)]" data-testid="pagesetup-gridlines">
          <input
            type="checkbox"
            checked={showGridlines}
            onChange={(e) => onSetShowGridlines(e.target.checked)}
            data-testid="pagesetup-gridlines-input"
          />
          Print the gridlines
        </label>

        {/* Said here because it is the one thing about the printout that cannot
            be inferred from the sheet, and a silent omission would be worse
            than an ugly one. */}
        <p className="text-[11px] text-[var(--ink-50)] border-t border-[var(--edge-soft)] pt-2">
          A placed work widget prints as a named box rather than live content, and a chart that has not
          been drawn prints as a placeholder — so nothing disappears from the page without saying so.
        </p>
      </div>
    </div>
  )
}
