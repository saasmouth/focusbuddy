// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ASSISTANT_TABS, LEGACY_TAB } from '../../src/renderer/src/stores/assistantChrome'

// ── DEC-121 — the assistant's tabs, rearranged on operator direction:
// Today → Attention (the home Attention widget, uncapped, in the panel);
// Activity → PlexiChat (the Office Chat view, compact, in the panel);
// Agent + Work consolidated (desk agents as a sub-view of Agent).

const ROOT = join(__dirname, '..', '..')
const read = (p: string): string => readFileSync(join(ROOT, 'src', p), 'utf-8')
const overlay = read('renderer/src/components/assistant/AssistantOverlay.tsx')
const store = read('renderer/src/stores/assistantChrome.ts')
const attentionTab = read('renderer/src/components/assistant/tabs/AssistantAttentionTab.tsx')
const messagesTab = read('renderer/src/components/assistant/tabs/AssistantMessagesTab.tsx')
const agentTab = read('renderer/src/components/assistant/tabs/AssistantAgentTab.tsx')
const widgets = read('renderer/src/components/views/attentionWidgets.tsx')
const messages = read('renderer/src/components/views/MessagesView.tsx')

describe('DEC-121/122 — the tab set', () => {
  it('the mark · Attention · PlexiiMessage · Agents, in that order, in the store and the strip', () => {
    // DEC-131: Calendar joins after Attention; PlexiiMessage reads "Message"
    expect(ASSISTANT_TABS).toEqual(['chat', 'attention', 'calendar', 'messages', 'agent'])
    const order = [
      "{ id: 'chat', label: 'PlexiiAssist', mark: true }",
      "{ id: 'attention', label: 'Attention', icon: 'notifications' }",
      "{ id: 'calendar', label: 'Calendar', icon: 'calendar_month' }",
      "{ id: 'messages', label: 'Message', icon: 'chat' }",
      "{ id: 'agent', label: 'Agents', icon: 'rocket_launch' }"
    ].map((s) => overlay.indexOf(s))
    for (const i of order) expect(i).toBeGreaterThan(-1)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    for (const gone of ["'today'", "'activity'", "'work'", "'tasks'", 'StandupHome', 'AssistantActivityTab', 'AssistantWorkTab', 'AssistantTasksTab', 'PlexiChat'])
      expect(overlay).not.toContain(gone)
  })

  it('the conversation tab wears the animated double-ii mark alone — the label is its accessible name', () => {
    expect(overlay).toContain('{t.mark ? (')
    expect(overlay).toMatch(/<PlexiiMark height=\{16\} motion=\{[^}]*'once\+hover'[^}]*\} title=\{null\}/)
    expect(overlay).toContain('aria-label={t.label}')
  })

  it('a tab saved before still lands somewhere sensible; the default is the conversation', () => {
    expect(LEGACY_TAB).toEqual({ today: 'attention', tasks: 'attention', activity: 'messages', work: 'agent' })
    expect(store).toContain('if (raw && LEGACY_TAB[raw]) return LEGACY_TAB[raw]')
    expect(store).toContain("return 'chat'\n}")
  })

  it('the retired Activity and Tasks tabs are gone; the Work tab survives as the Agents sub-view', () => {
    expect(existsSync(join(ROOT, 'src/renderer/src/components/assistant/tabs/AssistantActivityTab.tsx'))).toBe(false)
    expect(existsSync(join(ROOT, 'src/renderer/src/components/assistant/tabs/AssistantTasksTab.tsx'))).toBe(false)
    expect(existsSync(join(ROOT, 'src/renderer/src/components/assistant/tabs/AssistantWorkTab.tsx'))).toBe(true)
  })
})

