import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FbNode } from '@shared/types'
import Icon from '../Icon'
import CompleteCircle from './CompleteCircle'
import ItemStatusPill, { statusLabel, statusTone } from './ItemStatusPill'
import { useCloseWorkItem } from './useCloseWorkItem'
import AttentionItemEditor from '../AttentionItemEditor'
import { useWorkItemStore } from '../../stores/workItems'
import { useNodeStore } from '../../stores/nodes'
import { useViewStore } from '../../stores/view'
import {
  isTerminalState,
  itemReason,
  queueOf,
  queueTint,
  PRIMARY_ACTION,
  QUEUE_COLOR
} from '../../lib/attentionQueues'
import { itemContext, parseTags, sourceLabel, urgencyOf } from '../../lib/itemTags'
import { parseMentions, mentionKey, MENTION_ICON } from '../../lib/itemMentions'
import { subtaskProgress } from '../../lib/attentionGrouping'
import { parseMeetingMomentUrl } from '../../lib/meetingLink'
import { parseMessageUrl } from '../../lib/messageLink'
import { openMessageLink } from '../../lib/openMessage'
import { openMeetingMoment } from '../../lib/openMeeting'
import { startWithPlexii } from '../../lib/startWithPlexii'
import { meetingOf, meetingEnded, meetProviderLabel } from '../../lib/meetInvite'
import { formatMeetWhen } from '../../lib/meetWhen'

// DEC-128 — the Attention WIDGET's row (home canvas, a desk, the assistant's
// Attention tab): the same item, three depths, none of them a trip to the
// Attention page.
//
//   at rest    the title (and the due date when there is one) — the DEC-050
//              anatomy: queue spine, completion circle, status, date;
//   one click  a drop-down IN PLACE — the page's quick summary: notes, the
//              reason, the chips (desk · plan · meeting/message/source ·
//              mentions · tags), priority, subtask progress, a Meet
//              invitation's when/where/RSVP — and the page's row actions:
//              the source door (a meeting moment, the message in
//              PlexiiMessage, the web page), the desk, Start with Plexii,
//              Snooze until tomorrow, Archive, Open the item, and a door to
//              the Attention page itself;
//   double-click the full item — the page's own editor — over the page you
//              are on (portalled to <body>, so the floating panel cannot
//              clip it).
//
// Operator (DEC-128): "if I click on an attention item on a widget… it takes
// me straight to the attention page, and it doesn't actually show me which
// attention item I clicked on."

const chipClass =
  'inline-flex items-center gap-1 px-1.5 h-5 rounded-full text-[10.5px] bg-[var(--surface-sunken)] text-[var(--ink-50)] hover:text-[var(--ink-100)] fb-press max-w-[160px]'
const actionClass = 'icon-btn !h-6 !w-6'

