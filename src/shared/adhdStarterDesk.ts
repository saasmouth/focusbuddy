// The ADHD Starter Desk — the canvas a brand-new install lands on instead of
// an empty desk. Three blocks, all self-contained (sticky notes + a timer),
// so the desk is useful the moment it appears. No titles of the person's own
// work, no account data, no remote content.
//
// "Brain calm in 30 seconds" is the promise the desk is built around:
// today's top 3, a brain dump, and one focus block.

import type { WidgetDraft } from './types'

export const ADHD_STARTER_DESK_TITLE = 'ADHD Starter Desk'

export const ADHD_STARTER_DESK_DESCRIPTION =
  'Brain calm in 30 seconds. Today\u2019s top 3, a quick brain dump, and one focus block. Change or delete anything.'

const POMODORO = JSON.stringify({ targetSec: 1500, elapsedSec: 0, state: 'idle', startedAt: null })

const TOP_3 = [
  'Brain calm in 30 seconds.',
  '',
  '[ ] The one thing that makes today a win',
  '[ ] A 10-minute task I can finish',
  '[ ] One thing I have been avoiding'
].join('\n')

const BRAIN_DUMP = [
  'Get it out of your head. One line each.',
  'Nothing here is a commitment yet.',
  '',
  '\u2022 '
].join('\n')

const FOCUS_BLOCK = [
  '[ ] Pick the top priority',
  '[ ] Start the 25-minute timer',
  '[ ] Work only on that until it rings',
  '[ ] Write the next tiny step'
].join('\n')

export interface StarterWidgetSpec {
  kind: 'sticky' | 'timer'
  title: string
  content: string
  x: number
  y: number
  width: number
  height: number
  color: string | null
}

export const ADHD_STARTER_WIDGETS: readonly StarterWidgetSpec[] = [
  {
    kind: 'sticky',
    title: "Today's Top 3",
    content: TOP_3,
    x: 48,
    y: 48,
    width: 320,
    height: 280,
    color: '#fef08a'
  },
  {
    kind: 'sticky',
    title: 'Quick brain dump',
    content: BRAIN_DUMP,
    x: 400,
    y: 48,
    width: 320,
    height: 280,
    color: '#bfdbfe'
  },
  {
    kind: 'sticky',
    title: 'Focus block',
    content: FOCUS_BLOCK,
    x: 48,
    y: 360,
    width: 320,
    height: 260,
    color: '#bbf7d0'
  },
  {
    kind: 'timer',
    title: '25-minute focus',
    content: POMODORO,
    x: 400,
    y: 360,
    width: 240,
    height: 240,
    color: null
  }
]

export function starterWidgetDrafts(taskId: string): WidgetDraft[] {
  return ADHD_STARTER_WIDGETS.map((w) => ({
    taskId,
    kind: w.kind,
    title: w.title,
    content: w.content,
    x: w.x,
    y: w.y,
    width: w.width,
    height: w.height,
    color: w.color
  }))
}

export function isUntouchedStarterWorkspace(
  nodes: ReadonlyArray<{ id: string; kind: string; archived?: boolean }>,
  starterDeskId: string | null
): boolean {
  if (!starterDeskId) return false
  const live = nodes.filter((n) => !n.archived)
  return live.length === 1 && live[0].kind === 'task' && live[0].id === starterDeskId
}

export type StarterSyncState = 'disabled' | 'idle' | 'syncing' | 'ok' | 'offline' | 'error'

export type StarterDecision = 'provisioned' | 'skipped'

export type StarterAction = 'wait' | 'provision' | 'open' | 'skip'

/**
 * Whether this install should receive the starter desk.
 *
 * Existing work is never touched: an upgrade (not a first install), a
 * workspace that already has desks, or a decision already made (including
 * "they deleted the starter") all skip. A first install waits until sync has
 * settled, so a second computer does not grow a desk on top of work that is
 * still downloading. The test harness skips so empty-workspace specs stay empty.
 */
export function decideStarterProvision(input: {
  harness: boolean
  firstInstall: boolean
  decision: StarterDecision | null
  starterStillExists: boolean
  hasOtherWork: boolean
  /** True once a sync cycle has finished, or when sync will not run at all. */
  syncSettled: boolean
}): StarterAction {
  if (input.harness) return 'skip'
  if (input.decision === 'skipped') return 'skip'
  if (input.decision === 'provisioned') return input.starterStillExists ? 'open' : 'skip'
  if (!input.firstInstall) return 'skip'
  if (input.hasOtherWork) return 'skip'
  if (!input.syncSettled) return 'wait'
  return 'provision'
}
