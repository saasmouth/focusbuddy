import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SPEAKER_PALETTE,
  UNKNOWN_SPEAKER,
  speakerOrder,
  speakerColor,
  speakerInitials,
  spokenMsBySpeaker,
  speakerChanges,
  questionCount,
  transcriptSpanMs,
  timelineBands,
  segmentAtMs,
  filterSegments,
  fmtClock,
  fmtDuration
} from '../../src/renderer/src/lib/meetingRecordStats'
import type { TranscriptSegment } from '../../src/shared/meetings'

// ── DEC-115 — the meeting Record reorganised. Operator direction (three
// reference screenshots, "a design direction, not the trump card"): the
// transcript tagged by person, searchable and linked; action items with a
// checkbox and a bell into Attention; analytics filterable by person; all of
// it organised and categorised; Find commitments kept; core function kept.
//
// Two halves here. The numbers are pure functions over the segments, so the
// suite vouches for every figure the Analytics tab and timeline show. The
// layout is pinned as source strings, the house convention, so a refactor
// cannot quietly fold the transcript back into a tab or drop a door.

const ROOT = join(__dirname, '..', '..')
const read = (p: string): string => readFileSync(join(ROOT, 'src', p), 'utf-8')
const view = read('renderer/src/components/views/PlexiMeetView.tsx')
const stats = read('renderer/src/lib/meetingRecordStats.ts')

const seg = (id: string, speakerName: string, startMs: number, endMs: number, text: string): TranscriptSegment => ({
  id,
  meetingId: 'm1',
  speakerAccountId: speakerName ? `acct-${speakerName}` : null,
  speakerName,
  startMs,
  endMs,
  text,
  confidence: 0.9
})

// A short call: two named people, one unattributed line, two questions.
const CALL: TranscriptSegment[] = [
  seg('s1', 'Dana', 0, 4000, 'Morning — can we start with the budget?'),
  seg('s2', 'Ryan', 4000, 10000, 'Sure. I will send the revised numbers by Friday.'),
  seg('s3', 'Dana', 10000, 12000, 'Great.'),
  seg('s4', '', 12000, 15000, 'Did anyone ping legal?'),
  seg('s5', 'Ryan', 15000, 20000, 'Not yet, I own that.')
]

