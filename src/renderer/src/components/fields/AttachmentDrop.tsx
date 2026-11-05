import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  appendAttachmentIds,
  attachDropNotice,
  dragMayCarryAttachment,
  extractAttachmentDrop,
  ingestAttachmentDrop,
  pickDropEffect,
  type AttachDeps
} from '../../lib/attachmentDrop'
import { useNoticeStore } from '../../stores/notice'

// The React side of dropping a picture onto an attachment field
// (lib/attachmentDrop has the reading and storing).
//
// Two ways in:
//   - the attachment editor itself (FieldEditor's Attachment) is a drop zone
//     wherever it renders on its own: a Field work widget, a form, a Kanban
//     card;
//   - a surrounding element can own the drop instead, so the whole TABLE CELL
//     (or a List or Cards view's field block) takes it, not just the chips
//     inside: wrap it in <AttachmentDropZone>. The editor inside sees the zone
//     through context, binds nothing of its own and shows the zone's progress.
//
// Every drop the zone takes is claimed outright: preventDefault on dragover
// (so the Workcentre clears its drop well and the desk does not offer to place
// it) and preventDefault + stopPropagation on drop, so neither the canvas's
// handleDrop nor the Workcentre's makes a second object from the same drop.

/**
 * The highlight while a drag is held over a zone: the app's drop look (File and
 * Gallery work widgets: a 2px accent line inside the edge, an accent tint).
 * Drawn as an OUTLINE, not their inset ring: an inset box-shadow paints beneath
 * the zone's children, so attachment chips sitting flush against the edge hid
 * most of it (a Kanban card's field showed only a sliver). An outline paints
 * above them.
 */
export const ATTACHMENT_DROP_OVER_CLASS = 'outline outline-2 -outline-offset-2 outline-accent bg-accent/10'

export interface AttachmentDropBinding {
  /** A drag that may carry something to attach is held over the zone. */
  over: boolean
  /** Drops still being stored. */
  busy: boolean
  /** Spread onto the zone's element. Empty when the zone is disabled. */
  handlers: {
    onDragEnter?: (e: React.DragEvent<HTMLElement>) => void
    onDragOver?: (e: React.DragEvent<HTMLElement>) => void
    onDragLeave?: (e: React.DragEvent<HTMLElement>) => void
    onDrop?: (e: React.DragEvent<HTMLElement>) => void
  }
}

export interface AttachmentDropOptions {
  /** The field's value NOW (read when the drop finishes storing, not when it began). */
  current: () => unknown
  /** Persist the field's next value. */
  commit: (next: string[]) => void
  /** Bind nothing (a surrounding zone owns the drop). */
  disabled?: boolean
}

function attachDeps(): AttachDeps {
  const files = window.api.files
  return {
    ingestBuffer: (input) => files.ingestBuffer(input),
    ingestUrl: typeof files.ingestUrl === 'function' ? (url) => files.ingestUrl(url, null) : undefined
  }
}

export function useAttachmentDrop(opts: AttachmentDropOptions): AttachmentDropBinding {
  const [over, setOver] = useState(false)
  const [pending, setPending] = useState(0)
  // The latest current/commit, so a slow fetch appends to what the field holds
  // when it lands (another drop may have landed meanwhile), not to a snapshot.
  const optsRef = useRef(opts)
  optsRef.current = opts

  // A drag cancelled with Esc or released elsewhere ends the highlight too.
  useEffect(() => {
    if (!over) return
    const end = (): void => setOver(false)
    window.addEventListener('dragend', end, true)
    window.addEventListener('drop', end, true)
    return () => {
      window.removeEventListener('dragend', end, true)
      window.removeEventListener('drop', end, true)
    }
  }, [over])

  if (opts.disabled) return { over: false, busy: pending > 0, handlers: {} }

  const accept = (e: React.DragEvent<HTMLElement>): boolean => {
    if (!dragMayCarryAttachment(e.dataTransfer?.types)) return false
    // Claim it, but let it bubble: the views around read defaultPrevented and
    // stand down (the Workcentre takes its drop well away).
    e.preventDefault()
    try {
      e.dataTransfer.dropEffect = pickDropEffect(e.dataTransfer.effectAllowed)
    } catch {
      /* read-only in some synthetic events */
    }
    return true
  }

  return {
    over,
    busy: pending > 0,
    handlers: {
      onDragEnter: (e) => {
        if (accept(e)) setOver(true)
      },
      onDragOver: (e) => {
        if (accept(e) && !over) setOver(true)
      },
      onDragLeave: (e) => {
        // Moving onto a child is not leaving.
        const to = e.relatedTarget as Node | null
        if (to && e.currentTarget.contains(to)) return
        setOver(false)
      },
      onDrop: (e) => {
        if (!dragMayCarryAttachment(e.dataTransfer?.types)) return
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        // Read now: a DataTransfer answers only during its event.
        const payload = extractAttachmentDrop(e.dataTransfer)
        const early = attachDropNotice(payload, null)
        if (payload.files.length === 0 && payload.urls.length === 0) {
          if (early) useNoticeStore.getState().show({ text: early, icon: 'info' })
          return
        }
        setPending((n) => n + 1)
        void (async () => {
          try {
            const outcome = await ingestAttachmentDrop(payload, attachDeps())
            if (outcome.ids.length > 0) {
              const { current, commit } = optsRef.current
              commit(appendAttachmentIds(current(), outcome.ids))
            }
            const text = attachDropNotice(payload, outcome)
            if (text) useNoticeStore.getState().show({ text, icon: outcome.ids.length > 0 ? 'info' : 'error_outline' })
          } finally {
            setPending((n) => Math.max(0, n - 1))
          }
        })()
      }
    }
  }
}

interface ScopeValue {
  /** A surrounding zone takes the drop; the editor binds none of its own. */
  owned: boolean
  busy: boolean
  over: boolean
}
const AttachmentDropScope = createContext<ScopeValue>({ owned: false, busy: false, over: false })

/** For the attachment editor: is it inside a zone that owns the drop (and what is that zone doing)? */
export function useAttachmentDropScope(): ScopeValue {
  return useContext(AttachmentDropScope)
}

/**
 * Make a surrounding element (a table cell, a field block) the drop zone for
 * the attachment editor inside it. Render-prop, so the caller keeps its own
 * element (a <td> stays a <td>) and spreads `drop.handlers` onto it.
 */
export function AttachmentDropZone({
  current,
  commit,
  children
}: {
  current: () => unknown
  commit: (next: string[]) => void
  children: (drop: AttachmentDropBinding) => ReactNode
}): JSX.Element {
  const drop = useAttachmentDrop({ current, commit })
  return (
    <AttachmentDropScope.Provider value={{ owned: true, busy: drop.busy, over: drop.over }}>
      {children(drop)}
    </AttachmentDropScope.Provider>
  )
}
