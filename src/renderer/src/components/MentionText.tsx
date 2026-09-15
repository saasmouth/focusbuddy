import { useMemo } from 'react'
import { parseMentionText, type TextMention } from '@shared/mentionText'
import { useViewStore } from '../stores/view'
import Icon from './Icon'

// Text with its @-mentions drawn as links.
//
// Every mention is clickable and goes to the thing it names. A mention that
// merely LOOKED like a link -- styled, unclickable -- would be worse than
// plain text, because it would promise navigation the app then refuses.

/** Take the user to whatever a mention names. */
export function openMention(m: TextMention): void {
  const view = useViewStore.getState()
  switch (m.kind) {
    case 'desk':
      view.goTask(m.id)
      return
    case 'room':
      view.goRoom(m.id)
      return
    case 'widget':
      // A widget is reached through the desk it lives on; without that there is
      // nowhere to put the viewport.
      if (m.taskId) view.goTask(m.taskId)
      return
    case 'document':
      view.goDocuments?.()
      return
    default:
      // person, file, knowledge: no view owns them on their own, so the link is
      // inert rather than sending somebody somewhere arbitrary.
      return
  }
}

/** Is there anywhere to go? Drives whether the chip looks clickable. */
/**
 * Icons by kind, exported so a picker and a chip agree.
 *
 * A mention that looks like one thing in the list and another in the text is
 * the sort of small inconsistency that makes people distrust the link.
 */
export const MENTION_ICON: Record<string, string> = {
  desk: 'space_dashboard',
  room: 'folder',
  widget: 'widgets',
  document: 'description',
  person: 'person',
  file: 'draft',
  knowledge: 'menu_book'
}

export function mentionIsNavigable(m: TextMention): boolean {
  return (
    m.kind === 'desk' ||
    m.kind === 'room' ||
    m.kind === 'document' ||
    (m.kind === 'widget' && Boolean(m.taskId))
  )
}

export default function MentionText({
  text,
  className
}: {
  text: string
  className?: string
}): JSX.Element {
  const segments = useMemo(() => parseMentionText(text), [text])
  if (segments.length === 0) return <span className={className} />
  return (
    <span className={className}>
      {segments.map((seg, i) =>
        seg.type === 'text' ? (
          <span key={i}>{seg.text}</span>
        ) : (
          <MentionChip key={i} mention={seg.mention} />
        )
      )}
    </span>
  )
}

export function MentionChip({ mention }: { mention: TextMention }): JSX.Element {
  const navigable = mentionIsNavigable(mention)
  return (
    <button
      type="button"
      disabled={!navigable}
      onClick={(e) => {
        e.stopPropagation()
        openMention(mention)
      }}
      onMouseDown={(e) => e.stopPropagation()}
      title={navigable ? `Open ${mention.title}` : mention.title}
      className={`mention-chip widget-nodrag inline-flex max-w-full items-baseline gap-0.5 rounded-[4px] px-1 align-baseline ${
        navigable
          ? 'cursor-pointer bg-accent/10 text-accent hover:bg-accent/20'
          : 'cursor-default bg-[var(--surface-sunken)] text-[var(--ink-60)]'
      }`}
    >
      <Icon name={MENTION_ICON[mention.kind] ?? 'link'} size={10} className="shrink-0 translate-y-[1px]" />
      <span className="truncate">{mention.title}</span>
    </button>
  )
}
