import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  mergeTrackSegments,
  formatAttributedTranscript,
  fmtOffset
} from '../../src/renderer/src/lib/transcriptMerge'

// ── M2a (SPEC-003) — transcript truth ───────────────────────────────────────
// The transcript becomes SEGMENTS: attributed by capture (never by model),
// timestamped on one shared clock, with the engine's own confidence or an
// honest null. Meeting audio transcribes ON-DEVICE only (CR-11) — no silent
// cloud fallback exists on that path.

describe('M2a — mergeTrackSegments: arithmetic, not inference', () => {
  const seg = (startMs: number, endMs: number, text: string, confidence: number | null = 0.9) => ({
    startMs,
    endMs,
    text,
    confidence
  })

  it('interleaves two speakers by when each span was actually spoken', () => {
    const merged = mergeTrackSegments([
      { accountId: 'a1', speakerName: 'Dana', offsetMs: 0, durationSec: 60, text: '', segments: [seg(0, 2000, 'hello'), seg(9000, 11000, 'march is tight')] },
      { accountId: 'a2', speakerName: 'Sam', offsetMs: 500, durationSec: 60, text: '', segments: [seg(3000, 5000, 'hi dana')] }
    ])
    expect(merged.map((m) => `${m.speakerName}:${m.text}@${m.startMs}`)).toEqual([
      'Dana:hello@0',
      'Sam:hi dana@3500',
      'Dana:march is tight@9000'
    ])
  })

  it('a late-joining track is shifted by its offset on the shared clock', () => {
    const merged = mergeTrackSegments([
      { accountId: 'a2', speakerName: 'Sam', offsetMs: 120_000, durationSec: 30, text: '', segments: [seg(1000, 2000, 'sorry, late')] }
    ])
    expect(merged[0].startMs).toBe(121_000)
    expect(merged[0].endMs).toBe(122_000)
  })

  it('an engine that gave text only degrades to one attributed span — attribution survives', () => {
    const merged = mergeTrackSegments([
      { accountId: 'a1', speakerName: 'Dana', offsetMs: 4000, durationSec: 30, text: 'the whole take', segments: null }
    ])
    expect(merged).toEqual([
      { speakerAccountId: 'a1', speakerName: 'Dana', startMs: 4000, endMs: 34_000, text: 'the whole take', confidence: null }
    ])
  })

  it("'me' is a placeholder id, stored as null; empty spans are dropped", () => {
    const merged = mergeTrackSegments([
      { accountId: 'me', speakerName: 'You', offsetMs: 0, durationSec: 10, text: '', segments: [seg(0, 1000, 'mine'), seg(2000, 3000, '   ')] }
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].speakerAccountId).toBeNull()
  })

  it('confidence rides through untouched — the engine’s own belief, or null', () => {
    const merged = mergeTrackSegments([
      { accountId: 'a1', speakerName: 'D', offsetMs: 0, durationSec: 5, text: '', segments: [seg(0, 1000, 'x', 0.42), seg(1000, 2000, 'y', null)] }
    ])
    expect(merged.map((m) => m.confidence)).toEqual([0.42, null])
  })

  it('formats as the attributed transcript the summariser reads', () => {
    const merged = mergeTrackSegments([
      { accountId: 'a1', speakerName: 'Dana', offsetMs: 0, durationSec: 60, text: '', segments: [seg(65_000, 67_000, 'ship it')] }
    ])
    expect(formatAttributedTranscript(merged)).toBe('[1:05] Dana: ship it')
    expect(fmtOffset(605_000)).toBe('10:05')
  })
})

// ── source pins ─────────────────────────────────────────────────────────────
const ROOT = join(__dirname, '../..', 'src')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8')

describe('M2a — both engines yield timestamps', () => {
  it('local: return_timestamps on, chunks parsed, confidence an HONEST null', () => {
    // The pure decode/shaping logic moved to whisperCore in the
    // transcription-quality round (the `task` root-cause fix) — the pins
    // follow it, and its history comment names why.
    const core = read('main/ai/whisperCore.ts')
    expect(core).toContain('return_timestamps: true')
    expect(core).toContain('confidence: null')
    expect(core).toContain('transformers.js exposes no logprobs')
  })
  it('cloud: verbose_json segments finally parsed, exp(avg_logprob) as confidence', () => {
    const vn = read('main/ai/voiceNote.ts')
    expect(vn).toContain('Math.exp(s.avg_logprob)')
    expect(vn).toContain('the old parser threw them away')
  })
  it('a caller can force an engine; meetings force local (CR-11)', () => {
    const vn = read('main/ai/voiceNote.ts')
    expect(vn).toContain('input.forceProvider ?? getTranscriptionProvider()')
  })
})

describe('M2a — meeting audio never leaves the machine (CR-11)', () => {
  it('transcribeRecording pins the on-device engine with NO cloud fallback', () => {
    const tr = read('renderer/src/lib/transcribeRecording.ts')
    expect(tr).toContain("forceProvider: 'local'")
    expect(tr).toContain('no cloud fallback')
  })
  it('the meeting handoff marks its audio as local-only and names its speakers', () => {
    const store = read('renderer/src/stores/meetingRoom.ts')
    expect(store).toContain('forceLocalTranscription: true')
    expect(store).toContain('speakers[p.accountId] = personDisplayName(p, p.handle)')
  })
  it('the model warms while the meeting runs, not after it ends', () => {
    const store = read('renderer/src/stores/meetingRoom.ts')
    expect(store).toContain('window.api.voiceNote.preloadLocal()')
  })
  it('the wrap-up fails honestly on the track path — never a silent second disclosure', () => {
    const wrapup = read('renderer/src/stores/wrapup.ts')
    expect(wrapup).toContain('there is no cloud fallback — fix the local engine and re-run')
    expect(wrapup).toContain('{ forceLocal: true }')
  })
})

describe('M2a — the segments have a home', () => {
  it('the schema: attributed, timestamped, nullable confidence', () => {
    // Schema + migrations now live beside database.ts so both runtimes can run
    // them; read all three so this pins content rather than a file path.
    const db = read('main/db/database.ts') + read('main/db/migrations.ts') + read('main/db/schema.ts')
    expect(db).toContain('CREATE TABLE IF NOT EXISTS fb_transcript_segments')
    expect(db).toContain('speaker_account_id TEXT,')
    expect(db).toContain('confidence REAL,')
    expect(db).toContain('idx_fb_segments_meeting')
  })
  it('a deleted meeting takes its segments with it — no orphaned speech', () => {
    const mdb = read('main/db/meetings.ts')
    expect(mdb).toContain("DELETE FROM fb_transcript_segments WHERE meeting_id = ?")
  })
  it('saved atomically per meeting after the record exists', () => {
    const tdb = read('main/db/transcripts.ts')
    expect(tdb).toContain("DELETE FROM fb_transcript_segments WHERE meeting_id = ?")
    const wrapup = read('renderer/src/stores/wrapup.ts')
    expect(wrapup).toContain('window.api.meetings.saveSegments(meeting.id, segmentDrafts)')
  })
})
