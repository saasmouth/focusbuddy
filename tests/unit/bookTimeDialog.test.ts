import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { vi } from 'vitest'
import {
  parseBlockTokens,
  scheduleInviteHold,
  fmtTimeRange,
  resolvePlaceholder,
  nearestStepIndex,
  rankGuestSuggestions,
  nameFromEmail,
  guestInitials,
  resolveGuestEntry,
  filterSuggestions
} from '../../src/renderer/src/lib/bookTime'

// Book time — spec pass 1 (steps 1–3). The contract is the operator's
// book-time spec, 2026-08-30. DEC number assigned at commit time.

const read = (p: string): string => readFileSync(p, 'utf8')
const src = read('src/renderer/src/components/BookTimeDialog.tsx')

describe('placeholder resolution — recomputed, ordered, and it NEVER dates itself', () => {
  const base = {
    mode: 'focus' as const,
    attachedTitle: null,
    guests: [] as string[],
    roomName: null
  }

  it('resolution order: attached → guests → Meeting → room → Focus', () => {
    expect(
      resolvePlaceholder({
        ...base,
        mode: 'meeting',
        attachedTitle: 'CETRA deck',
        guests: ['Alex']
      })
    ).toBe('CETRA deck')
    expect(resolvePlaceholder({ ...base, mode: 'meeting', guests: ['Alex', 'Sam'] })).toBe('Alex & Sam')
    expect(resolvePlaceholder({ ...base, mode: 'meeting' })).toBe('Meeting')
    expect(resolvePlaceholder({ ...base, roomName: 'Product' })).toBe('Product')
    expect(resolvePlaceholder(base)).toBe('Focus')
  })

  it('the explicit refusal: no date/time fallback exists in the resolver', () => {
    // "A timestamp is the calendar repeating itself." The deliberate
    // divergence from DEC-073's desk prefill — a desk carries no time of its
    // own; a block does. Recorded here so nobody harmonizes them later.
    expect(resolvePlaceholder(base)).not.toMatch(/\d/)
    const lib = read('src/renderer/src/lib/bookTime.ts')
    const start = lib.indexOf('export function resolvePlaceholder')
    const fn = lib.slice(start, lib.indexOf('\nexport ', start + 1))
    expect(fn).not.toContain('toLocaleDateString')
    expect(fn).not.toContain('toLocaleTimeString')
    expect(fn).not.toContain('Date.now')
  })
})

describe('duration cycling — the drag seed is never clobbered (DEC-053 kept)', () => {
  it('steps are exactly 15/25/30/45/60/90/120', () => {
    expect(read('src/renderer/src/lib/bookTime.ts')).toContain('const DURATION_STEPS = [15, 25, 30, 45, 60, 90, 120]')
  })

  it('a non-step seed enters the cycle at the NEAREST step', () => {
    expect(nearestStepIndex(50)).toBe(3) // 45 — not 60, not a reset
    expect(nearestStepIndex(100)).toBe(5) // 90
    expect(nearestStepIndex(7)).toBe(0) // 15
    expect(nearestStepIndex(500)).toBe(6) // clamped to 120
  })

  it('the seed line itself survives from the old composer', () => {
    expect(src).toContain('useState(initialDurationMin ?? 60)')
  })
})

