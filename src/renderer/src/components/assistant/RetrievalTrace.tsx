import { useEffect, useRef, useState } from 'react'
import type { ChatSource } from '@shared/types'
import Icon from '../Icon'
import { useSiteIcon } from '../../lib/siteIcon'
import PlexiiThinking from './PlexiiThinking'
import { isOpenable } from '../../lib/sourceTarget'
import { sourceIdentity } from '../../lib/sourceIdentity'
import {
  getTraceView,
  hasTraceContent,
  traceSummary,
  rotatedLabel,
  cascadeDelayMs,
  SOURCE_READ_TICK_MS,
  type AssistantTrace
} from '../../lib/traceView'
import { useLocalAiWarming, LOCAL_WARMING_COPY } from '../../lib/localAiEngine'
import AnsweredBy from '../ai/AnsweredBy'

// What the assistant did, while it does it.
//
// Every line here is drawn from `getTraceView` — a pure derivation of facts the
// server actually reported. This component owns exactly one piece of state that
// isn't derived (`revealedCount`, the reveal tick) plus the collapse timers.
// Nothing it draws can outlive the work it describes.
//
// The two rules it enforces visually:
//   • when nothing happened, it renders nothing at all — no empty shell, no
//     "0 sources" badge over an answer that used none;
//   • a failure ends red. Phases that really finished stay green, the failing
//     step is named, and nothing ahead of it is drawn as done.

// How long a finished trace stays fully expanded before folding away.
const HOLD_BEFORE_COLLAPSE_MS = 1400
// Must match the .fb-trace-body fold transition in globals.css (--dur-base).
const FADE_MS = 240
// Rows past this count need the panel to scroll; below it the panel clips,
// so a row rising into place never flashes a scrollbar (AI-30 shot sweep).
const SCROLL_PAST_ROWS = 7

interface Props {
  trace: AssistantTrace
  // Remembered open/shut state for this turn, or undefined if the user has never
  // been asked. Held by the caller (the store) because this component unmounts
  // on every navigation — see onDisclosureChange.
  disclosure?: 'open' | 'closed'
  onDisclosureChange?: (state: 'open' | 'closed') => void
  // The answer's prose has started arriving (A1). Once the model is visibly
  // WRITING, a ticker still claiming "Reading X…" is a re-enactment, so the
  // read phase ends at once. (The rows themselves are already in place — the
  // cascade is CSS over a panel that took its final height when retrieval
  // landed, so nothing above the prose ever reflows: the P3 law.)
  settled?: boolean
  // The finished answer is still landing below (AI-30's drain). Folding the
  // expanded tree while the waves are still arriving would shove the text
  // up; the auto-collapse waits until the caller lets go.
  holdOpen?: boolean
  // Open a retrieved source. Every source leaf is a link, not just the ones the
  // answer cited — retrieved-but-uncited material appears nowhere else, so this
  // is the only route to it.
  onOpenSource?: (source: ChatSource) => void
}

