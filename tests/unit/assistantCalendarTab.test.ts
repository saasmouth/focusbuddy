// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultSlotFor, monthCells, sameDay, startOfDay } from '../../src/renderer/src/lib/monthGrid'

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8')
const tab = read('src/renderer/src/components/assistant/tabs/AssistantCalendarTab.tsx')
const overlay = read('src/renderer/src/components/assistant/AssistantOverlay.tsx')
const store = read('src/renderer/src/stores/assistantChrome.ts')
const attentionTab = read('src/renderer/src/components/assistant/tabs/AssistantAttentionTab.tsx')
const widgets = read('src/renderer/src/components/views/attentionWidgets.tsx')
const messages = read('src/renderer/src/components/views/MessagesView.tsx')
const composer = read('src/renderer/src/components/views/chat/ChatComposer.tsx')
const book = read('src/renderer/src/lib/bookBlock.ts')
const grid = read('src/renderer/src/components/views/WeekTimeGrid.tsx')

// DEC-131 — the assistant panel round: Message (not PlexiiMessage) with a
// one-row header and a panel-shaped composer; a + on Attention that captures;
// and a Calendar tab — today's day column, the month at a glance, a day click
// that books through the calendar's own dialog and path.

describe('dec_131 — the month at a glance (pure)', () => {
  it('42 cells from the Sunday on or before the 1st, tiling six weeks', () => {
    const cells = monthCells(new Date(2026, 8, 1)) // September 2026 — the 1st is a Tuesday
    expect(cells).toHaveLength(42)
    expect(cells[0].getDay()).toBe(0)
    expect(cells[0].getDate()).toBe(30) // Aug 30
    expect(cells[2].getDate()).toBe(1)
    expect(cells[41].getDate()).toBe(10) // Oct 10
    // Consecutive CALENDAR days at local midnight, not a fixed 24h delta. A day
    // is not always 86400000ms: this grid spans 30 Aug to 10 Oct 2026, and a
    // daylight-saving transition inside that range makes one day 23 hours, so
    // the fixed-delta assertion failed anywhere observing DST in that window
    // (Australia/Adelaide) while passing under UTC. monthCells already steps by
    // calendar date and was correct; only the assertion assumed otherwise.
    for (let i = 1; i < cells.length; i++) {
      const prev = cells[i - 1]
      const nextDay = new Date(prev.getFullYear(), prev.getMonth(), prev.getDate() + 1)
      expect(cells[i].getTime()).toBe(nextDay.getTime())
      expect(cells[i].getHours()).toBe(0)
    }
  })
  it('a picked day opens on 9:00; today opens on the next round half hour', () => {
    const tomorrow = new Date(2026, 8, 8)
    const t = new Date(defaultSlotFor(tomorrow, new Date(2026, 8, 7, 14, 12).getTime()))
    expect([t.getHours(), t.getMinutes()]).toEqual([9, 0])
    expect(sameDay(t, tomorrow)).toBe(true)
    const today = new Date(2026, 8, 7, 14, 12)
    const s = new Date(defaultSlotFor(startOfDay(today), today.getTime()))
    expect([s.getHours(), s.getMinutes()]).toEqual([14, 30])
    const late = new Date(2026, 8, 7, 14, 45)
    const s2 = new Date(defaultSlotFor(startOfDay(late), late.getTime()))
    expect([s2.getHours(), s2.getMinutes()]).toEqual([15, 0])
  })
})

