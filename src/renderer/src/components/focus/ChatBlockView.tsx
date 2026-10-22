import ReactMarkdown from 'react-markdown'
import rehypeSectionIcons from '../../lib/rehypeSectionIcons'
import remarkGfm from 'remark-gfm'
import type { AnswerGrounding, AppliedProposal, ChatBlock, ChatSource } from '@shared/types'
import { checkSpansFor, remarkCheckThis } from '../../lib/checkThis'
import { CHECK_MARK_CLASS, CheckSummary } from '../ai/CheckThis'
import ProposalCards from '../ProposalCards'

const REHYPE_PLUGINS = [rehypeSectionIcons]
import remarkCitations from '../../lib/remarkCitations'
import { connectorMeta } from '../../lib/chatBlocks'
import { isOpenable } from '../../lib/sourceTarget'
import Icon from '../Icon'
import ChatUiBlockView from '../assistant/ChatUiBlockView'

// The block-renderer registry for the agentic chat's typed-block thread.
//
// A message renders as an ordered ChatBlock[]; each block dispatches here to its
// renderer. This registry IS the open extension point: a new block kind = one
// new case (and its union member in shared/types). Today 'text' and 'action'
// (and connector-branded actions) carry real data; the remaining kinds render a
// tasteful, labelled placeholder so the frame is visibly ready for the session
// that wires their live data.
//
// Connector affordances are intentionally data-driven (icon/label resolved from
// the connector string), so adding Slack / Notion / Drive / etc. needs no change
// to this component beyond the lookup table.

interface Props {
  block: ChatBlock
  activeTaskId: string | null
  // Applied-card state + the mark-applied callback, threaded from the host
  // surface's store so approved cards persist (green + "Go to").
  appliedProposals: Record<string, AppliedProposal>
  onApplied: (proposalId: string, applied: AppliedProposal) => void
  onConsumeProposal: (proposalId: string) => void
  // Jump to a real workspace item (widget/document) when a block links to one.
  onOpenWidget?: (widgetId: string) => void
  // Open a cited source — the document, knowledge entry, desk or widget the
  // claim rests on. Both the chip row and the inline [n] markers route here, so
  // a citation is a link wherever it appears. Optional: a host that can't
  // navigate (the Focus chat) simply renders them as static text.
  onOpenSource?: (source: ChatSource) => void
  // The sources this turn cites, so an inline [n] can resolve its own target.
  citedSources?: ChatSource[]
  // Interactive UI blocks (Plexii P4): whether this turn's blocks may answer
  // for the user right now (latest turn, nothing in flight), and where a tap's
  // text goes. A host that passes neither renders blocks as an inert record.
  uiEnabled?: boolean
  onUiSubmit?: (text: string) => void
  // What the grounding check found in this answer: its specifics that no
  // source supports are marked "check this" in the prose, with one line below.
  grounding?: AnswerGrounding
}

