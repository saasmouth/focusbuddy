// What a shared desk's visitor just did, for the bridge to decide their calls by
// (readOnly.ts decideCall), and the gate those decisions open.
//
// Owner, 2026-11-07: the visitor may look around, arrange the desk, and drag
// apps, widgets, files and tools onto it. Anything else says "Download this
// desk on Plexii" and starts the download.
//
// A call alone cannot say which of those it is. widgets:create is a widget
// dragged from the palette -- or "Add to desk" picked from a menu; nodes:update
// is the visitor renaming a desk -- or the app writing on its own as the desk
// opens. So the bridge also asks two questions of the moment the call is made:
//
//   did the visitor act just now?  A click, a key, a drop in the last few
//       seconds. A call with no person behind it is the app keeping itself in
//       order (layout snapshots, trails, a widget saving its own state); it is
//       left alone, as it always was, and NEVER opens the gate -- a download
//       prompt nobody asked for is the worst thing this page could do.
//   was something just dropped?  A drop opens a short window in which adding
//       (a widget, a file, a document or table a tool makes) is the drop
//       finishing, not a menu being used.
//
// The visitor may also take back what they dropped: removing a widget they
// added in this browser is undoing their own drop, not editing the sender's desk.
import { SHARE_GATE_EVENT, type ShareGateDetail } from '@renderer/lib/shareGate'

/** How long after a click or a key a call still counts as the visitor's. */
export const USER_ACTED_MS = 4000
/**
 * How long after a drop adding still counts as that drop. Generous on purpose:
 * a dropped file is read, stored and then placed, and a large one takes time.
 */
export const ADD_WINDOW_MS = 20_000

export interface CallContext {
  /** The visitor clicked, typed or dropped within USER_ACTED_MS. */
  userActed: boolean
  /** Something was dropped within ADD_WINDOW_MS. */
  adding: boolean
  /** A widget the visitor added in this browser. */
  ownWidget: (id: string) => boolean
}

let lastAct = -Infinity
let lastDrop = -Infinity
const own = new Set<string>()
let installed = false

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/** Keys that are not the visitor doing anything (a modifier pressed alone). */
const NOT_AN_ACT = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn'])

/** Watch for the visitor acting. Capture phase, so nothing can hide it. */
export function installShareGestures(target: Window = window): void {
  if (installed) return
  installed = true
  // Reachable from the console for support: which doors this visit tried.
  ;(target as unknown as { plexiiShareGates?: typeof shareGateLog }).plexiiShareGates = shareGateLog
  const act = (): void => {
    lastAct = now()
  }
  target.addEventListener('pointerdown', act, true)
  target.addEventListener('keydown', (e) => {
    if (!NOT_AN_ACT.has((e as KeyboardEvent).key)) act()
  }, true)
  target.addEventListener('paste', act, true)
  target.addEventListener('drop', () => {
    act()
    lastDrop = now()
  }, true)
}

/** The moment a call is being made in. */
export function callContext(at: number = now()): CallContext {
  return {
    userActed: at - lastAct <= USER_ACTED_MS,
    adding: at - lastDrop <= ADD_WINDOW_MS,
    ownWidget: (id) => own.has(id)
  }
}

/** A widget the visitor added: theirs to take away again. */
export function noteOwnWidget(result: unknown): void {
  const id = result && typeof result === 'object' ? (result as { id?: unknown }).id : null
  if (typeof id === 'string' && id) own.add(id)
}

/** Every gate this page opened, newest last: for support, and for the tests. */
const gateLog: Array<{ what: string; channel: string | null; at: number }> = []

export function shareGateLog(): ReadonlyArray<{ what: string; channel: string | null; at: number }> {
  return gateLog
}

/** Open the gate: the share page shows "Download this desk on Plexii". */
export function openShareGate(what: string, channel: string | null = null): void {
  gateLog.push({ what, channel, at: Date.now() })
  if (gateLog.length > 50) gateLog.shift()
  try {
    window.dispatchEvent(new CustomEvent<ShareGateDetail>(SHARE_GATE_EVENT, { detail: { what } }))
  } catch {
    /* no window: nothing to show it in */
  }
}

/** Test seam. */
export function resetShareGestures(): void {
  lastAct = -Infinity
  lastDrop = -Infinity
  own.clear()
}

/** Test seam: pretend the visitor acted (or dropped) at `at`. */
export function noteActForTests(kind: 'act' | 'drop', at: number = now()): void {
  lastAct = at
  if (kind === 'drop') lastDrop = at
}
