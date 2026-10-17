// The fullscreen home's capability row (Phase 3a.4 P8, made functional in 3b
// per the operator's live-drive call): an honest statement of what the
// assistant can act on TODAY, where every chip is also a real entry point.
// Clicking one sends its `starter` as a genuine user request — the assistant
// then uses the question protocol to ask for whatever specifics it needs.
// Every entry is backed by real ActionProposal kinds — the `kinds` field is
// typed against the union, so a capability the appliers cannot deliver fails
// typecheck rather than shipping as a fake connector toggle.

import type { ActionProposal } from '@shared/types'

export interface AssistantCapability {
  icon: string
  label: string
  // The real user request a click sends — verbatim. Locked by e2e: the far
  // end must receive exactly this string, so a chip can never claim one flow
  // and start another.
  starter: string
  // The real proposal kinds backing this capability — the honesty anchor.
  kinds: ActionProposal['kind'][]
}

export const ASSISTANT_CAPABILITIES: AssistantCapability[] = [
  {
    icon: 'mail',
    label: 'Draft an email',
    starter: 'Draft an email for me',
    kinds: ['compose-mail']
  },
  {
    icon: 'event',
    label: 'Schedule an event',
    starter: 'Schedule something on my calendar',
    kinds: ['schedule-event']
  },
  {
    icon: 'forum',
    label: 'Post to a chat',
    starter: 'Post an update to one of my chats',
    kinds: ['post-chat']
  },
  {
    icon: 'description',
    label: 'Write a document',
    starter: 'Write a document for me',
    kinds: ['create-document', 'generate-document', 'edit-document', 'create-page']
  },
  {
    icon: 'widgets',
    label: 'Make a widget file',
    starter: 'Make me a task list I can put on any desk',
    kinds: ['create-widget-file', 'update-widget-file']
  },
  {
    icon: 'table_chart',
    label: 'Build a table',
    starter: 'Set up a table to track something for me',
    kinds: ['create-table', 'add-table-row', 'set-cell']
  },
  {
    icon: 'space_dashboard',
    label: 'Arrange this desk',
    starter: 'Tidy up and arrange this desk',
    kinds: ['create-widget', 'update-widget', 'arrange-widgets', 'link-widgets']
  },
  {
    icon: 'checklist',
    label: 'Plan my desks',
    starter: 'Help me plan and organise my desks',
    kinds: ['create-task', 'update-task', 'create-todo-list', 'toggle-todo-item']
  },
  {
    icon: 'smart_toy',
    label: 'Set up a desk agent',
    starter: 'Set up a desk agent for me',
    kinds: ['create-agent']
  }
]
