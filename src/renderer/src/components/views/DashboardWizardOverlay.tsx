// The dashboard configuration wizard.
//
// A conversation, not a form: Plexii asks a handful of questions, every one
// answerable by clicking, every one also answerable in your own words. At the
// end it shows the dashboard it built — as the real thing, live, at the real
// proportions — before anything is committed. Nothing is saved until "Use this
// dashboard".
//
// The arrangement is built deterministically the moment the last question is
// answered (see dashboardWizard.ts), so the wizard finishes instantly and
// finishes offline. The model's pass runs after that and only reorders,
// resizes and drops within the real widget catalogue; if there is no API key,
// or the call fails, or it answers with nonsense, the dashboard already on
// screen is the one you keep.

import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import Icon from '../Icon'
import {
  WIZARD_QUESTIONS,
  EMPTY_ANSWERS,
  SURFACE_LABEL,
  planDashboard,
  planToInstances,
  refineWithPlan,
  describeAnswers,
  catalogueFor,
  type DashboardPlan,
  type WizardAnswers,
  type WizardQuestion
} from './dashboardWizard'
import { widgetDef, type DashboardSurface } from './homeWidgetDefs'
import { cellRect, packGrid, packedRows, type SizedInstance } from './homeGridLayout'

const SIZE_LABEL: Record<string, string> = {
  icon: 'Icon',
  sm: 'Small',
  md: 'Medium',
  lg: 'Large',
  stack: 'Stack'
}

// ── The live miniature ───────────────────────────────────────────────────────
// The review step shows the actual dashboard, packed by the same grid the real
// board uses and rendered with the same widgets, scaled down. Showing a mockup
// instead would be showing something that is not what you are about to get.

