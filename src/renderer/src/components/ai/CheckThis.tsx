// Plain-text answers with their "check this" marks (PlexiSearch Ask, Ask your
// workspace): the specifics the grounding check found in no source are
// highlighted, and one line says what that means.
import type { AnswerGrounding } from '@shared/types'
import { checkSpansFor, checkSummary, splitCheck } from '../../lib/checkThis'

export const CHECK_MARK_CLASS = 'rounded-[3px] bg-amber-200/60 dark:bg-amber-400/25 text-inherit px-[1px] underline decoration-dotted decoration-amber-600 underline-offset-2 cursor-help'

export function CheckedText({ text, grounding }: { text: string; grounding?: AnswerGrounding | null }): JSX.Element {
  const parts = splitCheck(text, checkSpansFor(grounding))
  return (
    <>
      {parts.map((p, i) =>
        p.check ? (
          <mark key={i} data-testid="check-this" title={p.check} className={CHECK_MARK_CLASS}>
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </>
  )
}

export function CheckSummary({ grounding, className = '' }: { grounding?: AnswerGrounding | null; className?: string }): JSX.Element | null {
  const line = checkSummary(grounding)
  if (!line) return null
  return (
    <p data-testid="check-this-summary" className={`fb-t-caption text-amber-700 dark:text-amber-300 ${className}`}>
      {line}
    </p>
  )
}
