// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── DEC-120 — the assistant's header, first. Operator (2026-09-06): the tab
// row (Today / Chat / Agent / Tasks / Activity / Work) goes BELOW the
// wordmark row; that row is, from the right, Minimize · Display mode · What
// was I doing? · New chat; Body double and Your conversations leave the bar;
// "Plexii / your workspace" becomes the sidebar's own animated wordmark.
//
// ── 2026-10-08 — Your conversations comes BACK, and the nav loses its own
// list. The operator removed the Plexii row's recent-conversation sublist from
// the desk sidebar and asked for history to live in the right-hand assistant
// instead, searchable. That makes this button load-bearing rather than
// redundant: in sidebar and floating mode it is now the ONLY door to an older
// chat. Fullscreen keeps its permanent rail and so does not show the button.
// The DEC-120 assertions below are updated rather than deleted, so the
// reversal is on the record instead of looking like it never happened.

const ROOT = join(__dirname, '..', '..')
const read = (p: string): string => readFileSync(join(ROOT, 'src', p), 'utf-8')
const header = read('renderer/src/components/assistant/AssistantHeader.tsx')
const overlay = read('renderer/src/components/assistant/AssistantOverlay.tsx')
const panel = read('renderer/src/components/ChatPanel.tsx')
const store = read('renderer/src/stores/chat.ts')
const sidebar = read('renderer/src/components/Sidebar.tsx')

describe('DEC-120 — the header is the first row; the tabs sit under it', () => {
  it('the overlay mounts AssistantHeader BEFORE the tab strip', () => {
    expect(overlay).toContain('<AssistantHeader chrome />')
    expect(overlay.indexOf('<AssistantHeader chrome />')).toBeLessThan(overlay.indexOf('data-testid="assistant-tabs"'))
    expect(overlay).toContain('<ChatPanel />')
    expect(overlay).not.toContain('onCollapse')
  })

  it('the wordmark is the desk sidebar\'s own mark — same component, same motion', () => {
    expect(sidebar).toContain('<PlexiiLogo height={22} />')
    expect(header).toContain("import PlexiiLogo from '../PlexiiLogo'")
    expect(header).toContain('<PlexiiLogo height={20} />')
    // the old two-line title is gone from the MARKUP (the comment may still name it)
    expect(header).not.toContain('>Plexii</h2>')
    expect(header).not.toContain('fb-t-title')
  })

  it('from the right: Minimize · Display mode · Your conversations · What was I doing? · New chat', () => {
    const order = [
      'assistant-history-toggle',
      'assistant-new-chat',
      'assistant-recap',
      'assistant-mode-toggle',
      'assistant-minimize'
    ].map((id) => header.indexOf(`data-testid="${id}"`))
    for (const i of order) expect(i).toBeGreaterThan(-1)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    for (const gone of ['Body double ON', 'group_off', 'delete_sweep', 'bodyDouble'])
      expect(header).not.toContain(gone)
    // the chrome doors are the overlay's; the page (hub) wears the bar without them
    expect(header).toContain('{chrome && (')
    expect(panel).toContain('{page && <AssistantHeader chrome={false} />}')
  })

  it('New chat and What was I doing? land on the Chat tab', () => {
    expect(header).toContain("newConversation()\n            setTab('chat')")
    expect(header).toContain("setTab('chat')\n            void recap(activeTaskId)")
    expect(header).toContain("title={recapping ? 'Reading the trail…' : 'What was I doing? — replay the last 30 minutes as a narrative'}")
  })
})

