import { useEffect, useRef, useState } from 'react'
import Icon from '../Icon'
import PlexiiLogo from '../PlexiiLogo'
import { useAssistantChrome, type AssistantMode } from '../../stores/assistantChrome'
import { useChatStore } from '../../stores/chat'
import { useNodeStore } from '../../stores/nodes'

// The assistant's header (operator direction, 2026-09-06). The wordmark that
// lives at the top-left of the desk sidebar — the SAME PlexiiLogo, the same
// blink-once-and-wink-on-hover mark — in place of "Plexii / your workspace",
// and, from the right: Minimize, Display mode, Your conversations, "What was I
// doing?", New chat. Body double keeps its doors in the app header and the
// command centre. The tab strip sits BELOW this bar, so the header is the
// panel's first line on every tab. The page (the hub) wears the same bar
// without the chrome doors — it is not re-dressable and has nothing to
// minimize into.
//
// Your conversations came BACK to this bar (operator direction, 2026-10-08).
// It had been removed on the reasoning that the list "stays the fullscreen
// rail" — but the recent-conversation sublist in the desk sidebar was the only
// other way to reach history, and that has now gone from the nav. Without this
// door, anyone working in sidebar or floating mode could not reach an old
// conversation at all. Fullscreen still has the rail, so the button hides
// there rather than offering a second, redundant list.

// The three display modes, in Notion's order and with Notion's labels. The
// button shows the current mode's icon; the dropdown lists all three with a
// check on the active one.
export const MODE_OPTIONS: Array<{ mode: AssistantMode; label: string; icon: string }> = [
  { mode: 'sidebar', label: 'Sidebar', icon: 'vertical_split' },
  { mode: 'floating', label: 'Floating', icon: 'picture_in_picture_alt' },
  { mode: 'fullscreen', label: 'Full screen', icon: 'fullscreen' }
]

export default function AssistantHeader({ chrome }: { chrome: boolean }): JSX.Element {
  const newConversation = useChatStore((s) => s.newConversation)
  const recap = useChatStore((s) => s.recap)
  const recapping = useChatStore((s) => s.recapping)
  const activeTaskId = useNodeStore((s) => s.activeTaskId)
  const mode = useAssistantChrome((s) => s.mode)
  const setMode = useAssistantChrome((s) => s.setMode)
  const setTab = useAssistantChrome((s) => s.setTab)
  const close = useAssistantChrome((s) => s.close)
  const historyOpen = useAssistantChrome((s) => s.historyOpen)
  const toggleHistory = useAssistantChrome((s) => s.toggleHistory)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!menuOpen) return
    function onPointerDown(e: PointerEvent): void {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [menuOpen])
  const active = MODE_OPTIONS.find((o) => o.mode === mode) ?? MODE_OPTIONS[1]

  return (
    <div
      className="shrink-0 flex items-center gap-2 px-3 h-12 border-b border-[var(--edge-soft)] bg-[var(--surface-raised)]"
      data-testid="assistant-header"
    >
      {/* The desk sidebar's mark, verbatim — one wordmark, one motion. */}
      <PlexiiLogo height={20} />
      <div className="ml-auto flex items-center gap-1">
        {chrome && mode !== 'fullscreen' && (
          <button
            onClick={() => {
              setTab('chat')
              toggleHistory()
            }}
            className="icon-btn"
            data-testid="assistant-history-toggle"
            title="Your conversations — search and reopen an earlier chat"
            aria-label="Your conversations"
            aria-expanded={historyOpen}
            aria-pressed={historyOpen}
          >
            <Icon name="forum" size={16} className={historyOpen ? 'text-accent' : undefined} />
          </button>
        )}
        <button
          onClick={() => {
            newConversation()
            setTab('chat')
          }}
          className="icon-btn"
          data-testid="assistant-new-chat"
          title="New chat (⌘O)"
          aria-label="New chat"
        >
          <Icon name="add" size={16} />
        </button>
        <button
          onClick={() => {
            setTab('chat')
            void recap(activeTaskId)
          }}
          disabled={recapping}
          className="icon-btn"
          data-testid="assistant-recap"
          title={recapping ? 'Reading the trail…' : 'What was I doing? — replay the last 30 minutes as a narrative'}
          aria-label="What was I doing?"
        >
          <Icon name={recapping ? 'hourglass_top' : 'replay'} size={16} className={recapping ? 'animate-spin' : ''} />
        </button>
        {chrome && (
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="icon-btn"
              title={`Display mode — ${active.label}`}
              aria-label="Display mode"
              aria-expanded={menuOpen}
              data-testid="assistant-mode-toggle"
            >
              <Icon name={active.icon} size={16} />
            </button>
            {menuOpen && (
              <div
                data-testid="assistant-mode-menu"
                className="absolute right-0 top-full mt-1.5 z-30 min-w-[172px] rounded-[var(--radius-row)] border border-[var(--edge-soft)] bg-[var(--surface-raised)] p-1"
                style={{ boxShadow: 'var(--shadow-cast)' }}
              >
                {MODE_OPTIONS.map((opt) => (
                  <button
                    key={opt.mode}
                    onClick={() => {
                      setMode(opt.mode)
                      setMenuOpen(false)
                    }}
                    data-testid={`assistant-mode-${opt.mode}`}
                    className="w-full flex items-center gap-2 rounded-[var(--radius-chip)] px-2 py-1.5 fb-t-label text-[var(--ink-90)] hover:bg-[var(--surface-sunken)] transition-colors"
                  >
                    <Icon name={opt.icon} size={15} className="text-[var(--ink-60)]" />
                    <span className="flex-1 text-left">{opt.label}</span>
                    {opt.mode === mode && <Icon name="check" size={14} className="text-accent" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {chrome && (
          <button
            onClick={close}
            className="icon-btn"
            title="Minimize to pill"
            aria-label="Minimize to pill"
            data-testid="assistant-minimize"
          >
            <Icon name="remove" size={16} />
          </button>
        )}
      </div>
    </div>
  )
}
