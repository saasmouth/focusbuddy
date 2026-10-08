import { useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { FbNode, Widget } from '@shared/types'
import { useNodeStore } from '../stores/nodes'
import { useViewStore } from '../stores/view'
import DeskMiniature from './DeskMiniature'
import Icon from './Icon'
import CanvasContextMenu from './CanvasContextMenu'
import { deskLifecycleMenuItems } from '../lib/deskLifecycleMenu'

// Apple WWDC23 Stage Manager spring — measured from Archeon research
const SPRING = { type: 'spring' as const, stiffness: 158, damping: 25, mass: 1 }

// Small branded "Plexii grid" mark for empty desks — 2×2 rounded squares
function PlexiMark({ size = 28 }: { size?: number }): JSX.Element {
  const s = size / 4
  const gap = s * 0.45
  const total = s * 2 + gap
  return (
    <svg width={total} height={total} viewBox={`0 0 ${total} ${total}`} className="opacity-30">
      <rect x={0} y={0} width={s} height={s} rx={s * 0.3} fill="rgb(var(--accent))" />
      <rect x={s + gap} y={0} width={s} height={s} rx={s * 0.3} fill="rgb(var(--accent))" />
      <rect x={0} y={s + gap} width={s} height={s} rx={s * 0.3} fill="rgb(var(--accent))" />
      <rect x={s + gap} y={s + gap} width={s} height={s} rx={s * 0.3} fill="rgb(var(--accent))" opacity={0.5} />
    </svg>
  )
}

interface Props {
  roomId: string | null
  activeId: string
}

export default function StageManagerStrip({ roomId, activeId }: Props): JSX.Element {
  const nodes = useNodeStore((s) => s.nodes)
  const setActive = useNodeStore((s) => s.setActive)
  const goTask = useViewStore((s) => s.goTask)
  const goProject = useViewStore((s) => s.goProject)
  // Was aliased to goProject, which opened the room as a single canvas. Going
  // "back to the room" now shows the desks in it, like every other room door.
  const goRoom = useViewStore((s) => s.goRoom)
  const goHome = useViewStore((s) => s.goHome)
  const [widgetsByDesk, setWidgetsByDesk] = useState<Record<string, Widget[]>>({})
  const [transitioning, setTransitioning] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; desk: FbNode } | null>(null)

  const desks = useMemo(() => {
    const candidates = nodes.filter(
      (n) =>
        n.kind !== 'work_item' && !n.archived && (roomId ? n.parentId === roomId : n.parentId === null)
    )
    return candidates.sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
  }, [nodes, roomId])

  // activeId is the breadcrumb segment that opened this dropdown.
  // If it's a folder the user is navigating rooms; if it's a task they're navigating desks.
  const activeNode = nodes.find(n => n.id === activeId)
  const showAsRoom = activeNode?.kind === 'folder'

  const deskIdsKey = desks.map((d) => d.id).join(',')

  useEffect(() => {
    setTransitioning(true)
    let cancelled = false
    void (async () => {
      const entries = await Promise.all(
        desks.map(async (d) => {
          try {
            return [d.id, await window.api.widgets.listByTask(d.id)] as const
          } catch {
            return [d.id, [] as Widget[]] as const
          }
        })
      )
      if (!cancelled) {
        setWidgetsByDesk(Object.fromEntries(entries))
        setTransitioning(false)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deskIdsKey])

  function openDesk(n: FbNode): void {
    if (n.id === activeId) return
    setActive(n.id)
    if (n.kind === 'folder') goProject(n.id)
    else goTask(n.id)
  }

  function goBackToRoom(): void {
    if (roomId) goRoom(roomId)
    else goHome()
  }

  // Open the build wizard (NewNodeDialog) rather than dropping a blank
  // "Untitled" desk on the canvas. The wizard is where the user names the
  // desk, describes it, and sets importance, urgency, duration and due date.
  // We reuse the same global event the sidebar's "New" button fires, passing
  // the current room as the parent so the new desk lands in the right Room.
  function handleAddDesk(): void {
    window.dispatchEvent(
      new CustomEvent('fb:command-new-task', { detail: { parentId: roomId, kind: 'task' } })
    )
  }

  function handleAddRoom(): void {
    window.dispatchEvent(
      new CustomEvent('fb:command-new-task', { detail: { parentId: null, kind: 'folder' } })
    )
  }

  return (
    <div className="flex flex-col min-h-0 flex-1 select-none overflow-hidden" data-testid="stage-manager-strip">
      {/* Room home button */}
      <button
        onClick={goBackToRoom}
        title={roomId ? 'Back to room' : 'Home'}
        className="flex items-center justify-center gap-1.5 py-2 text-[10px] text-[var(--ink-40)] hover:text-[var(--ink-70)] transition-colors shrink-0"
        data-testid="stage-manager-home"
      >
        <Icon name={roomId ? 'arrow_back' : 'home'} size={13} />
        <span className="tracking-wide uppercase">{roomId ? 'Room' : 'Home'}</span>
      </button>

      <div className="w-full h-px bg-[color-mix(in_oklab,var(--edge-soft)_60%,transparent)] shrink-0" />

      {/* Scrollable desk cards — wheel events stop here so canvas doesn't scroll.
          Fades to 0.4 opacity while widget data is loading to smooth the flash. */}
      <motion.div
        animate={{ opacity: transitioning ? 0.4 : 1 }}
        transition={{ duration: 0.1 }}
        data-stage-manager="true"
        className="flex-1 overflow-y-auto overflow-x-hidden py-2 px-2 flex flex-col gap-2 min-h-[80px]"
        onWheel={(e) => e.stopPropagation()}
        style={{ scrollbarWidth: 'none' }}
      >
        <AnimatePresence initial={false}>
          {desks.map((desk) => {
            const isActive = desk.id === activeId
            const ws = widgetsByDesk[desk.id] ?? []
            const isEmpty = ws.filter(w => !w.archived && !w.pinned && w.parentSectionId === null).length === 0

            return (
              <motion.div
                key={desk.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.12, ease: 'easeOut' }}
              >
                <motion.button
                  onClick={() => openDesk(desk)}
                  onContextMenu={(e) => {
                    // L1/S6: the shared lifecycle menu, on right-click.
                    e.preventDefault()
                    setCtxMenu({ x: e.clientX, y: e.clientY, desk })
                  }}
                  title={desk.title || 'Untitled desk'}
                  data-testid={`stage-desk-${desk.id}`}
                  initial={false}
                  animate={{
                    scale: isActive ? 1 : 0.96,
                  }}
                  whileHover={{
                    scale: 1.03,
                    transition: { ...SPRING, stiffness: 220 }
                  }}
                  whileTap={{ scale: 0.97 }}
                  transition={SPRING}
                  style={{}}
                  className={[
                    'relative w-full rounded-xl overflow-hidden text-left shrink-0 block',
                    isActive
                      ? 'cursor-default'
                      : 'cursor-pointer'
                  ].join(' ')}
                >
                  {/* Card glow on hover via CSS — motion handles scale/tilt */}
                  <div
                    className={[
                      'absolute inset-0 rounded-xl transition-opacity duration-200 pointer-events-none z-10',
                      isActive
                        ? 'ring-2 ring-[rgb(var(--accent))] ring-inset opacity-100'
                        : 'ring-1 ring-black/10 dark:ring-white/10 opacity-100'
                    ].join(' ')}
                  />

                  {/* Thumbnail */}
                  <div className="h-[68px] bg-[var(--surface-sunken)] flex items-center justify-center overflow-hidden relative">
                    {!isEmpty ? (
                      <DeskMiniature widgets={ws} width={148} height={68} />
                    ) : (
                      <div className="flex flex-col items-center gap-2">
                        <PlexiMark size={32} />
                        <span className="text-[9px] uppercase tracking-[0.14em] text-[var(--ink-30)] font-medium">
                          Empty desk
                        </span>
                      </div>
                    )}
                    {/* Active indicator — subtle accent overlay at top */}
                    {isActive && (
                      <div className="absolute top-0 inset-x-0 h-[2px] bg-[rgb(var(--accent))]" />
                    )}
                  </div>

                  {/* Caption */}
                  <div className="px-2 py-1.5 bg-[var(--surface-raised)] flex items-center gap-1.5">
                    <Icon
                      name="grid_view"
                      size={10}
                      filled={isActive}
                      className={isActive ? 'text-[rgb(var(--accent))] shrink-0' : 'text-[var(--ink-30)] shrink-0'}
                    />
                    <span className={[
                      'text-[11px] truncate leading-tight flex-1',
                      isActive ? 'font-semibold text-[var(--ink-100)]' : 'text-[var(--ink-70)]'
                    ].join(' ')}>
                      {desk.title || 'Untitled'}
                    </span>
                  </div>
                </motion.button>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </motion.div>

      {/* New desk / New room — card-style button pinned at bottom */}
      <div className="shrink-0 px-2 pb-2 pt-1">
        <button
          onClick={() => void (showAsRoom ? handleAddRoom() : handleAddDesk())}
          className="w-full rounded-xl h-9 flex items-center justify-center gap-1.5 text-[rgb(var(--accent))] bg-[var(--surface-sunken)] hover:bg-[var(--surface-raised)] transition-colors"
          style={{ border: '1.5px dashed rgb(var(--accent) / 0.4)' }}
        >
          <Icon name="add" size={12} />
          <span className="text-[11px] font-medium">
            {showAsRoom ? 'New room' : 'New desk'}
          </span>
        </button>
      </div>
      {ctxMenu && (
        <CanvasContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={deskLifecycleMenuItems(ctxMenu.desk)}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  )
}
