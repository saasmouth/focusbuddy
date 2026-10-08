import { useEffect, useMemo, useRef, useState } from 'react'
import type { FbNode } from '@shared/types'
import Icon from '../Icon'
import DeskPresenceBar from '../DeskPresenceBar'
import { useViewStore } from '../../stores/view'
import { usePresenceStore } from '../../stores/presence'
import { useCapabilityEnabled } from '../../stores/capabilities'
import { presenceColor } from '../../lib/presence'
import ShareDialog from '../ShareDialog'

// Where you are and who is here — ONE menu, in vertical lists.
//
// This replaces two horizontal strips that floated over the desk: a
// hover-expanding breadcrumb pill at the top-left and a presence bar at the
// top-right. Moving them into the header side by side was not enough and was
// the wrong reading of the ask — they were still two controls, just higher up.
// Both answer "what am I looking at", so they are one menu.
//
// WHY VERTICAL. The breadcrumb was a pill that expanded ON HOVER to reveal the
// ancestor chain, with nested hover-dropdowns for sibling desks and rooms. That
// is a lot of state to discover with a mouse and impossible to scan: the trail
// was only ever visible while pointing at it, and reading it meant reading
// sideways through dividers. A vertical list shows the whole trail at once, in
// the order people read, with the current desk marked — and the same list can
// hold the people and the actions underneath it without competing for width.
//
// WHAT IS NOT HERE. The view-mode switcher stays in the header beside the
// trigger. It changes how the desk is DRAWN rather than describing what the
// desk is, and it is itself a popover — nesting one inside this one would be
// the hover-dropdown problem again in a new shape.

export interface DeskContextMenuProps {
  activeTask: FbNode
  nodes: FbNode[]
  onOpenTask: (id: string) => void
  onHome: () => void
  onRenameTask: (id: string, title: string) => void
  onAssignToRoom: (deskId: string, roomId: string) => void
  onCreateRoomFromDesk: (deskId: string) => void
}

