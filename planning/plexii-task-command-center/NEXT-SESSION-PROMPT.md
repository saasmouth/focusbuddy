# Next Session — Resume Prompt

> **SHIPPED 2026-09-01: Release 4.2.0.** Michael merged ryan-command-center
> into main and released it (everything through DEC-095, plus his timezone
> fixture fix). `ryan-command-center` sits at main + 2 (DEC-096 ink sweep +
> the merge-back), pushed to BOTH remotes and zero-conflict mergeable —
> Michael pulls it whenever. **New work starts on `ryan-next`** (branched
> from this tip, on both remotes); ryan-command-center is maintenance-only
> until DEC-096 lands in main. Still open: GAP-017 ruling (naming,
> needs usage data), Phase 4 on the operator's go (GAP-019 closed by
> DEC-097 — all three paint-integrity gaps now closed), the ten [TEST] seed items
> in the operator's LOCAL database (dismiss by tag `test-seed` before
> demos — they are data, not code).
>
> **Meet (SPEC-003) is underway on ryan-next** — analysis/28 is the plan;
> M1 landed as DEC-098; M2a (transcript truth) as DEC-099 — segments from
> both engines, the attributed per-track pipeline, CR-11 local-only
> meeting audio. M2 is COMPLETE: DEC-099 (transcript
> truth), DEC-100 (the Record + three renderings), DEC-101 (container,
> templates, export, CR-13 retention). **M3 is COMPLETE (DEC-102)**:
> anchored commitment extraction, the batch confirm stop (other-owned
> unchecked, owner as mention — never a send), the C6 split, and the
> host's To Know brief; verified live end-to-end. **M4 is COMPLETE
> (DEC-103)**: the G2 spike measured live decode CHEAP (RTF 0.09, ~15%
> of a core), so both halves shipped — segment-FTS Recall (Meet search
> box, assistant grounding pool, meeting citations that route) AND the
> ⌘⇧T live transcript (consent-inherited tap, view-driven cost,
> shed-don't-lag queue). G3: MCP ruled to its own round (no server
> surface exists). **M5 is COMPLETE (DEC-104)**: series_id stamped from
> the calendar origin, prep as pure database facts in the Stage's PREP
> pane, "Carried from last time" atop the wrap-up AND the Record (with
> a Done verb — house state 'completed', a live-caught fix), and Q14's
> per-series brief knob. **M6 is COMPLETE (DEC-105) — and with it ALL
> of SPEC-003 (M1–M6, DEC-098…105)**: G1 proved ScreenCaptureKit
> loopback live (a one-shot armed grant; screen share keeps its native
> picker), and Guest Capture shipped in CR-12 reduced mode —
> non-dismissible disclosure bar, You/Them attribution by construction,
> guests never in the extractor roster, mic-only as the named floor —
> riding the existing recorder/wrap-up/series foundations. The round
> also caught + fixed an M2-era seam: the transcribe IPC bridge dropped
> forceProvider (CR-11 forced-local never reached main; failed closed).
> Suite: 3,593 tests / 330 files.
> **PlexiCam calls consent is CLOSED (DEC-106)**: the 1:1 form of the
> M1 hole — the whisper pref now records MY mic and ASKS the peer over
> the callSignal relay (capture-on-answer, decline never tapped,
> standing-pref auto-answer, worded states both sides, requester-only
> Stop with a held take); calls ride the meeting pipeline (per-track,
> attributed, on-device) and ConversationRecorder is deleted. Suite:
> 3,602 tests / 331 files.
> **C5 is fully closed (DEC-107)**: widget kind 'meeting-record' minted
> first on the meeting desk (live store read, provenance tiers, heard
> lines are doors), plus per-item moment anchors — plexii://meeting/
> <id>?seg=<segId> stamped on anchored commitments; the Attention chip
> parses before it opens (moments inside, DEC-091 web marks still
> external). Suite: 3,611 tests / 332 files.
> **Recall-over-MCP is closed (DEC-108)**: POST /mcp on the existing
> PlexiAPI server (its auth, loopback, Origin + rebind guards all
> inherited), a hand-rolled dependency-free JSON-RPC layer, three
> READ-ONLY attributed tools (search / meeting / recent), refusals
> stated where enforced; proven live over real HTTP end-to-end. Suite:
> 3,624 tests / 333 files.
> **Briefs for other attendees is complete (DEC-109) — Q14 closed, and
> with it EVERY named build round from SPEC-003 (DEC-098…109).** The
> brief rides PlexiChat DMs (server-persisted — the away channel that
> already existed): host opts in to SEND per series (shareBriefs,
> default off), recipient opts in to FILE per series (first arrival
> asks via notice; nothing files until they say so); prose always
> survives for old clients. Suite: 3,637 tests / 334 files.
> **analysis/27 Phase 4 is now open and nearly done (DEC-110)**: #16
> AI-suggested tags shipped (deterministic, vocabulary-grounded, the
> DEC-088 pattern — lit desk pill, accent chips, click-to-accept,
> never auto-applied; two live-caught fixes pinned); #13 transcript
> rebuild marked SATISFIED by SPEC-003; #17 home widgets stays gated
> on the operator SHAPING it (which home? embedding what?). Suite:
> 3,647 tests / 335 files.
> **Phase 5 is prepared (DEC-111)**: main (4.2.2) merged back — zero
> conflicts, 3,655 tests / 336 files green on the merged tree — and
> **analysis/29 is the review → landing package** (Michael's review
> guide + Caleb's two-line checkout + flags note + the two-machine QA
> sheet + the deferred list). Remaining acts belong to people: Michael
> reviews and lands; Caleb checks out; the operator runs the
> two-machine QA sheet and shapes #17; the taxonomy ruling waits on
> real queue-usage data (dismiss the [TEST] seeds by tag `test-seed`
> before measuring).
> **DEC-112**: PlexiMeet restyled into the house material (desk paper,
> raised rail, glossy rose primary, RECORDING card, sunken segmented
> track, sticky raised detail header) — presentation only, 7 material
> pins; and a verification lesson: an OCCLUDED window serves stale
> compositor tiles to CDP screenshots (layerized elements especially) —
> captureBeyondViewport + a damage nudge is the honest capture. Suite:
> 3,662 tests / 337 files.
> **DEC-113 (the real bug fix)**: meeting transcription was garbage —
> `task: 'transcribe'` poisoned whisper (looped one sentence a dozen
> times; "Find commitments" honestly found nothing). Fixed by dropping
> `task`, defaulting to whisper-base (tiny only for the live pane),
> anti-loop guards + a collapse net, an OfflineAudioContext resample,
> and a "Re-transcribe" recovery button. A long child-process detour was
> a red herring, fully reverted — engine stays in-process. Verified live
> on the operator's own broken meeting: clean transcript + both
> deliverables surface as commitments. **DEC-114**: Stage + wrap-up
> wear the house material (presentation only). Suite: 3,675 tests /
> 338 files.
> **DEC-115**: the meeting Record reorganised on operator direction
> (three reference screenshots — "a design direction, not the trump
> card"): the transcript ALWAYS on screen beside Overview / Action
> items (default) / Analytics — tagged by speaker, searchable (`/`),
> filterable, every timestamp a link; a click-to-seek speaker timeline
> with heard/action-item markers; Action items with a checkbox (house
> `completed`) and a bell into Attention (human-origin, approved,
> pointing back at the meeting — promoted, not duplicated); Analytics
> as neutral facts (SPEC-003 refusal pinned by banned words); links
> BOTH ways (transcript lines wear "In Brief · <section>" / "Action
> item" chips). `lib/meetingRecordStats.ts` unit-tested; 42 live CDP
> checks; the transcription engine itself was NOT re-tested this round.
> Suite: 3,693 tests / 339 files.
> **DEC-116**: PlexiMeet moved onto Home's own substrate and idioms
> (operator: "look and feel more like the main home screen") —
> `paper-texture` (not desk-paper) inside Home's page shell, a hero
> header with the rose module chip, Home's surface-button doors and
> ACCENT primary (the rose primary retired to the chip — a judgment
> call, one line to revert), the rail and the three Record panels as
> floating kit `RailCard`s with icon headers (kit grew `trailing` /
> `bodyClassName` / `testId`, Home pixel-identical), the module
> dashboard `embedded` as the empty state. Live-caught: duplicate
> marker keys when two Brief entries cite one line. Suite: 3,695
> tests / 339 files.
> **DEC-117**: the New meeting dialog is the Calendar composer's twin
> (operator: "nearly identical" to the booking page) — BookTimeDialog's
> recipes verbatim (slider, 23px title, date/start → end chips, Repeat,
> GUESTS chips, WHERE segmented, AGENDA, Attach, Esc/↵ footer; a twin
> test holds the strings in both files) over Meet's behaviour: Start
> now opens the room, rings picked online teammates, emails the rest;
> Schedule writes a real meeting block (room id, guests, where, agenda,
> attached desk, repeat) and emails invites. Attach is REAL here (the
> composer's is still the DEC-019 stub); the invite email is
> where-aware (`composeInviteBody`). 18/18 live; suite 3,737 tests /
> 340 files.
> **DEC-118**: Record notes / Record external open the same twin
> (`RecordDialog`): title, "now → until you stop", NOTES → `yours`
> spans, a real desk for Record notes (the meeting's deskNodeId), and
> for Record external WHERE — a call on this Mac (You / Them) or in the
> room (mic only, the picker never raised) — with the CR-12 disclosure
> stated before anything runs. `guestCapture.start` grew `notes` /
> `micOnly`. 12/12 live with the mic stubbed to refuse; suite 3,759
> tests / 341 files.
> **DEC-119**: the Message door opens the twin too (`MessageDialog`:
> Video / Voice slider sets the capture, the 23px field is the DM text,
> TO is one teammate from live presence; the door becomes "Stop & send
> to <name>" while recording — the popover is gone), and Meet's
> embedded dashboard renders no header row (no Customize) so the tiles
> start level with the rail. 10/10 live, mic stubbed; suite 3,778
> tests / 342 files. **Every Meet door is now the composer's twin
> (DEC-117/118/119).**
> **DEC-120 — the Plexii assistant panel, round 1 of an operator-led
> series ("start there and then we'll keep going")**: `AssistantHeader`
> is the panel's first row on every tab — the sidebar's own animated
> wordmark, then New chat · What was I doing? · Display mode · Minimize;
> Body double and Your conversations left the bar; the tab strip sits
> under it; ChatPanel keeps only a slim context strip (focused desk,
> Discovery, linked desk, Clear). `recap` lives in the chat store. 10/10
> live, panel restored as found; suite 3,785 tests / 343 files.
> **BRANCHES (2026-09-06, operator instruction): the Meet work is PR #6
> (`ryan-next` → main, frozen at DEC-119, zero conflicts, ready to
> ship; Michael lands). The assistant series lives on `ryan-assistant`
> (from DEC-120).** **DEC-121**: tabs rearranged — Attention (the home
> Attention widget itself, uncapped + scrolling), Chat, Agent (with a
> Desk agents sub-view — Work folded in), Tasks, PlexiChat (the Office
> `MessagesView`, compact: one pane at a time with a way back). Today,
> Activity and Work are gone; saved tabs migrate. 13/13 live; suite
> 3,793 tests / 344 files. **DEC-122**: the strip is now the animated
> double-ii mark (the conversation, "Plexii AI") · Attention ·
> PlexiiMessage (two i's) · Agents; Tasks retired into Attention; the
> default is the conversation. 7/7 live; suite 3,794 tests / 344 files.
> **DEC-123**: PlexiiMessage's thread header in the panel — one Meet door
> (a DM meets the person now; a space opens PlexiMeet), no translate menu,
> the doors on their own left-aligned wrapping row so nothing is cut off;
> the Office page untouched. 5/5 live; suite 3,795 tests / 344 files.
> **DEC-124**: the bell means Attention — PlexiiMessage's notification
> bell left the panel; every message wears a bell that opens the house
> capture prompt (Respond by default, the card asks), filing an item that
> points back at the message (`plexii://message/<conv>?m=<id>`, routed
> from the Attention page). 6/6 live; suite 3,803 tests / 346 files.
> **DEC-125**: the message bell IS the desk bell — one shared
> `attention/BellIcon.tsx`; a marked message's bell fills and stays
> visible with the shared completion circle beside it (closes through
> DEC-051's one path with the queue's verb, then empties); the meta row
> left the bubble (time · Translate · pin icon on the left, the thread at
> the right edge). 5/5 read-only + 7/7 check-off on one `test-seed`
> scratch (left closed on disk); suite 3,809 tests / 347 files.
> **DEC-126**: a message's doors — palette · bell · ⋯ — are one cluster
> hung off the bubble on its vertical centre (both sides); the time shows
> on hover; Translate lives in the ⋯ menu, which every message has now
> (Edit / Delete still yours only); the palette and the menu close on a
> click anywhere outside or Esc (`hooks/useClickAway.ts`, the house
> pattern extracted). 16/16 live; suite 3,817 tests / 348 files.
> **DEC-127**: the way back — an Attention item filed from a message (the
> row's `message` chip, its source door, the editor's Source link) opens
> the floating assistant on PlexiiMessage, on that person, landed on the
> exact message (`lib/openMessage.ts` + `messaging.landOnMessage`,
> consumed once by MessagesView after its pin-to-newest; replies open
> their thread first via the link's new `p=`). 9/9 live; suite 3,828
> tests / 349 files.
> **DEC-128**: the Attention widget's row, everywhere the widget lives
> (home, desk, the assistant's Attention tab) — `attention/WidgetItemRow`:
> title + date at rest; one click opens the page's quick summary and row
> actions IN PLACE (source door, desk, Start with Plexii, Snooze, Archive,
> Open the item, the page); double-click opens the page's editor over the
> current page (portalled). Shared doors extracted: `lib/startWithPlexii`,
> `lib/openMeeting`. 13/13 live; suite 3,838 tests / 350 files.
> **DEC-129**: the Today tile's meeting and calendar items get the same
> three depths — `attention/CalendarBlockRow` (summary in place with the
> calendar's own doors: Join, Record external, Start, Done, Skip, Open,
> Delete, the page; double-click → BookTimeDialog in edit mode, saving via
> `lib/blockEdit`); the tile's dated work and the Overdue radar use
> `WidgetItemRow`; MiniRow retired. Judgement call: `dayTimeline` puts
> overdue work BEHIND today's timed shape. 8/8 live with scratch blocks
> (removed); suite 3,846 tests / 351 files.
> **DEC-130 — the recording audit.** The operator's silent "Record notes"
> was a DIGITALLY SILENT microphone (the dev app launched from Claude Code
> inherits a mic-less macOS permission; the app never said so) plus an
> on-device engine that derails a whole take on a few hard seconds. Now:
> every door asks the system, listens 1.2 s and refuses silence with the
> settings door (`lib/micHealth`, `MicLevelPill`, `media:micStatus` /
> `media:askMic` — the main bridge needs an app RESTART, no `--watch`);
> Record notes rides the on-device wrap-up (segments, retained take, the
> picked desk as container); `transcriptSanity` refuses hallucinations;
> the derail net (`audioSplit`) cuts at pauses and decodes the pieces;
> decode at 48 kHz. 10/10 + 10/10 live with a synthetic mic (residue in
> Trash + dismissed briefs — purge on the operator's word); suite 3,871
> tests / 354 files. The operator's mic works when Plexii is launched
> from the Dock or the launcher is allowed the microphone.
> **DEC-131**: the panel — Message (was PlexiiMessage) with a one-row
> header (people · Meet · Recall · pin; no members button, a space reads
> as its people) and a panel-shaped composer (mic inside the box, no
> camera, taller); a + on Attention that opens the capture prompt; a
> Calendar tab after Attention (today's rail column, ‹ Today ›, the month
> at a glance, a day click → Book-time dialog → `lib/bookBlock`, shared
> with the grid). 12/12 live; suite 3,880 tests / 355 files. Addendum: the
> Calendar tab's day column fills the tab (`WeekTimeGrid fill`).
> **DEC-132**: home tiles scroll instead of clipping (the tile wrapper is
> `overflow-y-auto`); RailCard `fill` pins the header and scrolls the body
> (Rooms and desks' two columns each scroll; Continue; Quick actions); the
> standup pins its title row over a scrolling body; the command-center
> blocks scroll; `ItemStatusPill`'s menu is portalled at the pill's
> coordinates (flips upward at the bottom). 5/5 live; suite 3,886 tests /
> 356 files. **DEC-133**: every desk widget body scrolls (`WidgetFrame`),
> the Attention widget verified pinned + scrolling on home and desk, the
> standup's Save chip fixed (`icon-btn` retired from it). 4/4 live; suite
> 3,888 tests / 356 files. **DEC-134**: the Calendar and Meet pages are
> windows, not scrolls — headers pinned, the rail/grid/panes take the rest
> and scroll inside themselves (the week grid on `fill`, the month sharing
> its height across six weeks, the Meet rail hugging-or-shrinking, the
> Record and Transcript hugging-or-capping); the four `100vh` caps and both
> sticky rails are gone. 16/16 live at 2021×1105 and 1400×640; suite
> 3,896 tests / 356 files. **DEC-135**: the meeting detail header sits on
> a house card (the Timeline's own material), edge to edge with the cards
> below it, the speaker avatars ringed in the card's fill. 4/4 live; suite
> 3,896 tests / 356 files. Addendum: "Notes" and "New meeting" already carry
> it (one component) — verified on the running app, no code. **DEC-136**:
> the Record's section titles in Overview and Analytics (Summary, Your
> notes, the Brief sections, the transcript toggle, Who spoke, Moments) sit
> on a sunken band — `RECORD_SECTION_BAND` / `RecordSectionTitle`; Action
> items untouched. 4/4 live; suite 3,897 tests / 356 files. **DEC-137**:
> the Action items tab too (In Attention, From the summary, Carried from
> last time via a `band` prop; the wrap-up keeps its eyebrow); the band now
> lives in `components/RecordSectionTitle.tsx`. 4/4 live; suite 3,898
> tests / 356 files.

**Last updated:** 2026-09-07 — through DEC-137 on `ryan-assistant` (the Meet work is PR #6 from `ryan-next`; analysis/29 is its review package).
calendar: padded slots + an adjustable meeting buffer, affinity-scored
placement with visible "Grouped beside" reasons, discretionary clustering
with due-date barriers, and the RESCHEDULE route — "reschedule my day,
split between tomorrow and wednesday" now moves today's remaining blocks
across the named days, replacing them on accept in one undo batch).
DEC-096 closed GAP-020: the five real ink steps are defined in all three
themes (midpoints of their neighbours), --ink-300 rewrote to --ink-60, and
the lock is strict. DEC-095 restyled the Attention analytics tiles as house
material (gloss, tone ring, hover lift). DEC-094 restyled the plan review as Book time's sibling (presentation only —
the operator cut a larger redesign spec back to visuals; the cascade,
pinning, locked rows and capacity line were NOT built and remain open ideas
in that spec). DEC-093 made deadline chips draggable onto the grid;
DEC-091 was Phase 3 (context fidelity), DEC-090 plan-intent honesty + time
comprehension. **GAP-019 remains open** (`bg-[var(--token)]/N` invalid CSS,
~40 sites). analysis/27: Phases 1–3 done; Phase 4 gated on operator go;
Phase 5 rulings/process. DECISIONS-LOG carries DEC-072…092 in full.
**Branch:** `ryan-command-center` (push state: check both remotes before
assuming).
**Suite:** 3,528 tests green. Full typecheck clean.
**Operator action still owed (DEC-082):** grant Camera to the app Plexii is
launched from (System Settings → Privacy & Security → Camera) — until then
Meet tiles show the honest "Camera blocked by macOS" note.
**The transcript-UI rebuild is DONE (DEC-115)** — the operator's three
reference screenshots were the go; it shipped as the reorganised Record.

## <<<PROMPT BEGIN>>>

You are resuming **plexii-task-command-center** — the Attention layer (work_items) plus the
Calendar surface, iterating post-landing in PR-sized rounds under the operator's live QA.
You have no memory of prior sessions; everything lives in the repo's planning docs.

Read in order:
1. [ACTIVE-MISSION.md](ACTIVE-MISSION.md) — live state, newest at top
2. [DECISIONS-LOG.md](DECISIONS-LOG.md) — **DEC-001…101**, append-only. DEC-072…101 carry
   the day of post-landing rounds; DEC-056…061 the platform lessons.
3. [analysis/27-DEMO-FEEDBACK-PLAN.md](analysis/27-DEMO-FEEDBACK-PLAN.md) — the demo
   feedback consolidation and 5-phase plan (Phases 1–2 done; Phase 3 = context fidelity)
4. [GAP-REGISTER.md](GAP-REGISTER.md) — GAP-017 (Respond → Messages) is the last
   live one (GAP-018/019/020 all closed — the paint-integrity family is done)

Pre-flight:
```bash
cd ~/plexii-plexi && git fetch origin --prune && git fetch fork --prune && git status --short --branch && npm run typecheck && npx vitest run tests/unit
```

---

## Where we left off

**The platform is healthy and that was not free.** Six defects (DEC-056…061) were found
by *measuring the live database*, not by reading code — the suite was green the whole
time. Headlines: an unbounded sync loop costing 10 server writes/minute forever; ~2,500
Events per boot in a store that PLX-EVT-030 forbids ever pruning; a Keychain call on the
boot path that hung the app behind an invisible OS prompt. All fixed, all measured before
and after. **These shipped separately to `main` as [PR #5](https://github.com/saasmouth/focusbuddy/pull/5) — still OPEN and MERGEABLE**, deliberately carrying no
Attention/Calendar work so Caleb and Michael can inherit the fixes without the feature branch.

**The queue's hierarchy was re-baselined (DEC-070).** Four rounds of per-row connector
segments (DEC-062…069) each fixed a seam and produced another. The operator called a
reset and supplied an inspiration component. A subtree is now ONE animated group with ONE
dashed connector — seams are impossible by construction rather than by care. **The tests
now pin the ABSENCE of the old segment machinery. Do not reintroduce per-row line
segments.**

**Meet items point at a meeting (DEC-063/064/068)** — operator ruled option 2. Six manifest
columns, invite-shaped rows, capture flow in the editor, and a link to a real calendar block.

**The day plan is reviewable (DEC-071)** — a centre-peek pane showing which items, when,
and *why*, before anything is booked.

---

## What is next (priority order)

1. **The operator's live QA pass.** This has been the highest-yield loop all build —
   DEC-053, 055, 062, 065, 066, 067, 069, 070 and 071 all came from him looking at the
   screen. Notes come in → reproduce → fix in-stage → gates → commit.

2. ~~Reason text quality~~ **DONE 2026-08-30 (DEC-072).** `reasonFor` is now a
   strongest-checkable-fact ladder (overdue day counts, weekday dues, chosen
   urgency, momentum, already-started, days waited, mode-aware fallbacks incl.
   "Nothing else needs today"); the start strip got the same honesty pass.
   Live-verified over CDP on real data: 7 proposals, 6 distinct reasons, zero
   generic strings. 15 new pins; suite 3,211.

3. **SPEC-002 "The Attendant" — written up 2026-08-30; rulings not made.**
   The spec is preserved verbatim in
   [analysis/25](analysis/25-SPEC-002-ATTENDANT-RAW.md); the comparison was
   rebuilt against the code (not transcribed) in
   [analysis/26](analysis/26-SPEC-002-ATTENDANT-COMPARISON.md) — a REVIEW
   BACKLOG: potential items to adopt gradually, nothing authorized. Headlines:
   THREE spec corrections now (§3.7 velocity refined, §3.10 refined, §4.3
   trashNode claim stale — already fixed), the spec's self-assigned DEC/CR
   numbers all collide with the live log, ranked adoption candidates
   (export first), six recommended refusals each anchored to a standing DEC,
   and the Inbox↔Today wall question framed for a ruling (analysis/26 §7).

4. **GAP-017 — Respond → Messages.** Operator explicitly deferred: investigate the
   messaging surface FIRST. Do not rename a taxonomy primary; it is a schema and
   migration event, not a label edit.

5. **Still open from DEC-052:** Track C (external calendar sync — foundation laid, build
   deferred by ruling) and Track D tiers 3a/3b (email completion signals over the existing
   IMAP, then Slack behind an OAuth layer that does not exist yet — audit confirmed).

6. **Landing decision (operator's call):** 71 commits sit unmerged to `main`, flag-OFF for
   the team. PR #5 already carries the platform fixes, so nothing is blocked on this.

---

## Working rules that earned their place this build

- **Measure the live DB before believing the code.** Every platform defect was invisible to
  a green suite. `sqlite3 "file:$DB?mode=ro"` — always read-only, always back up first.
- **Verify by measurement, not screenshots.** The queue re-renders and scrolls between
  positioning and capture; clipped screenshots repeatedly landed on the wrong rows and
  twice produced a *confidently wrong* conclusion. `getBoundingClientRect` /
  `getComputedStyle` over CDP is the reliable evidence. Full-viewport shots don't drift; clips do.
- **A pin that a legitimate change breaks should be rewritten to the superseding truth,
  never deleted.** Several were, and each carries its history in the comment.
- **Main-process edits need an Electron restart**, not HMR. Renderer edits hot-reload.
- **Dual-remote push:** `git push fork …` as ryan-swan, then `gh auth switch -u ryanswan313`
  → `git push origin …` → switch back.
- **Disclose live-data changes.** Test values were written to real items three times this
  build and cleared each time; the record is in the transcript and the commits.

## <<<PROMPT END>>>