describe('DEC-115 — the numbers are facts over the segments', () => {
  it('speakers come in order of first appearance; a blank name is the neutral fallback', () => {
    expect(speakerOrder(CALL)).toEqual(['Dana', 'Ryan', UNKNOWN_SPEAKER])
    expect(speakerOrder([])).toEqual([])
    expect(speakerOrder([seg('x', '   ', 0, 1, 'hm')])).toEqual([UNKNOWN_SPEAKER])
  })

  it('colours follow appearance order, accent leads, and the palette wraps rather than runs out', () => {
    const order = speakerOrder(CALL)
    expect(speakerColor('Dana', order)).toBe(SPEAKER_PALETTE[0])
    expect(speakerColor('Dana', order)).toBe('rgb(var(--accent))')
    expect(speakerColor('Ryan', order)).toBe(SPEAKER_PALETTE[1])
    // Unknown to the order → the lead colour, never an undefined swatch.
    expect(speakerColor('Nobody', order)).toBe(SPEAKER_PALETTE[0])
    const many = Array.from({ length: SPEAKER_PALETTE.length + 1 }, (_, i) => `P${i}`)
    expect(speakerColor(many[SPEAKER_PALETTE.length], many)).toBe(SPEAKER_PALETTE[0])
  })

  it('initials: first + last, a single word takes two letters, nothing is a question mark', () => {
    expect(speakerInitials('Dana Ortiz')).toBe('DO')
    expect(speakerInitials('ryan')).toBe('RY')
    expect(speakerInitials('Jean-Luc van Picard')).toBe('JP')
    expect(speakerInitials('')).toBe('?')
    expect(speakerInitials('   ')).toBe('?')
  })

  it('spoken time is summed per speaker from segment spans, clamped at zero', () => {
    const m = spokenMsBySpeaker(CALL)
    expect(m.get('Dana')).toBe(6000)
    expect(m.get('Ryan')).toBe(11000)
    expect(m.get(UNKNOWN_SPEAKER)).toBe(3000)
    // An inverted span (bad timestamps) contributes nothing, not a negative.
    expect(spokenMsBySpeaker([seg('b', 'Dana', 500, 100, 'x')]).get('Dana')).toBe(0)
  })

  it('speaker changes count the hand-offs, questions count the marks, span is the last end', () => {
    expect(speakerChanges(CALL)).toBe(4)
    expect(speakerChanges([])).toBe(0)
    expect(speakerChanges([CALL[0]])).toBe(0)
    expect(speakerChanges([CALL[0], CALL[2]])).toBe(0)
    expect(questionCount(CALL)).toBe(2)
    expect(transcriptSpanMs(CALL)).toBe(20000)
    expect(transcriptSpanMs([])).toBe(0)
  })

  it('timeline bands are proportional, a sliver survives, nothing paints past the end', () => {
    expect(timelineBands(CALL, 0)).toEqual([])
    const bands = timelineBands(CALL, 20000)
    expect(bands.map((b) => b.id)).toEqual(['s1', 's2', 's3', 's4', 's5'])
    expect(bands[0]).toMatchObject({ speaker: 'Dana', leftPct: 0, widthPct: 20, startMs: 0 })
    expect(bands[2].widthPct).toBe(10)
    expect(bands[3].speaker).toBe(UNKNOWN_SPEAKER)
    // A 10 ms interjection still gets the minimum sliver.
    const sliver = timelineBands([seg('t', 'Dana', 1000, 1010, 'mm')], 20000)[0]
    expect(sliver.widthPct).toBe(0.4)
    // A segment stamped after the total (audio longer than the takes) clamps.
    expect(timelineBands([seg('late', 'Dana', 30000, 31000, 'x')], 20000)[0].leftPct).toBe(100)
  })

  it('segmentAtMs: containing segment first, else the nearest by start, null when empty', () => {
    expect(segmentAtMs(CALL, 5000)?.id).toBe('s2')
    expect(segmentAtMs(CALL, 0)?.id).toBe('s1')
    expect(segmentAtMs(CALL, 20000)?.id).toBe('s5')
    expect(segmentAtMs(CALL, -1)?.id).toBe('s1')
    expect(segmentAtMs([], 5000)).toBeNull()
    // A gap between segments resolves to the nearer start.
    const gappy = [seg('a', 'Dana', 0, 1000, 'x'), seg('b', 'Ryan', 9000, 10000, 'y')]
    expect(segmentAtMs(gappy, 8000)?.id).toBe('b')
    expect(segmentAtMs(gappy, 2000)?.id).toBe('a')
  })

  it('filterSegments: by person, by text (case-insensitive), both, or neither', () => {
    expect(filterSegments(CALL, {})).toHaveLength(5)
    expect(filterSegments(CALL, { query: '   ' })).toHaveLength(5)
    expect(filterSegments(CALL, { speaker: 'Ryan' }).map((s) => s.id)).toEqual(['s2', 's5'])
    expect(filterSegments(CALL, { speaker: UNKNOWN_SPEAKER }).map((s) => s.id)).toEqual(['s4'])
    expect(filterSegments(CALL, { query: 'FRIDAY' }).map((s) => s.id)).toEqual(['s2'])
    expect(filterSegments(CALL, { speaker: 'Ryan', query: 'friday' }).map((s) => s.id)).toEqual(['s2'])
    expect(filterSegments(CALL, { speaker: 'Dana', query: 'legal' })).toEqual([])
  })

  it('clock and duration formatting', () => {
    expect(fmtClock(0)).toBe('0:00')
    expect(fmtClock(65000)).toBe('1:05')
    expect(fmtClock(3599999)).toBe('59:59')
    expect(fmtClock(-5)).toBe('0:00')
    // Sub-minute says its seconds — "0 min" for a 24-second call is a lie.
    expect(fmtDuration(0)).toBe('0 s')
    expect(fmtDuration(24000)).toBe('24 s')
    expect(fmtDuration(59400)).toBe('59 s')
    expect(fmtDuration(60000)).toBe('1 min')
    expect(fmtDuration(42 * 60000)).toBe('42 min')
    expect(fmtDuration(90000)).toBe('2 min')
    expect(fmtDuration(65 * 60000)).toBe('1 h 05 min')
    expect(fmtDuration(-5000)).toBe('0 s')
  })

  it('the SPEC-003 boundary is written into the module: distribution, never a ranking', () => {
    expect(stats).toContain('It never ranks people')
    expect(stats).toContain('talk-time scoring is')
  })
})

