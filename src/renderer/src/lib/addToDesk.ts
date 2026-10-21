// "Add … to desk" from the right-click menu on a web page (the standalone
// browser and the browser work widget; main/webContextMenu.ts builds the menu).
//
// What the click was on decides the work widget it becomes:
//   selected text → a sticky when it is short, a note (with where it came
//                   from) when it is longer;
//   an image      → an image work widget;
//   a video       → a video work widget when the video has an address, else
//                   the page that plays it as a browser work widget (a
//                   streamed video cannot be fetched again);
//   a link / page → a browser work widget on that address.
//
// One undoable action: undo takes the work widget away again, and the desk
// too when "New desk…" made it. The toast says where it went and offers to
// open that desk.

import type { Widget, WidgetKind } from '@shared/types'
import type { WebMenuCommand } from '@shared/webMenu'
import { widgetFileIdFromGroup } from '@shared/widgetFiles'
import { catalogFor } from './widgetCatalog'
import { recordActionWithToast } from '../stores/actionHistory'
import { useNodeStore } from '../stores/nodes'
import { useViewStore } from '../stores/view'
import { useWidgetStore } from '../stores/widgets'
import { useNoticeStore } from '../stores/notice'

export type AddToDeskCommand = Extract<WebMenuCommand, { command: 'add-to-desk' }>

/** Selected text up to this long becomes a sticky; longer becomes a note. */
export const STICKY_MAX_CHARS = 280

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url.slice(0, 60)
  }
}

export interface DeskWidgetDraft {
  kind: WidgetKind
  title: string
  content: string
  /** What the toast calls it: "selection", "image"… */
  noun: string
}

/** The work widget a command becomes. Pure; null when there is nothing to add. Exported for tests. */
export function widgetDraftFor(cmd: AddToDeskCommand): DeskWidgetDraft | null {
  const pageTitle = cmd.pageTitle.trim() || hostOf(cmd.pageUrl)
  switch (cmd.target) {
    case 'selection': {
      const text = (cmd.text ?? '').trim()
      if (!text) return null
      if (text.length <= STICKY_MAX_CHARS && !text.includes('\n\n')) return { kind: 'sticky', title: '', content: text, noun: 'selection' }
      // A note keeps where its words came from, as a link a person can follow.
      const source = /^https?:\/\//i.test(cmd.pageUrl) ? `\n\nFrom [${pageTitle.replace(/[[\]]/g, '')}](${cmd.pageUrl})` : ''
      return { kind: 'note', title: pageTitle, content: text + source, noun: 'selection' }
    }
    case 'image':
      return cmd.url ? { kind: 'image', title: hostOf(cmd.url), content: cmd.url, noun: 'image' } : null
    case 'video':
      if (cmd.url) return { kind: 'video', title: hostOf(cmd.url), content: cmd.url, noun: 'video' }
      return /^https?:\/\//i.test(cmd.pageUrl) ? { kind: 'webview', title: pageTitle, content: cmd.pageUrl, noun: 'video' } : null
    case 'link':
      return cmd.url ? { kind: 'webview', title: hostOf(cmd.url), content: cmd.url, noun: 'link' } : null
    case 'page':
      return cmd.url ? { kind: 'webview', title: pageTitle, content: cmd.url, noun: 'page' } : null
  }
}

/** A clear spot on a desk that is not on screen: to the right of what is there. Pure; exported for tests. */
export function placeBesideExisting(existing: Array<Pick<Widget, 'x' | 'y' | 'width' | 'height'>>, gap = 40): { x: number; y: number } {
  if (existing.length === 0) return { x: 80, y: 80 }
  const right = Math.max(...existing.map((w) => w.x + w.width))
  const top = Math.min(...existing.map((w) => w.y))
  return { x: Math.round(right + gap), y: Math.round(top) }
}

/** Desks the picker offers: open desks, most recently changed first (the menu's order). */
export function desksForPicker(): Array<{ id: string; title: string }> {
  return useNodeStore
    .getState()
    .nodes.filter((n) => n.kind === 'task' && !n.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((n) => ({ id: n.id, title: n.title }))
}

/**
 * Put what was clicked on a desk: an existing one (`deskId`) or a new one
 * (`newDeskTitle`). Returns the desk id, or null when nothing was added (the
 * person is told why).
 */
export async function addToDesk(cmd: AddToDeskCommand, where: { deskId: string } | { newDeskTitle: string }): Promise<string | null> {
  const draft = widgetDraftFor(cmd)
  if (!draft) {
    useNoticeStore.getState().show({ text: 'There was nothing there to add to a desk.', icon: 'info' })
    return null
  }
  const entry = catalogFor(draft.kind)
  const width = Math.min(entry?.defaultWidth ?? 480, 720)
  const height = Math.min(entry?.defaultHeight ?? 360, 520)
  let createdDesk: { id: string; title: string } | null = null
  let deskId: string
  let deskTitle: string
  try {
    if ('newDeskTitle' in where) {
      const title = where.newDeskTitle.trim() || 'New desk'
      const node = await window.api.nodes.create({ parentId: null, kind: 'task', title })
      createdDesk = { id: node.id, title: node.title }
      deskId = node.id
      deskTitle = node.title
    } else {
      deskId = where.deskId
      deskTitle = useNodeStore.getState().nodes.find((n) => n.id === deskId)?.title || 'Untitled desk'
    }
    const existing = createdDesk ? [] : await window.api.widgets.listByTask(deskId).catch(() => [] as Widget[])
    const widget = await window.api.widgets.create({
      taskId: deskId,
      kind: draft.kind,
      title: draft.title,
      content: draft.content,
      ...placeBesideExisting(existing),
      width,
      height
    })
    const fileId = widgetFileIdFromGroup(widget.syncGroupId)
    const refreshDesk = async (): Promise<void> => {
      await useNodeStore.getState().refresh()
      const v = useViewStore.getState().view
      if (v.kind === 'task' && v.taskId === deskId) await useWidgetStore.getState().loadForTask(deskId, { refresh: true })
    }
    await refreshDesk()
    const where_ = createdDesk ? `a new desk, ${deskTitle}` : deskTitle
    let trashedDesk: string[] = []
    recordActionWithToast({
      label: `Add ${draft.noun} to ${deskTitle}`,
      toast: `Added ${draft.noun} to ${where_}`,
      toastIcon: 'desk',
      toastAction: {
        label: 'Open desk',
        run: () => {
          useNodeStore.getState().setActive(deskId)
          useViewStore.getState().goTask(deskId)
        }
      },
      undo: async () => {
        if (createdDesk) trashedDesk = await window.api.nodes.delete(createdDesk.id) // takes its work widget with it
        else if (fileId) await window.api.widgetFiles.trash(fileId)
        else await window.api.widgets.delete(widget.id)
        await refreshDesk()
      },
      redo: async () => {
        if (createdDesk) await window.api.nodes.restore(trashedDesk)
        else if (fileId) await window.api.documents.restore(fileId)
        else await window.api.widgets.restore(widget.id)
        await refreshDesk()
      }
    })
    return deskId
  } catch (e) {
    useNoticeStore.getState().show({ text: `Could not add that to the desk: ${(e as Error).message}`, icon: 'warning' })
    return null
  }
}
