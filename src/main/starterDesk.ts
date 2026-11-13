// Provision the ADHD Starter Desk once, for a brand-new install whose
// workspace is still empty after sync has had a chance to deliver existing
// work. Existing installs and any workspace that already has desks are left
// exactly as they are.

import { getDb } from './db/database'
import { createNode, deleteNode, getNode } from './db/nodes'
import { createWidget } from './db/widgets'
import { markStarterDesk, markStarterSkipped, readActivationState } from './db/activation'
import {
  ADHD_STARTER_DESK_DESCRIPTION,
  ADHD_STARTER_DESK_TITLE,
  decideStarterProvision,
  starterWidgetDrafts,
  type StarterAction
} from '@shared/adhdStarterDesk'

export interface StarterConsiderInput {
  syncSettled: boolean
}

export interface StarterConsiderResult {
  action: StarterAction
  deskId: string | null
}

let failedThisSession = false
let provisioning = false

function harness(): boolean {
  return Boolean(process.env.FB_TEST_USER_DATA)
}

export function starterDeskCurrent(): { deskId: string | null } {
  const id = readActivationState().starterDeskId
  if (!id) return { deskId: null }
  const node = getNode(id)
  return { deskId: node && !node.archived ? id : null }
}

export function considerAdhdStarterDesk(input: StarterConsiderInput): StarterConsiderResult {
  if (failedThisSession) return { action: 'skip', deskId: null }
  if (provisioning) return { action: 'wait', deskId: null }
  const state = readActivationState()
  const current = starterDeskCurrent()
  // Any desk or room, in any organisation. listNodes is scoped to the active
  // org, which would hide work that is still downloading into another org and
  // then treat that install as empty.
  const hasOtherWork = otherWorkExists(state.starterDeskId)
  const action = decideStarterProvision({
    harness: harness(),
    // Cohort is stamped at boot from the launch-version file. "new" is a
    // first install; an upgrade is "existing" and never receives a desk.
    firstInstall: state.cohort === 'new',
    decision: state.starterDecision,
    starterStillExists: current.deskId !== null,
    hasOtherWork,
    syncSettled: input.syncSettled === true
  })

  if (!harness() && action === 'skip' && state.cohort === 'new' && !state.starterDecision && hasOtherWork) {
    markStarterSkipped()
  }
  if (action !== 'provision') {
    return { action, deskId: action === 'open' ? current.deskId : null }
  }

  provisioning = true
  try {
    const created = provision()
    if (!created) {
      failedThisSession = true
      return { action: 'skip', deskId: null }
    }
    return { action: 'provision', deskId: created }
  } finally {
    provisioning = false
  }
}

function otherWorkExists(starterDeskId: string | null): boolean {
  try {
    const row = getDb()
      .prepare(
        `SELECT 1 AS n FROM nodes
         WHERE trashed_at IS NULL AND kind != 'work_item' AND id IS NOT ?
         LIMIT 1`
      )
      .get(starterDeskId ?? '') as { n: number } | undefined
    return !!row
  } catch {
    // If we cannot tell, do not invent a desk on top of a workspace we failed to read.
    return true
  }
}

function provision(): string | null {
  let id: string | null = null
  try {
    const node = createNode({
      parentId: null,
      kind: 'task',
      title: ADHD_STARTER_DESK_TITLE,
      description: ADHD_STARTER_DESK_DESCRIPTION
    })
    id = node.id
    for (const draft of starterWidgetDrafts(node.id)) createWidget(draft)
    markStarterDesk(node.id)
    return node.id
  } catch (err) {
    if (id) {
      try {
        deleteNode(id)
      } catch {
        /* the empty row is trashed when it can be; a retry next launch is safe */
      }
    }
    console.warn('[starter-desk] could not provision:', err instanceof Error ? err.message : err)
    return null
  }
}