export function WidgetItemRow({
  i,
  dense = false,
  nowMs
}: {
  i: FbNode
  /** Small widgets: a status DOT instead of the pill, no reason line at rest. */
  dense?: boolean
  nowMs: number
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const all = useWorkItemStore((s) => s.items)
  const setState = useWorkItemStore((s) => s.setState)
  const snooze = useWorkItemStore((s) => s.snooze)
  const refresh = useWorkItemStore((s) => s.refresh)
  const updateFields = useWorkItemStore((s) => s.updateFields)
  const nodes = useNodeStore((s) => s.nodes)
  const setActiveNode = useNodeStore((s) => s.setActive)
  const goTask = useViewStore((s) => s.goTask)
  const goProject = useViewStore((s) => s.goProject)
  const goRoom = useViewStore((s) => s.goRoom)
  const goAttention = useViewStore((s) => s.goAttention)
  const closeItem = useCloseWorkItem()
  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  // Personal, live desks only — shared and archived desks refuse work-item
  // parenting (the Attention page's own rule for its editor).
  const deskChoices = useMemo(
    () => nodes.filter((n) => n.kind === 'task' && !n.archived && !n.sharedRootId),
    [nodes]
  )

  const primary = PRIMARY_ACTION[queueOf(i)] ?? PRIMARY_ACTION.to_do
  const closed = isTerminalState(i.workItemState)
  const tone = statusTone(i.workItemState)
  const reason = itemReason(i, nowMs)
  const overdue = !!i.dueAt && Date.parse(i.dueAt) < nowMs
  const notes = (i.description || '').trim()
  const ctx = itemContext(i, nodesById)
  const tags = parseTags(i.tags)
  const mentions = parseMentions(i.mentions)
  const people = mentions.filter((m) => m.kind === 'person')
  const places = mentions.filter((m) => m.kind !== 'person')
  const urgency = urgencyOf(i)
  const progress = useMemo(
    () => subtaskProgress(i.id, all, (x) => isTerminalState(x.workItemState)),
    [i.id, all]
  )
  const invite = queueOf(i) === 'to_meet' ? meetingOf(i) : null
  const hasDesk = !!(i.parentId && nodes.some((n) => n.id === i.parentId && n.kind === 'task'))
  const moment = parseMeetingMomentUrl(i.sourceUrl)
  const msgLink = parseMessageUrl(i.sourceUrl)

  const openDesk = (): void => {
    if (!i.parentId) return
    setActiveNode(i.parentId)
    goTask(i.parentId)
  }
  // The page's source door: a meeting moment opens PlexiMeet at the line, a
  // message link opens the floating assistant at the message (DEC-127),
  // anything else is DEC-091's web deep link.
  const openSourceDoor = (): void => {
    if (moment) openMeetingMoment(moment.meetingId, moment.segmentId)
    else if (!openMessageLink(i.sourceUrl)) void window.api.files.openExternal(i.sourceUrl!)
  }
  const snoozeTomorrow = async (): Promise<void> => {
    const d = new Date(nowMs)
    d.setDate(d.getDate() + 1)
    d.setHours(9, 0, 0, 0)
    await snooze(i.id, d.getTime())
    await refresh()
  }
  const dueLabel = i.dueAt
    ? new Date(i.dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : null
  const showChips =
    !!ctx.desk || !!ctx.plan || !!ctx.source || tags.length > 0 || places.length > 0 || people.length > 0 || !!urgency || !!i.dueAt

  return (
    <div
      data-widget-item
      data-item-id={i.id}
      data-testid={`widget-item-${i.id}`}
      onDoubleClick={(e) => {
        // The action cluster is off-limits — double-clicking Archive should
        // archive, not open the editor behind it. Everything else, including
        // the title, opens the full item.
        e.stopPropagation()
        if ((e.target as HTMLElement).closest('[data-row-action]')) return
        setEditing(true)
      }}
      className={`group relative min-w-0 rounded-md border border-[var(--edge-soft)] bg-[var(--surface-raised)] hover:border-[var(--edge-firm)] transition-colors ${
        open ? 'bg-accent/[0.045]' : 'hover:bg-accent/[0.045]'
      }`}
    >
      <span
        aria-hidden
        className="absolute left-0 top-1.5 bottom-1.5 w-[2.5px] rounded-full"
        style={{ backgroundColor: queueTint(QUEUE_COLOR[queueOf(i)] ?? '#64748b', 0.55) }}
      />
      <div className="flex items-center gap-2 min-w-0 pl-2.5 pr-2 py-1.5">
        {!closed && (
          <CompleteCircle
            size={15}
            className="shrink-0"
            onClick={() => void closeItem(i, primary.state)}
            title={`${primary.label} — close this item`}
            dataTestId={`widget-item-complete-${i.id}`}
          />
        )}
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          title={open ? 'Hide details · double-click to open the item' : 'Click for details · double-click to open the item'}
          data-testid={`widget-item-toggle-${i.id}`}
          className="min-w-0 flex-1 text-left fb-press"
        >
          <span className="flex items-center gap-1 min-w-0">
            <span
              className={`min-w-0 text-[12px] text-[var(--ink-90)] ${
                open ? 'whitespace-pre-wrap break-words' : 'truncate'
              }`}
            >
              {i.title}
            </span>
            <Icon
              name="expand_more"
              size={12}
              className={`shrink-0 text-[var(--ink-30)] transition-transform duration-200 ${
                open ? 'rotate-180' : 'opacity-0 group-hover:opacity-100'
              }`}
            />
          </span>
          {reason && !dense && !open && (
            <span className="block text-[10px] text-[var(--ink-40)] truncate">{reason}</span>
          )}
        </button>
        {dueLabel && (
          <span
            className={`shrink-0 text-[10px] fb-tabular ${overdue ? 'text-rose-500' : 'text-[var(--ink-40)]'}`}
          >
            {dueLabel}
          </span>
        )}
        {closed ? (
          <Icon name="task_alt" size={13} className="shrink-0 text-emerald-500" />
        ) : dense && !open ? (
          <span
            title={statusLabel(i.workItemState, primary.label)}
            className="shrink-0 h-2 w-2 rounded-full"
            style={{ backgroundColor: tone.fg }}
          />
        ) : (
          <span data-row-action className="shrink-0">
            <ItemStatusPill
              state={i.workItemState}
              closeChoice={{ state: primary.state, label: primary.label }}
              onPick={(next) => {
                // The queue's closing verb runs through the SAME path the
                // completion circle uses (DEC-051), so the desk-done offer
                // and the subtask accounting fire either way.
                if (next === primary.state) void closeItem(i, next)
                else void setState(i.id, next)
              }}
            />
          </span>
        )}
      </div>
      {open && (
        <div
          className="px-2.5 pb-2 flex flex-col gap-1.5 select-text"
          data-testid={`widget-item-open-${i.id}`}
        >
          {notes && (
            <div className="text-[11.5px] text-[var(--ink-70)] whitespace-pre-wrap break-words">{notes}</div>
          )}
          {reason && <div className="text-[11px] text-[var(--ink-40)] leading-tight">{reason}</div>}
          {showChips && (
            <div className="flex flex-wrap items-center gap-1">
              {urgency && (
                <span
                  title={`Priority: ${urgency}`}
                  className={`inline-flex items-center gap-1 px-1.5 h-5 rounded-full text-[10.5px] capitalize ${
                    urgency === 'urgent'
                      ? 'text-red-500 bg-red-500/10'
                      : urgency === 'high'
                        ? 'text-amber-500 bg-amber-500/10'
                        : 'text-[var(--ink-40)] bg-[var(--surface-sunken)]'
                  }`}
                >
                  <Icon name="flag" size={10} />
                  {urgency}
                </span>
              )}
              {dueLabel && (
                <span
                  className={`inline-flex items-center gap-1 px-1.5 h-5 rounded-full text-[10.5px] ${
                    overdue
                      ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                      : 'bg-[var(--surface-sunken)] text-[var(--ink-50)]'
                  }`}
                >
                  <Icon name="schedule" size={10} /> {overdue ? 'overdue · ' : 'due '}
                  {dueLabel}
                </span>
              )}
              {ctx.plan && (
                <button data-row-action onClick={() => goProject(ctx.plan!.id)} title="Open the plan" className={chipClass}>
                  <Icon name="account_tree" size={10} />
                  <span className="truncate">{ctx.plan.title}</span>
                </button>
              )}
              {ctx.desk && (
                <button data-row-action onClick={openDesk} title="Open the desk" className={chipClass}>
                  <Icon name="desk" size={10} />
                  <span className="truncate">{ctx.desk.title}</span>
                </button>
              )}
              {ctx.source && ctx.source.type === 'meeting' ? (
                <button
                  data-row-action
                  onClick={() => openMeetingMoment(ctx.source!.ref)}
                  title={sourceLabel(ctx.source.type)}
                  data-testid="widget-item-meeting-link"
                  className={chipClass}
                >
                  <Icon name="groups" size={10} />
                  meeting
                </button>
              ) : ctx.source && ctx.source.type === 'message' && msgLink ? (
                <button
                  data-row-action
                  onClick={() => openMessageLink(i.sourceUrl)}
                  title={sourceLabel(ctx.source.type)}
                  data-testid="widget-item-message-link"
                  className={chipClass}
                >
                  <Icon name="forum" size={10} />
                  message
                </button>
              ) : ctx.source ? (
                <span
                  title={sourceLabel(ctx.source.type)}
                  className="inline-flex items-center gap-1 px-1.5 h-5 rounded-full text-[10.5px] bg-[var(--surface-sunken)] text-[var(--ink-40)]"
                >
                  <Icon name="widgets" size={10} />
                  {ctx.source.type}
                </span>
              ) : null}
              {places.map((m) => (
                <button
                  key={mentionKey(m)}
                  data-row-action
                  onClick={() => {
                    if (m.kind === 'desk') {
                      setActiveNode(m.id)
                      goTask(m.id)
                    } else if (m.kind === 'plan') goProject(m.id)
                    else if (m.kind === 'room') goRoom(m.id)
                  }}
                  title={`Open ${m.title}`}
                  className="inline-flex items-center gap-1 px-1.5 h-5 rounded-full text-[10.5px] bg-accent/10 text-[var(--ink-60)] hover:text-[var(--ink-100)] fb-press max-w-[150px]"
                >
                  <Icon name={MENTION_ICON[m.kind]} size={10} />
                  <span className="truncate">{m.title}</span>
                </button>
              ))}
              {people.map((m) => (
                <span
                  key={mentionKey(m)}
                  title={`${m.title} — mentioned`}
                  className="inline-flex items-center gap-1 px-1.5 h-5 rounded-full text-[10.5px] bg-accent/10 text-[var(--ink-60)] max-w-[150px]"
                >
                  <Icon name={MENTION_ICON[m.kind]} size={10} />
                  <span className="truncate">{m.title}</span>
                </span>
              ))}
              {tags.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1 px-1.5 h-5 rounded-full text-[10.5px] bg-accent/10 text-[var(--ink-60)]"
                >
                  <Icon name="sell" size={10} />
                  {t}
                </span>
              ))}
            </div>
          )}
          {invite?.isInvite && (
            <div className="flex items-center flex-wrap gap-x-2 gap-y-1 text-[11px] text-[var(--ink-50)]">
              {invite.startAtMs !== null && (
                <span className="fb-tabular">{formatMeetWhen(invite.startAtMs, invite.durationMin, nowMs)}</span>
              )}
              {invite.place.url && !meetingEnded(invite, nowMs) && (
                <button
                  data-row-action
                  onClick={() => void window.api.files.openExternal(invite.place.url as string)}
                  title={invite.place.url}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 bg-accent/10 text-[rgb(var(--accent))] hover:bg-accent/[0.16] fb-press"
                >
                  <Icon name="videocam" size={12} />
                  {meetProviderLabel(invite.place.url)}
                </button>
              )}
              {invite.place.location && (
                <span className="inline-flex items-center gap-1 text-[var(--ink-45)]" title={invite.place.location}>
                  <Icon name="place" size={12} />
                  <span className="truncate max-w-[180px]">{invite.place.location}</span>
                </span>
              )}
              {invite.awaitingRsvp ? (
                <span className="inline-flex items-center gap-1">
                  <span className="text-[var(--ink-40)]">RSVP</span>
                  {(['yes', 'maybe', 'no'] as const).map((answer) => (
                    <button
                      key={answer}
                      data-row-action
                      onClick={() => void updateFields(i.id, { meetRsvp: answer })}
                      className="rounded px-1.5 py-0.5 border border-[var(--edge-soft)] text-[var(--ink-60)] hover:bg-[var(--surface-sunken)] fb-press capitalize"
                    >
                      {answer}
                    </button>
                  ))}
                </span>
              ) : (
                invite.rsvp && <span className="text-[var(--ink-40)] capitalize">Replied {invite.rsvp}</span>
              )}
            </div>
          )}
          {progress.total > 0 && (
            <div className="inline-flex items-center gap-2" title="Subtasks closed">
              <span className="h-1 w-16 rounded-full bg-[var(--surface-sunken)] overflow-hidden">
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${(progress.done / progress.total) * 100}%`,
                    backgroundColor: queueTint('#10b981', 0.75)
                  }}
                />
              </span>
              <span className="fb-t-caption fb-tabular text-[var(--ink-40)]">
                {progress.done}/{progress.total} subtask{progress.total === 1 ? '' : 's'}
              </span>
            </div>
          )}
          <div data-row-action className="flex items-center gap-1 flex-wrap" data-testid={`widget-item-actions-${i.id}`}>
            {i.sourceUrl && (
              <button
                onClick={openSourceDoor}
                title={
                  moment
                    ? 'Jump to the spoken moment in the meeting'
                    : msgLink
                      ? 'Open the message in PlexiiMessage — the conversation, at this message'
                      : `Open the source page — ${i.sourceUrl}`
                }
                className={actionClass}
              >
                <Icon name={moment ? 'my_location' : msgLink ? 'forum' : 'link'} size={14} />
              </button>
            )}
            {hasDesk && (
              <button onClick={openDesk} title="Open the whole desk it came from" className={actionClass}>
                <Icon name="desk" size={14} />
              </button>
            )}
            {!closed && (
              <>
                <button
                  onClick={() => startWithPlexii([i], nodes)}
                  title="Start it with Plexii — opens a chat prefilled from this capture"
                  className={actionClass}
                >
                  <Icon name="auto_awesome" size={14} />
                </button>
                <button onClick={() => void snoozeTomorrow()} title="Snooze until tomorrow morning" className={actionClass}>
                  <Icon name="snooze" size={14} />
                </button>
                <button
                  onClick={() => void setState(i.id, 'archived')}
                  title="Archive — keep it, out of the way"
                  className={actionClass}
                >
                  <Icon name="archive" size={14} />
                </button>
              </>
            )}
            <button
              onClick={() => setEditing(true)}
              title="Open the item — the full view, right here"
              data-testid={`widget-item-edit-${i.id}`}
              className={actionClass}
            >
              <Icon name="open_in_new" size={14} />
            </button>
            <button
              onClick={() => goAttention()}
              title="Open the Attention page"
              data-testid={`widget-item-page-${i.id}`}
              className={`${actionClass} ml-auto`}
            >
              <Icon name="notifications" size={14} />
            </button>
          </div>
        </div>
      )}
      {editing &&
        createPortal(
          <AttentionItemEditor
            item={i}
            desks={deskChoices}
            onClose={(changed) => {
              setEditing(false)
              if (changed) void refresh()
            }}
          />,
          document.body
        )}
    </div>
  )
}
