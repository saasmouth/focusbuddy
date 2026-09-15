import { forwardRef, useImperativeHandle, useRef, type InputHTMLAttributes } from 'react'
import { useMentionAutocomplete } from '../lib/useMentionAutocomplete'
import MentionPicker from './MentionPicker'

// An <input> that understands `@`. The one-line sibling of MentionTextarea,
// same drop-in contract, and separate only because the native value setter it
// has to call lives on a different prototype.

export interface MentionInputFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  /** Class for the wrapper, when the field is inside a flex/grid layout. */
  wrapperClassName?: string
}

const MentionInputField = forwardRef<HTMLInputElement, MentionInputFieldProps>(
  function MentionInputField(
    { value, onChange, onKeyDown, onKeyUp, onBlur, wrapperClassName, ...rest },
    ref
  ) {
    const inner = useRef<HTMLInputElement | null>(null)
    useImperativeHandle(ref, () => inner.current as HTMLInputElement)

    const mentions = useMentionAutocomplete(value, (next, caret) => {
      const el = inner.current
      if (!el) return
      // React owns this value, so the change has to arrive as a real input
      // event; assigning el.value is discarded on the next render.
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set
      setter?.call(el, next)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      requestAnimationFrame(() => {
        el.setSelectionRange(caret, caret)
        el.focus()
      })
    })

    return (
      <div className={`relative ${wrapperClassName ?? ''}`}>
        <input
          {...rest}
          ref={inner}
          value={value}
          onChange={(e) => {
            onChange(e)
            mentions.onInput(e.target.value, e.target.selectionStart ?? e.target.value.length)
          }}
          onKeyUp={(e) => {
            mentions.onInput(
              e.currentTarget.value,
              e.currentTarget.selectionStart ?? e.currentTarget.value.length
            )
            onKeyUp?.(e)
          }}
          onKeyDown={(e) => {
            // Enter picks a mention while the picker is open, and submits only
            // when it is not — otherwise choosing a reference also sends the
            // prompt, which is the one mistake that cannot be undone.
            if (mentions.onKeyDown(e)) return
            onKeyDown?.(e)
          }}
          onBlur={(e) => {
            mentions.close()
            onBlur?.(e)
          }}
        />
        <MentionPicker mentions={mentions} />
      </div>
    )
  }
)

export default MentionInputField
