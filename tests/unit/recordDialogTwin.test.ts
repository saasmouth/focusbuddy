// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── DEC-118 — Record notes / Record external open the composer's twin too.
// Operator (2026-09-06): "Now do the same for the Record notes and Record
// external buttons." The same recipes as BookTimeDialog (and DEC-117's
// NewMeetingDialog), over what each recording can HONESTLY carry: a title,
// NOTES that become `yours` spans, a real desk for Record notes, and for
// Record external the one question that changes the capture — where the
// call is — with the disclosure stated in the dialog before anything runs.

const ROOT = join(__dirname, '..', '..')
const read = (p: string): string => readFileSync(join(ROOT, 'src', p), 'utf-8')
const record = read('renderer/src/components/RecordDialog.tsx')
const composer = read('renderer/src/components/BookTimeDialog.tsx')
const meet = read('renderer/src/components/views/PlexiMeetView.tsx')
const store = read('renderer/src/stores/guestCapture.ts')

// DEC-144: Attention was renamed Focus and its items are "tasks"; these pins follow the new words.
describe('DEC-118 — twins: the record dialog wears the composer\'s own strings', () => {
  const SHARED = [
    'relative grid grid-cols-2 rounded-full bg-[var(--surface-sunken)] p-1 select-none',
    'absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-full bg-[var(--surface-raised)] border border-[var(--edge-soft)] shadow-[0_1px_4px_rgba(0,0,0,0.08)]',
    "mode === m ? 'text-[rgb(var(--accent))]' : 'text-[var(--ink-50)]'",
    'w-full bg-transparent text-[23px] font-semibold text-[var(--ink-100)] placeholder:text-[var(--ink-50)] outline-none [&:focus-visible]:outline-none border-b border-[var(--edge-soft)] focus:border-[rgb(var(--accent))] pb-1.5 transition-colors',
    'Leave blank and it saves as',
    "'h-9 px-3 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] text-[13px] font-medium ' +",
    "? 'bg-[var(--surface-raised)] border border-[var(--edge-soft)] text-[rgb(var(--accent))] shadow-[0_1px_3px_rgba(0,0,0,0.06)]'",
    'w-full px-3 py-2 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] outline-none [&:focus-visible]:outline-none border border-transparent focus:border-[rgb(var(--accent))] text-[13px] text-[var(--ink-100)] placeholder:text-[var(--ink-50)] resize-none transition-colors',
    'h-10 px-3 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] border border-[var(--edge-strong)] inline-flex items-center gap-2 text-[13px] text-[var(--ink-70)] fb-press transition-colors hover:text-[var(--ink-90)]',
    'Attach a desk or task',
    'inline-flex items-center gap-1 h-6 px-2 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[11px] font-semibold',
    'to discard',
    'className="btn-primary ml-auto"',
    'rounded bg-white/20 px-1 text-[11px] leading-4',
    'fb-card w-full max-w-[560px] overflow-hidden max-h-[86vh] flex flex-col shadow-[0_32px_80px_-16px_rgba(0,0,0,0.5)]',
    'px-6 pt-5 pb-5 flex flex-col gap-4 overflow-y-auto',
    'px-6 py-4 border-t border-[var(--edge-soft)] flex items-center gap-3 shrink-0'
  ]
  it.each(SHARED)('%s', (s) => {
    expect(composer).toContain(s)
    expect(record).toContain(s)
  })

  it('the slider chooses Record notes / Record external; the time row is honest — now, until you stop', () => {
    expect(record).toContain("['notes', 'mic', 'Record notes'],")
    expect(record).toContain("['external', 'radio_button_checked', 'Record external']")
    expect(record).toContain('data-testid={`record-mode-${m}`}')
    expect(record).toContain('Until you stop')
    expect(record).not.toContain('Focus time')
  })

  it('the keyboard map: Esc discards, Enter starts, Cmd+M flips; NOTES keeps Enter as its newline', () => {
    expect(record).toContain("if (e.key === 'Escape') {")
    expect(record).toContain("if ((e.metaKey || e.ctrlKey) && (e.key === 'm' || e.key === 'M')) {")
    expect(record).toContain("if (e.key === 'Enter' && !e.shiftKey) {")
    expect(record).toContain("if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) e.stopPropagation()")
  })
})