describe('DEC-121 — Attention IS the home widget', () => {
  it('the tab renders the same AttentionWidget, uncapped and scrolling, under its own remembered section', () => {
    expect(attentionTab).toContain("import { AttentionWidget } from '../../views/attentionWidgets'")
    // DEC-131: the mount grew a capture door (onCapture) and went multi-line
    expect(attentionTab).toContain('<AttentionWidget\n        size="lg"\n        storageKey="attention.assistant.section"\n        limit={Number.POSITIVE_INFINITY}\n        scroll\n        onCapture={() => openConsole()}\n      />')
    expect(overlay).toContain("{activeTab === 'attention' && <AssistantAttentionTab />}")
  })
  it('the widget grew limit / scroll additively — the home and desk slices are untouched', () => {
    expect(widgets).toContain("const max = limit ?? (size === 'lg' ? 7 : size === 'md' ? 4 : 2)")
    // DEC-128: every host scrolls now (an open row's in-place summary needs
    // room); `scroll` stays in the signature for its callers.
    expect(widgets).toContain('<div className="mt-1.5 flex-1 min-h-0 overflow-y-auto" data-testid="attention-widget-list">')
    expect(widgets).toContain("storageKey = 'attention.widget.section',\n  limit,")
    expect(widgets).toContain('scroll: _scroll = false')
  })
})

describe('DEC-121 — PlexiChat IS the Office Chat view', () => {
  it('the tab renders MessagesView compact', () => {
    expect(messagesTab).toContain("import MessagesView from '../../views/MessagesView'")
    expect(messagesTab).toContain('<MessagesView compact />')
    expect(overlay).toContain("{activeTab === 'messages' && <AssistantMessagesTab />}")
  })
  it('compact: one pane at a time, a way back, no paper of its own; the Office page is unchanged by default', () => {
    expect(messages).toContain('export default function MessagesView({ compact = false }: { compact?: boolean } = {}): JSX.Element {')
    expect(messages).toContain("const [compactPane, setCompactPane] = useState<'list' | 'thread'>('thread')")
    expect(messages).toContain('data-testid="messages-back"')
    expect(messages).toContain('data-testid="messages-list-pane"')
    expect(messages).toContain('data-testid="messages-thread-pane"')
    expect(messages).toContain("compact ? 'h-full flex flex-col' : 'h-full flex desk-paper no-tod'")
    // every door into a conversation goes through openConv (the one `void open(`
    // left is the helper itself), so the thread shows whichever way you arrive
    expect(messages.split('void open(').length - 1).toBe(1)
    expect(messages.split('openConv(').length - 1).toBeGreaterThanOrEqual(3)
  })
  it('compact header (DEC-123): one Meet door, no translate menu, doors on their own left-aligned wrapping row', () => {
    expect(messages).toContain("{callTarget && !compact && (")
    expect(messages).toContain("onClick={() => (compact && callTarget ? void startCall(callTarget, 'video') : goMeetings())}")
    expect(messages).toContain("{activeId && !compact && (\n                  <select")
    // DEC-131: the panel's doors moved to the right of the name — one row, no wrap
    expect(messages).toContain('<div className="flex items-center gap-1.5 shrink-0" data-testid="messages-actions">')
    expect(messages).toContain('data-testid="messages-actions"')
    expect(messages).toContain("const hdrBtn = compact")
    // the Office page is unchanged: both doors, the translate menu, the wide sizes
    expect(messages).toContain('data-testid="messages-call"')
    expect(messages).toContain('data-testid="messages-translate-lang"')
    expect(messages).toContain("'fb-btn-surface inline-flex items-center gap-1.5 h-8 px-3 text-[12.5px] text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]'")
  })
})

describe('DEC-121 — Agent + Work consolidated', () => {
  it('the Agent tab keeps its autonomous surface and adds Desk agents as a sub-view', () => {
    expect(agentTab).toContain("import AssistantWorkTab from './AssistantWorkTab'")
    expect(agentTab).toContain('data-testid={`agent-subtab-${k}`}')
    expect(agentTab).toContain("['agent', 'rocket_launch', 'Autonomous agent'],")
    expect(agentTab).toContain("['desks', 'smart_toy', 'Desk agents']")
    expect(agentTab).toContain("{sub === 'desks' ? (")
    expect(agentTab).toContain('<AssistantWorkTab />')
    expect(agentTab).toContain('data-testid="agent-run"')
    expect(agentTab).toContain('data-testid="agent-transcript"')
  })
})