export default function ChatBlockView({
  block,
  activeTaskId,
  appliedProposals,
  onApplied,
  onConsumeProposal,
  onOpenWidget,
  onOpenSource,
  citedSources,
  uiEnabled,
  onUiSubmit,
  grounding
}: Props): JSX.Element | null {
  // A citation is clickable only when we both know where it goes and have a way
  // to get there. Anything else stays plain text rather than offering a click
  // that does nothing.
  const sourceForMarker = (n: string): ChatSource | null => {
    if (!onOpenSource || !citedSources) return null
    const found = citedSources.find((s) => String(s.n) === n)
    return found && isOpenable(found) ? found : null
  }

  const checkSpans = checkSpansFor(grounding)

  switch (block.kind) {
    // ── Live blocks ──────────────────────────────────────────────────────────
    case 'text':
      // Assistant prose is deliberately UNBUBBLED — it sits on the panel rather
      // than inside a bordered box. Boxing both sides is the generic-chat tell,
      // and it forces long answers, tables and code to fight a 10px radius. The
      // speaker is carried by the turn's identity row, not by a container.
      return (
        <div className="fb-chat-prose text-[var(--ink-90)] md-rendered">
          <ReactMarkdown
            remarkPlugins={checkSpans.length ? [remarkGfm, remarkCitations, remarkCheckThis(checkSpans)] : [remarkGfm, remarkCitations]}
            rehypePlugins={REHYPE_PLUGINS}
            components={{
              a: ({ href, children, ...rest }) => (
                <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
                  {children}
                </a>
              ),
              // Inline [n] citation markers, rewritten by remarkCitations into a
              // span carrying data-citation. Any other span passes through
              // untouched, so this override costs nothing when there are no
              // citations. Rendered as a small accent chip so a claim and its
              // grounding read as one thing.
              mark: ({ node, children, ...rest }) => {
                const why = node?.properties?.dataCheck ?? node?.properties?.['data-check']
                return (
                  <mark {...rest} data-testid={why ? 'check-this' : undefined} title={why ? String(why) : undefined} className={why ? CHECK_MARK_CLASS : undefined}>
                    {children}
                  </mark>
                )
              },
              span: ({ node, children, ...rest }) => {
                // hProperties keys arrive in hast VERBATIM ('data-citation'),
                // not camelized — reading only dataCitation missed every chip
                // and rendered citations as invisible empty spans (A1 fix).
                const n =
                  node?.properties?.dataCitation ?? node?.properties?.['data-citation']
                if (n === undefined || n === null || n === '') {
                  return <span {...rest}>{children}</span>
                }
                const chipClass =
                  'inline-grid place-items-center align-[1.5px] mx-[1px] min-w-[14px] h-[14px] px-[3px] rounded-[4px] bg-accent/15 text-accent text-[9px] font-mono font-semibold'
                const source = sourceForMarker(String(n))
                if (!source) {
                  return (
                    <span data-testid="chat-citation" title={`Source ${String(n)}`} className={chipClass}>
                      {String(n)}
                    </span>
                  )
                }
                // The marker sits inside prose, so it opens on click but must not
                // behave like a block-level control: type="button" keeps it out of
                // form submission, and the title names what it opens.
                return (
                  <button
                    type="button"
                    data-testid="chat-citation"
                    title={`Open ${source.title}`}
                    onClick={() => onOpenSource?.(source)}
                    className={`${chipClass} cursor-pointer hover:bg-accent/30 transition-colors`}
                  >
                    {String(n)}
                  </button>
                )
              }
            }}
          >
            {block.markdown}
          </ReactMarkdown>
          <CheckSummary grounding={grounding} className="mt-1" />
        </div>
      )

    case 'sources': {
      // What the answer stands on. The numbers match the inline markers above,
      // and each chip opens the thing it names — the document, the knowledge
      // entry, or the desk the cited widget or table lives on. A source we can't
      // route stays a plain chip; an affordance that goes nowhere is worse than
      // no affordance. The tooltip carries the retrieved excerpt, which is the
      // closest thing to "the line this came from" that retrieval hands back.
      const chipClass =
        'inline-flex items-center gap-1.5 max-w-full rounded-full bg-[var(--surface-sunken)] pl-1.5 pr-2 py-0.5 text-[10px] text-[var(--ink-70)]'
      return (
        <div className="flex flex-wrap gap-1" data-testid="chat-sources">
          {block.sources.map((s) => {
            const openable = onOpenSource && isOpenable(s)
            const body = (
              <>
                <b className="font-mono text-[8.5px] font-bold text-accent">{s.n}</b>
                <span className="truncate">{s.title}</span>
                {openable && (
                  <Icon name="north_east" size={10} className="shrink-0 text-[var(--ink-40)]" />
                )}
              </>
            )
            if (!openable) {
              return (
                <span key={`${s.n}-${s.docId}`} title={s.snippet || s.title} className={chipClass}>
                  {body}
                </span>
              )
            }
            return (
              <button
                key={`${s.n}-${s.docId}`}
                type="button"
                data-testid="chat-source-link"
                title={`Open ${s.title}${s.snippet ? ` — ${s.snippet}` : ''}`}
                onClick={() => onOpenSource?.(s)}
                className={`${chipClass} hover:border-[rgb(var(--accent)/0.45)] hover:text-[var(--ink-100)] transition-colors`}
              >
                {body}
              </button>
            )
          })}
        </div>
      )
    }

    case 'action':
      // Reuse the shared apply pipeline (dependency resolution, batched undo,
      // per-card toasts). One proposal per action block.
      return (
        <ProposalCards
          proposals={[block.proposal]}
          activeTaskId={activeTaskId}
          appliedProposals={appliedProposals}
          onApplied={onApplied}
          onConsume={onConsumeProposal}
        />
      )

    case 'action-group':
      // The turn's whole build batch through ONE card surface (A4, AI-09):
      // Apply all and the per-card checkboxes work over the real group.
      return (
        <ProposalCards
          proposals={block.proposals}
          activeTaskId={activeTaskId}
          appliedProposals={appliedProposals}
          onApplied={onApplied}
          onConsume={onConsumeProposal}
        />
      )

    case 'connector-action': {
      const meta = connectorMeta(block.connector)
      // Connector actions flow through the SAME apply pipeline as any action —
      // they're just branded with the connector's icon/label. The card body is
      // ProposalCards; the connector chip above it names the integration.
      return (
        <div className="max-w-[92%] flex flex-col gap-1">
          <div className="inline-flex items-center gap-1.5 self-start rounded-full bg-[var(--surface-sunken)] px-2 py-0.5">
            <Icon name={meta.icon} size={12} className="text-[rgb(var(--accent))]" />
            <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--ink-50)]">
              {meta.label}
            </span>
          </div>
          <ProposalCards
            proposals={[block.proposal]}
            activeTaskId={activeTaskId}
            appliedProposals={appliedProposals}
            onApplied={onApplied}
            onConsume={onConsumeProposal}
          />
        </div>
      )
    }

    case 'ui':
      // Model-emitted interactive blocks (Plexii P4) — chips, scales, icon
      // rows, cards. A tap sends the selection as the user's next message.
      return <ChatUiBlockView block={block.block} enabled={!!uiEnabled} onSubmit={onUiSubmit} />

    // ── Declared-but-not-yet-emitted blocks: tasteful placeholders ────────────
    // These render so the frame is visibly complete; a later session teaches the
    // model to emit them and swaps these bodies for live data.
    case 'record-table':
      return (
        <BlockShell icon="table_chart" label={block.title || 'Records'}>
          <div className="text-[11px] text-[var(--ink-50)]">
            {block.columns.length} columns · {block.rows.length} rows
          </div>
        </BlockShell>
      )

    case 'chart':
      return (
        <BlockShell icon="bar_chart" label={block.title || `${block.chartType} chart`}>
          <div className="text-[11px] text-[var(--ink-50)]">Chart · {block.chartType}</div>
        </BlockShell>
      )

    case 'widget-card':
      return (
        <button
          onClick={() => block.widgetId && onOpenWidget?.(block.widgetId)}
          disabled={!block.widgetId}
          className="fb-btn-surface max-w-[92%] flex items-center gap-2.5 hover:border-accent px-3 py-2 text-left transition-colors disabled:cursor-default"
        >
          <span className="h-7 w-7 rounded-md bg-[var(--surface-sunken)] flex items-center justify-center text-[var(--ink-50)] shrink-0">
            <Icon name="widgets" size={15} />
          </span>
          <span className="min-w-0 flex-1 text-[13px] text-[var(--ink-100)] truncate">
            {block.title}
          </span>
          {block.widgetId && <Icon name="north_east" size={14} className="text-[var(--ink-40)]" />}
        </button>
      )

    case 'link':
      return (
        <a
          href={block.external ? block.href : undefined}
          target={block.external ? '_blank' : undefined}
          rel="noopener noreferrer"
          className="max-w-[92%] inline-flex items-center gap-1.5 text-[13px] text-[rgb(var(--accent))] hover:underline self-start"
        >
          <Icon name={block.external ? 'open_in_new' : 'link'} size={14} />
          {block.label}
        </a>
      )

    default:
      return null
  }
}

// Small shared shell for placeholder blocks — a labelled, iconed container that
// matches the design system so a not-yet-live block still looks intentional.
function BlockShell({
  icon,
  label,
  children
}: {
  icon: string
  label: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="max-w-[92%] rounded-lg bg-[var(--surface-sunken)] px-3 py-2.5">
      <div className="flex items-center gap-1.5 mb-1">
        <Icon name={icon} size={14} className="text-[var(--ink-50)]" />
        <span className="text-[12px] font-medium text-[var(--ink-90)]">{label}</span>
      </div>
      {children}
    </div>
  )
}
