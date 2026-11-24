// The one place a key or token is typed (SPEC-CONNECTIONS.md §2 step 3).
//
// Deliberately UNCONTROLLED. A controlled React input mirrors its value into
// the `value` attribute, which puts the key in the DOM markup for anything that
// serialises the page. Here the key lives only in the input's own value until
// submit, where readAndClear() takes it and empties the field in one step. It
// never enters React state, a draft or a log.

import { forwardRef, type RefObject } from 'react'

export const FIELD_CLASS =
  'fb-field w-full rounded-[var(--radius-field)] px-3 min-h-[36px] py-1.5 text-[14px] text-[var(--ink-100)] bg-[var(--surface-sunken)] border border-[var(--edge-soft)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[rgb(var(--accent))]'

export const SecretField = forwardRef<
  HTMLInputElement,
  { id: string; onPresenceChange: (has: boolean) => void; testId?: string; placeholder?: string; describedBy?: string; autoFocus?: boolean }
>(function SecretField(props, ref) {
  return (
    <input
      ref={ref}
      id={props.id}
      type="password"
      autoComplete="off"
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      // Password managers must not offer to save a provider key as a login.
      data-1p-ignore="true"
      data-lpignore="true"
      data-bwignore="true"
      aria-describedby={props.describedBy}
      placeholder={props.placeholder}
      autoFocus={props.autoFocus}
      data-testid={props.testId}
      className={`${FIELD_CLASS} fb-mono`}
      onChange={(e) => props.onPresenceChange(e.currentTarget.value.trim().length > 0)}
    />
  )
})

// Take the typed secret and empty the field at once (success or failure).
export function readAndClear(ref: RefObject<HTMLInputElement>): string {
  const el = ref.current
  if (!el) return ''
  const v = el.value
  el.value = ''
  return v.trim()
}
