import { forwardRef, useImperativeHandle, useRef, useState, type TextareaHTMLAttributes } from 'react'
import { useMentionAutocomplete } from '../lib/useMentionAutocomplete'
import { caretCoordinates } from '../lib/caretCoordinates'
import MentionPicker from './MentionPicker'

// A <textarea> that understands `@`.
//
// A DROP-IN: same props, same native onChange signature, same ref. Adding
// mentions to a field is changing the tag, which is the only way this was ever
// going to reach a dozen surfaces without each one growing its own slightly
// different version of the behaviour.
//
// The wrapper div is the one visible difference. The picker is positioned
// against it, so the field itself must not be the positioning context -- hence
// `relative` here and nowhere else.

export interface MentionTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  value: string
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  /** Class for the wrapper, when the field is inside a flex/grid layout. */
  wrapperClassName?: string
}

const MentionTextarea = forwardRef<HTMLTextAreaElement, MentionTextareaProps>(function MentionTextarea(
  { value, onChange, onKeyDown, onKeyUp, onBlur, wrapperClassName, ...rest },
  ref
) {
  const inner = useRef<HTMLTextAreaElement | null>(null)
  // Where the `@` is on screen, so the menu opens beside it rather than
  // under the whole field.
  const [caret, setCaret] = useState<{ left: number; bottom: number } | null>(null)
  useImperativeHandle(ref, () => inner.current as HTMLTextAreaElement)

  const mentions = useMentionAutocomplete(value, (next, caret) => {
    const el = inner.current
    if (!el) return
    // React controls this input, so the new text has to arrive through the
    // caller's own onChange -- setting el.value directly would be overwritten
    // on the next render. The native setter + input event is how you make a
    // controlled React field accept a programmatic change.
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
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
      return null
    }
  }

  return (
    <div className={`relative ${wrapperClassName ?? ''}`}>
      <textarea
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
          // Arrows and clicks move the caret without changing the value, and a
          // picker that ignores that stays open over text it no longer relates to.
          const i = e.currentTarget.selectionStart ?? e.currentTarget.value.length
          mentions.onInput(e.currentTarget.value, i)
          setCaret(measure(i))
          onKeyUp?.(e)
        }}
        onKeyDown={(e) => {
          // The picker consumes Enter and the arrows while open, so the field's
          // own handler does not also submit or break the line.
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
})

export default MentionTextarea
