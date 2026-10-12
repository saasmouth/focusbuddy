import { useState } from 'react'
import type { ChatQuestion } from '@shared/types'
import Icon from '../Icon'

// The follow-up-question card — the assistant asking instead of guessing.
// Sits directly above the composer, inside the composer's form, the way
// Notion's does: a bold prompt, a single-select option list, a dismiss ×, and
// a Send. The composer below stays live as the free-text escape ("or describe
// it your own way"), so there is exactly one way an answer leaves the panel:
// as a normal user turn through the existing send path.
//
// The card renders ONLY a question the model actually emitted (store-held,
// from the completed response) — rendering an invented question would be the
// same class of lie as a trace phase that never ran.

interface Props {
  question: ChatQuestion
  // Rendered inside the composer card (F1): no border, no fill, no radius of
  // its own — the card it lives in is the surface.
  docked?: boolean
  // A send is already in flight (possibly on another thread) — answering must
  // wait, exactly like the composer's own send button.
  disabled: boolean
  onAnswer: (option: string) => void
  onDismiss: () => void
}

export default function QuestionCard({
  question,
  disabled,
  onAnswer,
  onDismiss,
  docked
}: Props): JSX.Element {
  const [selected, setSelected] = useState<number | null>(null)

  function submit(): void {
    if (selected === null || disabled) return
    onAnswer(question.options[selected])
  }

  return (
    <div
      data-testid="assistant-question-card"
      className={
        docked
          ? 'flex flex-col gap-2 px-0.5 pt-0.5 pb-1'
          : 'mb-2 rounded-[var(--radius-card)] border border-[rgb(var(--accent)/0.35)] bg-[rgb(var(--accent)/0.06)] px-3 pt-2.5 pb-2 flex flex-col gap-2'
      }
    >
      <div className="flex items-start justify-between gap-2">
        <p className="fb-t-label font-semibold leading-snug text-[var(--ink-100)]">
          {question.prompt}
        </p>
        <button
          type="button"
          onClick={onDismiss}
          className="icon-btn !h-6 !w-6 shrink-0"
          title="Dismiss — answer in your own words below, or not at all"
          aria-label="Dismiss question"
          data-testid="question-dismiss"
        >
          <Icon name="close" size={12} />
        </button>
      </div>

      <div role="radiogroup" aria-label={question.prompt} className="flex flex-col gap-0.5">
        {question.options.map((opt, i) => (
          <label
            key={i}
            className={`flex items-center gap-2 rounded-[var(--radius-row)] px-1.5 py-1 cursor-pointer transition-colors fb-t-label leading-snug ${
              selected === i
                ? 'bg-[rgb(var(--accent)/0.12)] text-[var(--ink-100)]'
                : 'text-[var(--ink-80)] hover:bg-[var(--surface-sunken)]'
            }`}
          >
            <input
              type="radio"
              name="assistant-question-option"
              checked={selected === i}
              onChange={() => setSelected(i)}
              className="h-3 w-3 shrink-0"
              style={{ accentColor: 'rgb(var(--accent))' }}
              data-testid="question-option"
            />
            <span>{opt}</span>
          </label>
        ))}
      </div>

      <div className="flex items-center gap-2">
        {question.allowFreeText && (
          <span className="fb-t-caption text-[var(--ink-50)]">
            Or describe it your own way below
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={submit}
          disabled={selected === null || disabled}
          aria-label="Send answer"
          data-testid="question-send"
          className="fb-press h-[24px] px-2.5 rounded-full fb-t-caption font-medium transition-colors bg-[rgb(var(--accent))] text-white hover:bg-[rgb(var(--accent-hover))] disabled:bg-[var(--surface-sunken)] disabled:text-[var(--ink-40)] disabled:border disabled:border-[var(--edge-soft)]"
        >
          Send
        </button>
      </div>
    </div>
  )
}
