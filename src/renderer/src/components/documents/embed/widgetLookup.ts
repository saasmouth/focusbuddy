// Widget resolution for document embeds. The preload surface has no
// widgets:get(id), only widgets:listByTask, so an embed resolves its widget by
// scanning the user's desks (task nodes). A module-level widgetId -> taskId
// cache keeps the steady state at one nodes:list + one listByTask per render
// instead of a full rescan; a widget moved between desks just falls back to
// the scan once and re-caches.

import type { FbNode, Widget } from '@shared/types'
import { isWidgetFilePaneId, widgetFileIdFromGroup, widgetFileGroupId, widgetFromFile } from '@shared/widgetFiles'

export interface ResolvedWidget {
  widget: Widget
  deskTitle: string
}

export interface DeskWidgets {
  desk: FbNode
  widgets: Widget[]
}

// Remembers which desk a widget was last found on. Never trusted blindly: the
// cached desk is re-fetched, and a miss falls through to the full scan.
const deskOfWidget = new Map<string, string>()

async function listDesks(): Promise<FbNode[]> {
  const nodes = await window.api.nodes.list()
  return nodes.filter((n) => n.kind === 'task' && !n.archived)
}

// Find a widget by id across every desk. Returns null when it genuinely does
// not exist any more (deleted, archived, or its desk is gone) so the caller
// can render an honest missing state rather than a fabricated one.
export async function resolveWidget(widgetId: string): Promise<ResolvedWidget | null> {
  // A WORK WIDGET FILE resolves directly, with no desk scan, because it has
  // no desk — docs/widget-files.md: "A work widget is a file... A desk is
  // only the place it lives." Its id is the `wf:<file id>` pane id, which is
  // also what the widget store routes writes through, so an embed built from
  // this is editable rather than a copy.
  //
  // Checked FIRST: a file id would never be found by the desk scan below, and
  // falling through would render "this work widget no longer exists" about a
  // file that is sitting in Files perfectly intact.
  if (isWidgetFilePaneId(widgetId)) {
    const fileId = widgetFileIdFromGroup(widgetId)
    if (!fileId) return null
    const file = await window.api.widgetFiles.get(fileId)
    return file ? { widget: widgetFromFile(file), deskTitle: '' } : null
  }

  const desks = await listDesks()
  const byId = new Map(desks.map((d) => [d.id, d]))

  const cachedDeskId = deskOfWidget.get(widgetId)
  if (cachedDeskId && byId.has(cachedDeskId)) {
    const widgets = await window.api.widgets.listByTask(cachedDeskId)
    const hit = widgets.find((w) => w.id === widgetId && !w.archived)
    if (hit) return { widget: hit, deskTitle: byId.get(cachedDeskId)?.title ?? '' }
    deskOfWidget.delete(widgetId)
  }

  for (const desk of desks) {
    if (desk.id === cachedDeskId) continue
    const widgets = await window.api.widgets.listByTask(desk.id)
    const hit = widgets.find((w) => w.id === widgetId && !w.archived)
    if (hit) {
      deskOfWidget.set(widgetId, desk.id)
      return { widget: hit, deskTitle: desk.title }
    }
  }
  return null
}

// Kinds that make no sense as a document embed: pure canvas chrome.
const NON_EMBEDDABLE = new Set<Widget['kind']>(['section', 'minimap'])

// Every desk with its embeddable widgets, for the picker. Desks with no
// embeddable widgets are kept so the picker can show them honestly as empty.
/**
 * Work widget FILES that are not on any desk, as a pseudo-desk the picker can
 * list beside the real ones.
 *
 * Without this the picker can only offer widgets that live on a desk, so the
 * standard kind since 4.3.32 — a work widget with no desk, sitting in Files —
 * was reachable by dragging it in and by no other route. A menu that cannot
 * see most of your widgets is worse than no menu, because it looks complete.
 *
 * The ids handed back are `wf:<file id>` pane ids, which is what an embed
 * needs and what makes the result editable in place.
 */
export async function listDesklessWidgetFiles(): Promise<Widget[]> {
  try {
    const files = await window.api.widgetFiles.list()
    const out: Widget[] = []
    for (const f of files) {
      if (NON_EMBEDDABLE.has(f.kind)) continue
      // Only the ones with no instance anywhere: a file that is already on a
      // desk is listed under that desk, and showing it twice would make one
      // object look like two.
      const instances = await window.api.widgetFiles.instances(f.id)
      if (instances.length) continue
      out.push({ ...widgetFromFile(f), id: widgetFileGroupId(f.id) })
    }
    return out
  } catch {
    return []
  }
}

export async function listDesksWithWidgets(): Promise<DeskWidgets[]> {
  const desks = await listDesks()
  const all = await Promise.all(
    desks.map(async (desk) => {
      const widgets = await window.api.widgets.listByTask(desk.id)
      return { desk, widgets: widgets.filter((w) => !w.archived && !NON_EMBEDDABLE.has(w.kind)) }
    })
  )
  return all
}