describe('steps 1–3 structure pins', () => {
  it('the mode slider is the header; Cmd+M toggles; labels take accent/ink-50', () => {
    expect(src).toContain("(e.metaKey || e.ctrlKey) && (e.key === 'm' || e.key === 'M')")
    expect(src).toContain("mode === m ? 'text-[rgb(var(--accent))]' : 'text-[var(--ink-50)]'")
  })

  it('the reveal is the house Framer pattern and respects reduced motion', () => {
    expect(src).toContain('AnimatePresence')
    expect(src).toContain("animate={{ height: 'auto', opacity: 1 }}")
    expect(src).toContain('useReducedMotion')
    expect(src).not.toContain('grid-template-rows') // the prototype trick, not ported
  })

  it('Esc is the cancel; the primary label tracks the mode', () => {
    expect(src).toContain('to discard')
    expect(src).toContain("mode === 'meeting' ? 'Schedule meeting' : 'Book it'")
    expect(src).not.toContain('>Cancel<')
  })

  it('keyboard focus: the global halo owns the controls; the title is underline-only', () => {
    // The house :focus-visible halo (globals.css "Apple pass") covers every
    // chip and button — no per-control rings to double it. The TITLE opts
    // out with a higher-specificity override because the spec's borderless
    // field carries focus in its accent underline instead.
    expect(src).toContain('[&:focus-visible]:outline-none')
    expect(src).not.toContain('ring-accent/')
    // GAP-018 discipline regardless: no invalid rgba(var(--accent)) anywhere.
    expect(src).not.toContain('rgba(var(--accent)')
  })
})

// ── Step 4 — the meeting-only fields ────────────────────────────────────────

describe('guest suggestions — recency of shared meetings, never the alphabet', () => {
  const blk = (startMs: number, invitees: string[]): { startMs: number; meeting: { invitees: string[] } } => ({
    startMs,
    meeting: { invitees }
  })

  it('the person you met yesterday outranks the person you met last month', () => {
    const ranked = rankGuestSuggestions([blk(100, ['zed@x.com']), blk(900, ['alex@x.com']), blk(500, ['mia@x.com'])])
    expect(ranked.map((c) => c.email)).toEqual(['alex@x.com', 'mia@x.com', 'zed@x.com'])
  })

  it('dedupes by address, keeping the most recent meeting; junk is dropped', () => {
    const ranked = rankGuestSuggestions([blk(100, ['alex@x.com', 'not-an-email']), blk(700, ['ALEX@x.com'])])
    expect(ranked).toHaveLength(1)
    expect(ranked[0].email).toBe('alex@x.com')
  })

  it('display names come honestly from the address', () => {
    expect(nameFromEmail('alex.p-swan@x.com')).toBe('Alex P Swan')
    expect(guestInitials('Alex Swan')).toBe('AS')
    expect(guestInitials('alex')).toBe('AL')
  })
})

describe('guest entry — bare words resolve, unresolved words get the domain', () => {
  const contacts = [
    { name: 'Alex Swan', email: 'alex@plexii.app' },
    { name: 'Mia Torres', email: 'mia@plexii.app' }
  ]

  it('a bare word that matches a contact becomes that contact', () => {
    expect(resolveGuestEntry('ale', contacts, 'plexii.app')?.email).toBe('alex@plexii.app')
    expect(resolveGuestEntry('torres', contacts, 'plexii.app')?.email).toBe('mia@plexii.app')
  })

  it('an unresolved bare word gets the workspace domain appended', () => {
    const c = resolveGuestEntry('caleb', contacts, 'plexii.app')
    expect(c).toEqual({ email: 'caleb@plexii.app', name: 'caleb' })
  })

  it('an explicit address passes through; with no domain the word is kept, never invented', () => {
    expect(resolveGuestEntry('Sam@Ext.IO', contacts, 'plexii.app')?.email).toBe('sam@ext.io')
    expect(resolveGuestEntry('caleb', contacts, null)).toEqual({
      email: 'caleb',
      name: 'caleb'
    })
    expect(resolveGuestEntry('  ', contacts, 'plexii.app')).toBeNull()
  })

  it('the dropdown excludes the already-invited and stays a glance (6)', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      name: `P${i}`,
      email: `p${i}@x.com`
    }))
    expect(filterSuggestions(many, '', ['p0@x.com'])).toHaveLength(6)
    expect(filterSuggestions(many, '', ['p0@x.com']).some((c) => c.email === 'p0@x.com')).toBe(false)
    expect(filterSuggestions(many, 'p9', [])).toHaveLength(1)
  })
})

