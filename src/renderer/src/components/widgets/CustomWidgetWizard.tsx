// The build wizard, inside the widget it is building.
//
// One question at a time, because this runs in a desk widget that may be 400px
// wide — five questions at once would need a modal, and a modal would take the
// person away from the thing they are describing.
//
// Two jobs, one component: building a new widget, and CHANGING one that exists.
// The difference is only that editing starts from the answers already given, so
// changing a widget's behaviour is picking a different option rather than
// writing a fresh description of something you built three weeks ago.

import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../Icon'
import MentionTextarea from '../MentionTextarea'
import {
  WIDGET_WIZARD_QUESTIONS,
  describeAnswers,
  answersSaySomething,
  type WidgetWizardAnswers
} from '@shared/customWidgetWizard'

export default function CustomWidgetWizard({
  initial,
  mode,
  onCancel,
  onDone
}: {
  /** Answers to start from. Editing passes what was chosen last time. */
  initial: WidgetWizardAnswers
  mode: 'build' | 'edit'
  onCancel: () => void
  onDone: (answers: WidgetWizardAnswers) => void
}): JSX.Element {
  const [answers, setAnswers] = useState<WidgetWizardAnswers>(() => ({
    choices: { ...initial.choices },
    other: { ...initial.other }
  }))
  const [step, setStep] = useState(0)
  const [otherOpen, setOtherOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const otherRef = useRef<HTMLTextAreaElement>(null)

  const total = WIDGET_WIZARD_QUESTIONS.length
  const reviewing = step >= total
  const q = reviewing ? null : WIDGET_WIZARD_QUESTIONS[step]

  useEffect(() => {
    if (otherOpen) otherRef.current?.focus()
  }, [otherOpen])

  // Escape backs out one layer at a time: the free-text box, then the wizard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (otherOpen) setOtherOpen(false)
      else onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [otherOpen, onCancel])

  const toggle = (id: string): void => {
    if (!q) return
    setAnswers((prev) => {
      const cur = prev.choices[q.id] ?? []
      const next = q.multi
        ? cur.includes(id)
          ? cur.filter((x) => x !== id)
          : [...cur, id]
        : [id]
      return { ...prev, choices: { ...prev.choices, [q.id]: next } }
    })
    // A single-choice question has nothing left to decide, so it advances on the
    // click rather than making somebody confirm a choice they just made.
    if (!q.multi) window.setTimeout(() => go(1), 140)
  }

  function go(delta: number): void {
    setOtherOpen(false)
    setDraft('')
    setStep((s) => Math.max(0, Math.min(total, s + delta)))
  }

  const saveOther = (): void => {
    if (!q) return
    const text = draft.trim()
    setAnswers((prev) => ({ ...prev, other: { ...prev.other, [q.id]: text } }))
    setOtherOpen(false)
    setDraft('')
  }

  const summary = useMemo(() => describeAnswers(answers), [answers])
  const enough = answersSaySomething(answers)

  const chip = (active: boolean): string =>
    `text-left rounded-lg px-2.5 py-1.5 text-[11.5px] leading-snug border transition-colors ${
      active
        ? 'border-indigo-500 bg-indigo-50 text-indigo-900 dark:bg-indigo-500/15 dark:text-indigo-100'
        : 'border-stone-200 bg-white text-stone-700 hover:border-indigo-300 dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-200 dark:hover:border-indigo-500/40'
    }`

  return (
    <div
      className="absolute inset-0 z-30 flex flex-col bg-white/95 dark:bg-stone-900/95"
      data-testid="custom-widget-wizard"
    >
      <div className="shrink-0 flex items-center gap-2 border-b border-stone-200 px-3 py-2 dark:border-white/10">
        <Icon name="auto_awesome" size={14} className="shrink-0 text-indigo-500" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-stone-600 dark:text-stone-300">
          {mode === 'edit' ? 'Change this widget' : 'Build a widget'}
        </span>
        <span className="shrink-0 text-[10.5px] tabular-nums text-stone-400">
          {reviewing ? 'Review' : `${step + 1} / ${total}`}
        </span>
        <button
          onClick={onCancel}
          aria-label="Close"
          data-testid="wizard-close"
          className="shrink-0 text-stone-400 hover:text-stone-700 dark:hover:text-stone-100"
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {q && (
          <>
            <div className="text-[12.5px] font-medium text-stone-800 dark:text-stone-100">
              {q.prompt}
            </div>
            {q.why && <div className="mt-0.5 text-[10.5px] text-stone-500">{q.why}</div>}

            <div className="mt-2.5 grid grid-cols-1 gap-1.5">
              {q.options.map((o) => {
                const active = (answers.choices[q.id] ?? []).includes(o.id)
                return (
                  <button
                    key={o.id}
                    onClick={() => toggle(o.id)}
                    data-testid={`wizard-opt-${q.id}-${o.id}`}
                    aria-pressed={active}
                    className={chip(active)}
                  >
                    <span className="flex items-start gap-1.5">
                      <Icon
                        name={active ? 'check_circle' : 'radio_button_unchecked'}
                        size={13}
                        className={`mt-[1px] shrink-0 ${active ? 'text-indigo-500' : 'text-stone-300 dark:text-stone-600'}`}
                      />
                      <span className="min-w-0">
                        <span className="block font-medium">{o.label}</span>
                        {o.hint && (
                          <span className="block text-[10.5px] opacity-70">{o.hint}</span>
                        )}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>

            {/* Free text on every question — the list is a shortcut, not the set
                of acceptable answers. */}
            {otherOpen ? (
              <div className="mt-2">
                <MentionTextarea
                  ref={otherRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      saveOther()
                    }
                  }}
                  rows={2}
                  placeholder={q.otherPlaceholder}
                  data-testid={`wizard-other-input-${q.id}`}
                  className="w-full resize-none rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-[11.5px] text-stone-800 outline-none focus:border-indigo-400 dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-100"
                />
                <div className="mt-1 flex justify-end gap-1.5">
                  <button
                    onClick={() => setOtherOpen(false)}
                    className="rounded px-2 py-1 text-[11px] text-stone-500 hover:text-stone-800 dark:hover:text-stone-200"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={saveOther}
                    disabled={draft.trim() === ''}
                    data-testid={`wizard-other-save-${q.id}`}
                    className="rounded border border-stone-200 px-2 py-1 text-[11px] text-stone-700 disabled:opacity-40 dark:border-white/10 dark:text-stone-200"
                  >
                    Add
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => {
                  setDraft(answers.other[q.id] ?? '')
                  setOtherOpen(true)
                }}
                data-testid={`wizard-other-${q.id}`}
                className="mt-2 inline-flex items-center gap-1 text-[11px] text-stone-500 hover:text-indigo-600 dark:hover:text-indigo-300"
              >
                <Icon name="edit" size={12} />
                {answers.other[q.id] ? 'Edit what you wrote' : 'Something else…'}
              </button>
            )}
            {answers.other[q.id] && !otherOpen && (
              <div className="mt-1 text-[10.5px] italic text-stone-500">
                “{answers.other[q.id]}”
              </div>
            )}
          </>
        )}

        {reviewing && (
          <div data-testid="wizard-review">
            <div className="text-[12.5px] font-medium text-stone-800 dark:text-stone-100">
              {mode === 'edit' ? 'Ready to change it' : 'Ready to build'}
            </div>
            <div className="mt-1.5 rounded-lg border border-stone-200 bg-stone-50 px-2.5 py-2 text-[11px] leading-relaxed text-stone-600 dark:border-white/10 dark:bg-white/[0.03] dark:text-stone-300">
              {summary || 'You skipped every question — I will build something general.'}
            </div>
            <div className="mt-2 text-[10.5px] leading-relaxed text-stone-500">
              {mode === 'edit'
                ? 'The current version is kept, so you can revert if this is worse.'
                : 'It will start empty — no made-up rows — and you can change any of this afterwards.'}
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 flex items-center gap-1.5 border-t border-stone-200 px-3 py-2 dark:border-white/10">
        {step > 0 && (
          <button
            onClick={() => go(-1)}
            data-testid="wizard-back"
            className="rounded px-2 py-1 text-[11.5px] text-stone-500 hover:text-stone-800 dark:hover:text-stone-200"
          >
            Back
          </button>
        )}
        <div className="flex-1" />
        {!reviewing && (
          <>
            <button
              onClick={() => go(1)}
              data-testid="wizard-skip"
              className="rounded px-2 py-1 text-[11.5px] text-stone-400 hover:text-stone-700 dark:hover:text-stone-200"
            >
              Skip
            </button>
            <button
              onClick={() => go(1)}
              data-testid="wizard-next"
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-[11.5px] font-medium text-white hover:bg-indigo-700"
            >
              Next
            </button>
          </>
        )}
        {reviewing && (
          <button
            onClick={() => onDone(answers)}
            disabled={mode === 'build' && !enough}
            data-testid="wizard-finish"
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-[11.5px] font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
          >
            <Icon name="bolt" size={13} />
            {mode === 'edit' ? 'Update widget' : 'Build it'}
          </button>
        )}
      </div>
    </div>
  )
}
