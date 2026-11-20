import { useEffect, useRef, useState } from 'react'
import type { WidgetKind } from '@shared/types'
import { useAccountStore } from '../stores/account'
import { useNodeStore } from '../stores/nodes'
import { useViewStore } from '../stores/view'
import { useNoticeStore } from '../stores/notice'
import { useWidgetStore } from '../stores/widgets'
import { useWidgetFilesStore } from '../stores/widgetFiles'
import { useDocumentsStore } from '../stores/documents'
import { catalogFor } from '../lib/widgetCatalog'
import { spawnPositionFor } from '../lib/spawnPosition'
import { bringInOpenedFiles, type OpenFilesDeps } from '../lib/openPlexiiFiles'

// Double-click a .plexii-* file in Finder or Explorer and Plexii opens it (F3,
// 2026-11-20): the window's end of main/plexiiFileOpen.ts.
//
// Main reads each file the OS hands over and keeps it. Once someone is signed in
// (the copy goes into that person's Files, as for a room from PlexiiLite in
// LiteRoomEffects), this takes every file waiting and brings each in
// (lib/openPlexiiFiles.ts): onto the desk on screen, or opened when no desk is.
// Files that arrive while it is busy are taken straight after.
//
// Mounted once in App. Renders nothing. Not in the browser runtime, which has no
// Finder or Explorer to hand it a file.
const isWebRuntime = (): boolean => Boolean((globalThis as { __PLEXII_WEB__?: boolean }).__PLEXII_WEB__)

/** The desk on screen, as the side menu reads it (WidgetsSection useDeskOpen). */
function deskOnScreen(): string | null {
  const view = useViewStore.getState().view
  if (view.kind !== 'task') return null
  return useNodeStore.getState().activeTaskId ?? view.taskId ?? null
}

const liveDeps: OpenFilesDeps = {
  importText: (text) => window.api.widgetFiles.import({ text }),
  deskOnScreen,
  // A linked instance of the new file, where a new widget goes on this desk.
  placeWidgetFile: async (fileId, deskId) => {
    const file = await useWidgetFilesStore.getState().load(fileId)
    if (!file) return null
    const entry = catalogFor(file.kind)
    const at = spawnPositionFor(entry?.defaultWidth ?? 320, entry?.defaultHeight ?? 240, file.kind)
    return useWidgetFilesStore.getState().place(fileId, deskId, at)
  },
  // The document's Office widget, pointing AT the new document (as a drop from Files makes one).
  placeDocument: async (doc, deskId) => {
    const kind = doc.docType as WidgetKind
    const entry = catalogFor(kind)
    const width = entry?.defaultWidth ?? 520
    const height = entry?.defaultHeight ?? 400
    const at = spawnPositionFor(width, height, kind)
    return useWidgetStore.getState().create({ taskId: deskId, kind, title: doc.title, content: doc.id, x: at.x, y: at.y, width, height })
  },
  open: (id) => useViewStore.getState().goDocument(id),
  notify: ({ text, icon }) => useNoticeStore.getState().show({ text, icon }, icon === 'check_circle' ? 8000 : 12000)
}

export default function PlexiiFileOpenEffects(): null {
  const accountId = useAccountStore((s) => s.account?.id ?? null)
  const [nudge, setNudge] = useState(0)
  const busy = useRef(false)
  const again = useRef(false)

  useEffect(() => {
    const api = window.api?.plexiiFiles
    if (isWebRuntime() || !api) return
    return api.onOpened(() => setNudge((n) => n + 1))
  }, [])

  useEffect(() => {
    const api = window.api?.plexiiFiles
    if (isWebRuntime() || !api || !accountId) return
    if (busy.current) {
      again.current = true
      return
    }
    busy.current = true
    void (async () => {
      try {
        for (;;) {
          const items = await api.takeOpened()
          if (!items.length) break
          await bringInOpenedFiles(items, liveDeps)
          // Files lists documents from this store.
          void useDocumentsStore.getState().refresh()
        }
      } catch (err) {
        useNoticeStore.getState().show({ text: `A file could not be opened: ${(err as Error).message}.`, icon: 'error' }, 12000)
      } finally {
        busy.current = false
        if (again.current) {
          again.current = false
          setNudge((n) => n + 1)
        }
      }
    })()
  }, [accountId, nudge])

  return null
}
