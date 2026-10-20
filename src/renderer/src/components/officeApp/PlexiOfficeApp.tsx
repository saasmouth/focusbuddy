// PlexiOffice — the standalone app shell. A focused Word/Excel/PowerPoint-style
// experience that reuses the very same editors PlexiDesk embeds (via @office), the
// same documents store, and the same file-manager store (OfficeDrive), so the two
// apps stay in lockstep. It deliberately does NOT pull in the desk canvas or
// collaboration — documents reach it through the cloud-documents API (@office
// sync), and the Drive organises them via the shared fb_files file manager.
//
// This is the second product's renderer root. It builds as its own HTML entry
// (plexioffice.html); the main process loads it when the app is the PlexiOffice
// build. The @office / @runtime imports are the package boundaries that will
// become real packages — call sites here won't change when they do.

import { useEffect, useState } from 'react'
import {
  DocEditor,
  SheetEditor,
  SlidesEditor,
  MapEditor,
  setCloudDocsEnabled,
  type SheetBody,
  type SlidesBody,
  type MapBody
} from '@office'
import { useTheme, useAccountStore } from '@runtime'
import { useDocumentsStore } from '../../stores/documents'
import { useFileManagerStore } from '../../stores/fileManager'
import OfficeAccountBar from './OfficeAccountBar'
import OfficeDrive from './OfficeDrive'
import OfficeShareDialog, { type ShareTarget } from './OfficeShareDialog'
import OfficeCollaborations from './OfficeCollaborations'
import OfficeTeamsDialog from './OfficeTeamsDialog'
import LiveDocEditorView from '../views/LiveDocEditorView'
import { createLiveDoc } from '../../lib/docCollabClient'
import UpdaterBanner from '../UpdaterBanner'
import { PromptDialogHost } from '../plexi/PromptDialog'
import { DocHistoryPanelHost } from '../documents/DocHistoryPanel'
import ApiKeysSection from '../settings/ApiKeysSection'
import OfficeAsk from './OfficeAsk'
import OfficeRelated from './OfficeRelated'
import Icon from '../Icon'

