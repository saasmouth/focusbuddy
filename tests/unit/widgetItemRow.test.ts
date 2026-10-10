// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8')
const row = read('src/renderer/src/components/attention/WidgetItemRow.tsx')
const widgets = read('src/renderer/src/components/views/attentionWidgets.tsx')
const view = read('src/renderer/src/components/views/AttentionView.tsx')
const start = read('src/renderer/src/lib/startWithPlexii.ts')
const meeting = read('src/renderer/src/lib/openMeeting.ts')
const tab = read('src/renderer/src/components/assistant/tabs/AssistantAttentionTab.tsx')

// DEC-128 — the Attention widget's row, everywhere the widget lives (home,
// desk, the assistant's Attention tab): title + date at rest, one click opens
// the page's quick summary and actions IN PLACE, a double-click opens the full
// item over the page you are on. No click is a trip to the Attention page.

describe('dec_128 — three depths in place', () => {
  it('at rest: the title and the due date; the title click toggles the summary, never navigates', () => {
    expect(row).toContain('onClick={() => setOpen((o) => !o)}')
    expect(row).toContain('aria-expanded={open}')
    expect(row).toContain('data-testid={`widget-item-toggle-${i.id}`}')
    expect(row).toContain("title={open ? 'Hide details · double-click to open the item' : 'Click for details · double-click to open the item'}")
    expect(row).not.toContain('onClick={goAttention}\n          title={i.title}')
    // the rest row keeps DEC-050's anatomy: the date beside the title
    expect(row).toContain("new Date(i.dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })")
  })

  it('one click: the summary — notes, reason, chips, priority, subtasks, the Meet invitation', () => {
    expect(row).toContain('data-testid={`widget-item-open-${i.id}`}')
    expect(row).toContain('const notes = (i.description || \'\').trim()')
    expect(row).toContain('const ctx = itemContext(i, nodesById)')
    expect(row).toContain('subtaskProgress(i.id, all, (x) => isTerminalState(x.workItemState))')
    expect(row).toContain("const invite = queueOf(i) === 'to_meet' ? meetingOf(i) : null")
    expect(row).toContain('{invite?.isInvite && (')
    expect(row).toContain("{(['yes', 'maybe', 'no'] as const).map((answer) => (")
  })

  it('the links: the meeting chip, the message chip (DEC-127), the desk, the plan, mentions', () => {
    expect(row).toContain('data-testid="widget-item-meeting-link"')
    expect(row).toContain('onClick={() => openMeetingMoment(ctx.source!.ref)}')
    expect(row).toContain('data-testid="widget-item-message-link"')
    expect(row).toContain('onClick={() => openMessageLink(i.sourceUrl)}')
    expect(row).toContain('<button data-row-action onClick={openDesk} title="Open the desk" className={chipClass}>')
    expect(row).toContain('onClick={() => goProject(ctx.plan!.id)}')
    expect(row).toContain("else if (m.kind === 'room') goRoom(m.id)")
  })

  it("the actions: the page's own row cluster — source door, desk, Start with Plexii, Snooze, Archive, Open the item, the page", () => {
    expect(row).toContain('data-testid={`widget-item-actions-${i.id}`}')
    expect(row).toContain('if (moment) openMeetingMoment(moment.meetingId, moment.segmentId)')
    expect(row).toContain('else if (!openMessageLink(i.sourceUrl)) void window.api.files.openExternal(i.sourceUrl!)')
    expect(row).toContain('onClick={() => startWithPlexii([i], nodes)}')
    expect(row).toContain('title="Snooze until tomorrow morning"')
    expect(row).toContain("onClick={() => void setState(i.id, 'archived')}")
    expect(row).toContain('title="Open the item — the full view, right here"')
    expect(row).toContain('data-testid={`widget-item-page-${i.id}`}')
    expect(row).toContain('onClick={() => goAttention()}')
    // snooze is the page's rule: tomorrow, 9am
    expect(row).toContain('d.setDate(d.getDate() + 1)\n    d.setHours(9, 0, 0, 0)')
  })

  it('double-click: the full item, the page\'s editor, portalled to <body> so the floating panel cannot clip it', () => {
    expect(row).toContain("if ((e.target as HTMLElement).closest('[data-row-action]')) return\n        setEditing(true)")
    expect(row).toContain("import { createPortal } from 'react-dom'")
    expect(row).toContain('createPortal(\n          <AttentionItemEditor')
    expect(row).toContain('document.body')
    expect(row).toContain("nodes.filter((n) => n.kind === 'task' && !n.archived && !n.sharedRootId)")
    expect(row).toContain('if (changed) void refresh()')
  })

  it('closing and status changes still run the one accounted path (DEC-051)', () => {
    expect(row).toContain('void closeItem(i, primary.state)')
    expect(row).toContain('if (next === primary.state) void closeItem(i, next)')
  })
})

describe('dec_128 — every host gets it, and none clips it', () => {
  it('ItemLines renders the row for all five widget faces; the lists scroll', () => {
    expect(widgets).toContain('<WidgetItemRow key={i.id} i={i} dense={dense} nowMs={nowMs} />')
    expect(widgets.match(/<ItemLines /g)?.length).toBe(5)
    expect(widgets).toContain('<div className="mt-2 flex-1 min-h-0 overflow-y-auto">')
    expect(widgets).toContain('<div className="mt-1.5 flex-1 min-h-0 overflow-y-auto" data-testid="attention-widget-list">')
    expect(widgets).not.toContain("${scroll ? 'overflow-y-auto' : 'overflow-hidden'}")
  })

  it('the assistant tab and the desk widget are the same component', () => {
    // DEC-131: the mount grew a capture door (onCapture) and went multi-line
    expect(tab).toContain('<AttentionWidget\n        size="lg"\n        storageKey="attention.assistant.section"\n        limit={Number.POSITIVE_INFINITY}\n        scroll\n        onCapture={() => openConsole()}\n      />')
    expect(widgets).toContain('<AttentionWidget\n            size="lg"\n            itemsOverride={effective}')
  })
})

describe('dec_128 — the doors are shared with the page, not copied', () => {
  it('Start with Plexii: one lib — desk first, the panel on chat, staged twice, never sent', () => {
    expect(start).toContain('export function startWithPlexii(list: FbNode[], nodes: readonly FbNode[]): boolean {')
    expect(start).toContain("chrome.setTab('chat')")
    expect(start).toContain('chrome.openPanel()')
    expect(start).toContain("new CustomEvent('fb:composer-stage', { detail: prompt })")
    expect(start).toContain('setTimeout(stage, 400)')
    expect(start).not.toContain('.send(')
    expect(view).toContain("import { startWithPlexii as startItemsWithPlexii } from '../../lib/startWithPlexii'")
    // the page no longer dispatches it itself (a comment still names the seam)
    expect(view).not.toContain("new CustomEvent('fb:composer-stage'")
  })

  it('the meeting moment: one lib — PlexiMeet, then the hand-off once mounted', () => {
    expect(meeting).toContain('export function openMeetingMoment(meetingId: string, segmentId?: string | null): void {')
    expect(meeting).toContain('useViewStore.getState().goMeetings()')
    expect(meeting).toContain("new CustomEvent('fb:open-meeting', {")
    expect(view).toContain('openMeetingMoment(meetingId, segmentId)')
    expect(view).not.toContain("new CustomEvent('fb:open-meeting'")
  })
})