describe('step 4 structure — the Enter guard, autofocus, and meeting-only', () => {
  it('ENTER GUARD: the guest input consumes Enter on every branch', () => {
    // stopPropagation is what keeps the dialog-level Enter-commits handler
    // from ever seeing it — the most likely regression, per the spec.
    const guard = src.slice(src.indexOf('function onGuestKeyDown'), src.indexOf('function onAgendaKeyDown'))
    expect(guard).toContain("if (e.key === 'Enter')")
    expect(guard).toContain('e.stopPropagation()')
    expect(guard).toContain("if (e.key === ',')")
    expect(guard).toContain("if (e.key === 'Tab' && guestInput.trim())")
    expect(guard).toContain("if (e.key === 'Backspace' && guestInput === '' && guests.length > 0)")
  })

  it('ENTER GUARD: agenda consumes plain Enter; Shift+Enter is the newline', () => {
    const guard = src.slice(src.indexOf('function onAgendaKeyDown'), src.indexOf('function moveDate'))
    expect(guard).toContain('e.stopPropagation()')
    expect(guard).toContain('if (!e.shiftKey) e.preventDefault()')
  })

  it('the revealed Where input autofocuses — the behaviour that earns the segmented control', () => {
    const link = src.indexOf('data-testid="where-link-input"')
    const inperson = src.indexOf('data-testid="where-inperson-input"')
    expect(src.lastIndexOf('autoFocus', link)).toBeGreaterThan(src.indexOf('where-plexi'))
    expect(src.lastIndexOf('autoFocus', inperson)).toBeGreaterThan(link)
    expect(src).toContain('Paste a Google Meet, Zoom or Teams link')
    expect(src).toContain('An address, a room, or where to meet')
  })

  it('agenda is meeting-only, on purpose, and says what it is for', () => {
    expect(src).toContain('What this meeting needs to settle')
    // It lives inside the meeting reveal — after the reveal testid, and the
    // deliberate rationale is recorded where the next person will read it.
    expect(src.indexOf('What this meeting needs to settle')).toBeGreaterThan(src.indexOf('meeting-reveal'))
    expect(src).toContain('guests can')
  })

  it('the Plexi Meet copy accurately explains delivery and the desktop join path', () => {
    expect(src).toContain('After the 10-second undo window')
    expect(src).toContain('opens PlexiiDesk when Mail is connected')
    expect(src).not.toContain('browser — no account needed')
  })
})

// ── Step 6 — attach (persisted) ─────────────────────────────────────────────

describe('attach — the selected node is persisted', () => {
  it('passes the real selected node id to the time block', () => {
    expect(src).toContain('const taskId = attached?.id ?? null')
    expect(src).not.toContain('STUB_ATTACH')
  })

  it('the title placeholder inherits from the attached item (rule 1)', () => {
    // resolvePlaceholder rule 1 is already unit-covered; the wiring reads
    // the live attach state, not the prefill prop.
    expect(src).toContain('const attachedTitle = attached?.title ?? null')
  })

  it('the Staged badge appears in a success tone, and says why it matters', () => {
    expect(src).toContain('data-testid="staged-badge"')
    expect(src).toContain('bg-emerald-500/15 text-emerald-600 dark:text-emerald-400')
    expect(src).toContain('prepared before this block starts')
  })

  it('a drag prefill seeds the attach and the live node picker selects real nodes', () => {
    expect(src).toContain('prefillNode ? { id: prefillNode.id, title: prefillNode.title } : null')
    expect(src).toContain('data-testid="book-attach-picker"')
    expect(src).toContain('setAttached({ id: node.id, title: node.title })')
  })
})

// ── Steps 7–9 — commit/toast/undo, the proposed state, inline create ───────

const grid = read('src/renderer/src/components/views/WeekTimeGrid.tsx')

