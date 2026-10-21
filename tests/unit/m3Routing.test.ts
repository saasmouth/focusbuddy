import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateCommitments, fmtAnchor } from '../../src/renderer/src/lib/commitments'
import type { TranscriptSegment } from '../../src/shared/meetings'

// ── M3 (SPEC-003 §3.6) — routing into Attention: the part nobody else does.
// Commitments never file silently (S3-DEC-023); other-owned ones arrive
// unchecked with the owner as a MENTION, never a send (C7 / SPEC-027
// boundary); anchors are validated, and an unanchored commitment is marked
// as the machine's guess.

const seg = (id: string, startMs: number, speaker = 'Dana', accountId: string | null = 'a1'): TranscriptSegment => ({
  id,
  meetingId: 'm1',
  speakerAccountId: accountId,
  speakerName: speaker,
  startMs,
  endMs: startMs + 1000,
  text: 'I will send the contract by Friday',
  confidence: 0.9
})

describe('M3 — validateCommitments', () => {
  const segments = [seg('s1', 5000), seg('s2', 60000, 'Sam', 'a2')]

  it('mine (or unowned) arrives CHECKED; someone else’s arrives UNCHECKED', () => {
    const out = validateCommitments(
      [
        { title: 'Send the contract', ownerAccountId: 'me-id', segmentId: 's1' },
        { title: 'Review the deck', ownerAccountId: 'a2', ownerName: 'Sam', segmentId: 's2' },
        { title: 'Confirm the venue' }
      ],
      segments,
      'me-id'
    )
    expect(out.map((c) => c.checked)).toEqual([true, false, true])
    expect(out[1].mine).toBe(false)
    expect(out[1].ownerName).toBe('Sam')
  })

  it('a real anchor keeps the moment; a broken one is stripped and marked', () => {
    const out = validateCommitments(
      [
        { title: 'Anchored', segmentId: 's1' },
        { title: 'Broken anchor', segmentId: 'nope' },
        { title: 'No anchor' }
      ],
      segments,
      'me-id'
    )
    expect(out[0].anchored).toBe(true)
    expect(out[0].segment?.startMs).toBe(5000)
    expect(out[1].anchored).toBe(false)
    expect(out[1].segment).toBeNull()
    expect(out[2].anchored).toBe(false)
  })

  it('dates must parse; classes canonicalise; garbage titles are dropped', () => {
    const out = validateCommitments(
      [
        { title: 'Dated', dueAt: '2026-09-05', intentClass: 'to_respond' },
        { title: 'Bad date', dueAt: 'friday-ish' },
        { title: '   ' },
        { title: 'Weird class', intentClass: 'not-a-class' }
      ],
      segments,
      'me'
    )
    expect(out).toHaveLength(3)
    expect(out[0].dueAt).toBe('2026-09-05')
    expect(out[0].intentClass).toBe('to_respond')
    expect(out[1].dueAt).toBeNull()
    expect(out[2].intentClass).toBe('to_do')
  })

  it('fmtAnchor speaks minutes', () => {
    expect(fmtAnchor(65_000)).toBe('1:05')
  })
})

// ── source pins ─────────────────────────────────────────────────────────────
const ROOT = join(__dirname, '../..', 'src')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8')

describe('M3 — the extractor contract', () => {
  it('anchors are optional-but-honest; owners come only from the roster; zero is valid', () => {
    const ex = read('main/ai/extractCommitments.ts')
    expect(ex).toContain('the item will be marked unverified, which is honest; a wrong anchor is not')
    expect(ex).toContain('ONLY from the roster given')
    expect(ex).toContain('0 commitments is a valid answer')
    expect(ex).toContain('Never invent deadlines')
  })
})

describe('M3 — the confirm stop', () => {
  const card = read('renderer/src/components/MeetingCommitmentsCard.tsx')
  it('nothing files silently; Enter files the checked set; one undo batch', () => {
    expect(card).toContain('nothing files until you say so')
    expect(card).toContain("useActionHistory.getState().beginBatch()")
    expect(card).toContain('Filed ${take.length} from the meeting')
  })
  it('other-owned files with the owner as a person MENTION — never a send (C7)', () => {
    expect(card).toContain("serializeMentions([{ kind: 'person', id: c.ownerAccountId")
    expect(card).toContain('owner is {c.ownerName ?? ')
  })
  it('anchored rows show the moment; unanchored ones look like the guess they are', () => {
    expect(card).toContain('[{fmtAnchor(c.segment.startMs)}] {c.segment.speakerName}')
    expect(card).toContain('No transcript anchor — the machine’s reading')
    expect(card).toContain('confidence: c.anchored ? 0.95 : 0.6')
  })
  it('everything stays on the meeting’s desk; items point home (sourceType meeting)', () => {
    expect(card).toContain('parentId: deskNodeId')
    expect(card).toContain("sourceType: 'meeting'")
  })
})

describe('M3 — wiring', () => {
  const w = read('renderer/src/stores/wrapup.ts')
  it('extraction is meetings-only and feeds the review, never Attention directly', () => {
    expect(w).toContain('meeting?.id && savedSegments.length && forceLocalTranscription')
    expect(w).toContain('commitments = validateCommitments(ex.commitments, savedSegments, selfId)')
  })
  // DEC-144 rewrite: action items arrive as create-work-item now that Focus is
  // always on, so both kinds leave the cards when commitments exist.
  it('C6 — commitments and create-task proposals are one door, not two', () => {
    expect(w).toContain("proposals.filter((p) => p.kind !== 'create-task' && p.kind !== 'create-work-item')")
  })
  it('Q14 — the host gets ONE machine-authored To Know brief', () => {
    expect(w).toContain("intentClass: 'to_know'")
    expect(w).toContain('Meeting brief — ${title')
    expect(w).toContain("wiOrigin: 'ai'")
  })
  it('the review leads with the confirm stop; past meetings get the same door', () => {
    expect(read('renderer/src/components/WrapupOverlay.tsx')).toContain('<MeetingCommitmentsCard')
    const view = read('renderer/src/components/views/PlexiMeetView.tsx')
    expect(view).toContain('data-testid="find-commitments"')
    expect(view).toContain('an honest zero, not a failure')
  })
})