export default function DeskContextMenu({
  activeTask,
  nodes,
  onOpenTask,
  onHome,
  onRenameTask,
  onAssignToRoom,
  onCreateRoomFromDesk
}: DeskContextMenuProps): JSX.Element {
  const goRoom = useViewStore((s) => s.goRoom)
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [roomPicker, setRoomPicker] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Same walk the pill used, including the work_item exclusion: a work item is
  // never a place you navigate to.
  const chain = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const out: FbNode[] = []
    let cur: FbNode | undefined = byId.get(activeTask.id) ?? activeTask
    let guard = 0
    while (cur && guard++ < 50) {
      if (cur.kind !== 'work_item') out.unshift(cur)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    return out
  }, [activeTask, nodes])

  const current = chain[chain.length - 1] ?? activeTask
  const ancestors = chain.slice(0, -1)
  // Top-level, non-archived folders — the same set the pill offered for desk
  // assignment. `trashedAt` is a DB column, not on the renderer's FbNode.
  // Who is on this desk right now, for the TRIGGER. The menu shows the detail;
  // the trigger has to carry the glance, otherwise folding the presence bar
  // into a menu would cost the one thing it was good at — knowing someone else
  // is here without doing anything. Same source and same entitlement gate as
  // DeskPresenceBar, so the two can never disagree.
  const presenceEnabled = useCapabilityEnabled('presence')
  const peers = usePresenceStore((st) => st.peers)
  const present = useMemo(
    () =>
      !presenceEnabled
        ? []
        : Object.values(peers).filter(
            (pp) => pp.location?.kind === 'desk' && pp.location.id === activeTask.id
          ),
    [peers, presenceEnabled, activeTask.id]
  )

  const rooms = useMemo(
    () => nodes.filter((n) => !n.archived && n.kind === 'folder' && n.parentId === null),
    [nodes]
  )

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function close(): void {
    setOpen(false)
    setRenaming(false)
    setRoomPicker(false)
    triggerRef.current?.focus()
  }

  function commitRename(): void {
    const next = draft.trim()
    if (next && next !== current.title) onRenameTask(current.id, next)
    setRenaming(false)
  }

  const Row = ({
    icon,
    label,
    sub,
    onClick,
    active,
    testid
  }: {
    icon: string
    label: string
    sub?: string
    onClick: () => void
    active?: boolean
    testid?: string
  }): JSX.Element => (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      data-testid={testid}
      aria-current={active ? 'true' : undefined}
      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-chip)] text-left text-[12px] ${
        active
          ? 'bg-[rgb(var(--accent)/0.12)] text-[var(--ink-100)]'
          : 'text-[var(--ink-80)] hover:bg-[var(--surface-sunken)]'
      }`}
    >
      <Icon name={icon} size={14} className={active ? 'text-accent shrink-0' : 'text-[var(--ink-50)] shrink-0'} />
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {sub && <span className="shrink-0 text-[10px] text-[var(--ink-40)]">{sub}</span>}
      {active && <Icon name="check" size={13} className="text-accent shrink-0" />}
    </button>
  )

  const Heading = ({ children }: { children: React.ReactNode }): JSX.Element => (
    <div className="px-2 pt-2 pb-1 fb-t-caption uppercase tracking-[0.06em] text-[var(--ink-40)] select-none">
      {children}
    </div>
  )

  return (
    <div className="relative" ref={ref} data-testid="desk-context">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="desk-context-trigger"
        title={`${current.title || 'Untitled'} — where you are, who is here, and what you can do`}
        className="flex items-center gap-1.5 max-w-[320px] px-2 py-1 rounded-[var(--radius-row)] border border-[var(--edge-soft)] bg-[var(--surface-raised)] hover:border-[rgb(var(--accent)/0.45)] transition-colors"
      >
        <Icon
          name={current.kind === 'folder' ? 'meeting_room' : 'desk'}
          size={14}
          className="text-accent shrink-0"
        />
        <span className="min-w-0 truncate text-[12px] font-medium text-[var(--ink-90)]">
          {current.title || 'Untitled'}
        </span>
        {present.length > 0 && (
          <span
            className="shrink-0 flex items-center -space-x-1"
            data-testid="desk-context-presence-dots"
            aria-label={`${present.length} other ${present.length === 1 ? 'person' : 'people'} on this desk`}
          >
            {present.slice(0, 3).map((pp) => (
              <span
                key={pp.accountId}
                className="h-2 w-2 rounded-full ring-1 ring-[var(--surface-raised)]"
                style={{ background: presenceColor(pp.status) }}
              />
            ))}
            {present.length > 3 && (
              <span className="pl-1.5 text-[10px] text-[var(--ink-40)]">+{present.length - 3}</span>
            )}
          </span>
        )}
        <Icon name={open ? 'expand_less' : 'expand_more'} size={14} className="text-[var(--ink-40)] shrink-0" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Desk context"
          data-testid="desk-context-menu"
          className="absolute left-0 top-full mt-1 z-50 w-[282px] max-h-[70vh] overflow-y-auto rounded-[var(--radius-card)] border border-[var(--edge-firm)] bg-[var(--surface-raised)] p-1.5"
          style={{ boxShadow: 'var(--shadow-cast)' }}
        >
          {/* ── Where you are ───────────────────────────────────────────── */}
          <Heading>Where you are</Heading>
          <div className="space-y-0.5" data-testid="desk-context-trail">
            <Row icon="home" label="Workspace home" onClick={() => { onHome(); close() }} testid="desk-context-home" />
            {ancestors.map((a) => (
              <Row
                key={a.id}
                icon={a.kind === 'folder' ? 'meeting_room' : 'desk'}
                label={a.title || 'Untitled'}
                sub={a.kind === 'folder' ? 'room' : 'desk'}
                testid={`desk-context-node-${a.id}`}
                onClick={() => {
                  if (a.kind === 'folder') goRoom(a.id)
                  else onOpenTask(a.id)
                  close()
                }}
              />
            ))}
            <Row
              icon={current.kind === 'folder' ? 'meeting_room' : 'desk'}
              label={current.title || 'Untitled'}
              sub="you are here"
              active
              onClick={() => close()}
              testid="desk-context-current"
            />
          </div>

          {/* ── Who's here ──────────────────────────────────────────────── */}
          {/* DeskPresenceBar renders null entirely when live presence is not
              entitled (Team tier) or nobody is on the desk, so this heading
              would otherwise sit over nothing. */}
          <PresenceSection taskId={current.id} />

          {/* ── This desk ───────────────────────────────────────────────── */}
          <div className="mt-1 pt-1 border-t border-[var(--edge-soft)]">
            <Heading>This desk</Heading>
            {renaming ? (
              <div className="px-1 pb-1">
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') setRenaming(false)
                  }}
                  onBlur={commitRename}
                  data-testid="desk-context-rename-input"
                  className="fb-field w-full text-[12px] px-2 py-1 bg-[var(--surface-sunken)] text-[var(--ink-90)]"
                />
              </div>
            ) : (
              <Row
                icon="edit"
                label="Rename"
                testid="desk-context-rename"
                onClick={() => {
                  setDraft(current.title || '')
                  setRenaming(true)
                }}
              />
            )}
            <Row
              icon="ios_share"
              label="Share…"
              testid="desk-context-share"
              onClick={() => {
                setOpen(false)
                setShareOpen(true)
              }}
            />
            {current.kind !== 'folder' && (
              roomPicker ? (
                <div className="space-y-0.5">
                  <Heading>Move to a room</Heading>
                  {rooms.length === 0 && (
                    <p className="px-2 pb-1 text-[11px] text-[var(--ink-50)]">
                      No rooms yet — the first one can be made from this desk.
                    </p>
                  )}
                  {rooms.map((r) => (
                    <Row
                      key={r.id}
                      icon="meeting_room"
                      label={r.title || 'Untitled room'}
                      active={r.id === current.parentId}
                      onClick={() => {
                        onAssignToRoom(current.id, r.id)
                        close()
                      }}
                    />
                  ))}
                  <Row
                    icon="add"
                    label="New room from this desk"
                    testid="desk-context-new-room"
                    onClick={() => {
                      onCreateRoomFromDesk(current.id)
                      close()
                    }}
                  />
                </div>
              ) : (
                <Row
                  icon="drive_file_move"
                  label="Move to a room…"
                  testid="desk-context-move"
                  onClick={() => setRoomPicker(true)}
                />
              )
            )}
          </div>
        </div>
      )}

      {shareOpen && (
        <ShareDialog
          kind={current.kind === 'folder' ? 'folder' : 'task'}
          entityId={current.id}
          label={current.title || 'Untitled'}
          onClose={() => setShareOpen(false)}
        />
      )}
    </div>
  )
}

// Rendered as its own component so the heading can be dropped when the bar
// itself renders nothing — a heading over an empty section reads as a bug.
function PresenceSection({ taskId }: { taskId: string }): JSX.Element | null {
  const bar = <DeskPresenceBar taskId={taskId} />
  // DeskPresenceBar returns null when presence is not entitled or nobody is
  // here. React cannot tell us that without rendering, so this section is
  // always mounted and the bar decides; the heading is inside the same wrapper
  // so an empty bar leaves an empty wrapper rather than a stray label.
  return (
    <div className="mt-1 pt-1 border-t border-[var(--edge-soft)] empty:hidden [&:has(>div:only-child)]:border-0">
      <div className="px-2 pt-1 pb-1 fb-t-caption uppercase tracking-[0.06em] text-[var(--ink-40)] select-none">
        Who&apos;s here
      </div>
      <div className="px-1 pb-1" data-testid="desk-context-presence">
        {bar}
      </div>
    </div>
  )
}
