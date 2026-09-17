import { useViewStore } from '../stores/view'
import { useNodeStore } from '../stores/nodes'
import { useWidgetStore } from '../stores/widgets'
import { catalogFor } from './widgetCatalog'

// The single AI assistant (ChatPanel) is context-aware: it adapts what it is
// scoped to, how it frames itself, and its starter suggestions to whatever the
// user is looking at. This hook derives that context from the current view (plus
// the focused widget on a desk). One assistant, many contexts — no second rail.
export type AssistantContextKind =
  | 'desk'
  | 'room'
  | 'doc'
  | 'chat'
  | 'meet'
  | 'design'
  | 'artwork'
  | 'widget'
  | 'workspace'

export interface AssistantContext {
  // Conversation thread key for the chat store's message map. For a desk this is
  // the real task id, so desk behaviour (server task context, attachments) is
  // unchanged; other screens get their own synthetic thread.
  key: string
  // The real task id to hand the server for task-scoped context, or null when the
  // screen isn't a task (doc/chat/meet/design/room) so it degrades cleanly.
  serverTaskId: string | null
  kind: AssistantContextKind
  // Short "what am I looking at" for the header subtitle, e.g. "this desk".
  label: string
  // The specific object's title (desk/doc/widget name), or '' when not applicable.
  title: string
  icon: string
  // Empty-state intro line.
  intro: string
  suggestions: { icon: string; text: string }[]
  placeholder: string
}

const DESK_SUGGESTIONS = [
  { icon: 'list_alt', text: 'Break this into clear steps' },
  { icon: 'edit_note', text: 'Draft a first version for me' },
  { icon: 'travel_explore', text: 'Research this and summarize what matters' },
  { icon: 'arrow_forward', text: 'What should I work on next?' }
]

