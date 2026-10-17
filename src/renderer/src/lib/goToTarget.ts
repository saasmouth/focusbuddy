// Resolve + navigate the "Go to" target of an approved action card.
//
// When an action is approved it stays in the chat as a green, done card with an
// optional "Go to" that jumps to whatever it produced or affected — the created
// task, the new/edited widget, the created document. We derive the target from
// the proposal plus the resolvedIds map the executor populated for creations
// (create-task/create-table/create-document set resolvedIds[proposal.id] = newId),
// WITHOUT changing the executor's return type. Navigation reuses the existing
// stores; nothing here is new plumbing.

import type { ActionProposal, GoToTarget } from '@shared/types'
import { useWidgetStore } from '../stores/widgets'
import { useNodeStore } from '../stores/nodes'
import { useDocumentsStore } from '../stores/documents'
import { useViewStore } from '../stores/view'

// Given a just-applied proposal + the batch resolvedIds map, what did it produce
// or affect that we can navigate to? Returns null for actions with no navigable
// result (draft email, focus-session, arrange, toggle, etc.).
export function resolveGoToTarget(
  p: ActionProposal,
  resolvedIds: Map<string, string> | undefined
): GoToTarget | null {
  switch (p.kind) {
    // Creations: the executor stashed the new entity id under the proposal id.
    case 'create-task': {
      const id = resolvedIds?.get(p.id)
      return id ? { kind: 'task', id, label: p.title } : null
    }
    case 'create-document':
    case 'create-widget-file': {
      // A widget file opens full-pane through the same document route.
      const id = resolvedIds?.get(p.id)
      return id ? { kind: 'document', id, label: p.title } : null
    }
    case 'update-widget-file': {
      const id = p.fileId.startsWith('$') ? resolvedIds?.get(p.fileId.slice(1)) : p.fileId
      return id ? { kind: 'document', id, label: p.label } : null
    }
    // Widget-producing creates — the executor stashed the new WIDGET id under the
    // proposal id, so "Go to" (and any host, e.g. MindMap's agent-outcome ref)
    // can resolve what was made.
    case 'create-widget':
    case 'create-page':
    case 'create-agent': {
      const id = resolvedIds?.get(p.id)
      return id ? { kind: 'widget', id, label: p.title ?? '' } : null
    }
    case 'create-section': {
      const id = resolvedIds?.get(p.id)
      return id ? { kind: 'widget', id, label: p.name } : null
    }
    case 'create-table': {
      // create-table stashes the backing TABLE id, but the user navigates to the
      // table WIDGET. We don't have the widget id here, so fall back to the most
      // recently created table widget on apply is unreliable — instead leave the
      // target null and rely on the success message. (Widget-producing creates
      // below cover the common "focus what I made" cases.)
      return null
    }
    // delete-widget removed the widget — there's nothing to navigate to.
    case 'delete-widget':
      return null
    // Actions that name an existing widget → jump to that widget.
    case 'update-widget':
    case 'focus-widget':
    case 'drill-in-widget':
      return { kind: 'widget', id: p.widgetId, label: p.label }
    case 'toggle-todo-item':
      // Same widget target, but this member labels it `widgetLabel`.
      return { kind: 'widget', id: p.widgetId, label: p.widgetLabel }
    // edit-document targets a document id (may be symbolic $ref in a batch).
    case 'edit-document': {
      const raw = p.documentId
      const id = raw.startsWith('$') ? resolvedIds?.get(raw.slice(1)) : raw
      return id ? { kind: 'document', id, label: p.label } : null
    }
    // update-task targets a task id (or the active task).
    case 'update-task': {
      const id = p.taskId
      return id ? { kind: 'task', id, label: p.label } : null
    }
    default:
      return null
  }
}

// Navigate to a resolved target. Best-effort: a stale target (the thing was
// since deleted) just no-ops rather than throwing.
export async function goToTarget(target: GoToTarget): Promise<void> {
  const widgets = useWidgetStore.getState()
  switch (target.kind) {
    case 'widget': {
      const exists = widgets.widgets.some((w) => w.id === target.id)
      if (!exists) return
      widgets.bringToFront(target.id)
      widgets.setActive(target.id)
      widgets.focusOn(target.id)
      return
    }
    case 'task': {
      const node = useNodeStore.getState().nodes.find((n) => n.id === target.id)
      if (!node) return
      // Make it the active task; the canvas + sidebar reflect the switch. We
      // don't force a view change — the user stays where they are, now scoped to
      // the task the action created.
      useNodeStore.getState().setActive(target.id)
      return
    }
    case 'document': {
      await useDocumentsStore.getState().open(target.id).catch(() => {})
      useViewStore.getState().goDocument(target.id)
      return
    }
  }
}
