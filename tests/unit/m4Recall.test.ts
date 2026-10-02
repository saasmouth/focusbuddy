// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  ensureSegmentFts,
  searchSegmentsDb,
  meetingRecallSourcesDb,
  attributedLine
} from '../../src/main/segmentRecall'
import type { ChunkDb } from '../../src/main/chunkIndex'

// M4 (SPEC-003 P4) — Recall over the transcript corpus. Real FTS5 through
// node:sqlite, per the chunkIndex precedent: the module's point is that a
// question finds the attributed line that answers it, and a mock cannot
// vouch for a MATCH expression.

const ROOT = join(__dirname, '..', '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8')

function freshDb(): ChunkDb {
  const db = new DatabaseSync(':memory:') as unknown as ChunkDb
  db.exec(`CREATE TABLE fb_meetings (
    id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', org_id TEXT NOT NULL DEFAULT 'personal'
  )`)
  db.exec(`CREATE TABLE fb_transcript_segments (
    id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, speaker_account_id TEXT,
    speaker_name TEXT NOT NULL DEFAULT '', start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL, text TEXT NOT NULL, confidence REAL,
    created_at INTEGER NOT NULL
  )`)
  ensureSegmentFts(db)
  return db
}

let segSeq = 0
function seedMeeting(db: ChunkDb, id: string, title: string, org = 'personal'): void {
  db.prepare('INSERT INTO fb_meetings (id, title, org_id) VALUES (?, ?, ?)').run(id, title, org)
}
function seedSegment(
  db: ChunkDb,
  meetingId: string,
  speakerName: string,
  startMs: number,
  text: string
): string {
  const id = `seg-${++segSeq}`
  db.prepare(
    `INSERT INTO fb_transcript_segments
       (id, meeting_id, speaker_account_id, speaker_name, start_ms, end_ms, text, confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)`
  ).run(id, meetingId, `acct-${speakerName.toLowerCase()}`, speakerName, startMs, startMs + 3000, text)
  return id
}

describe('searchSegmentsDb — the corpus query', () => {
  it('finds the attributed line that answers, with meeting identity attached', () => {
    const db = freshDb()
    seedMeeting(db, 'm1', 'Q3 pipeline review')
    seedSegment(db, 'm1', 'Dana', 12000, 'the vendor renewal needs a decision by Friday')
    seedSegment(db, 'm1', 'Sam', 45000, 'lunch order is settled')
    const hits = searchSegmentsDb(db, 'vendor renewal decision')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].speakerName).toBe('Dana')
    expect(hits[0].startMs).toBe(12000)
    expect(hits[0].meetingTitle).toBe('Q3 pipeline review')
    expect(hits[0].meetingId).toBe('m1')
  })

  it('caps how many lines one meeting can claim (perMeeting)', () => {
    const db = freshDb()
    seedMeeting(db, 'm1', 'Long meeting')
    seedMeeting(db, 'm2', 'Short meeting')
    for (let i = 0; i < 8; i++) seedSegment(db, 'm1', 'Dana', i * 1000, `budget item ${i} discussed`)
    seedSegment(db, 'm2', 'Sam', 5000, 'the budget was approved')
    const hits = searchSegmentsDb(db, 'budget', { limit: 6, perMeeting: 2 })
    expect(hits.filter((h) => h.meetingId === 'm1').length).toBeLessThanOrEqual(2)
    expect(hits.some((h) => h.meetingId === 'm2')).toBe(true)
  })

  it('respects org scope: another organisation\'s meetings never surface', () => {
    const db = freshDb()
    seedMeeting(db, 'm1', 'Mine', 'personal')
    seedMeeting(db, 'm2', 'Theirs', 'other-org')
    seedSegment(db, 'm1', 'Dana', 0, 'the roadmap slipped a quarter')
    seedSegment(db, 'm2', 'Eve', 0, 'the roadmap is confidential')
    const hits = searchSegmentsDb(db, 'roadmap', { orgId: 'personal' })
    expect(hits.length).toBe(1)
    expect(hits[0].meetingId).toBe('m1')
  })

  it('an orphaned segment (meeting deleted) is not a citable answer', () => {
    const db = freshDb()
    seedMeeting(db, 'm1', 'Doomed')
    seedSegment(db, 'm1', 'Dana', 0, 'the migration plan is ready')
    db.prepare('DELETE FROM fb_meetings WHERE id = ?').run('m1')
    expect(searchSegmentsDb(db, 'migration plan').length).toBe(0)
  })

  it('trigger sync: deleting segments removes them from the index', () => {
    const db = freshDb()
    seedMeeting(db, 'm1', 'M')
    seedSegment(db, 'm1', 'Dana', 0, 'kubernetes cluster upgrade')
    expect(searchSegmentsDb(db, 'kubernetes').length).toBe(1)
    db.prepare('DELETE FROM fb_transcript_segments WHERE meeting_id = ?').run('m1')
    expect(searchSegmentsDb(db, 'kubernetes').length).toBe(0)
  })

  it('backfill: rows written before the mirror existed become searchable at ensure', () => {
    const db = new DatabaseSync(':memory:') as unknown as ChunkDb
    db.exec(`CREATE TABLE fb_meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', org_id TEXT NOT NULL DEFAULT 'personal')`)
    db.exec(`CREATE TABLE fb_transcript_segments (
      id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, speaker_account_id TEXT,
      speaker_name TEXT NOT NULL DEFAULT '', start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL, text TEXT NOT NULL, confidence REAL, created_at INTEGER NOT NULL)`)
    db.prepare(`INSERT INTO fb_meetings (id, title) VALUES ('m1', 'Pre-M4 meeting')`).run()
    db.prepare(
      `INSERT INTO fb_transcript_segments (id, meeting_id, speaker_name, start_ms, end_ms, text, created_at)
       VALUES ('s1', 'm1', 'Dana', 0, 3000, 'the legacy invoice pipeline', 0)`
    ).run()
    ensureSegmentFts(db)
    expect(searchSegmentsDb(db, 'legacy invoice').length).toBe(1)
  })

  it('a query with no indexable terms returns [] rather than matching everything', () => {
    const db = freshDb()
    seedMeeting(db, 'm1', 'M')
    seedSegment(db, 'm1', 'Dana', 0, 'anything at all')
    expect(searchSegmentsDb(db, '!!! ???')).toEqual([])
  })
})