// A web result's favicon. Search results are sites the person did not choose,
// so nothing is fetched for them: a cached icon if they linked that site before
// (lib/siteIcon, cache only), otherwise the neutral connect mark.
function WebFavicon({ domain }: { domain: string }): React.JSX.Element {
  const src = useSiteIcon(domain ? `https://${domain}` : null, false)
  if (!src) return <Icon name="hub" size={12} className="shrink-0 text-[var(--ink-50)]" />
  return <img src={src} width={12} height={12} className="shrink-0 rounded-[3px]" alt="" />
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

// Total wall time of a finished trace, as a quiet suffix for the summary
// line: "2 sources · 3.2s". Sub-second traces stay silent — a duration that
// reads 0.3s is noise dressed as information.
function traceDuration(trace: AssistantTrace): string | null {
  if (trace.completedAt === null) return null
  const s = (trace.completedAt - trace.startedAt) / 1000
  if (s < 1) return null
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`
}

export default function RetrievalTrace({
  trace,
  disclosure,
  onDisclosureChange,
  settled,
  holdOpen,
  onOpenSource
}: Props): JSX.Element | null {
  const warming = useLocalAiWarming()
  const sourceCount = trace.sources.length
  // Live elapsed seconds while the work runs (P6): the machine narrates AND
  // keeps time, in tabular numerals so the line never jitters. Appears only
  // after 2s — fast answers never flash a stopwatch.
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    if (trace.status !== 'running') return
    const id = window.setInterval(() => setNowTick(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [trace.status])
  const liveElapsedS = Math.floor((nowTick - trace.startedAt) / 1000)
  // A finished trace starts fully revealed. The staggered reveal exists to show
  // work happening; replaying it for a request that completed minutes ago is a
  // re-enactment, not progress — and it fired again every time the panel
  // remounted, which is on every navigation.
  const [revealedCount, setRevealedCount] = useState(() =>
    trace.status === 'running' ? 0 : trace.sources.length
  )
  // Entrance motion belongs to work happening NOW. A trace mounted already
  // finished — the handoff after the drain, a restored conversation, a
  // disclosure the user reopened — draws its rows in place, quietly; the
  // cascade played once, when the sources were actually found.
  const animateEntrance = useRef(trace.status === 'running')
  const [collapsed, setCollapsed] = useState(disclosure === 'closed')
  const [exiting, setExiting] = useState(false)
  // True once the disclosure has an owner — either the user has toggled it, or a
  // remembered state says they already have. The auto-collapse timers stand down
  // from then on, so a trace you deliberately opened is not folded away behind
  // your back when you come back to the page.
  const [userControlled, setUserControlled] = useState(disclosure !== undefined)

  // The read ticker walks the landed sources one label at a time — pure
  // narration of the wait, never a layout change. Self-rescheduling rather
  // than an interval, so a source list that grows mid-flight picks up
  // seamlessly. Once the answer is settled (prose below), the read phase is
  // over at once.
  useEffect(() => {
    if (revealedCount >= sourceCount) return
    if (settled) {
      setRevealedCount(sourceCount)
      return
    }
    const id = window.setTimeout(() => {
      setRevealedCount((c) => Math.min(c + 1, sourceCount))
    }, SOURCE_READ_TICK_MS)
    return () => window.clearTimeout(id)
  }, [sourceCount, revealedCount, settled])

  // A trace that ended in failure stays open: it's the only thing on screen
  // explaining what went wrong.
  const fullyDone =
    trace.status === 'done' && revealedCount >= sourceCount && trace.completedAt !== null

  useEffect(() => {
    if (!fullyDone || userControlled || holdOpen) return
    const fadeId = window.setTimeout(() => setExiting(true), HOLD_BEFORE_COLLAPSE_MS)
    const collapseId = window.setTimeout(() => {
      setCollapsed(true)
      // Record it, so returning to this page finds the trace as it was left
      // rather than expanded and mid-animation again.
      onDisclosureChange?.('closed')
    }, HOLD_BEFORE_COLLAPSE_MS + FADE_MS)
    return () => {
      window.clearTimeout(fadeId)
      window.clearTimeout(collapseId)
    }
  }, [fullyDone, userControlled, holdOpen, onDisclosureChange])

  // Nothing retrieved, nothing prepared, nothing failed — so nothing to say.
  if (!hasTraceContent(trace)) return null

  const setOpen = (open: boolean): void => {
    setExiting(false)
    setCollapsed(!open)
    setUserControlled(true)
    onDisclosureChange?.(open ? 'open' : 'closed')
  }

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="trace-collapsed"
        className="fb-trace-in flex items-center gap-1 text-[10.5px] text-[var(--ink-40)] hover:text-[var(--ink-70)] transition-colors"
        title="Show what the assistant did"
      >
        <Icon name="chevron_right" size={12} />
        <span>
          {traceSummary(trace)}
          {traceDuration(trace) && (
            <span className="fb-tabular"> · {traceDuration(trace)}</span>
          )}
        </span>
      </button>
    )
  }

  const { completed, active, error } = getTraceView(trace, revealedCount)

  // The way back. Without it, re-opening a collapsed trace is a one-way door —
  // it stays expanded for the rest of the conversation with no affordance to put
  // it away. Shown only when the trace won't fold itself away: while it is still
  // running there is nothing settled to collapse, and a trace that is about to
  // auto-collapse doesn't need a control that flashes up first.
  const showCollapseControl = userControlled || trace.status === 'error'
  let cascadeIndex = 0
  const enter = animateEntrance.current ? 'fb-fade-in-up' : ''

  return (
    // The fold (AI-30): the expanded tree collapses by height, not by a cut.
    // fb-trace-body is a one-row grid whose row goes 1fr -> 0fr while it
    // fades, so the answer below glides up over --dur-base instead of
    // jumping the tree's full height the instant the summary line replaces it.
    <div
      data-testid="assistant-trace"
      className={`fb-trace-body text-[11px] ${exiting ? 'fb-trace-out pointer-events-none' : ''}`}
    >
    <div className="min-h-0 overflow-hidden flex flex-col gap-0.5">
      {showCollapseControl && (
        <button
          type="button"
          onClick={() => setOpen(false)}
          data-testid="trace-collapse"
          className="flex items-center gap-1 self-start text-[10.5px] text-[var(--ink-40)] hover:text-[var(--ink-70)] transition-colors"
          title="Hide what the assistant did"
        >
          <Icon name="expand_more" size={12} />
          <span>
            {traceSummary(trace)}
            {traceDuration(trace) && (
              <span className="fb-tabular"> · {traceDuration(trace)}</span>
            )}
          </span>
        </button>
      )}
      {completed.map((line) => {
        // Rows cascade in index order across the whole tree (AI-30): the
        // workspace panel's rows lead and the web panel's continue the same
        // stagger, so two panels landing together read as one reveal. Every
        // row is mounted at once with `both` fill, so the panel takes its
        // final height in one commit and nothing below it moves again.
        const leadIndex = cascadeIndex
        cascadeIndex += line.leaves?.length ?? 0
        // A line that lands while the work runs grows into place by height
        // (fb-trace-grow) so whatever sits below it — the active line, the
        // landing prose — glides rather than jumps; its rows then cascade
        // inside the opened space.
        return (
        <div key={line.key} data-trace-line={line.key} className={enter ? 'fb-trace-grow' : ''}>
        <div className="min-h-0 overflow-hidden flex flex-col gap-0.5">
          <div className={`${enter} flex items-center gap-1.5 text-[var(--ink-40)]`}>
            <Icon name="check_circle" size={12} className="text-emerald-500/80 shrink-0" filled />
            <Icon name={line.icon} size={11} className="shrink-0 opacity-70" />
            <span className="truncate">{line.label}</span>
          </div>
          {line.leaves && line.leaves.length > 0 && (
            // The evidence panel (F2): found sources present as a grouped
            // result block, Claude-research style — each row wears its kind's
            // icon in the kind's sidebar colour, with a right-aligned
            // provenance slot naming where it lives, the way a web result
            // names its domain. Scrolls past six rows rather than growing.
            <ul
              className={`ml-[18px] mt-0.5 rounded-[var(--radius-row)] bg-[color-mix(in_oklab,var(--surface-sunken)_60%,transparent)] px-1.5 py-1 max-h-44 flex flex-col gap-px ${
                line.leaves.length > SCROLL_PAST_ROWS ? 'overflow-y-auto' : 'overflow-hidden'
              }`}
            >
              {line.leaves.map((leaf, li) => {
                const isWeb = leaf.source?.docType === 'web'
                const domain = isWeb && leaf.source ? domainOf(leaf.source.docId) : null
                const identity = !isWeb && leaf.source ? sourceIdentity(leaf.source.docType) : null
                const body = (
                  <>
                    {leaf.n !== undefined && (
                      <span className="w-3 shrink-0 text-right font-mono text-[9px] text-[var(--ink-40)]">
                        {leaf.n}
                      </span>
                    )}
                    {isWeb && domain ? (
                      <WebFavicon domain={domain} />
                    ) : (
                      <Icon
                        name={identity?.icon ?? leaf.icon}
                        size={12}
                        className={`shrink-0 ${identity ? identity.tone : 'opacity-70'}`}
                      />
                    )}
                    <span className="truncate text-[var(--ink-80)]">{leaf.label}</span>
                    {(identity || domain) && (
                      <span className="ml-auto pl-3 shrink-0 fb-t-caption text-[var(--ink-40)]">
                        {domain ?? identity?.location}
                      </span>
                    )}
                  </>
                )
                const rowClass =
                  'flex items-center gap-1.5 w-full text-left rounded-[var(--radius-chip)] px-1.5 py-1'
                const openable = leaf.source && onOpenSource && isOpenable(leaf.source)
                return (
                  <li
                    key={leaf.key}
                    data-testid="trace-leaf"
                    className={enter}
                    style={enter ? { animationDelay: `${cascadeDelayMs(leadIndex + li)}ms` } : undefined}
                  >
                    {openable ? (
                      <button
                        type="button"
                        data-testid="trace-leaf-link"
                        title={`Open ${leaf.label}${leaf.source?.snippet ? ` — ${leaf.source.snippet}` : ''}`}
                        onClick={() => leaf.source && onOpenSource?.(leaf.source)}
                        className={`${rowClass} hover:bg-[var(--surface-raised)] transition-colors`}
                      >
                        {body}
                      </button>
                    ) : (
                      <span className={rowClass} title={leaf.label}>
                        {body}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        </div>
        )
      })}

      {/* The live region is mounted unconditionally with only its contents
          swapping. A region created at the same moment as its content does not
          announce — screen readers have nothing to diff it against. */}
      <div aria-live="polite" aria-atomic="true">
        {active && (
          // The live line (P4): the breathing double-i is the thinking
          // indicator — the mark itself, not a spinner. The label rotates
          // through honest phase verbs every 2s (AI-29, Caleb's ask), each
          // swap arriving on the quiet trace fade; once prose starts typing
          // this line completes and the words themselves carry the motion.
          <div key={active.key} className="fb-trace-in flex items-center gap-1.5">
            <span className="w-4 h-4 grid place-items-center shrink-0 text-accent" aria-hidden="true">
              <PlexiiThinking size={14} />
            </span>
            <Icon name={active.icon} size={11} className="shrink-0 text-[var(--ink-50)]" />
            {(() => {
              const label = rotatedLabel(
                active.key,
                active.label,
                // The verbs narrate the gap before the first wave; once the
                // answer is visibly landing, "Thinking…" beside it would be
                // a contradiction, so the line settles on its honest label.
                trace.status === 'running' && !settled ? Math.floor(liveElapsedS / 2) : -1
              )
              // A cold on-device model: say so instead of rotating verbs over
              // a load the person is waiting on.
              const shown = trace.status === 'running' && !settled && warming ? LOCAL_WARMING_COPY : label
              return (
                <span key={shown} className="fb-trace-in text-[var(--ink-70)]" data-testid={shown === LOCAL_WARMING_COPY ? 'local-ai-warming' : undefined}>
                  {shown}
                </span>
              )
            })()}
            {trace.status === 'running' && liveElapsedS >= 2 && (
              <span className="fb-tabular text-[var(--ink-40)]">{liveElapsedS}s</span>
            )}
          </div>
        )}
        {trace.status === 'done' && <AnsweredBy feature="assistant" since={trace.startedAt} className="mt-0.5 pl-6" />}
        {error && (
          <div
            key={error.key}
            data-testid="trace-error"
            className="fb-trace-in flex items-start gap-1.5 text-rose-600 dark:text-rose-400"
          >
            <Icon name={error.icon} size={12} className="shrink-0 mt-[1px]" />
            <span>{error.label}</span>
          </div>
        )}
      </div>
    </div>
    </div>
  )
}
