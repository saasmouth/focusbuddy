// Moving between AI Space places. A project lives on a Desk (SPEC-AI-SPACE §
// Product decision), so "open a project" = open its Desk in the AI view mode.

import type { AiProject } from '@shared/aispace/model'
import { useDeskViewStore } from '../stores/deskView'
import { useViewStore } from '../stores/view'
import { useNodeStore } from '../stores/nodes'

export type DeskTab = 'overview' | 'tasks' | 'outputs' | 'impact'

// Which Desk tab and inspector item to show when a Desk opens in AI mode: a
// deep link from Home or Impact lands exactly on the affected work.
interface PendingFocus {
  deskId: string
  tab: DeskTab
  item?: { type: 'output' | 'task' | 'run' | 'decision' | 'thread' | 'source'; id: string; versionId?: string | null } | null
  changeId?: string | null
}

let pending: PendingFocus | null = null

export function takePendingFocus(deskId: string): PendingFocus | null {
  if (!pending || pending.deskId !== deskId) return null
  const p = pending
  pending = null
  return p
}

export function openProject(project: Pick<AiProject, 'deskId'>, focus?: Omit<PendingFocus, 'deskId'>): boolean {
  if (!project.deskId) return false
  useDeskViewStore.getState().set(project.deskId, 'ai')
  pending = focus ? { ...focus, deskId: project.deskId } : null
  window.dispatchEvent(new CustomEvent('aispace:focus', { detail: pending }))
  useViewStore.getState().goTask(project.deskId)
  return true
}

export async function startProjectOnNewDesk(input: { title: string; goal: string; brief: string; workspaceId: string; roomId?: string | null }): Promise<AiProject> {
  const title = input.title.trim() || 'New AI project'
  const desk = await window.api.nodes.create({ parentId: input.roomId ?? null, kind: 'task', title })
  const project = await window.api.aiSpace.createProject({ workspaceId: input.workspaceId, title, goal: input.goal, brief: input.brief, deskId: desk.id, roomId: input.roomId ?? null })
  await useNodeStore.getState().refresh()
  return project
}
