// Resolver for opening a document. A personal document opens in the ordinary
// last-write-wins editor. An ORG-SHARED document instead opens in the CRDT
// co-editing editor, reusing the document's own id as the live-doc id, so two
// members editing at once merge their changes instead of clobbering each other
// (the org workspace sync stores the whole body and last-write-wins, which loses
// a concurrent editor's work — see docs/CROSS-MEMBER-SYNC-DESIGN.md).
//
// Routing every navigation to a document through here — not just the list click —
// means links, search hits and doc-ref cells all land in the correct mode, so a
// member can never accidentally open an org doc in the clobber-prone editor.

import { useEffect, useState } from 'react'
import DocumentEditorView from './DocumentEditorView'
import WidgetFileView from './WidgetFileView'
import LiveDocEditorView from './LiveDocEditorView'
import { useAccountStore } from '../../stores/account'
import { ensureOrgLiveDoc } from '../../lib/docCollabClient'
import { isOrgSharedScope } from '../../lib/docScope'

type Mode = 'loading' | 'live' | 'lww' | 'widget'

export default function DocumentOpen({ documentId }: { documentId: string }): JSX.Element | null {
  const [mode, setMode] = useState<Mode>('loading')
  const token = useAccountStore((s) => s.sessionToken)

  useEffect(() => {
    let cancelled = false
    setMode('loading')
    ;(async () => {
      const doc = await window.api.documents.get(documentId)
      if (cancelled) return
      // A widget file opens as its widget, full-pane — every route to a
      // document (Files, search, mentions, links) lands here, so all of them
      // open it correctly. Org scope is irrelevant: its edits sync as rows.
      if (doc?.docType === 'widget') {
        setMode('widget')
        return
      }
      if (!doc || !isOrgSharedScope(doc.orgId) || !token) {
        setMode('lww')
        return
      }
      // Org-shared: ensure the CRDT room exists (idempotent) then open live. If the
      // room cannot be ensured (offline, not a member), fall back to the plain
      // editor so the document still opens rather than getting stuck.
      const meta = await ensureOrgLiveDoc(token, documentId, doc.orgId as string, {
        docType: doc.docType,
        title: doc.title,
        body: JSON.stringify(doc.body)
      })
      if (cancelled) return
      setMode(meta ? 'live' : 'lww')
    })()
    return () => {
      cancelled = true
    }
  }, [documentId, token])

  if (mode === 'loading') return null
  if (mode === 'widget') return <WidgetFileView fileId={documentId} />
  if (mode === 'live') return <LiveDocEditorView liveDocId={documentId} />
  return <DocumentEditorView documentId={documentId} />
}
