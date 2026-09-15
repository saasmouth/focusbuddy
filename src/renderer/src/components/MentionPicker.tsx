import type { MentionAutocomplete } from '../lib/useMentionAutocomplete'
import { MENTION_ICON } from './MentionText'
import Icon from './Icon'

// The @ picker, once.
//
// Extracted so adding mentions to a field is a hook call and one element
// rather than sixty lines of list markup copied per widget -- which is how the
// same feature ends up behaving slightly differently in five places.

export default function MentionPicker({
  mentions,
  className
}: {
  mentions: MentionAutocomplete
  className?: string
}): JSX.Element | null {
  if (!mentions.open) return null
  return (
    <div
      className={`absolute left-0 top-full z-[80] mt-1 max-h-[200px] w-[250px] overflow-y-auto rounded-md border border-[var(--line)] bg-[var(--surface-raised)] py-1 shadow-lg ${className ?? ''}`}
      // mousedown, not click: blur fires first and would close the picker
      // before a click could ever land on it.
      onMouseDown={(e) => e.preventDefault()}
      data-testid="mention-picker"
    >
      {mentions.candidates.map((c, i) => (
        <button
          key={`${c.kind}:${c.id}`}
          type="button"
          onClick={() => mentions.choose(c)}
          className={`flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] ${
            i === mentions.activeIndex
              ? 'bg-accent/10 text-[var(--ink-90)]'
              : 'text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'
          }`}
        >
          <Icon
            name={c.icon || MENTION_ICON[c.kind] || 'link'}
            size={12}
            className="shrink-0 text-[var(--ink-40)]"
          />
          <span className="min-w-0 flex-1 truncate">{c.title}</span>
          {c.detail && <span className="shrink-0 text-[9px] text-[var(--ink-35)]">{c.detail}</span>}
        </button>
      ))}
    </div>
  )
}