describe('DEC-120 — ChatPanel gave the header up and kept the conversation\'s own context', () => {
  it('no header, no body double, no local recap — but it does own the history overlay', () => {
    for (const gone of ['useBodyDouble', 'handleWhatWasIDoing', 'MODE_OPTIONS', 'summarizing'])
      expect(panel).not.toContain(gone)
    // The toggle is the HEADER's; ChatPanel only reads the state it sets.
    expect(panel).not.toContain('assistant-history-toggle')
    expect(panel).not.toContain('<h2 className="fb-t-title text-[var(--ink-100)]">')
  })

  it('the context strip keeps the focused thread, Discovery, the linked desk and Clear chat', () => {
    expect(panel).toContain('data-testid="chat-context"')
    expect(panel).toContain('(discovering || primaryDeskId || thread.title || messages.length > 0) && (')
    expect(panel).toContain('data-testid="chat-mode-badge"')
    expect(panel).toContain('data-testid="chat-linked-desk"')
    expect(panel).toContain('data-testid="chat-clear"')
  })

  it('"What was I doing?" lives in the chat store — one implementation for the overlay and the hub', () => {
    expect(store).toContain('recapping: boolean')
    expect(store).toContain('recap: (taskId: string | null) => Promise<void>')
    expect(store).toContain('const TRAIL_LOOKBACK_MS = 30 * 60 * 1000')
    expect(store).toContain('window.api.trail.summarize(taskId, Date.now() - TRAIL_LOOKBACK_MS)')
    expect(store).toContain('paste your Anthropic API key to use "What was I doing?"')
  })
})

// ── 2026-10-08 — conversations live in exactly one place ────────────────────
describe('conversation history moved out of the nav and into the assistant', () => {
  const list = read('renderer/src/components/assistant/ConversationList.tsx')
  const chrome = read('renderer/src/stores/assistantChrome.ts')

  it('the desk sidebar no longer carries a conversation sublist', () => {
    for (const gone of [
      'sidebar-plexii-conversation',
      'recentConversations',
      'plexiiNavOpen',
      'openConversation',
      "useChatStore"
    ]) {
      expect(sidebar).not.toContain(gone)
    }
    // The Plexii row is gone too now (operator ruling 2026-10-10): the hub had
    // two doors, a nav row and the assistant you were already talking to. The
    // assistant's wordmark is the one that remains.
    expect(sidebar).not.toContain('testid="sidebar-plexii"')
    expect(header).toContain('data-testid="assistant-open-hub"')
    expect(header).toContain('goPlexii()')
  })

  it('the header\'s history button is hidden in fullscreen, which has the rail', () => {
    expect(header).toContain("{chrome && mode !== 'fullscreen' && (")
    expect(header).toContain('data-testid="assistant-history-toggle"')
    expect(header).toContain('toggleHistory()')
  })

  it('ChatPanel renders the rail in fullscreen and the overlay in the narrow modes', () => {
    expect(panel).toContain('variant="rail"')
    expect(panel).toContain('variant="overlay"')
    expect(panel).toContain('{!isFullscreen && historyOpen && (')
    // Picking a conversation, or starting a new one, dismisses the overlay so
    // the thread is what you land on.
    expect(panel).toContain('setHistoryOpen(false)')
  })

  it('the overlay is anchored to the panel, not left to float on containment alone', () => {
    expect(panel).toContain('fb-chat-container relative')
    expect(list).toContain('absolute inset-x-2 top-2')
  })

  it('search is unconditional — it is the only way to reach an old chat now', () => {
    expect(list).toContain('{conversations.length > 0 && (')
    expect(list).toContain('data-testid="conversation-search"')
    expect(list).not.toContain('conversations.length > 5')
  })

  it('the overlay can be dismissed; the rail cannot', () => {
    expect(list).toContain('data-testid="conversation-close"')
    expect(list).toContain('if (isRail || !onClose) return')
    expect(list).toContain("if (e.key !== 'Escape') return")
  })

  it('historyOpen is chrome state, deliberately not persisted, and closed by fullscreen', () => {
    expect(chrome).toContain('historyOpen: boolean')
    expect(chrome).toContain('historyOpen: false,')
    expect(chrome).toContain("historyOpen: mode === 'fullscreen' ? false : get().historyOpen")
    // No localStorage key for it — an overlay restored open would hide the thread.
    expect(chrome).not.toContain('HISTORY_KEY')
  })
})
