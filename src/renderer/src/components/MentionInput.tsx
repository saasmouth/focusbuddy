import { useRef, type CSSProperties, type KeyboardEvent } from 'react'
import { useMentionAutocomplete } from '../lib/useMentionAutocomplete'
import Icon from './Icon'

// A textarea (or one-line input) that understands `@`.
//
// Drop-in: same value/onChange contract as the thing it replaces, so a widget
// adopts mentions by changing which component it renders rather than by
// learning how mentions work.

export interface MentionInputProps {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  className?: string
  style?: CSSProperties
  /** One line, submitting on Enter, rather than a growing textarea. */
  singleLine?: boolean
  onSubmit?: () => void
  onBlur?: () => void
  autoFocus?: boolean
  'data-testid'?: string
}

export default function MentionInput({
  value,
  onChange,
  placeholder,
  className,
  style,
  singleLine,
  onSubmit,
  onBlur,
  autoFocus,
  'data-testid': testId
}: MentionInputProps): JSX.Element {
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)

  const mentions = useMentionAutocomplete(value, (next, caret) => {
    onChange(next)
    // The caret has to be restored after React writes the new value, or it
    // jumps to the end and the next keystroke lands in the wrong place.
    requestAnimationFrame(() => {
      const el = ref.current
      if (el) el.setSelectionRange(caret, caret)
    })
  })

  const handleKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (mentions.onKeyDown(e)) return
    if (singleLine && e.key === 'Enter' && onSubmit) {
      e.preventDefault()
      onSubmit()
    }
  }

  const common: Record<string, unknown> = {
    ref: ref as never,
    value,
    placeholder,
    className,
    style,
    autoFocus,
    'data-testid': testId,
    onBlur: () => {
      // Closing on blur would eat a click on the picker, so the picker's own
      // mousedown suppression handles that; this only tidies up.
      mentions.close()
      onBlur?.()
    },
    onKeyDown: handleKeyDown,
    onChange: (e: { target: { value: string; selectionStart: number | null } }) => {
      onChange(e.target.value)
      mentions.onInput(e.target.value, e.target.selectionStart ?? e.target.value.length)
    },
    onKeyUp: (e: { currentTarget: { value: string; selectionStart: number | null } }) => {
      // Arrow keys and clicks move the caret without changing the value, and a
      // picker that ignores that stays open over text it no longer relates to.
      mentions.onInput(
        e.currentTarget.value,
        e.currentTarget.selectionStart ?? e.currentTarget.value.length
      )
    }
  }

  return (
    <div className="relative">
      {singleLine ? (
        <input type="text" {...(common as Record<string, never>)} />
      ) : (
        <textarea {...(common as Record<string, never>)} />
      )}
      {mentions.open && (
        <div
          className="absolute left-0 top-full z-[60] mt-1 max-h-[190px] w-[240px] overflow-y-auto rounded-md border border-[var(--line)] bg-[var(--surface-raised)] py-1 shadow-lg"
          // mousedown, not click: blur fires first and would close the picker
          // before the click ever lands.
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
              <Icon name={c.icon} size={12} className="shrink-0 text-[var(--ink-40)]" />
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
              {c.detail && (
                <span className="shrink-0 text-[9px] text-[var(--ink-35)]">{c.detail}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
