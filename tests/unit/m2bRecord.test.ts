import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildYoursSpans, validateRecordSpans } from '../../src/renderer/src/lib/recordSpans'
import type { TranscriptSegment } from '../../src/shared/meetings'

// ── M2b (SPEC-003 §3.4) — the Record: one object, three renderings, and the
// provenance rule that makes the middle tier honest: heard can never be
// asserted, only PROVEN (S3-DEC-021).

const seg = (id: string, startMs: number): TranscriptSegment => ({
  id,
  meetingId: 'm1',
  speakerAccountId: 'a1',
  speakerName: 'Dana',
  startMs,
  endMs: startMs + 1000,
  text: 'words',
  confidence: 0.9
})

describe('M2b — buildYoursSpans: the user’s words, verbatim, never rewritten', () => {
  it('one span per non-empty line, byte-for-byte', () => {
    const spans = buildYoursSpans('- doug pushing back\n\n  ⚑ 12:34 legal must confirm  \n')
    expect(spans.map((s) => s.text)).toEqual(['- doug pushing back', '⚑ 12:34 legal must confirm'])
    expect(spans.every((s) => s.tier === 'yours' && s.segmentId === null)).toBe(true)
  })
  it('empty notes build nothing', () => {
    expect(buildYoursSpans('  \n \n')).toEqual([])
  })
})

describe('M2b — validateRecordSpans: heard is proven or it is inferred', () => {
  const segments = [seg('s1', 5000), seg('s2', 9000)]

  it('a heard span with a real anchor keeps its tier — startMs from the SEGMENT, never the model', () => {
    const out = validateRecordSpans(
      [{ tier: 'heard', text: 'doug said march', segmentId: 's2', section: 'Decisions' }],
      segments
    )
    expect(out).toEqual([
      { tier: 'heard', text: 'doug said march', segmentId: 's2', startMs: 9000, section: 'Decisions' }
    ])
  })

  it('a heard span whose anchor does not resolve is DOWNGRADED — no exceptions', () => {
    const out = validateRecordSpans(
      [
        { tier: 'heard', text: 'unprovable claim', segmentId: 'nope' },
        { tier: 'heard', text: 'anchorless claim' }
      ],
      segments
    )
    expect(out.every((s) => s.tier === 'inferred' && s.segmentId === null && s.startMs === null)).toBe(true)
  })

  it('a model-forged "yours" is a forgery — downgraded to inferred', () => {
    const out = validateRecordSpans([{ tier: 'yours', text: 'i totally typed this', segmentId: 's1' }], segments)
    expect(out[0].tier).toBe('inferred')
  })

  it('empty and non-string texts are dropped; sections normalise', () => {
    const out = validateRecordSpans(
      [
        { tier: 'inferred', text: '   ' },
        { tier: 'inferred', text: 42 as unknown as string },
        { tier: 'inferred', text: 'kept', section: '  Open questions  ' }
      ],
      segments
    )
    expect(out).toHaveLength(1)
    expect(out[0].section).toBe('Open questions')
  })
})

// ── source pins ─────────────────────────────────────────────────────────────
const ROOT = join(__dirname, '../..', 'src')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8')

describe('M2b — the Enhance contract', () => {
  it('the model is told: no segmentId, no heard — and yours is never its to produce', () => {
    const enh = read('main/ai/enhanceRecord.ts')
    expect(enh).toContain('A heard claim without its segmentId will be discarded as unproven')
    expect(enh).toContain('Never restate the attendee')
  })
  it('the wrap-up builds yours from notes and validates the rest, non-blocking', () => {
    const w = read('renderer/src/stores/wrapup.ts')
    expect(w).toContain('buildYoursSpans(notes ?? \'\')')
    expect(w).toContain('validateRecordSpans(enh.spans, savedSegments)')
    expect(w).toContain('Best-effort and NON-BLOCKING')
  })
})

describe('M2b — three renderings, Commitments default', () => {
  const ui = read('renderer/src/components/views/PlexiMeetView.tsx')
  it('the segmented control with 1/2/3, Commitments the default', () => {
    expect(ui).toContain("useState<RecordView>('commitments')")
    // testids are template-generated per view key
    expect(ui).toContain('data-testid={`record-view-${v}`}')
    // History: M2b shipped Commitments / Brief / Thread as three tabs with
    // Commitments first. The Record reorganisation (DEC-115) keeps Commitments
    // as the DEFAULT (S3-DEC-022 still holds — the shortest artifact opens)
    // but the Thread stopped being a tab: the transcript is always on screen
    // beside the renderings, and the third tab became Analytics. Overview
    // (the Brief + summary) leads the order because it reads left-to-right
    // as "what happened → what I owe → the numbers".
    for (const v of ["'brief', 'Overview', '1'", "'commitments', 'Action items', '2'", "'analytics', 'Analytics', '3'"])
      expect(ui).toContain(v)
    expect(ui).not.toContain("'thread', 'Thread'")
  })
  it('the provenance treatment: yours full ink, heard ruled + jumpable, inferred lighter', () => {
    expect(ui).toContain('data-testid="brief-yours"')
    expect(ui).toContain('data-tier="heard"')
    expect(ui).toContain('data-tier="inferred"')
    expect(ui).toContain('border-l-2 border-[var(--edge-strong)]')
    expect(ui).toContain('jumpToSegment(s.segmentId!)')
  })
  it('the Thread shows real segments with confidence honesty', () => {
    expect(ui).toContain('data-segment-id={s.id}')
    expect(ui).toContain("'Engine confidence unknown (on-device)'")
    expect(ui).toContain('s.confidence != null && s.confidence < 0.5')
  })
})

describe('M2b — the record persists', () => {
  it('record_json rides fb_meetings; patch carries it', () => {
    // ensureColumn calls moved to migrations.ts with the rest of the phase.
    expect(
      read('main/db/database.ts') + read('main/db/migrations.ts')
    ).toContain("ensureColumn(db, 'fb_meetings', 'record_json', 'TEXT')")
    expect(read('main/db/meetings.ts')).toContain('record: parseRecord(row.record_json)')
    expect(read('shared/meetings.ts')).toContain('record?: MeetingRecord | null')
  })
})