export default function PlexiOfficeApp(): JSX.Element {
  // Applying the shared theme is the whole reason useTheme lives in @runtime —
  // PlexiOffice looks like PlexiDesk without copying the theme system.
  useTheme()
  const { active, refresh, saveBody, rename, close } = useDocumentsStore()
  const refreshDrive = useFileManagerStore((s) => s.refresh)
  const [renaming, setRenaming] = useState(false)
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null)
  const [liveDocId, setLiveDocId] = useState<string | null>(null)
  const [collabError, setCollabError] = useState<string | null>(null)
  const [collabNonce, setCollabNonce] = useState(0)
  const [teamsOpen, setTeamsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [askOpen, setAskOpen] = useState(false)

  // Turn the open document into a live (collaborative) document and open it in
  // the co-editing editor, where members type at once and their changes merge.
  // Reuses the same live-docs system as PlexiDesk.
  async function collaborate(): Promise<void> {
    if (!active) return
    const tok = useAccountStore.getState().sessionToken
    if (!tok) {
      setCollabError('Sign in (bottom of the sidebar) to collaborate.')
      return
    }
    setCollabError(null)
    const created = await createLiveDoc(tok, {
      docType: active.docType,
      title: active.title,
      body: JSON.stringify(active.body)
    }).catch(() => null)
    if (created) {
      setLiveDocId(created.id)
      setCollabNonce((n) => n + 1)
    } else {
      setCollabError('Could not start collaboration. Check your connection and sign-in.')
    }
  }
  // PlexiOffice is cloud-first: sign in once and your documents are the same as in
  // PlexiDesk. Enable sync and boot the account session on mount.
  const token = useAccountStore((s) => s.sessionToken)
  useEffect(() => {
    setCloudDocsEnabled(true)
    void useAccountStore.getState().init()
  }, [])
  // Refresh on mount and whenever the signed-in account changes — a fresh sign-in
  // pulls that account's documents from the cloud, and the Drive reflects them.
  useEffect(() => {
    void refresh()
    void refreshDrive()
  }, [refresh, refreshDrive, token])

  // Build-time version, injected by electron-vite from package.json (same global
  // the desk footer uses). Drives the footer version pill + manual update check.
  const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'

  return (
    <div className="h-screen w-screen flex flex-col bg-desk-50 dark:bg-stone-950 text-[var(--ink-100)]">
      <div className="flex-1 min-h-0 flex">
      {/* Sidebar — branding, new-document actions, the document list */}
      <aside className="w-64 shrink-0 flex flex-col border-r border-[var(--edge-soft)] bg-white/70 dark:bg-stone-900/60">
        <div className="px-4 py-3 flex items-center gap-2 border-b border-[var(--edge-soft)]">
          <Icon name="auto_awesome" size={16} className="text-accent" />
          <span className="font-semibold text-[14px]">PlexiOffice</span>
          <button
            onClick={() => setAskOpen(true)}
            data-testid="office-ask-btn"
            className="ml-auto inline-flex items-center gap-1 text-[12px] px-2 py-0.5 rounded-full border border-accent/40 text-accent hover:bg-accent/10"
            title="Ask your workspace — a grounded answer from your own documents"
          >
            <Icon name="auto_awesome" size={13} /> Ask
          </button>
          <button
            onClick={() => setTeamsOpen(true)}
            data-testid="office-teams-btn"
            className="icon-btn text-[var(--ink-40)] hover:text-accent"
            title="Teams"
          >
            <Icon name="groups" size={16} />
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            data-testid="office-settings-btn"
            className="icon-btn text-[var(--ink-40)] hover:text-accent"
            title="Settings — AI · API keys"
          >
            <Icon name="settings" size={16} />
          </button>
        </div>

        {/* Drive — folders + documents, reusing the shared file-manager store. */}
        <OfficeDrive onShareFolder={(folderId, name) => setShareTarget({ kind: 'docfolder', folderId, name })} />

        {/* Live collaborations you own or were invited to. */}
        <OfficeCollaborations
          refreshKey={collabNonce}
          activeId={liveDocId}
          onOpen={(id) => setLiveDocId(id)}
        />

        <OfficeAccountBar />
      </aside>

      {/* Editor pane */}
      <main className="flex-1 min-w-0 flex flex-col">
        {collabError && (
          <div className="shrink-0 px-4 py-1.5 text-[12px] bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-200 flex items-center gap-2">
            <Icon name="info" size={13} />
            <span>{collabError}</span>
            <button onClick={() => setCollabError(null)} className="ml-auto icon-btn" aria-label="Dismiss">
              <Icon name="close" size={12} />
            </button>
          </div>
        )}
        {liveDocId ? (
          <LiveDocEditorView liveDocId={liveDocId} onBack={() => setLiveDocId(null)} />
        ) : !active ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center text-[var(--ink-40)]">
            <Icon name="draft" size={40} className="mb-3 text-[var(--ink-30)]" />
            <div className="text-[14px]">Pick a document, or create a new one.</div>
            <div className="text-[12px] mt-1">Your documents sync with PlexiDesk.</div>
          </div>
        ) : (
          <>
            <header className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-[var(--edge-soft)]">
              <button onClick={() => close()} className="icon-btn" title="Back to list">
                <Icon name="arrow_back" size={16} />
              </button>
              {renaming ? (
                <input
                  autoFocus
                  defaultValue={active.title}
                  onBlur={(e) => {
                    void rename(e.target.value)
                    setRenaming(false)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                  className="text-[14px] font-semibold bg-transparent border-b border-accent"
                />
              ) : (
                <button
                  onClick={() => setRenaming(true)}
                  className="text-[14px] font-semibold hover:text-accent"
                  title="Rename"
                >
                  {active.title || 'Untitled'}
                </button>
              )}
              <span className="ml-auto">
                <OfficeRelated key={active.id} docId={active.id} />
              </span>
              <button
                onClick={() => void collaborate()}
                data-testid="office-collaborate-btn"
                className="fb-btn-surface inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] hover:border-accent hover:text-accent"
                title="Collaborate live on this document"
              >
                <Icon name="group" size={14} />
                Collaborate
              </button>
              <button
                onClick={() => setShareTarget({ kind: 'document', doc: active })}
                data-testid="office-share-btn"
                className="fb-btn-surface inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] hover:border-accent hover:text-accent"
                title="Share this document"
              >
                <Icon name="share" size={14} />
                Share
              </button>
            </header>
            <div className="flex-1 min-h-0">
              {active.docType === 'doc' ? (
                <DocEditor key={active.id} content={active.body} title={active.title} onChange={(b) => saveBody(b)} />
              ) : active.docType === 'sheet' ? (
                <SheetEditor
                  key={active.id}
                  body={active.body as SheetBody}
                  title={active.title}
                  onChange={(b) => saveBody(b)}
                />
              ) : active.docType === 'slides' ? (
                <SlidesEditor
                  key={active.id}
                  body={active.body as SlidesBody}
                  title={active.title}
                  onChange={(b) => saveBody(b)}
                />
              ) : (
                <MapEditor
                  key={active.id}
                  body={active.body as MapBody}
                  title={active.title}
                  onChange={(b) => saveBody(b)}
                />
              )}
            </div>
          </>
        )}
      </main>
      </div>

      <PromptDialogHost />
      <DocHistoryPanelHost />
      {shareTarget && <OfficeShareDialog target={shareTarget} onClose={() => setShareTarget(null)} />}
      {teamsOpen && <OfficeTeamsDialog onClose={() => setTeamsOpen(false)} />}
      {askOpen && <OfficeAsk onClose={() => setAskOpen(false)} />}
      {settingsOpen && (
        <div
          className="fb-scrim fixed inset-0 z-[300] flex items-center justify-center"
          onMouseDown={() => setSettingsOpen(false)}
          data-testid="office-settings-modal"
        >
          <div
            className="fb-card w-[480px] max-w-[92vw] max-h-[82vh] overflow-auto p-4"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-2">
              <Icon name="key" size={15} className="text-accent" />
              <span className="text-[14px] font-semibold">AI · API keys</span>
              <button onClick={() => setSettingsOpen(false)} className="ml-auto icon-btn" aria-label="Close">
                <Icon name="close" size={15} />
              </button>
            </div>
            <p className="text-[12px] text-[var(--ink-50)] mb-3">
              AI features here (slides generation, document rewrites, auto-filing) run on Anthropic. Paste your own key
              from console.anthropic.com to enable them.
            </p>
            <ApiKeysSection onKeySaved={() => setSettingsOpen(false)} />
          </div>
        </div>
      )}

      {/* Footer — version pill (click to check for updates) + the shared updater
          banner, mirroring PlexiDesk so updates are visible here too. */}
      <footer className="h-7 shrink-0 px-3 flex items-center gap-2 text-[11px] text-[var(--ink-50)] border-t border-[var(--edge-soft)] bg-[var(--surface-sunken)] select-none">
        <span>PlexiOffice</span>
        <span className="text-[var(--ink-30)]">·</span>
        <button
          type="button"
          onClick={() => void window.api.update.check()}
          title="Click to check for updates"
          data-testid="office-version"
          className="font-mono hover:text-[var(--ink-70)] transition-colors"
        >
          v{appVersion}
        </button>
        <UpdaterBanner />
      </footer>
    </div>
  )
}
