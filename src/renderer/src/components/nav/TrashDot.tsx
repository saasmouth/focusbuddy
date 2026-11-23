// The Trash's dot (4.3.55): something on the desk you had open was deleted on
// another device, or by someone you work with, and is waiting in the Trash. Lit
// by lib/deletedElsewhere.ts, cleared when the Trash is opened. Small and quiet:
// a dot, not a count, because the notice already said what it was.
export const TRASH_DOT_LABEL = 'Something on your desk was deleted elsewhere. It is in the Trash.'

export function TrashDot({ className = 'ml-auto' }: { className?: string }): JSX.Element {
  return (
    <span
      role="status"
      aria-label={TRASH_DOT_LABEL}
      title={TRASH_DOT_LABEL}
      data-testid="trash-dot"
      className={`${className} w-1.5 h-1.5 rounded-full bg-[rgb(var(--accent))] shrink-0`}
    />
  )
}