describe('dec_131 — the Calendar tab', () => {
  it('is the fifth tab, after Attention, and the strip renders it', () => {
    expect(store).toContain("export const ASSISTANT_TABS: AssistantTab[] = ['chat', 'attention', 'calendar', 'messages', 'agent']")
    expect(overlay).toContain("{ id: 'calendar', label: 'Calendar', icon: 'calendar_month' }")
    expect(overlay).toContain("{activeTab === 'calendar' && <AssistantCalendarTab />}")
  })
  it("the day is the Attention rail's own column; ‹ Today › walks days; the month toggles", () => {
    // the column FILLS the tab (operator: "so it doesn't cut off before the bottom")
    expect(tab).toContain('<WeekTimeGrid weekStart={day} days={1} compact fill />')
    expect(grid).toContain("className={`flex overflow-y-auto overscroll-contain pt-2 ${fill ? 'flex-1 min-h-0' : ''}`}")
    expect(grid).toContain("style={fill ? undefined : { maxHeight: compact ? 12 * hourPx : 'max(280px, calc(100vh - 380px))' }}")
    expect(tab).toContain('data-testid="assistant-calendar-prev"')
    expect(tab).toContain('data-testid="assistant-calendar-today"')
    expect(tab).toContain('data-testid="assistant-calendar-next"')
    expect(tab).toContain('data-testid="assistant-calendar-month-toggle"')
    expect(tab).toContain("useState<'day' | 'month'>('day')")
  })
  it('the month reads its own slice — never the shared range — and dots the booked days', () => {
    expect(tab).toContain('const tick = useTimeBlockStore((s) => s.blocks.length)')
    expect(tab).not.toContain('loadRange(')
    expect(tab).toContain('window.api.timeBlocks\n      .list(from, to)')
    expect(tab).toContain('data-booked={booked || undefined}')
  })
  it('a day click opens the Book-time dialog on that day (portalled), and booking runs the calendar\'s own path', () => {
    expect(tab).toContain('setBooking(defaultSlotFor(d))')
    expect(tab).toContain('createPortal(\n          <BookTimeDialog')
    expect(tab).toContain('document.body')
    expect(tab).toContain('await bookBlockWithToast({ taskId, title, startMs, durationMin, meeting, recurrence })')
    expect(book).toContain('export async function bookBlockWithToast(draft: TimeBlockDraft): Promise<TimeBlock> {')
    expect(grid).toContain('await bookBlockWithToast({ taskId, title, startMs, durationMin, meeting, recurrence })')
  })
})

describe('dec_131 — Attention gets a +', () => {
  it('the widget wears a capture door when asked; the tab asks, through the house capture prompt', () => {
    expect(widgets).toContain('onCapture?: () => void')
    expect(widgets).toContain('data-testid="attention-widget-capture"')
    expect(attentionTab).toContain("import { useCaptureConsole } from '../../../stores/captureConsole'")
    expect(attentionTab).toContain('onCapture={() => openConsole()}')
  })
})

describe('dec_131 — the Message tab', () => {
  it('reads "Message"; the header is one row — the people, then Meet · Recall · pin; no members button in the panel', () => {
    expect(overlay).toContain("{ id: 'messages', label: 'Message', icon: 'chat' }")
    expect(overlay).not.toContain("label: 'PlexiiMessage'")
    expect(messages).toContain('<div className="flex items-center gap-1.5 shrink-0" data-testid="messages-actions">')
    expect(messages).toContain("{compact ? panelTitle : headerTitle}")
    expect(messages).toContain("? others.map((m) => personDisplayName(m, m.handle ?? 'teammate')).join(', ')")
    expect(messages).toContain('{activeId && activeConv && !compact && (\n                  <div className="relative">\n                    <button\n                      onClick={() => setShowMembers((v) => !v)}')
  })
  it("the panel's composer: no meeting door, the mic inside the box at its right, attach · emoji · GIF kept, a taller box", () => {
    expect(messages).toContain('compact={compact}')
    expect(composer).toContain('compact?: boolean')
    expect(composer).toContain('{!compact && (\n          <button\n            onClick={() => void launchMeeting(')
    expect(composer).toContain("className={`absolute right-1.5 bottom-1.5 icon-btn !h-7 !w-7 ${recording ? 'text-rose-500' : ''}`}")
    // The panel is always stacked; a narrow chat widget stacks the same way.
    expect(composer).toContain('const stacked = compact || narrow')
    expect(composer).toContain('rows={stacked ? 3 : 1}')
    expect(composer).toContain("stacked ? 'pr-10 min-h-[76px]' : ''")
    // the Office page keeps every button where it was
    expect(composer).toContain('data-testid="composer-meet"')
    expect(composer).toContain('data-testid="composer-attach"')
    expect(composer).toContain('data-testid="composer-gif"')
    expect(composer).toContain('data-testid="composer-emoji"')
  })
})