describe('meetingRecallSources — the grounding pool', () => {
  it('groups hits by meeting; grounding text is the attributed lines', () => {
    const db = freshDb()
    seedMeeting(db, 'm1', 'Contract sync')
    seedSegment(db, 'm1', 'Dana', 12000, 'I will send the revised contract by Friday')
    seedSegment(db, 'm1', 'Sam', 30000, 'the contract redlines are done')
    const sources = meetingRecallSourcesDb(db, 'contract')
    expect(sources.length).toBe(1)
    expect(sources[0].docId).toBe('m1')
    expect(sources[0].docType).toBe('meeting')
    expect(sources[0].title).toBe('Contract sync')
    // Attribution is IN the text the model reads — who said it and when,
    // not a paraphraseable bare string.
    expect(sources[0].text).toContain('[0:12] Dana: I will send the revised contract by Friday')
  })

  it('attributedLine formats [m:ss] Name: text, with an honest Unknown', () => {
    expect(attributedLine({ startMs: 83000, speakerName: 'Dana', text: 'hello' })).toBe('[1:23] Dana: hello')
    expect(attributedLine({ startMs: 0, speakerName: '', text: 'hi' })).toBe('[0:00] Unknown: hi')
  })
})

describe('M4 wiring pins', () => {
  const workspaceSearch = read('src/main/workspaceSearch.ts')
  const sourceTarget = read('src/renderer/src/lib/sourceTarget.ts')
  const sourceIdentity = read('src/renderer/src/lib/sourceIdentity.ts')
  const chatPanel = read('src/renderer/src/components/ChatPanel.tsx')
  // The reference router moved out of ChatPanel into its own module when a
  // second caller appeared (the in-place peek's "Open where it lives"). The
  // door this test guards is the same door; it is just no longer in the panel.
  const refRouter = read('src/renderer/src/lib/goToSourceTarget.ts')
  const meetView = read('src/renderer/src/components/views/PlexiMeetView.tsx')
  const ipc = read('src/main/ipc/index.ts')

  it('the meetings pool rides retrieveSources round-robin', () => {
    expect(workspaceSearch).toContain('const meetingSources = meetingRecallSources(query, limit)')
    expect(workspaceSearch).toContain('chatSources, meetingSources]')
  })

  it('a meeting citation routes: target, identity, and the door out of the panel', () => {
    expect(sourceTarget).toContain("if (type === 'meeting') return { kind: 'meeting', meetingId: id }")
    expect(sourceIdentity).toContain("meeting: { icon: 'video_call', tone: areaTone('office'), location: 'PlexiMeet' }")
    expect(refRouter).toContain("case 'meeting':")
    expect(refRouter).toContain("new CustomEvent('fb:open-meeting', { detail: { id: target.meetingId } })")
    // And the panel still reaches it: a citation click must end up in the
    // router, whether it peeks first or goes straight there.
    expect(chatPanel).toContain('goToSourceTarget')
  })

  it('the Meet view renders Recall hits and lands the Thread on the cited line', () => {
    expect(meetView).toContain('FROM THE TRANSCRIPTS')
    expect(meetView).toContain('data-testid="recall-hits"')
    expect(meetView).toContain('setPendingSegment(h.segmentId)')
    // fb:open-meeting now carries an optional segment anchor.
    expect(meetView).toContain('if (segmentId) setPendingSegment(segmentId)')
    // The jump consumes exactly once.
    expect(meetView).toContain('onJumpConsumed?.()')
  })

  it('the FTS mirror is ensured at IPC-register time (backfill before first query)', () => {
    expect(ipc).toContain('ensureSegmentRecall()')
    expect(ipc).toContain("ipcMain.handle('meetings:searchSegments'")
  })
})