describe('DEC-118 — what each mode honestly carries', () => {
  it('Record notes: title, NOTES → yours spans, a REAL desk; the meeting it becomes gets all three', () => {
    expect(record).toContain('export interface RecordNotesDraft {')
    expect(record).toContain("onStartNotes({ title: finalTitle, notes: notes.trim(), deskNodeId: attached?.id ?? null })")
    expect(record).toContain('data-testid="record-attach-picker"')
    expect(record).not.toContain('STUB_ATTACH')
    // DEC-130: the door answers with WHY it did not open (denied / silent / failed), not a bare boolean
    expect(meet).toContain('async function startRecording(draft?: RecordNotesDraft): Promise<StartResult> {')
    // DEC-130: the notes door rides the on-device wrap-up now — the title
    // defaults the same way, the NOTES become `yours` spans there (buildYoursSpans
    // in the wrap-up, never rewritten), and the picked desk is the origin AND
    // the container the Record stands on (no desk minted over it).
    expect(meet).toContain("const title = draft?.title.trim() || `Meeting · ${fmtDate(Date.now())}`")
    expect(meet).toContain("notes: draft?.notes ?? '',")
    expect(meet).toContain('deskNodeId: draft?.deskNodeId ?? null')
    expect(meet).toContain('if (draft?.deskNodeId) markDeskOrigin(draft.deskNodeId, title)')
  })

  it('Record external: WHERE decides the capture — in the room never raises the picker; NOTES ride to the wrap-up', () => {
    expect(record).toContain("['both', 'headset_mic', 'A call on this Mac'],")
    expect(record).toContain("['mic', 'place', 'In the room']")
    expect(record).toContain("onStartExternal({ title: finalTitle, notes: notes.trim(), micOnly: where === 'mic' })")
    expect(record).toContain('Plexii can hear you, not them')
    expect(record).toContain('A disclosure bar stays on screen until you stop')
    expect(store).toContain('micOnly?: boolean')
    expect(store).toContain('if (!micOnly) {')
    expect(store).toContain("notes: notes?.trim() ?? ''")
    expect(store).toContain('const { title, moments, notes } = get()')
    // the CR-12 floor and its wording survive untouched
    expect(store).toContain('NO roster handshake')
    expect(store).toContain('display.getVideoTracks().forEach((t) => t.stop())')
    expect(store).toContain("export const GUESTS_ID = 'guests'")
  })

  it('the doors open the dialog first; nothing records until Start; the mic is reported honestly', () => {
    expect(meet).toContain("onClick={() => setRecordDialog('notes')}")
    expect(meet).toContain("onClick={() => setRecordDialog('external')}")
    expect(meet).toContain('data-testid="meet-record"')
    expect(meet).toContain('data-testid="meet-record-external"')
    expect(meet).toContain("useGuestCaptureStore.getState().start({ title: d.title, notes: d.notes, micOnly: d.micOnly })")
    expect(meet).not.toContain("start({ title: 'External meeting' })")
    // DEC-130: the dialog shows the door's own message — the old text survives as MIC_FAILED_MESSAGE for a refused getUserMedia
    expect(record).toContain('setError(r.message)')
    expect(read('renderer/src/lib/micHealth.ts')).toContain("export const MIC_FAILED_MESSAGE = 'Could not access the microphone. Check your system permissions.'")
    // the calendar's own Record external door is untouched — it carries the block's identity
    expect(read('renderer/src/components/views/WeekTimeGrid.tsx')).toContain('data-testid="block-record-external"')
  })
})