describe('step 7 — commit closes immediately; the toast holds the regret', () => {
  it('the wording tracks the button through the whole flow', () => {
    expect(src).toContain("mode === 'meeting' ? 'Schedule meeting' : 'Book it'")
    // DEC-131: the verb rides with the booking, in lib/bookBlock
    expect(readFileSync('src/renderer/src/lib/bookBlock.ts', 'utf8')).toContain(
      "const verb = meeting ? 'Scheduled' : 'Booked'"
    )
  })

  // DEC-131: the booking itself (create, the undo toast, the stated invite
  // hold) moved to lib/bookBlock — shared with the assistant's Calendar tab —
  // and the grid delegates to it. The pins follow the code.
  const book = readFileSync('src/renderer/src/lib/bookBlock.ts', 'utf8')

  it('closes FIRST, then creates — no spinner, no confirmation step', () => {
    const closure = grid.slice(
      grid.indexOf('Step 7 — closes IMMEDIATELY'),
      grid.indexOf('bookBlockWithToast({ taskId, title, startMs, durationMin, meeting, recurrence })')
    )
    expect(closure).toContain('setComposer(null)')
    expect(book.indexOf('await createBlock(draft)')).toBeGreaterThan(0)
  })

  it('the toast is the house recordWithToast, and Undo removes the block', () => {
    expect(book).toContain('useActionHistory.getState().recordWithToast')
    expect(book).toContain('await removeBlock(block.id)')
    expect(grid).toContain("import { bookBlockWithToast } from '../../lib/bookBlock'")
  })

  it('the invite hold sends after expiry and Undo cancels it', () => {
    expect(book).toContain('scheduleInviteHold')
    expect(book).toContain('sendMeetingInvites({')
    expect(book).toContain('inviteDeliveryNote')
    expect(book).toContain('invites hold ${HOLD_INVITES_MS / 1000}s')
    expect(book).toContain('hold?.cancel()')
  })

  it('scheduleInviteHold: expiry fires once; cancel wins the race', () => {
    vi.useFakeTimers()
    let fired = 0
    const h1 = scheduleInviteHold(() => fired++, 1000)
    vi.advanceTimersByTime(1500)
    expect(fired).toBe(1)
    expect(h1.fired()).toBe(true)
    const h2 = scheduleInviteHold(() => fired++, 1000)
    h2.cancel()
    vi.advanceTimersByTime(1500)
    expect(fired).toBe(1)
    expect(h2.fired()).toBe(false)
    vi.useRealTimers()
  })

  it('the meeting payload is real now — and the agenda rides it', () => {
    // Edit mode preserves the block's own room — a meeting's join link must
    // survive a title change; only a NEW meeting mints one.
    expect(src).toContain('roomId: editBlock?.meeting?.roomId ?? newMeetingRoomId()')
    expect(src).toContain('invitees: guests.map((g) => g.email)')
    expect(src).toContain('agenda: agenda.trim() || null')
  })

  it('the toast names the range', () => {
    expect(fmtTimeRange(new Date(2026, 7, 30, 15, 0).getTime(), 45)).toMatch(/3:00.+3:45/)
  })
})

describe('step 8 — the proposed state has the three mandate properties', () => {
  it('same box, same fields, fully editable — no readonly anywhere', () => {
    expect(src).not.toContain('readOnly')
    expect(src).not.toContain('disabled={!!proposal')
  })

  it('a stated default with a countdown that BOOKS at zero', () => {
    expect(src).toContain('data-testid="proposal-countdown"')
    expect(src).toContain('const t = setTimeout(() => commitRef.current(), ms)')
  })

  it('dismissal is one keystroke and the banner says so', () => {
    expect(src).toContain('Esc dismisses.')
  })

  it('fires only from the manual trigger today — hold-time is unruled', () => {
    expect(grid).toContain('__plexiiProposeBlock')
    expect(grid).toContain('manual trigger')
  })
})

