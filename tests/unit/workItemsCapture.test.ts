// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import {
  ensureWorkItemSchema,
  decayLooseThoughtsCore,
  LOOSE_THOUGHT_DECAY_DAYS,
  setWorkItemStateCore
} from '../../src/main/db/workItems'
import type { LifecycleDb } from '../../src/main/db/nodeLifecycle'

// Attention S5 — the capture pipeline's non-UI guarantees: the loose-thought
// decay tier (Δ3), the closure-notification wiring, the executor's real apply
// path, and the gated prompt swaps (meeting + voice) that activate with the
// capability flag.

type Db = LifecycleDb & { exec(sql: string): void }

function freshDb(): { raw: DatabaseSync; db: Db } {
  const raw = new DatabaseSync(':memory:')
  raw.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      trashed_at INTEGER,
      org_id TEXT NOT NULL DEFAULT 'personal',
      updated_at INTEGER NOT NULL DEFAULT 0
    );
  `)
  const db: Db = {
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => {
      const s = raw.prepare(sql)
      return {
        run: (...a: unknown[]) => s.run(...(a as never[])),
        get: (...a: unknown[]) => s.get(...(a as never[])),
        all: (...a: unknown[]) => s.all(...(a as never[])) as unknown[]
      }
    }
  }
  ensureWorkItemSchema(db)
  return { raw, db }
}

const DAY = 24 * 60 * 60 * 1000

describe('Δ3 — the loose-thought decay tier', () => {
  it('dismisses untouched loose thoughts after the window, reason "decayed", quietly', () => {
    const { raw, db } = freshDb()
    const now = 100 * DAY
    raw.prepare(
      "INSERT INTO nodes (id, kind, title, work_item_state, intent_class, updated_at) VALUES (?, 'work_item', ?, 'open', 'to_remember', ?)"
    ).run('stale', 'Old idea', now - (LOOSE_THOUGHT_DECAY_DAYS + 1) * DAY)
    raw.prepare(
      "INSERT INTO nodes (id, kind, title, work_item_state, intent_class, updated_at) VALUES (?, 'work_item', ?, 'open', 'to_remember', ?)"
    ).run('fresh', 'New idea', now - 2 * DAY)
    raw.prepare(
      "INSERT INTO nodes (id, kind, title, work_item_state, intent_class, updated_at) VALUES (?, 'work_item', ?, 'open', 'to_do', ?)"
    ).run('task', 'Real task', now - 40 * DAY) // actionable items NEVER decay
    expect(decayLooseThoughtsCore(db, now)).toBe(1)
    const stale = raw
      .prepare('SELECT work_item_state, status, reason_code FROM nodes WHERE id = ?')
      .get('stale') as { work_item_state: string; status: string; reason_code: string }
    expect(stale).toEqual({ work_item_state: 'dismissed', status: 'parked', reason_code: 'decayed' })
    expect(
      (raw.prepare('SELECT work_item_state FROM nodes WHERE id = ?').get('fresh') as { work_item_state: string })
        .work_item_state
    ).toBe('open')
    expect(
      (raw.prepare('SELECT work_item_state FROM nodes WHERE id = ?').get('task') as { work_item_state: string })
        .work_item_state
    ).toBe('open')
    // A touch (promotion via reclassify, or any update) resets the clock —
    // and a decayed item never re-decays (terminal filter).
    expect(decayLooseThoughtsCore(db, now)).toBe(0)
  })

  it('a decayed thought remains promotable: reclassify-then-reopen path stays legal', () => {
    const { raw, db } = freshDb()
    raw.prepare(
      "INSERT INTO nodes (id, kind, title, work_item_state, intent_class, updated_at) VALUES ('t', 'work_item', 'X', 'dismissed', 'to_remember', 0)"
    ).run()
    expect(setWorkItemStateCore(db, 't', 'open')).toBe(true)
    const row = raw.prepare('SELECT status FROM nodes WHERE id = ?').get('t') as { status: string }
    expect(row.status).toBe('open')
  })
})

describe('S5 wiring locks (file-level)', () => {
  const ROOT = join(__dirname, '..', '..')
  const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8')

  it('terminal setState posts the closure through the S4 substrate, deduped per transition', () => {
    const wi = read('src/main/db/workItems.ts')
    expect(wi).toContain("dedupeKey: `wi-close:${id}:${state}`")
    expect(wi).toContain("trigger: 'loop-closure'")
  })

  it('the executor applies create-work-item through the store (one code path), origin ai, approved', () => {
    const ex = read('src/renderer/src/lib/actionExecutor.ts')
    expect(ex).toContain('applyCreateWorkItem')
    expect(ex).toContain("wiOrigin: 'ai'")
    expect(ex).toContain("approvalState: 'approved'")
    expect(ex).not.toContain("Work items aren't enabled yet.")
  })

  // DEC-144 rewrite: these used to swap routing with the flag, and the OFF
  // phrasing sent action items to create-task. The flag is retired: meetings
  // and voice always route action items to create-work-item.
  it('the meeting system + voice system always route action items to work items', () => {
    const anthropic = read('src/main/ai/anthropic.ts')
    expect(anthropic).toContain('meetingEndSystem()')
    expect(anthropic).toContain('meetingCaptureRule()')
    const voice = read('src/main/ai/voiceNote.ts')
    expect(voice).toContain('VOICE_WORK_ITEM_SHAPE')
    const vocab = read('src/main/ai/vocabulary.ts')
    expect(vocab).toContain('Use create-work-item for an action item')
    expect(vocab).not.toContain('Use create-task for an action item someone needs to do')
  })

  it('the capture console + classifier + seam are wired end to end', () => {
    // DEC-028: the ONE confirm stop is the shared card — classify lives there,
    // and both hosts (console overlay + chat inline) render it.
    const card = read('src/renderer/src/components/AttentionConfirmCard.tsx')
    expect(card).toContain('window.api.workItems')
    expect(card).toContain('.classify(')
    expect(read('src/renderer/src/components/CaptureConsole.tsx')).toContain('AttentionConfirmCard')
    expect(read('src/renderer/src/components/ChatPanel.tsx')).toContain('AttentionConfirmCard')
    expect(read('src/renderer/src/components/Sidebar.tsx')).toContain('openConsole(')
    expect(read('src/main/ipc/index.ts')).toContain("'workItems:classify'")
    // DEC-019(b): ONE universal entry, @attention prefix captures directly.
    expect(read('src/renderer/src/components/CommandCenter.tsx')).toContain('attention-capture')
    // DEC-144: the prefix grammar moved into the one parser (@focus, with
    // @attention kept as an alias); ⌘K reads it from there.
    expect(read('src/renderer/src/components/CommandCenter.tsx')).toContain('LEADING_CAPTURE_WORD')
    expect(read('src/renderer/src/lib/attentionCommand.ts')).toContain('@?(?:focus|attention)')
    // The decay sweep rides the scheduler cadence.
    expect(read('src/main/notifications/scheduler.ts')).toContain('decayLooseThoughts(nowMs)')
  })

  it('DEC-027/028 — typeahead, chips, arming, and the inline chat card', () => {
    // The chat picker offers the capture COMMAND; picking inserts a VISUAL
    // chip whose title serialises to "@attention" — never a stored reference
    // (onPick skipped; a kind with no resolver must never become one).
    const sugg = read('src/renderer/src/components/assistant/MentionSuggestion.ts')
    expect(sugg).toContain("kind: 'capture'")
    expect(sugg).toContain("title: 'attention'")
    // A LEADING @attention send never reaches the model — it renders the
    // shared confirm card INLINE in the chat (DEC-028). DEC-031 moved the
    // grammar itself into the shared parser, so the panel reads THAT rather
    // than carrying a private regex that could drift from the other surfaces.
    const panel = read('src/renderer/src/components/ChatPanel.tsx')
    expect(panel).toContain("from '../lib/attentionCommand'")
    expect(panel).toContain('parseAttentionCommand(content)')
    expect(panel).toContain('setInlineCapture')
    // History: ⌘K armed a Slack-style pill on Tab (DEC-028c) — retired by
    // operator ruling 2026-08-30: selecting Attention in ⌘K OPENS the Capture
    // window, typing happens there. The home bar keeps its pill.
    expect(read('src/renderer/src/components/CommandCenter.tsx')).not.toContain('attnArmed')
    expect(read('src/renderer/src/components/CommandCenter.tsx')).toContain('Attention — open Capture')
    const home = read('src/renderer/src/components/views/StartOrAskPlexi.tsx')
    expect(home).toContain("'capture:attention'")
    expect(home).toContain('armAttention')
  })

  it('the @ picker owns Tab — the intent-cycler must yield while it is open', () => {
    // Operator live QA: Tab never selected the Attention row and silently
    // flipped the previewed intent to "Search the web" instead. The composer's
    // Tab cycler is CAPTURE-phase, so it ran before ProseMirror's suggestion
    // plugin and swallowed every Tab. The guard is the fix; this pins it so
    // the keyboard contract (DEC-028c) cannot regress.
    const panel = read('src/renderer/src/components/ChatPanel.tsx')
    const guard = panel.indexOf('[data-testid="mention-picker"]')
    expect(guard).toBeGreaterThan(-1)
    // …and it must come BEFORE the cycler, or it changes nothing.
    const cycler = panel.indexOf('setOmniPick((p) => (p + 1) % composerIntents.length)')
    expect(cycler).toBeGreaterThan(guard)
    // The picker really does carry the testid the guard looks for.
    expect(read('src/renderer/src/components/assistant/MentionList.tsx')).toContain(
      'data-testid="mention-picker"'
    )
  })

  it('DEC-031 — every capture surface reads the ONE @attention grammar', () => {
    // The operator ruled @attention deterministic wherever it sits. Three
    // surfaces implement it; all three must consult the shared parser, or the
    // grammar drifts back into four private regexes.
    const parser = "from '../lib/attentionCommand'"
    expect(read('src/renderer/src/components/ChatPanel.tsx')).toContain(parser)
    expect(read('src/renderer/src/components/CommandCenter.tsx')).toContain(parser)
    expect(read('src/renderer/src/components/views/StartOrAskPlexi.tsx')).toContain(
      "from '../../lib/attentionCommand'"
    )
    // ⌘K: an inline token outranks everything, exactly like a leading one.
    const ck = read('src/renderer/src/components/CommandCenter.tsx')
    expect(ck).toContain('attnInline')
    // (attnArmed left with the retired ⌘K pill; the explicit-address rule
    // stands on the two grammar forms.)
    expect(ck).toContain('attnPrefix || attnInline')
    // …and the omni rows yield to EVERY Attention mention (plain "attention"
    // included), so Enter opens Capture instead of asking the model.
    expect(ck).toContain("if (q !== '' && !attnAddressed) {")
    expect(ck).toContain('const attnAddressed =')
    // Chat: an inline token captures AND still sends the stripped message.
    const panel = read('src/renderer/src/components/ChatPanel.tsx')
    expect(panel).toContain("attn.mode === 'inline' && attn.messageText")
    // The intent strip yields to ANY @attention now, not just a leading one.
    expect(panel).toContain('hasAttentionCommand(draft)')
    // ⌘K's omni rows ("Ask Plexii" hard-scores 2000) must yield too, or they
    // outrank the capture entry and the token reaches the model instead.
    // History: the omni suppression keyed on the literal token only; the
    // 2026-08-30 ruling widened it to every Attention mention (attnAddressed
    // — which itself includes hasAttentionCommand(q)).
    expect(ck).toContain('hasAttentionCommand(q) ||')
    // The last mile: send() itself intercepts, so the direct callers that
    // bypass the composer (⌘K Ask, home bar, voice) cannot leak a token to
    // the model. The composer strips first, so this never double-captures.
    const store = read('src/renderer/src/stores/chat.ts')
    expect(store).toContain('parseAttentionCommand(content)')
    expect(store).toContain("fb:command-new-work-item")
    expect(store).toContain("attn.mode === 'leading' || !attn.messageText")
  })

  it('DEC-034 evolved: two labelled fields, then the pill-grid confirm', () => {
    // History: DEC-034 made capture task+notes with an Enter ↵ preview. The
    // capture rebuild (operator spec) kept the two-field + confirm shape and
    // re-presented it: labelled fields, a rotating category placeholder,
    // Cmd+Enter as the verbatim commit path, and the confirm step as four
    // labelled pills with one drawer open at a time.
    const console_ = read('src/renderer/src/components/CaptureConsole.tsx')
    const card = read('src/renderer/src/components/AttentionConfirmCard.tsx')
    expect(console_).toContain('WHAT NEEDS YOU?')
    expect(console_).toContain('NOTES')
    expect(console_).toContain('CAPTURE_LEADINS')
    expect(console_).toContain('file exactly as typed')
    expect(console_).toContain('fileVerbatim')
    expect(card).toContain('Plexii read it like this.')
    expect(card).toContain("pill('category', 'CATEGORY'")
    expect(card).toContain('File it')
  })

  it('the picker highlights its selected row visibly (the Enter/Tab target is legible)', () => {
    const list = read('src/renderer/src/components/assistant/MentionList.tsx')
    // A 10% tint read as "nothing is selected" in live QA.
    expect(list).not.toContain('bg-accent/10')
    // GAP-018 (DEC-086): the highlight now uses a color that paints.
    expect(list).toContain('bg-accent/[0.14]')
    expect(list).toContain('inset_2px_0_0_rgb(var(--accent))')
  })
})
