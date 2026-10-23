import Icon from '../Icon'
import type { FbDocument } from '@shared/types'

// "Changed elsewhere" — shown when a save was REFUSED because the document's
// body moved on underneath it.
//
// The rule this exists to keep: the editor still holding unsaved text never
// loses it. Nothing has been written when this appears, the text is still on
// the screen, and all three ways out are spelled out rather than one of them
// being chosen quietly. A document can be open in a desk widget and the
// Documents view at once — two linked-duplicate widgets share a document id —
// and before body_rev the slower save simply overwrote the other.
//
// Wording is deliberate. "Changed elsewhere" says what happened without
// guessing where; "Keep mine" says what it does rather than "Overwrite", which
// reads like a warning about the user's own work; and "Save mine as a copy" is
// listed last because it is the branch where nobody loses anything, so it
// should be the easy thing to notice rather than the clever thing to find.

export interface DocumentConflictBarProps {
  /** The body that is actually stored — someone else's work. */
  theirs: FbDocument
  /** Discard my edit and take what is stored. */
  onTheirs: () => void
  /** Replace what is stored with my edit, against the version just shown. */
  onMine: () => void
  /** Keep both: my edit becomes its own document. */
  onCopy: () => void
  busy?: boolean
}

export default function DocumentConflictBar({
  theirs,
  onTheirs,
  onMine,
  onCopy,
  busy = false
}: DocumentConflictBarProps): JSX.Element {
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-t border-[var(--edge-soft)] bg-amber-500/10 px-3 py-1.5 text-[11px] text-[var(--ink-80)]"
      role="alert"
      data-testid="document-conflict"
    >
      <Icon name="warning" size={13} className="shrink-0 text-amber-600" />
      <span className="min-w-0">
        Changed elsewhere. Your edit has <strong>not</strong> been saved, and nothing has been
        overwritten.
      </span>
      <span className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={onTheirs}
          disabled={busy}
          className="btn-ghost !h-6 px-2 text-[11px]"
          data-testid="document-conflict-theirs"
        >
          Reload theirs
        </button>
        <button
          type="button"
          onClick={onMine}
          disabled={busy}
          className="btn-ghost !h-6 px-2 text-[11px]"
          data-testid="document-conflict-mine"
        >
          Keep mine
        </button>
        <button
          type="button"
          onClick={onCopy}
          disabled={busy}
          className="btn-primary !h-6 px-2 text-[11px]"
          data-testid="document-conflict-copy"
        >
          Save mine as a copy
        </button>
      </span>
      {/* Named, so "Reload theirs" is not a blind choice. */}
      <span className="sr-only">The stored version is titled {theirs.title || 'Untitled'}.</span>
    </div>
  )
}
