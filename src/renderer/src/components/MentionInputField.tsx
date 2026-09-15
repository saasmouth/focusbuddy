import { forwardRef, useImperativeHandle, useRef, useState, type InputHTMLAttributes } from 'react'
import { useMentionAutocomplete } from '../lib/useMentionAutocomplete'
import { caretCoordinates } from '../lib/caretCoordinates'
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
    // Where the `@` is on screen, so the menu opens beside it rather than
    // under the whole field.
    const [caret, setCaret] = useState<{ left: number; bottom: number } | null>(null)
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

    const measure = (index: number): { left: number; bottom: number } | null => {
      const el = inner.current
      if (!el) return null
      try {
        const p = caretCoordinates(el, index)
        return { left: p.left, bottom: p.bottom }
      } catch {
        // Measurement failing must not cost the picker; it falls back to
        // sitting under the field.
        return null
      }
    }

    return (
      <div className={`relative ${wrapperClassName ?? ''}`}>
        <input
          {...rest}
          ref={inner}
          value={value}
          onChange={(e) => {
            onChange(e)
            const i = e.target.selectionStart ?? e.target.value.length
            mentions.onInput(e.target.value, i)
            setCaret(measure(i))
          }}
          onKeyUp={(e) => {
            const i = e.currentTarget.selectionStart ?? e.currentTarget.value.length
            mentions.onInput(e.currentTarget.value, i)
            setCaret(measure(i))
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
        <MentionPicker mentions={mentions} at={caret} />
      </div>
    )
  }
)

export default MentionInputField