describe('DEC-115 — the Record layout: renderings beside an always-visible transcript', () => {
  it('three renderings, no Thread tab — the transcript is its own column', () => {
    expect(view).toContain("type RecordView = 'commitments' | 'brief' | 'analytics'")
    // History: DEC-115 pinned these as raw data-testids on plain cards; the
    // Home-material round (DEC-116) made every panel a kit RailCard, which
    // takes the id as `testId` and lands it on its <section>. Same ids, same
    // elements in the live DOM.
    expect(view).toContain('testId="meet-record-pane"')
    expect(view).toContain('testId="meet-transcript-pane"')
    expect(view).toContain('data-testid="rendering-thread" ref={threadRef}')
    expect(view).toContain("if (e.key === '1') setView('brief')")
    expect(view).toContain("if (e.key === '2') setView('commitments')")
    expect(view).toContain("if (e.key === '3') setView('analytics')")
  })

  it('the transcript is tagged by person, searchable ("/" lands in the box), and highlighted', () => {
    expect(view).toContain('data-testid="meet-transcript-search"')
    expect(view).toContain('placeholder="Search the transcript"')
    expect(view).toContain("if (e.key === '/')")
    expect(view).toContain('searchRef.current?.focus()')
    expect(view).toContain('data-testid="meet-speaker-chip-all"')
    expect(view).toContain('data-testid={`meet-speaker-chip-${name}`}')
    expect(view).toContain('filterSegments(segments, { speaker: speakerFilter, query })')
    expect(view).toContain('<mark key={i} className="bg-[rgb(var(--accent)/0.18)]')
    expect(view).toContain('style={{ color: colorOf(name) }}')
    expect(view).toContain('data-testid="meet-transcript-empty-filter"')
    expect(view).toContain('No transcript for this meeting.')
  })

  it('every timestamp is a link: the row anchors survive and jumping no longer needs a tab switch', () => {
    expect(view).toContain('data-segment-id={s.id}')
    expect(view).toContain('const jumpToSegment = (segmentId: string): void => {')
    expect(view).not.toContain("setView('thread')")
    expect(view).toContain('setActiveSegmentId(segmentId)')
    expect(view).toContain("scrollIntoView({ block: 'center', behavior: 'smooth' })")
    // A filter that would hide the target is cleared, so a Brief row or a
    // Recall hit can never land on an empty list.
    expect(view).toContain("if (speakerFilter && (target.speakerName?.trim() || 'Speaker') !== speakerFilter) setSpeakerFilter(null)")
    expect(view).toContain("active ? 'bg-[rgb(var(--accent)/0.10)]'")
    // And the reverse: a line that anchors a Brief entry or an action item
    // wears a chip that opens it — links run both ways.
    expect(view).toContain('const rowAnchors = markers.filter((m) => m.segmentId === s.id)')
    expect(view).toContain('data-brief-section={section}')
    expect(view).toContain("a.kind === 'heard' ? `In Brief · ${a.section}` : 'Action item'")
    expect(view).toContain("function openAnchor(a: { kind: 'heard' | 'item'; section?: string; itemId?: string }): void {")
    expect(view).toContain("setView(a.kind === 'heard' ? 'brief' : 'commitments')")
  })

  it('the timeline is a door into the call, built from bands and marked with moments', () => {
    expect(view).toContain('testId="meet-timeline"')
    expect(view).toContain('data-testid="meet-timeline-bar"')
    expect(view).toContain('onClick={seekTimeline}')
    expect(view).toContain('segmentAtMs(segments, frac * totalMs)')
    expect(view).toContain('Click the timeline to move through the call')
    expect(view).toContain('data-testid="meet-timeline-markers"')
    expect(view).toContain("if (s.tier === 'heard' && s.segmentId && s.startMs != null)")
    expect(view).toContain('parseMeetingMomentUrl(i.sourceUrl)')
  })

  it('Action items: checkbox closes with the house terminal state; the bell files with the meeting as source', () => {
    expect(view).toContain('data-testid="rendering-commitments"')
    // DEC-144: Attention is Focus.
    expect(view).toContain('the bell adds it to Focus with a link back to the moment it was said')
    // The operator's keeper.
    expect(view).toContain('data-testid="find-commitments"')
    expect(view).toContain('an honest zero, not a failure')
    // Filed items are the work items that point at this meeting; dismissed
    // and archived ones do not haunt the list.
    expect(view).toContain('data-testid="meet-filed-items"')
    expect(view).toContain('if (i.sourceRef !== meeting.id) return false')
    expect(view).toContain("return st !== 'dismissed' && st !== 'archived'")
    expect(view).toContain('data-testid={`meet-item-done-${i.id}`}')
    expect(view).toContain('isTerminalState(itemState(i))')
    expect(view).toContain("await setItemState(i.id, done ? 'open' : 'completed')")
    expect(view).toContain('data-testid={`meet-item-moment-${i.id}`}')
    expect(view).toContain('CLASS_LABEL[i.intentClass]')
    // Legacy summary lines: Desk stays, the bell is new, and what it files
    // is a human-origin, already-approved item — no silent assignment.
    expect(view).toContain('data-testid={`meet-make-task-${i}`}')
    expect(view).toContain('data-testid={`meet-legacy-bell-${i}`}')
    // A filed line is promoted, not duplicated: it leaves "From the summary"
    // for the checkbox list, and comes back if dismissed from Attention.
    expect(view).toContain('const unfiledLegacy = useMemo(() => {')
    expect(view).toContain('.filter(({ text }) => !filedTitles.has(text.trim().toLowerCase()))')
    expect(view).toContain('{unfiledLegacy.map(({ text: item, i }) => (')
    expect(view).toContain('<Icon name="radio_button_unchecked" size={18}')
    // The pills carry a count, not a key digit — the shortcut lives in the tooltip.
    expect(view).toContain('title={`${label} — press ${key}`}')
    expect(view).toContain("sourceType: 'meeting'")
    expect(view).toContain('sourceRef: meeting.id')
    expect(view).toContain("wiOrigin: 'human'")
    expect(view).toContain("approvalState: 'approved'")
    expect(view).toContain("intentClass: 'to_do'")
  })

  it('Analytics shows facts and a per-person filter — never a ranking, a score, or a mood', () => {
    expect(view).toContain('data-testid="rendering-analytics"')
    expect(view).toContain('<StatTile icon="schedule" label="Duration"')
    expect(view).toContain('label="Speaker changes"')
    expect(view).toContain('label="Questions asked"')
    expect(view).toContain('data-testid="meet-who-spoke"')
    expect(view).toContain('a fact from the attributed lines, not a score')
    expect(view).toContain('empty is an honest answer, not a failure')
    const lower = view.toLowerCase()
    for (const banned of ['longest speaker', 'talk time score', 'talk-time score', 'sentiment', 'engagement score'])
      expect(lower).not.toContain(banned)
  })

  it('the header keeps its doors: Desk, one Export menu with both formats, delete', () => {
    expect(view).toContain('data-testid="meet-open-desk"')
    expect(view).toContain('data-testid="meet-export"')
    expect(view).toContain('aria-expanded={exportOpen}')
    expect(view).toContain('data-testid="meet-export-md"')
    expect(view).toContain('data-testid="meet-export-json"')
    expect(view).toContain('data-testid="meet-delete"')
    expect(view).toContain('data-testid="meet-meta"')
    expect(view).toContain('<StatusPill tone={captureState.tone} label={captureState.label} />')
    expect(view).toContain('data-testid="meet-speakers"')
    expect(view).toContain('{speakerInitials(name)}')
  })

  it('Overview is the Brief organised by section, with the summary and plain text folded in', () => {
    expect(view).toContain('data-testid="rendering-brief-outer"')
    expect(view).toContain('data-testid="meet-summary"')
    expect(view).toContain('data-testid="brief-yours"')
    expect(view).toContain('Your notes')
    expect(view).toContain('Plain transcript text')
    expect(view).toContain('showTranscript || segments.length === 0')
  })
})
