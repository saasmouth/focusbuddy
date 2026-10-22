// @vitest-environment node
//
// Owner, for 4.3.41: a reopened chat keeps its "check this" marks. The marks
// (what the grounding check found in an answer, a2f5d94a) were held in memory
// only, so reopening a conversation showed the answer without them.
//
// They are now saved with the turn and restored exactly as saved. They are
// never recomputed on reopen: the sources may have changed since, and marks
// for a different answer than the one on screen would be fakery. A turn saved
// before marks were stored, or one the check found clean, shows none.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AnswerGrounding } from '../../src/shared/types'

const USERDATA = mkdtempSync(join(tmpdir(), 'plexii-chat-grounding-'))
vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, getName: () => 'plexii', getVersion: () => '0.0.0-test', isPackaged: false, on: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  ipcMain: { handle: () => undefined, on: () => undefined },
  shell: { openExternal: async () => undefined },
  net: {},
  default: {}
}))
let db: import('../../src/web/worker/sqlite').SqliteDb
vi.mock('../../src/main/db/database', () => ({
  getDb: () => db,
  databaseFilePath: () => ':memory:',
  closeDb: () => {},
  nodesKindMigrationStatus: () => null
}))

const MARKS: AnswerGrounding = {
  path: 'local',
  repaired: [{ span: '24/7', kind: 'time', confidence: 'high', reason: 'Not in your documents' }],
  flagged: [{ span: '3 March', kind: 'date', confidence: 'medium', reason: 'No source gives this date' }]
}

let chat: typeof import('../../src/main/db/aiChat')
let norm: typeof import('../../src/shared/storedGrounding')

beforeAll(async () => {
  const { initSqlite, openMemoryDatabase } = await import('../../src/web/worker/sqlite')
  await initSqlite()
  db = openMemoryDatabase()
  db.pragma('foreign_keys = ON')
  const { applySchemaAndMigrations } = await import('../../src/main/db/migrations')
  applySchemaAndMigrations(db as never)
  chat = await import('../../src/main/db/aiChat')
  norm = await import('../../src/shared/storedGrounding')
})

describe('normalizeStoredGrounding', () => {
  it('keeps a real finding exactly', () => {
    expect(norm.normalizeStoredGrounding(MARKS)).toEqual(MARKS)
  })
  it('reads nothing, a clean check, junk and malformed findings as no marks', () => {
    expect(norm.normalizeStoredGrounding(null)).toBeNull()
    expect(norm.normalizeStoredGrounding(undefined)).toBeNull()
    expect(norm.normalizeStoredGrounding({ path: 'local', repaired: [], flagged: [] })).toBeNull()
    expect(norm.normalizeStoredGrounding('{"path":"local"}')).toBeNull()
    expect(norm.normalizeStoredGrounding({ path: 'elsewhere', repaired: [], flagged: MARKS.flagged })).toBeNull()
    expect(norm.normalizeStoredGrounding({ ...MARKS, flagged: [{ span: 'x', kind: 'time', confidence: 'certain', reason: 'r' }] })).toBeNull()
    expect(norm.normalizeStoredGrounding({ ...MARKS, flagged: [{ span: '', kind: 'time', confidence: 'high', reason: 'r' }] })).toBeNull()
  })
})

describe('a chat turn keeps its marks through a save and reopen', () => {
  let conv: string
  beforeEach(() => {
    conv = chat.createConversation({ title: 'Grounding' } as never).id
  })

  it('an answer saved with marks reopens with the same marks', () => {
    chat.appendMessage(conv, { role: 'user', content: 'When is support open?', ts: 1 })
    const saved = chat.appendMessage(conv, { role: 'assistant', content: 'Support is open [not in your documents].', ts: 2, grounding: MARKS })
    expect(saved.grounding).toEqual(MARKS)
    const reopened = chat.getConversation(conv)!
    expect(reopened.messages.map((m) => m.grounding)).toEqual([null, MARKS])
  })

  it('a clean answer, and a turn saved before marks were stored, reopen with none', () => {
    chat.appendMessage(conv, { role: 'assistant', content: 'Clean.', ts: 3, grounding: null })
    chat.appendMessage(conv, { role: 'assistant', content: 'Older turn.', ts: 4 })
    // A row written by a build that predates the column: grounding_json NULL.
    db.prepare(`UPDATE ai_chat_messages SET grounding_json = NULL WHERE conversation_id = ?`).run(conv)
    expect(chat.getConversation(conv)!.messages.map((m) => m.grounding)).toEqual([null, null])
  })

  it('a damaged stored value reads as no marks, never as something invented', () => {
    chat.appendMessage(conv, { role: 'assistant', content: 'A.', ts: 5, grounding: MARKS })
    db.prepare(`UPDATE ai_chat_messages SET grounding_json = '{not json' WHERE conversation_id = ?`).run(conv)
    expect(chat.getConversation(conv)!.messages[0].grounding).toBeNull()
  })

  it('a malformed finding sent to be saved is stored as none', () => {
    chat.appendMessage(conv, { role: 'assistant', content: 'B.', ts: 6, grounding: { path: 'local', repaired: 'x', flagged: [] } as never })
    const row = db.prepare(`SELECT grounding_json FROM ai_chat_messages WHERE conversation_id = ?`).get(conv) as { grounding_json: string | null }
    expect(row.grounding_json).toBeNull()
  })
})

