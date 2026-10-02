import { useViewStore } from '../stores/view'
import { useNodeStore } from '../stores/nodes'
import { useWidgetStore } from '../stores/widgets'
import { useChatStore } from '../stores/chat'
import { useFileManagerStore } from '../stores/fileManager'
import { useMailModalStore } from '../stores/mailModal'
import { useWebPanel } from '../stores/webPanel'
import type { ResolvedTarget } from './sourcePeek'

// Taking the user TO a reference.
//
// Lifted out of ChatPanel so there is one router for references rather than one
// per surface. It had exactly one caller when it lived there; it now has two --
// a citation click, and the "Open where it lives" button inside the peek -- and
// a third would otherwise have been written by hand against the same ten kinds.
// Two places that must agree about where a reference lives is the drift shape
// this codebase keeps paying for.
export async function goToSourceTarget(target: ResolvedTarget): Promise<void> {
    const view = useViewStore.getState()
    const openDesk = (taskId: string): void => {
      useNodeStore.getState().setActive(taskId)
      view.goTask(taskId)
    }
    switch (target.kind) {
      case 'document':
        view.goDocument(target.documentId)
        break
      case 'knowledge':
        view.goKnowledge(target.entryId)
        break
      case 'email':
        // Open the message itself, in the shared reader, rather than dropping the
        // user at the inbox to search for it again. goMail first so the reader has
        // its surface; the store is what actually shows the message.
        view.goMail()
        useMailModalStore.getState().open(target.uid)
        break
      case 'url':
        // A web source opens in the in-app browser panel (A2, R4/R13): the
        // web never leaves Plexii. The panel's toolbar carries the explicit
        // system-browser escape.
        useWebPanel.getState().openWeb(target.url)
        break
      case 'desk':
        openDesk(target.taskId)
        break
      case 'widget': {
        // widgets.get is newer than the rest of this bridge, so an Electron
        // process still running an older preload won't have it. Say so rather
        // than throwing a TypeError into a click handler — a silent dead link is
        // exactly the kind of thing that costs an hour to track down.
        if (typeof window.api.widgets.get !== 'function') {
          console.warn(
            '[assistant] window.api.widgets.get is missing, so a cited widget cannot be ' +
              'resolved to its desk. Restart the Electron process (npm run dev) to pick up ' +
              'the current preload bundle.'
          )
          return
        }
        const widget = await window.api.widgets.get(target.widgetId)
        if (!widget?.taskId) return
        openDesk(widget.taskId)
        // Select it so the desk opens with the cited widget picked out rather
        // than leaving you to find it among everything else on the canvas.
        useWidgetStore.getState().setSelection([target.widgetId])
        break
      }
      case 'table': {
        const table = await window.api.tables.get(target.tableId)
        if (!table?.taskId) return
        openDesk(table.taskId)
        break
      }
      case 'file': {
        // Reveal the cited file in the Drive: its folder opens with the file
        // selected, mirroring what a search hit does.
        const entry =
          typeof window.api.fileManager?.get === 'function'
            ? await window.api.fileManager.get(target.fileId).catch(() => null)
            : null
        view.goFiles()
        const fm = useFileManagerStore.getState()
        await fm.openFolder(entry?.parentId ?? null)
        fm.select(target.fileId)
        break
      }
      case 'chat':
        // A cited past conversation opens as the panel's live conversation,
        // exactly like picking it from the history rail.
        await useChatStore.getState().openConversation(target.conversationId)
        break
      case 'meeting':
        // A cited meeting opens in PlexiMeet at that meeting — the same door
        // an Attention item's meeting chip uses (DEC-079's seam).
        view.goMeetings()
        window.dispatchEvent(
          new CustomEvent('fb:open-meeting', { detail: { id: target.meetingId } })
        )
        break
    }
}