describe('step 9 — inline create, flagged, no regressions', () => {
  it('ships behind the flag — default OFF by operator ruling (drag opens the dialog)', () => {
    const planner = read('src/renderer/src/lib/attentionPlanner.ts')
    expect(planner).toContain('inlineCreate: boolean')
    expect(planner).toContain('inlineCreate: false')
    expect(read('src/renderer/src/components/views/CalendarView.tsx')).toContain('data-testid="inline-create-toggle"')
  })

  it('flag OFF keeps the DEC-053 path verbatim — seed and all', () => {
    expect(grid).toContain('setComposer({ dayIndex: cur.dayIndex, startMs, initialDurationMin: durationMin })')
  })

  it('the inline block is named by the SAME resolution the dialog uses', () => {
    const branch = grid.slice(grid.indexOf('Step 9 (flagged)'), grid.indexOf('function onColumnDragOver'))
    expect(branch).toContain('resolvePlaceholder({')
  })

  it('Enter keeps, Esc removes, Cmd+Enter promotes with the draft carried', () => {
    expect(grid).toContain('void finishInline(true)')
    expect(grid).toContain('void cancelInline()')
    expect(grid).toContain('void promoteInline()')
    expect(grid).toContain('initialTitle: ie.draft')
    expect(src).toContain("useState(editBlock?.title ?? initialTitle ?? '')")
  })

  it('drop-books-immediately is untouched', () => {
    expect(grid).toContain('No composer stop')
  })
})

// ── The brand is spelled Plexii — two i\u2019s, everywhere, forever ─────────────

describe('the name is Plexii', () => {
  it('no standalone "Plexi" survives anywhere in src (operator ruling, 2026-08-30)', () => {
    // Fused legacy product names (PlexiDesk, PlexiSuite, PlexiOffice…) are
    // separate identifiers and pass the lookahead; the NAME on its own —
    // "Plexii Meet", "inside Plexii", "Plexii 4.0" — always takes both i\u2019s.
    // This lock is the "acknowledged going forward" half of the ruling.
    const { execSync } = require('node:child_process') as typeof import('node:child_process')
    let out = ''
    try {
      out = execSync(String.raw`grep -rnE '\bPlexi\b([^a-zA-Z]|$)' src --include='*.ts' --include='*.tsx'`, {
        encoding: 'utf8'
      })
    } catch {
      out = '' // grep exits 1 on zero matches — exactly what we want
    }
    expect(out.trim()).toBe('')
  })

  it('the wake word hears both transcript spellings of the one spoken name', () => {
    expect(read('src/renderer/src/lib/voiceHold.ts')).toContain('plexii?')
  })
})

// ── Edit mode — the dialog is the edit surface ──────────────────────────────

describe('double-click opens the full dialog, seeded from the block', () => {
  it('every meeting detail seeds: guests, where, link/location, agenda, repeat', () => {
    expect(src).toContain('(editBlock?.meeting?.invitees ?? []).map((e) => ({')
    expect(src).toContain('name: nameFromEmail(e)')
    expect(src).toContain("editBlock?.meeting?.joinUrl ? 'link' : editBlock?.meeting?.location ? 'inperson' : 'plexi'")
    expect(src).toContain("useState(editBlock?.meeting?.agenda ?? '')")
    expect(src).toContain("useState<TimeBlockRecurrence | ''>(editBlock?.recurrence ?? '')")
  })

  it('the grid routes: meeting or plain block → dialog; DEC-074 routes kept', () => {
    expect(grid).toContain('if (block.meeting || !block.taskId) setEditBlockState(block)')
    expect(grid).toContain('else if (isWorkItem) setEditItem(linked!)')
  })

  it('Save is the verb; recurrence is read-only on a booked block', () => {
    expect(src).toContain("isEdit ? 'Save' :")
    expect(src).toContain('disabled={isEdit}')
  })

  it('saving toasts with Undo restoring every prior field', () => {
    // DEC-129: the save and its toast moved to lib/blockEdit (shared with the
    // Today tile's block row); the grid delegates to it.
    const lib = readFileSync('src/renderer/src/lib/blockEdit.ts', 'utf8')
    expect(grid).toContain('await saveBlockEdit(prev, patch)')
    expect(lib).toContain('label: `Saved')
    const undo = lib.slice(lib.indexOf('label: `Saved'), lib.indexOf('redo: async () => {'))
    for (const f of [
      'taskId: prev.taskId',
      'title: prev.title',
      'startMs: prev.startMs',
      'durationMin: prev.durationMin',
      'meeting: prev.meeting ?? null'
    ])
      expect(undo).toContain(f)
  })
})