export function useAssistantContext(): AssistantContext {
  const view = useViewStore((s) => s.view)
  const activeTaskId = useNodeStore((s) => s.activeTaskId)
  const nodes = useNodeStore((s) => s.nodes)
  const focusedWidgetId = useWidgetStore((s) => s.focusedWidgetId)
  const widgets = useWidgetStore((s) => s.widgets)

  const activeTask = activeTaskId ? nodes.find((n) => n.id === activeTaskId) ?? null : null

  // A focused widget on a desk takes precedence — the user is zeroed in on one
  // object. Keep the desk's task thread + server context, but frame + suggest for
  // the widget so help is about the thing in front of them.
  if ((view.kind === 'task' || view.kind === 'project-dashboard') && focusedWidgetId) {
    const w = widgets.find((x) => x.id === focusedWidgetId)
    if (w) {
      const kindLabel = catalogFor(w.kind)?.label ?? w.kind
      const title = w.title || kindLabel
      return {
        key: activeTaskId ?? '__global__',
        serverTaskId: activeTaskId,
        kind: 'widget',
        label: `this ${kindLabel.toLowerCase()}`,
        title,
        icon: catalogFor(w.kind)?.icon ?? 'widgets',
        intro: `Ask about "${title}" — I can rewrite, summarise, extend, or act on what's in it.`,
        suggestions: [
          { icon: 'auto_fix_high', text: `Improve this ${kindLabel.toLowerCase()}` },
          { icon: 'summarize', text: 'Summarise what this says' },
          { icon: 'checklist', text: 'Turn this into action items' },
          { icon: 'north_east', text: 'Expand on this' }
        ],
        placeholder: `Ask about this ${kindLabel.toLowerCase()}…`
      }
    }
  }

  switch (view.kind) {
    case 'task':
    case 'project-dashboard': {
      const title = activeTask?.title ?? 'this desk'
      return {
        key: activeTaskId ?? '__global__',
        serverTaskId: activeTaskId,
        kind: 'desk',
        label: 'this desk',
        title,
        icon: 'space_dashboard',
        intro:
          'Ask anything about this desk. I can see what you have open here and can research, plan, draft, and act on it.',
        suggestions: DESK_SUGGESTIONS,
        placeholder: 'Ask about this desk…'
      }
    }
    case 'desks':
    case 'rooms':
    case 'shared':
      return {
        key: view.kind === 'desks' && view.roomId ? `room:${view.roomId}` : 'room',
        serverTaskId: null,
        kind: 'room',
        label: 'your rooms',
        title: '',
        icon: 'meeting_room',
        intro: 'Ask about your rooms and desks — what to open, where something lives, or what needs attention.',
        suggestions: [
          { icon: 'travel_explore', text: 'What needs my attention across my desks?' },
          { icon: 'add_task', text: 'Set up a new desk for…' },
          { icon: 'find_in_page', text: 'Where did I put…' }
        ],
        placeholder: 'Ask about your rooms…'
      }
    case 'document':
    case 'livedoc':
    case 'documents': {
      const id =
        view.kind === 'document'
          ? view.documentId
          : view.kind === 'livedoc'
            ? view.liveDocId
            : 'all'
      return {
        key: `doc:${id}`,
        serverTaskId: null,
        kind: 'doc',
        label: 'this document',
        title: '',
        icon: 'description',
        intro: 'Ask about this document — I can draft, rewrite, tighten, summarise, or continue it.',
        suggestions: [
          { icon: 'edit_note', text: 'Draft the next section' },
          { icon: 'compress', text: 'Tighten this writing' },
          { icon: 'summarize', text: 'Summarise this document' },
          { icon: 'spellcheck', text: 'Proofread for clarity' }
        ],
        placeholder: 'Ask about this document…'
      }
    }
    case 'messages':
      return {
        key: 'chat',
        serverTaskId: null,
        kind: 'chat',
        label: 'your chats',
        title: '',
        icon: 'forum',
        intro: 'Ask about your conversations — catch up, find a decision, or draft a reply.',
        suggestions: [
          { icon: 'bolt', text: 'Catch me up on what I missed' },
          { icon: 'gavel', text: 'What was decided in this channel?' },
          { icon: 'reply', text: 'Draft a reply' }
        ],
        placeholder: 'Ask about your chats…'
      }
    case 'meetings':
      return {
        key: 'meet',
        serverTaskId: null,
        kind: 'meet',
        label: 'your meetings',
        title: '',
        icon: 'videocam',
        intro: 'Ask about your meetings — prep an agenda, capture actions, or summarise what happened.',
        suggestions: [
          { icon: 'event_note', text: 'Draft an agenda for my next meeting' },
          { icon: 'task_alt', text: 'Pull the action items out of this meeting' },
          { icon: 'summarize', text: 'Summarise this meeting' }
        ],
        placeholder: 'Ask about your meetings…'
      }
    case 'design':
      return {
        key: 'design',
        serverTaskId: null,
        kind: 'design',
        label: 'this design',
        title: '',
        icon: 'palette',
        intro: 'Ask about this design — generate copy, suggest layouts, or refine the look.',
        suggestions: [
          { icon: 'auto_awesome', text: 'Write headline options for this' },
          { icon: 'dashboard_customize', text: 'Suggest a cleaner layout' },
          { icon: 'contrast', text: 'Improve the colour and contrast' }
        ],
        placeholder: 'Ask about this design…'
      }
    case 'draw':
      return {
        key: 'draw',
        serverTaskId: null,
        kind: 'artwork',
        label: 'this artwork',
        title: '',
        icon: 'brush',
        intro: 'Ask about this artwork — talk through composition, colour and how to build a shape.',
        suggestions: [
          { icon: 'palette', text: 'Suggest a colour palette for this' },
          { icon: 'architecture', text: 'How do I build this shape with the pen tool?' },
          { icon: 'contrast', text: 'Improve the contrast and balance' }
        ],
        placeholder: 'Ask about this artwork…'
      }
    case 'plexii':
      // The hub is the AI's own page: workspace scope, never a lingering desk —
      // being "on" the hub means being on no desk at all.
      return {
        key: '__global__',
        serverTaskId: null,
        kind: 'workspace',
        label: 'your workspace',
        title: '',
        icon: 'auto_awesome',
        intro: 'Ask anything. I can research, plan, draft, and act across your workspace.',
        suggestions: [
          { icon: 'travel_explore', text: 'What should I work on next?' },
          { icon: 'add_task', text: 'Plan out…' },
          { icon: 'search', text: 'Find…' }
        ],
        placeholder: 'Ask Plexii anything…'
      }
    default:
      return {
        key: '__global__',
        serverTaskId: activeTaskId,
        kind: 'workspace',
        label: 'your workspace',
        title: '',
        icon: 'smart_toy',
        intro: 'Ask anything. I can research, plan, draft, and act across your workspace.',
        suggestions: [
          { icon: 'travel_explore', text: 'What should I work on next?' },
          { icon: 'add_task', text: 'Plan out…' },
          { icon: 'search', text: 'Find…' }
        ],
        placeholder: 'Ask anything…'
      }
  }
}