function PlanPreview({
  instances,
  renderPreview,
  cellW,
  cellH,
  gap,
  cols,
  maxW,
  maxH
}: {
  instances: SizedInstance[]
  renderPreview: (inst: SizedInstance) => JSX.Element | null
  cellW: number
  cellH: number
  gap: number
  cols: number
  maxW: number
  maxH: number
}): JSX.Element {
  // Laid out at the board's REAL cell size and then scaled down as one piece,
  // exactly the way the widget gallery previews a single widget. Packing into
  // small cells instead would render each widget's real content into a box a
  // quarter the size, and every label would wrap and clip -- a preview that
  // misrepresents the thing it is previewing is worse than no preview.
  const positions = useMemo(() => packGrid(instances, cols), [instances, cols])
  const rows = packedRows(instances, positions)
  const boardW = cols * cellW + (cols - 1) * gap
  const boardH = Math.max(1, rows) * cellH + Math.max(0, rows - 1) * gap
  const scale = Math.min(1, maxW / boardW, maxH / boardH)

  return (
    <div style={{ width: boardW * scale, height: boardH * scale }} className="relative mx-auto">
      <div
        style={{
          width: boardW,
          height: boardH,
          transform: `scale(${scale})`,
          transformOrigin: 'top left'
        }}
        className="absolute left-0 top-0"
      >
        {instances.map((inst) => {
          const pos = positions.get(inst.key)
          if (!pos) return null
          const r = cellRect(pos, inst.size, {
            originX: 0,
            originY: 0,
            cellW,
            cellH,
            gap,
            cols
          })
          return (
            <motion.div
              key={inst.key}
              layout
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: 'spring', stiffness: 420, damping: 34, mass: 0.7 }}
              style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
              className="absolute overflow-hidden rounded-2xl fb-widget-tile pointer-events-none select-none [&>*]:h-full [&>*]:!bg-transparent [&>*]:!shadow-none [&>*]:!border-0"
            >
              {renderPreview(inst)}
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}

// ── Chips ────────────────────────────────────────────────────────────────────

function Chip({
  label,
  hint,
  selected,
  onClick,
  testId
}: {
  label: string
  hint?: string
  selected: boolean
  onClick: () => void
  testId?: string
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-pressed={selected}
      className={`text-left rounded-xl px-3.5 py-2.5 transition-all fb-press border ${
        selected
          ? 'border-[rgb(var(--accent))] bg-[rgb(var(--accent)/0.08)] text-[var(--ink-100)]'
          : 'border-[var(--edge-soft)] bg-[var(--surface-raised)] text-[var(--ink-80)] hover:border-[var(--ink-30)] hover:bg-[var(--surface-sunken)]'
      }`}
    >
      <span className="flex items-start gap-2">
        <span
          className={`mt-[2px] h-4 w-4 rounded-full shrink-0 inline-flex items-center justify-center border transition-colors ${
            selected
              ? 'border-transparent bg-[rgb(var(--accent))] text-white'
              : 'border-[var(--ink-30)]'
          }`}
        >
          {selected && <Icon name="check" size={11} />}
        </span>
        <span className="min-w-0">
          <span className="block text-[13px] font-medium leading-snug">{label}</span>
          {hint && <span className="block fb-t-caption leading-snug mt-0.5">{hint}</span>}
        </span>
      </span>
    </button>
  )
}

// ── Bubbles ──────────────────────────────────────────────────────────────────

function Said({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
      className="flex justify-end"
    >
      <div className="max-w-[80%] rounded-2xl rounded-br-md bg-[rgb(var(--accent))] text-white px-3.5 py-2 text-[13px] leading-snug shadow-[0_1px_2px_rgb(var(--accent)/0.25)]">
        {children}
      </div>
    </motion.div>
  )
}

function Asked({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
      className="flex items-start gap-2.5"
    >
      <span className="mt-0.5 h-7 w-7 shrink-0 rounded-full inline-flex items-center justify-center bg-[rgb(var(--accent)/0.12)] text-[rgb(var(--accent))]">
        <Icon name="auto_awesome" size={15} />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </motion.div>
  )
}

// ── The overlay ──────────────────────────────────────────────────────────────

export default function DashboardWizardOverlay({
  surface,
  renderPreview,
  cellW,
  cellH,
  gap,
  cols,
  onApply,
  onClose
}: {
  surface: DashboardSurface
  renderPreview: (inst: SizedInstance) => JSX.Element | null
  /** The live board's subunit geometry, so the preview is to scale. */
  cellW: number
  cellH: number
  gap: number
  cols: number
  onApply: (instances: SizedInstance[]) => void
  onClose: () => void
}): JSX.Element {
  const reduce = useReducedMotion()
  const [answers, setAnswers] = useState<WizardAnswers>(() => ({ choices: {}, other: {} }))
  // How many questions have been answered and sent. The one at this index is
  // the live question; past that index nothing has been asked yet.
  const [at, setAt] = useState(0)
  const [otherFor, setOtherFor] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [plan, setPlan] = useState<DashboardPlan | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [thinking, setThinking] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const reviewRef = useRef<HTMLDivElement>(null)
  const otherRef = useRef<HTMLTextAreaElement>(null)

  const done = plan !== null
  const question: WizardQuestion | null = at < WIZARD_QUESTIONS.length ? WIZARD_QUESTIONS[at] : null

  // Keep the newest message in view, the way a conversation does -- except at
  // the review step, where the newest thing is a tall block whose TOP is the
  // part worth seeing. Scrolling to the bottom there lands past the preview,
  // hiding the dashboard the whole wizard exists to show.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const behavior = reduce ? 'auto' : 'smooth'
    const review = reviewRef.current
    if (done && review) {
      el.scrollTo({ top: Math.max(0, review.offsetTop - el.offsetTop - 8), behavior })
      return
    }
    el.scrollTo({ top: el.scrollHeight, behavior })
  }, [at, done, thinking, otherFor, reduce])

  useEffect(() => {
    if (otherFor) otherRef.current?.focus()
  }, [otherFor])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (otherFor) setOtherFor(null)
        else onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [otherFor, onClose])

  const toggle = (q: WizardQuestion, id: string): void => {
    setAnswers((prev) => {
      const cur = prev.choices[q.id] ?? []
      const next = q.multi
        ? cur.includes(id)
          ? cur.filter((x) => x !== id)
          : [...cur, id]
        : [id]
      return { ...prev, choices: { ...prev.choices, [q.id]: next } }
    })
    // A single-choice question has nothing left to decide, so it advances on
    // the click rather than making you confirm a choice you just made.
    if (!q.multi) window.setTimeout(() => advance(), 140)
  }

  const saveOther = (q: WizardQuestion): void => {
    const text = draft.trim()
    setAnswers((prev) => ({ ...prev, other: { ...prev.other, [q.id]: text } }))
    setOtherFor(null)
    setDraft('')
  }

  function advance(): void {
    setOtherFor(null)
    setDraft('')
    if (at + 1 < WIZARD_QUESTIONS.length) {
      setAt(at + 1)
      return
    }
    setAt(WIZARD_QUESTIONS.length)
  }

  // Build as soon as the questions run out. The deterministic plan lands
  // immediately; the model's pass, if there is one, refines it in place.
  useEffect(() => {
    if (at < WIZARD_QUESTIONS.length || plan) return
    const base = planDashboard(answers, surface)
    setPlan(base)
    setThinking(true)
    let live = true
    void (async () => {
      try {
        const res = await window.api.dashboardWizard.refine({
          surfaceLabel: SURFACE_LABEL[surface],
          answers: describeAnswers(answers),
          catalogue: catalogueFor(surface),
          current: base.widgets.map((w) => ({ widget: w.widget, size: w.size }))
        })
        if (!live) return
        if (res.ok && res.widgets) {
          // refineWithPlan is what makes this safe: anything the model named
          // that is not a real, placeable widget at a real size is dropped, and
          // a response that survives none of it leaves `base` untouched.
          setPlan(refineWithPlan(base, res.widgets))
          if (res.note) setNote(res.note)
        }
      } catch {
        // The dashboard on screen is already the answer.
      } finally {
        if (live) setThinking(false)
      }
    })()
    return () => {
      live = false
    }
  }, [at, plan, answers, surface])

  const restart = (): void => {
    setAnswers({ ...EMPTY_ANSWERS, choices: {}, other: {} })
    setAt(0)
    setPlan(null)
    setNote(null)
    setThinking(false)
    setOtherFor(null)
    setDraft('')
  }

  const instances = useMemo(() => (plan ? planToInstances(plan) : []), [plan])

  /** What they said to one question, as a sent message. */
  const saidFor = (q: WizardQuestion): string => {
    const picked = (answers.choices[q.id] ?? [])
      .map((id) => q.options.find((o) => o.id === id)?.label)
      .filter((l): l is string => !!l)
    const free = (answers.other[q.id] ?? '').trim()
    const parts = [...picked, ...(free ? [free] : [])]
    return parts.length > 0 ? parts.join(' · ') : 'Skipped'
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-[85] flex items-center justify-center p-6"
      data-testid="dashboard-wizard"
    >
      <div className="fb-scrim absolute inset-0" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.97, transition: { duration: 0.15 } }}
        transition={{ type: 'spring', stiffness: 380, damping: 32, mass: 0.8 }}
        className="relative w-[760px] max-w-[94vw] max-h-[min(720px,90vh)] flex flex-col rounded-2xl fb-glass-panel ring-1 ring-black/[0.10] dark:ring-white/[0.10] overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-4 pb-3 border-b border-[var(--edge-soft)] shrink-0">
          <span className="h-8 w-8 rounded-lg inline-flex items-center justify-center bg-[rgb(var(--accent)/0.12)] text-[rgb(var(--accent))] shrink-0">
            <Icon name="auto_awesome" size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-semibold text-[var(--ink-100)] truncate">
              Set up your {SURFACE_LABEL[surface]} dashboard
            </div>
            <div className="fb-t-caption truncate">
              {done ? 'Here is what I built. Nothing is saved until you say so.' : 'A few questions. Click, or write your own.'}
            </div>
          </div>
          {!done && (
            <div className="fb-t-caption fb-tabular shrink-0 tabular-nums">
              {Math.min(at + 1, WIZARD_QUESTIONS.length)} / {WIZARD_QUESTIONS.length}
            </div>
          )}
          <button
            onClick={onClose}
            title="Close"
            aria-label="Close"
            className="h-8 w-8 rounded-lg inline-flex items-center justify-center text-[var(--ink-50)] hover:text-[var(--ink-100)] hover:bg-[var(--surface-sunken)] transition-colors shrink-0"
          >
            <Icon name="close" size={17} />
          </button>
        </div>

        {/* Conversation */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-5 space-y-4">
          <Asked>
            <div className="rounded-2xl rounded-tl-md bg-[var(--surface-raised)] border border-[var(--edge-soft)] px-3.5 py-2.5 text-[13px] leading-relaxed text-[var(--ink-90)] max-w-[88%]">
              I can build your {SURFACE_LABEL[surface]} dashboard around how you actually work.
              Answer what you like and skip the rest — you can change any of it afterwards.
            </div>
          </Asked>

          {WIZARD_QUESTIONS.slice(0, at).map((q) => (
            <div key={q.id} className="space-y-2.5">
              <Asked>
                <div className="rounded-2xl rounded-tl-md bg-[var(--surface-raised)] border border-[var(--edge-soft)] px-3.5 py-2.5 text-[13px] leading-relaxed text-[var(--ink-90)] max-w-[88%]">
                  {q.prompt}
                </div>
              </Asked>
              <Said>{saidFor(q)}</Said>
            </div>
          ))}

          {question && (
            <div className="space-y-3" key={question.id}>
              <Asked>
                <div className="rounded-2xl rounded-tl-md bg-[var(--surface-raised)] border border-[var(--edge-soft)] px-3.5 py-2.5 max-w-[88%]">
                  <div className="text-[13px] leading-relaxed text-[var(--ink-90)]">{question.prompt}</div>
                  {question.why && <div className="fb-t-caption mt-1">{question.why}</div>}
                </div>
              </Asked>

              <div className="pl-[38px] space-y-2.5">
                <div className="grid grid-cols-2 gap-2">
                  {question.options.map((o) => (
                    <Chip
                      key={o.id}
                      label={o.label}
                      hint={o.hint}
                      selected={(answers.choices[question.id] ?? []).includes(o.id)}
                      onClick={() => toggle(question, o.id)}
                      testId={`wizard-opt-${question.id}-${o.id}`}
                    />
                  ))}
                </div>

                {/* Free text is offered on every question, never as a fallback
                    for a question that "failed" — the list is a shortcut, not
                    the set of acceptable answers. */}
                <AnimatePresence initial={false} mode="wait">
                  {otherFor === question.id ? (
                    <motion.div
                      key="other-open"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.18 }}
                      className="overflow-hidden"
                    >
                      <textarea
                        ref={otherRef}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault()
                            saveOther(question)
                          }
                        }}
                        rows={2}
                        placeholder={question.otherPlaceholder}
                        data-testid={`wizard-other-input-${question.id}`}
                        className="w-full resize-none rounded-xl px-3 py-2 text-[13px] leading-snug fb-field"
                      />
                      <div className="flex items-center justify-end gap-2 mt-1.5">
                        <button
                          onClick={() => {
                            setOtherFor(null)
                            setDraft('')
                          }}
                          className="h-8 px-3 rounded-lg text-[12px] text-[var(--ink-50)] hover:text-[var(--ink-90)] hover:bg-[var(--surface-sunken)] transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => saveOther(question)}
                          disabled={draft.trim() === ''}
                          data-testid={`wizard-other-save-${question.id}`}
                          className="h-8 px-3 rounded-lg text-[12px] font-medium fb-btn-surface fb-press text-[var(--ink-80)] disabled:opacity-40 disabled:pointer-events-none"
                        >
                          Add this
                        </button>
                      </div>
                    </motion.div>
                  ) : (
                    <motion.button
                      key="other-closed"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      onClick={() => {
                        setDraft(answers.other[question.id] ?? '')
                        setOtherFor(question.id)
                      }}
                      data-testid={`wizard-other-${question.id}`}
                      className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] text-[var(--ink-60)] hover:text-[var(--ink-90)] hover:bg-[var(--surface-sunken)] transition-colors"
                    >
                      <Icon name="edit" size={14} />
                      {answers.other[question.id] ? 'Edit what you wrote' : 'Something else…'}
                    </motion.button>
                  )}
                </AnimatePresence>

                {answers.other[question.id] && otherFor !== question.id && (
                  <div className="text-[12px] text-[var(--ink-60)] italic pl-1">
                    “{answers.other[question.id]}”
                  </div>
                )}

                <div className="flex items-center gap-2 pt-0.5">
                  <button
                    onClick={() => advance()}
                    data-testid={`wizard-next-${question.id}`}
                    className="inline-flex items-center gap-1.5 h-9 px-4 rounded-[10px] text-[12.5px] font-medium fb-press bg-[rgb(var(--accent))] text-white shadow-[0_1px_2px_rgb(var(--accent)/0.25),0_4px_12px_-2px_rgb(var(--accent)/0.30)]"
                  >
                    {at + 1 === WIZARD_QUESTIONS.length ? 'Build my dashboard' : 'Next'}
                    <Icon name="arrow_forward" size={15} />
                  </button>
                  <button
                    onClick={() => advance()}
                    data-testid={`wizard-skip-${question.id}`}
                    className="h-9 px-3 rounded-lg text-[12px] text-[var(--ink-50)] hover:text-[var(--ink-90)] hover:bg-[var(--surface-sunken)] transition-colors"
                  >
                    Skip
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Review */}
          {done && plan && (
            <div className="space-y-3" ref={reviewRef}>
              <Asked>
                <div className="rounded-2xl rounded-tl-md bg-[var(--surface-raised)] border border-[var(--edge-soft)] px-3.5 py-2.5 text-[13px] leading-relaxed text-[var(--ink-90)] max-w-[88%]">
                  {note ??
                    `Here is your ${SURFACE_LABEL[surface]} dashboard — ${plan.widgets.length} widget${plan.widgets.length === 1 ? '' : 's'}, arranged around what you told me.`}
                  {thinking && (
                    <span className="inline-flex items-center gap-1.5 ml-2 text-[var(--ink-50)]">
                      <span className="fb-dot fb-dot-pulse" />
                      <span className="text-[12px]">refining…</span>
                    </span>
                  )}
                </div>
              </Asked>

              <div className="pl-[38px] space-y-3">
                <div className="rounded-2xl border border-[var(--edge-soft)] bg-[var(--surface-sunken)] p-4">
                  <PlanPreview
                    instances={instances}
                    renderPreview={renderPreview}
                    cellW={cellW}
                    cellH={cellH}
                    gap={gap}
                    cols={cols}
                    maxW={548}
                    maxH={300}
                  />
                </div>

                <ul className="space-y-1.5" data-testid="wizard-reasons">
                  {plan.widgets.map((w) => {
                    const def = widgetDef(w.widget)
                    return (
                      <motion.li
                        key={w.widget}
                        layout
                        initial={{ opacity: 0, x: -6 }}
                        animate={{ opacity: 1, x: 0 }}
                        className="flex items-start gap-2.5"
                      >
                        <span className={`mt-[1px] h-6 w-6 shrink-0 rounded-lg inline-flex items-center justify-center ${def.tint}`}>
                          <Icon name={def.icon} size={14} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="text-[12.5px] font-medium text-[var(--ink-90)]">{def.name}</span>
                          <span className="fb-t-caption ml-1.5">{SIZE_LABEL[w.size] ?? w.size}</span>
                          {w.reason && (
                            <span className="block fb-t-caption leading-snug">{w.reason}</span>
                          )}
                        </span>
                      </motion.li>
                    )
                  })}
                </ul>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {done && plan && (
          <div className="flex items-center justify-between gap-2 px-5 py-3.5 border-t border-[var(--edge-soft)] shrink-0">
            <button
              onClick={restart}
              data-testid="wizard-restart"
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[12px] text-[var(--ink-50)] hover:text-[var(--ink-90)] hover:bg-[var(--surface-sunken)] transition-colors"
            >
              <Icon name="restart_alt" size={15} />
              Start over
            </button>
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                className="h-9 px-3.5 rounded-lg text-[12.5px] fb-btn-surface fb-press text-[var(--ink-80)]"
              >
                Not now
              </button>
              <button
                onClick={() => onApply(instances)}
                disabled={instances.length === 0}
                data-testid="wizard-apply"
                className="inline-flex items-center gap-2 h-9 px-4 rounded-[10px] text-[12.5px] font-medium fb-press bg-[rgb(var(--accent))] text-white shadow-[0_1px_2px_rgb(var(--accent)/0.25),0_4px_12px_-2px_rgb(var(--accent)/0.30)] disabled:opacity-40 disabled:pointer-events-none"
              >
                <Icon name="check" size={16} />
                Use this dashboard
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>
  )
}