// ── Step 5, option B — the shared token grammar (operator ruling) ───────────

describe('parseBlockTokens — strip what you apply, echo what you did, no @', () => {
  const rooms = [
    { id: 'r1', title: 'Design' },
    { id: 'r2', title: 'LakeDash' }
  ]

  it('duration tokens: 45m, 30min, 2h, 1.5h — stripped, echoed', () => {
    expect(parseBlockTokens('deck 45m ', rooms)).toMatchObject({
      cleaned: 'deck ',
      durationMin: 45
    })
    expect(parseBlockTokens('deck 30min ', rooms).durationMin).toBe(30)
    expect(parseBlockTokens('deck 2h ', rooms).durationMin).toBe(120)
    expect(parseBlockTokens('deck 1.5h ', rooms).durationMin).toBe(90)
    expect(parseBlockTokens('deck 45m ', rooms).echo).toContain('Set 45m')
  })

  it('typing "45min" is never clipped at "45m" — the unit must complete', () => {
    // Mid-word there is no boundary; the dialog only parses on space/blur,
    // and the regex itself requires the unit to end the token.
    expect(parseBlockTokens('deck 45mi', rooms).durationMin).toBeNull()
  })

  it('#room strips ONLY when it resolves; an unmatched #word stays visible', () => {
    const hit = parseBlockTokens('notes #des ', rooms)
    expect(hit.room).toMatchObject({ id: 'r1', title: 'Design' })
    expect(hit.cleaned).toBe('notes ')
    const miss = parseBlockTokens('notes #nosuchroom ', rooms)
    expect(miss.room).toBeNull()
    expect(miss.cleaned).toContain('#nosuchroom')
  })

  it('mode keywords flip to meeting but are NEVER stripped — they are the name', () => {
    const fx = parseBlockTokens('Roadmap sync ', rooms)
    expect(fx.meeting).toBe(true)
    expect(fx.cleaned).toBe('Roadmap sync ')
    expect(fx.echo).toContain('meeting')
    // …and the echo stays honest: no "meeting" when already in meeting mode.
    expect(parseBlockTokens('Roadmap sync ', rooms, true).echo).toBeNull()
  })

  it('the option-B acceptance: "Roadmap sync 30m" → "Roadmap sync", 30-minute meeting', () => {
    const fx = parseBlockTokens('Roadmap sync 30m ', rooms)
    expect(fx.cleaned.trim()).toBe('Roadmap sync')
    expect(fx.durationMin).toBe(30)
    expect(fx.meeting).toBe(true)
  })

  it('option B means NO @ tokens: "@sam" passes through untouched', () => {
    const fx = parseBlockTokens('standup @sam 25m ', rooms)
    expect(fx.cleaned).toContain('@sam')
    expect(fx.durationMin).toBe(25)
  })

  it('the dialog parses on token completion and blur, applies through the one contract', () => {
    expect(src).toContain("if (e.target.value.endsWith(' ')) applyTokens(e.target.value)")
    expect(src).toContain('applyTokens(title)')
    expect(src).toContain('data-testid="parse-echo"')
    // A typed duration keeps the DEC-053 display-as-is + nearest-step-entry contract.
    const apply = src.slice(src.indexOf('function applyTokens'), src.indexOf('const guestNames'))
    expect(apply).toContain('cycleIdx.current = DURATION_STEPS.includes(fx.durationMin)')
    // #room lands in the SAME attach seat rule 1 reads.
    expect(apply).toContain('setAttached({ id: fx.room.id, title: fx.room.title })')
  })
})
