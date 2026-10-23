import SnippetEditSessionView from './SnippetEditSessionView'
import { useSnippetSession } from './snippetSessionStore'

// The one place a snippet session is mounted, once per renderer root, beside
// DocHistoryPanelHost in App.
//
// It gives the session a box and nothing else: SessionShell is `h-full` and
// paints its own header and background, so the positioning is the host's half
// of that contract.
//
// THE SCRIM DOES NOT CLOSE ON CLICK, and that is the one deliberate departure
// from every other modal in the app. DocHistoryPanelHost closes on a scrim
// mousedown because a list of versions has nothing to lose. A session holds
// edits that exist nowhere else — no document row is created, by design — and
// their only guard is the confirm inside the view's own close. A scrim that
// called the store's close directly would walk straight past that guard and
// drop the edit on a stray click, with nothing to recover from. Closing goes
// through the header's × or Escape, both of which are the guarded path.

export function SnippetSessionHost(): JSX.Element | null {
  const snippetId = useSnippetSession((s) => s.snippetId)
  const close = useSnippetSession((s) => s.close)

  if (!snippetId) return null

  return (
    <div
      className="fb-scrim fixed inset-0 z-[300] flex items-center justify-center p-6"
      data-testid="snippet-session-host"
    >
      <div className="h-[min(78vh,720px)] w-[min(960px,94vw)] overflow-hidden rounded-xl border border-[var(--edge-soft)] bg-[var(--surface-base)] shadow-2xl">
        {/*
          Keyed on the snippet, so opening a second snippet remounts rather than
          re-pointing a live session. The view refetches when snippetId changes,
          but its buffered body and dirty flag would survive the change — and a
          buffer from one snippet saved against another is the one way this
          feature could write the wrong body to the wrong master.
        */}
        <SnippetEditSessionView key={snippetId} snippetId={snippetId} onClose={close} />
      </div>
    </div>
  )
}

export default SnippetSessionHost
