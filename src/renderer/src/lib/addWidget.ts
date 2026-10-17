// Adding a widget, from anywhere outside the canvas — the side menu's Widgets
// section, the collapsed rail, the command palette. One module so all of them
// make the same thing the same way (docs/widget-files.md):
//
//   click a kind            a standalone widget FILE, opened full-pane
//                           (desk-only kinds go onto the open desk instead)
//   "Add to this desk"      a new widget file AND a linked instance on the desk
//   drag onto a desk        the same, at the drop point (Canvas handleDrop)

import type { WidgetKind } from '@shared/types'
import { isStandaloneWidgetKind } from '@shared/widgetFiles'
import { catalogFor } from './widgetCatalog'
import { canCreateWidget } from './gating'
import { clickActionFor } from './widgetMenu'
import { requestCanvasAddKind } from './canvasCommands'
import { spawnPositionFor } from './spawnPosition'
import { useCapabilityStore } from '../stores/capabilities'
import { promptUpgrade } from '../stores/upgradePrompt'
import { useNodeStore } from '../stores/nodes'
import { useViewStore } from '../stores/view'
import { useNoticeStore } from '../stores/notice'
import { useWidgetFilesStore } from '../stores/widgetFiles'

/** The desk on screen right now, or null. */
export function openDeskId(): string | null {
  const view = useViewStore.getState().view
  if (view.kind !== 'task') return null
  return useNodeStore.getState().activeTaskId ?? view.taskId ?? null
}

/** False (after prompting to upgrade) when this plan cannot add `kind`. */
export function ensureCanAdd(kind: WidgetKind): boolean {
  if (canCreateWidget(useCapabilityStore.getState().capabilities, kind)) return true
  const label = catalogFor(kind)?.label ?? kind
  promptUpgrade(`The ${label} widget is a Pro feature.`)
  return false
}

/** The click on a kind in the Widgets section (or its rail icon). */
export async function openOrCreateFromMenu(kind: WidgetKind): Promise<void> {
  if (!ensureCanAdd(kind)) return
  const desk = openDeskId()
  const action = clickActionFor(kind, !!desk)
  if (action === 'create-file') {
    await useWidgetFilesStore.getState().create(kind)
    return
  }
  if (action === 'add-to-desk') {
    requestCanvasAddKind(kind)
    return
  }
  const label = catalogFor(kind)?.label ?? kind
  useNoticeStore.getState().show({
    text: `${label} only works on a desk — open a desk, then add it from here.`,
    icon: 'desk'
  })
}

/**
 * Put a NEW widget of `kind` on the open desk. A kind that can be a file
 * becomes one, placed as a linked instance beside the last-touched widget; a
 * desk-only kind goes through the canvas's own add path. Returns false when
 * there is no desk open.
 */
export async function addKindToOpenDesk(kind: WidgetKind): Promise<boolean> {
  const desk = openDeskId()
  if (!desk) return false
  if (!ensureCanAdd(kind)) return true
  if (!isStandaloneWidgetKind(kind)) {
    requestCanvasAddKind(kind)
    return true
  }
  const entry = catalogFor(kind)
  const pos = spawnPositionFor(entry?.defaultWidth ?? 320, entry?.defaultHeight ?? 240)
  // The store fits the size to the view (the one central cap for new widgets).
  await useWidgetFilesStore.getState().createAndPlace(kind, desk, {
    x: Math.round(pos.x),
    y: Math.round(pos.y)
  })
  return true
}
