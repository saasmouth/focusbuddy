import { useCallback } from 'react'
import type { FbNode } from '@shared/types'
import { useWorkItemStore } from '../../stores/workItems'
import { useNodeStore } from '../../stores/nodes'
import { promptText } from '../plexi/PromptDialog'
import { isTerminalState, queueOf, PRIMARY_ACTION } from '../../lib/attentionQueues'
import { subtreeIds, deskOf } from '../../lib/attentionGrouping'

// DEC-051 — closing an item, with its accounting, as ONE code path.
//
// Two offers ride every closure, and they must ride it from EVERY surface —
// the Attention page's completion circle and status pill, the home widget,
// the desk widget. Forking the logic per surface is how a widget quietly
// stops asking about subtasks while the page still does.
//
//   DEC-047 D-3 — a SUGGESTION, never a write: closing the last active item on
//   a still-open desk offers "mark the desk done?" once, right then. Accepting
//   uses the same user-owned status write every desk surface uses (D-6: the
//   app never auto-writes desk status).
//
//   DEC-048 — completing a PARENT accounts for its subtasks: open descendants
//   surface as an offer (close them with it / leave them), never a silent
//   cascade — and each subtask closes with its OWN queue's verb.

export type CloseWorkItem = (item: FbNode, state: string) => Promise<void>

export function useCloseWorkItem(): CloseWorkItem {
  const items = useWorkItemStore((s) => s.items)
  const setState = useWorkItemStore((s) => s.setState)
  const nodes = useNodeStore((s) => s.nodes)
  const updateNode = useNodeStore((s) => s.update)

  return useCallback(
    async (i: FbNode, state: string): Promise<void> => {
      const openKids = [...subtreeIds(i.id, items)]
        .filter((id) => id !== i.id)
        .map((id) => items.find((x) => x.id === id))
        .filter(
          (x): x is FbNode => !!x && !isTerminalState(x.workItemState) && x.detachedFromId == null
        )
      const closedKids: string[] = []
      if (openKids.length > 0) {
        const pick = await promptText({
          title: 'Close its subtasks too?',
          label: `“${i.title || 'This item'}” still has ${openKids.length} open subtask${
            openKids.length === 1 ? '' : 's'
          }.`,
          choices: [
            { value: 'all', label: `Close all ${openKids.length} with it` },
            { value: 'one', label: 'Just this one — subtasks stay open' },
            { value: 'cancel', label: 'Cancel' }
          ]
        })
        if (pick === 'cancel' || pick == null) return
        if (pick === 'all') {
          for (const k of openKids) {
            const verb = PRIMARY_ACTION[queueOf(k)] ?? PRIMARY_ACTION.to_do
            await setState(k.id, verb.state)
            closedKids.push(k.id)
          }
        }
      }
      await setState(i.id, state)
      // DEC-144: the DESK, not the item's parent. A task's step has a task as
      // its parent; offering "mark the desk done" for that task was wrong.
      const deskId = deskOf(i, items, nodes)
      if (!deskId) return
      const desk = nodes.find((n) => n.id === deskId && n.kind === 'task')
      if (!desk || desk.status === 'done' || desk.status === 'parked') return
      const closedNow = new Set([i.id, ...closedKids])
      const remaining = items.filter(
        (x) =>
          !closedNow.has(x.id) &&
          deskOf(x, items, nodes) === deskId &&
          !isTerminalState(x.workItemState) &&
          x.detachedFromId == null
      )
      if (remaining.length > 0) return
      const pick = await promptText({
        title: 'Desk complete?',
        label: `Everything on “${desk.title || 'this desk'}” is closed.`,
        choices: [
          { value: 'done', label: 'Mark the desk done' },
          { value: 'no', label: 'Leave it as is' }
        ]
      })
      if (pick === 'done') await updateNode(desk.id, { status: 'done' })
    },
    [items, nodes, setState, updateNode]
  )
}
