// Agentic Ops in the browser: there is no console to reach.
//
// On the desktop, src/renderer/src/components/views/AgenticOpsView.tsx embeds
// the agentic operations console, a local service on the same computer, and
// first asks http://localhost:8765/api/notify/status whether it is running.
//
// A browser tab must not. The share page is a public page with the whole app
// around the desk (shareGate.ts), and PlexiiBrain › Ops is in its side menu, so
// a visitor who clicked it made their own browser ask their own computer for a
// service (a0, 2026-11-24): the same fault as the Ollama check
// (../worker/main/localModel.ts). Nothing said so, and newer Chrome asks the
// visitor for permission to reach their local network.
//
// The browser build swaps the view for this one (MODULE_SWAPS in
// vite.web.config.ts), so the tab carries no Ops client at all. It says what
// Ops is and where it runs; in a share window it offers the desktop app, the
// one door out of a shared desk. tests/web/shareNetwork.spec.ts opens Ops as a
// visitor and checks that nothing is asked of the visitor's computer, and that
// the built app has no Ops address in it.
import Icon from '../../renderer/src/components/Icon'
import { shareGate } from '../../renderer/src/lib/shareGate'
import { isShareRecipient } from '../../renderer/src/lib/shareMode'
import type * as Desktop from '../../renderer/src/components/views/AgenticOpsView'

export default function AgenticOpsView(): JSX.Element {
  const share = isShareRecipient()
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-6 desk-paper no-tod" data-testid="agentic-ops-web">
      <div className="max-w-md">
        <div className="inline-flex items-center justify-center h-14 w-14 rounded-2xl bg-[var(--surface-sunken)] mb-4">
          <Icon name="smart_toy" size={28} className="text-accent" />
        </div>
        <h2 className="text-xl font-semibold text-[var(--ink-100)] mb-2">Agentic Ops runs on your computer</h2>
        <p className="text-sm text-[var(--ink-60)] mb-4">
          It is a console for your agent workforce that runs beside the Plexii desktop app, on the same machine. A web
          page cannot reach it, so this one does not try.
        </p>
        {share && (
          <button
            type="button"
            onClick={() => shareGate('Agentic Ops')}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90"
          >
            <Icon name="download" size={16} />
            Get Plexii for your computer
          </button>
        )}
      </div>
    </div>
  )
}

// Signature check against the desktop view: if its export drifts,
// typecheck:webruntime fails here instead of the swap breaking quietly.
// Type-only, so nothing of the desktop view is bundled.
;(AgenticOpsView) satisfies typeof Desktop.default
