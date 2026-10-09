# Active Mission

<!-- Single source of truth for live state. Update at every phase boundary, then regenerate
     NEXT-SESSION-PROMPT.md. -->

**Last updated:** 2026-08-30 (Attention/Calendar + platform-stability build) ·
**State:** 🏁 **LANDED on main** (PR #4, main @ `c0e32a0c`, default-OFF) →
**POST-LANDING ITERATION.** Branch `ryan-command-center` @ `4dc603de`, clean,
**71 commits ahead of main**, pushed to both remotes. Suite **3,196 / 304 files**
green; both typechecks clean; app boots in ~3s.
**Start here next session:** [NEXT-SESSION-PROMPT.md](NEXT-SESSION-PROMPT.md).

**SESSION 2026-08-30 (evening) — Plexi Meet round (DEC-082/083, UNCOMMITTED):**
video diagnosed to the root (macOS TCC denies camera to the LAUNCHING app's
identity — com.anthropic.claude-code, "Policy disallows prompt"; operator must
grant it in System Settings or launch dev from Terminal) + two real defects
fixed (tiles never called play(); OS-muted tracks rendered as silent black —
now an honest "Camera blocked by macOS" note, verified live against the
blocked camera). Meeting-born attention items now carry
sourceType 'meeting' → the queue chip links back to the meeting, transcript
on screen (driven live end-to-end). Suite **3,332**, full typecheck clean.
The Fireflies-level transcript UI rebuild is GATED on the operator's go —
not started, per instruction.


**SESSION 2026-08-30 (this doc's own update):** ① SPEC-002 "The Attendant"
written up — spec recovered verbatim from the transcript into
[analysis/25](analysis/25-SPEC-002-ATTENDANT-RAW.md), comparison REBUILT
against the code into
[analysis/26](analysis/26-SPEC-002-ATTENDANT-COMPARISON.md) (review backlog
only; three spec corrections incl. one new — §4.3's trashNode defect was
already fixed in S1; DEC/CR numbering collisions flagged; rulings NOT made).
② DEC-072 EXECUTED — planner reasons are now a strongest-checkable-fact
ladder, the intent/replan modes are distinguishable (`PlanDayOptions.source`),
the start strip stopped over-claiming superlatives; live-verified over CDP on
real data (7 proposals, 6 distinct reasons, zero generic). ③ DEC-069/070
hierarchy LIVE-VERIFIED by measurement (the owed photograph): a real
3-sub-item group + the LakeDash desk cluster, all geometry exact over CDP
(one connector per group, 14px inset, 6px bottom-1.5, spine top-level only,
handle at own depth, zero stray lines, collapse/re-expand drift-free) —
addendum under DEC-069/070. ④ **DEC-073…076 EXECUTED — the operator's
four-feature round:** New Desk (named + date/time prefill + Enter-creates +
navigates in), calendar double-click details + inline completion (rail circle;
the block check closes the ITEM through the one close path), the missed-items
launch triage (derived never stored, Later costs nothing, add-all-back = one
undo batch — fired live on remount and found 4 genuinely-slipped Thursday
blocks), and the widget bell + complete (state derived from the queue's own
rows; outlined-click = the menu's exact capture flow; filled-click opens the
queue — interpretive choice flagged in the DEC). ⑤ **DEC-077 EXECUTED — the
operator's refinement round on ④:** the bell FILLS solid (root cause: brand
line icons no-op Icon's `filled` by design — the same PLEXII path renders
filled at the call site), ONE `CompleteCircle` component adopted by all four
completion surfaces (grid blocks got a VISIBLE 12px circle; the hover check
narrows to plain blocks + undo), bell+circle moved beside the widget title,
the six-dot handle retired from BOTH queues with whole-row drag kept
(expanded rows opt out so notes stay selectable), and drop-to-nest lights
the whole target row (bg ternary consolidated — one owner per state). Suite
→ **3,254**; both typechecks clean; live-verified by real-DOM drive
(Attention: 15 rows / 14 draggable / 0 handles / 18px circles; Calendar:
15 rail circles / 4 block circles on 10 blocks / 0 handles), view restored
after. Earlier rounds COMMITTED on the operator's order: DEC-072 =
`d5a47571` · DEC-073…076 = `e781d7d8` · docs = `1e3ecae1`. **DEC-077 is
UNCOMMITTED — awaiting operator review.** ⑥ **DEC-078 EXECUTED — the
calendar breathes (operator QA, three asks):** HOUR_PX 44→56; the hours in
their OWN scroll window (pinned header band above — which also ends the
per-column deadline-band misalignment; `overscroll-contain`; opens at the
current hour; the rail's compact mode untouched); uniform raised day
columns with today as a light `ring-accent/35` outline ALONE. **Found while
verifying: `rgba(var(--accent),…)` arbitrary values are INVALID CSS and
have never painted** — DEC-053's today ring silently never rendered;
converted this round's nine occurrences to the configured slash pattern;
the ~10-file remainder is **GAP-018** (its own sweep — several files sit in
077's working set). All measured live over CDP: 150px commanded = 150px
moved, header pinned, page scroll untouched, ring computes
rgba(124,58,237,0.35). Suite → **3,255**. Follow-ups same day: the day
runs MIDNIGHT TO MIDNIGHT (constants flipped; the scroll window is what
made that safe), then ⑦ **DEC-079** — the rail's Today widget windows
twelve hours (scrolls for the rest, opens at now), trackpad horizontal
swipe pages the range through the chevrons' own `shift()` (one swipe = one
page, tail swallowed, vertical untouched), and the 12 AM label got its
headroom back (`pt-2`; it was clipping at the scroll edge). All verified
live against the real handler. Suite → **3,256**. Then ⑧ **DEC-080** — the
Book time dialog rebuilt to the operator's spec (steps 1–9 + edit mode +
the option-B token grammar; BlockComposer deleted; drag-highlight opens the
FULL dialog by ruling, inline create flagged OFF) and ⑨ **DEC-081** — the
name is Plexii, 70 fixes across 36 files, wake-word fix, grep-locked +
CLAUDE.md convention. ⑩ **DEC-082/083** (parallel session) — Plexii Meet camera root-caused to
the launcher's TCC identity (OS verdict, surfaced honestly in-app) +
meeting-born items link back to their meeting — committed `4f5e92c2`.
⑪ **DEC-084** — Capture rebuilt as Book time's sibling (tab bar gone, two
labelled fields + rotating placeholder, four-pill confirm with drawers,
honest confidence accents, New-item form DELETED) — `5b88490c`.
⑫ **DEC-085** — ⌘K → Attention opens Capture (armed pill retired from ⌘K;
the omni yield widened — plain "attention" no longer asks the model) —
`f31c7e24`. Suite → **3,332 / 311**. ALL ROUNDS COMMITTED: DEC-077 = `e88ee5c3` (parallel
session, attributed) · DEC-080 = `34feaab1` · DEC-081 = `327523f4`. Suite
→ **3,310**; both typechecks clean; tree clean.

**THIS BUILD (2026-08-27 → 08-30), 22 commits, DEC-056…071 — see DECISIONS-LOG:**

**Platform stability (DEC-056…061) — shipped SEPARATELY to main as PR #5, still
OPEN + MERGEABLE.** Deliberately carries no Attention/Calendar work so the team
inherits the fixes without the feature branch. Six defects, one shape: *a guard
that checked the request instead of the outcome.* An unbounded tombstone sync
loop (10 server writes/minute, forever, `sync_rev 7,319` on one widget); ~2,500
Events per boot in an append-only store PLX-EVT-030 forbids pruning (clean boot
now **4**); a synchronous Keychain call on the boot path that hung the app behind
an invisible OS prompt (**indefinite → 3s**); retention caps that had zero call
sites since the initial commit; a nav fan-in writing 39,762 rows in 19 hours; and
`visit_count` corruption user-visible AND fed to the LLM (Slack at 14,096
"visits"), repaired from its exact provenance. **All six were invisible to a
green suite and were found by measuring the live database.**

**Attention/Calendar (DEC-062…071).** Meet items now POINT AT a meeting (operator
ruled option 2 — an unanswered RSVP is a meeting not on your calendar, so it
cannot BE a block): six manifest columns, invite-shaped rows, a capture flow, and
a link to a real block. The day plan became reviewable before acceptance — a
centre-peek pane showing which items, when, and *why*, using a `reason` field the
planner had computed all along and never displayed.

**The queue's hierarchy was RE-BASELINED (DEC-070).** Four rounds of per-row
connector segments (DEC-062…069) each fixed a seam and produced another; the
operator called a reset and supplied an inspiration component. A subtree is now
ONE animated group with ONE dashed connector — seams impossible *by construction
rather than by care*. **The tests pin the ABSENCE of the old segment machinery.**

**A manifest gap surfaced while building (DEC-064):** `PATCHABLE` and `rowToNode`
both hand-listed `WORK_ITEM_COLUMNS`, so a new column got DDL, sync, CRDT
allowlists and emit but no way in or out — `source_url` had been **write-only
since DEC-052**. Both now derive from the manifest.

**SPEC-002 "The Attendant" written up (2026-08-30):** the spec is preserved
verbatim ([analysis/25](analysis/25-SPEC-002-ATTENDANT-RAW.md), recovered from
the transcript) and the side-by-side was REBUILT against the code at `9216f335`
([analysis/26](analysis/26-SPEC-002-ATTENDANT-COMPARISON.md)) — a REVIEW
BACKLOG only, per operator: adopt gradually, nothing authorized, nothing built.
The rebuild refined the two known spec corrections (§3.7 velocity — a legacy
desk-level elapsed-time ratio DOES exist but feeds nothing the spec claims;
§3.10 engaged time is aggregated, vs-plan is not) and found a third: §4.3's
"trashNode has no kind filter" defect was already fixed by nodeLifecycle.ts in
S1. Also flagged: the spec's self-assigned DEC-015…019/CR-08…10 numbers all
collide with the live log; two of its requested rulings are already
substantively ruled by DEC-052. Rulings remain NOT made.

**QA ROUND 3 + DEC-034/035 EXECUTED (2026-08-26, commits `ba3b518c`,
`2e7e210e`, `14419286`):** the operator captured his next asks INTO the layer
itself and they were built from his own queue. **Read/copy (`ba3b518c`):** queue
rows truncated with no way to open them — the text existed but only the DB could
give it back. Rows now expand in place (full title + notes, selectable) with a
Copy action; `itemFullText()` is the one definition. **DEC-034 (`2e7e210e`):**
capture is now task + optional NOTES (Tab into it, Enter files), the button says
**Enter ↵** not "Classify", and the second screen PREVIEWS the finished item
instead of asking what it will become. The tidy moved INTO that preview
("Tidied · undo") with **Enter as is** filing his own words — approve-before-
apply holds, R011 latency holds, and the verbatim capture is preserved on every
path (an untidied-notes case that would have dropped the typed text was caught
in review). **DEC-035 (`14419286`):** the six-dot handle — attach (group),
reorder, or drag to another section. Grouping is a SIBLING ref (`group_id` in
the manifest) because the leaf invariant forbids work-item parents; **exactly
one level, enforced at the DB**, and a child whose leader leaves the queue is
PROMOTED, never hidden. Suite **2,840**. Live-verified through the real IPC path.

**DEC-031/032/033 EXECUTED (2026-08-26, commit `f3741bf5`):** the operator ruled
"yes to all three" on the QA round's open questions. **DEC-031:** @attention is
now DETERMINISTIC anywhere in a message — one shared grammar
(`lib/attentionCommand.ts`) read by the composer, ⌘K, the home bar AND
`chatStore.send()`; leading = pure capture, inline = capture AND still send the
stripped message (both halves). Two bypasses were found only by driving the real
UI: ⌘K's "Ask Plexii" hard-scores 2000 and outranked the capture entry (the
operator's exact 30s path), and ⌘K/home/voice call `send()` directly, skipping
the composer's interception — `send()` is now the last-mile guarantee, and the
composer strips first so double capture is impossible. **DEC-032:** desk-placed
proposals carry an optional `deskId`; the model gets a real desk roster in both
prompts, the card resolves id-then-title and applies there — an unresolvable id
falls back to the chooser, never a silent retarget. **DEC-033:** the
`[ask-latency]` trail shipped and already answered the question —
`retrieval=831ms ttft=6518ms streamed=FALSE`: the credits proxy rejects
streaming, so the whole answer generates before anything appears. The 30s was
generation with zero feedback BY CONSTRUCTION, not a code inefficiency.
**Still open (needs a ruling):** BYOK-vs-progress-affordance for credits mode.
Suite **2,797**.

**QA ROUND 1 — chat composer (2026-08-26, commit `e61da75b`):** operator live QA
found the @ picker's keyboard contract (DEC-028c) broken in practice. Root cause:
ChatPanel's omni-intent Tab cycler is CAPTURE-phase, so it ran before
ProseMirror's suggestion plugin and swallowed every Tab — the picker's own
handler never fired, and the stolen keystroke cycled the preview to "Search the
web". Fixed (picker owns Tab while open) + two adjacent defects: the selected
row's 10%-tint highlight was invisible (now tint + inset accent bar), and the
intent strip PRE-SELECTED "Search the web" for @attention drafts even without
Tab — a false promise, since `submitComposer` intercepts a leading @attention
first; the strip now suppresses itself on a shared `ATTENTION_PREFIX_RE`.
Also strengthened the model rule: "@attention" ANYWHERE is a STANDING ORDER to
emit create-work-item, and alongside a buildable ask it must emit BOTH (the
operator's "pitch deck … @attention" produced only a create-page). Verified live
via CDP with real key events. Suite **2,781**. **OPEN FOR RULING (3):** (a) should
a trailing/mid-sentence @attention become DETERMINISTIC capture instead of
model-mediated (amends DEC-027)? (b) should `create-page` (and friends) carry a
desk target so "apply" doesn't demand a manual pick the model already knows?
(c) the ⌘K→ask→chat round trip took ~30s — needs its own latency trace.

**TAXONOMY ALIGNMENT EXECUTED (2026-08-26, commit `0ae275bf` — the stage
DEC-029a sequenced; no DEC consumed):** the eight primaries live end-to-end —
schema `to_do/to_review/to_decide/to_respond/to_meet/to_discuss/to_remember/
to_know` (acknowledgment+direct merged into to_respond; to_decide NEW with
terminal `'decided'`), labels To Do · Review · Decide · Respond · Meet ·
Discuss · Remember · Know, legacy→canonical map at every boundary, NEW
decide/respond hard triggers + the question-mark→to_respond wart fix, prompts
derive unions from the one shared list, `intent_sub` reserved in the manifest,
R-03 precision fix, SQL state predicates built from shared state arrays,
CLASS_CHOICES centralized (two drifting copies removed), and the **Layer-0
bare manual form** on the Attention page. `migrateIntentTaxonomyV2` renamed
the live DB's 24 rows + 20 notification rows (pre-imaged, idempotent,
re-runs each boot; VACUUM restore point via MIGRATION_VERSION 3).
**Incident caught live:** the first sync cycle REVERTED the rename (stale
baseRev → 409 → conflict-apply of the server's old copy) — fixed by
canonicalizing legacy classes in `normalizeAppliedWorkItem` ON APPLY (dirty
trigger re-pushes; fleet converges forward); second boot observed settled
canonical+clean on the real DB. CDP smoke: classify→to_decide/to_respond via
rules, new queue labels rendering, manual form→Decide queue→archived.
Baseline now **2,778 tests / 274 files**. Housekeeping: the standalone
sync-wake PR is MOOT (PRs #1–4 all merged, none open). Full ledger:
[phases/HANDOFFS/taxonomy-alignment.md](phases/HANDOFFS/taxonomy-alignment.md).

**DEC-020 EXECUTED (2026-08-25):** operator ruled "Retire the tabs and add plan due
dates to the feeders first" — done in that order. (1) `plan-due` feeder kind: plan
roots with due dates ("Plan due tomorrow" → plan dashboard) + due desks inside plans
("Due in 2 days · <plan>" → the desk), independent mutes/Δ10; (2) Plans, "Desks
(flat)", and Calendar left the sidebar (both rail states) — views stay ⌘K-reachable
(NEW "Plans" palette entry added), MainPane routes + calendar engine untouched
(DEC-009). Caleb precondition updated (shared Calendar surface).

**S7 + G6 CLOSED (2026-08-25):** feeders (due/stale desks surface AS attention, muting,
one-directional), Δ10 suppression both halves, the single deadline-proximity nudge, the
operator's three QA fixes (⌘K @attention score 500, desk-action routing rule, imperative
chat rule). 2745/2745 tests — 135 added over baseline, every stage closed with live
verification in ONE day. Full honest ledger incl. PARTIAL/DEFERRED/owed-P1 + merge
preconditions: [phases/HANDOFFS/s7-close-G6.md](phases/HANDOFFS/s7-close-G6.md).
**P1 LIVE PASS EXECUTED (2026-08-25):** R010 push-half PROVEN on live production data
(9/9 work_items server-accepted, revs 5–17, zero rejections) · retention rule RULED +
frozen in §8 · shared-refresh widened (org + shared arms reload the work-item store) ·
`nodeSharedRoot` partition fix (work_items resolve via their own store) · migrated-peer
attestation gate built (per-org, persisted, IPC'd; carry branch waits on SPEC-027) ·
re-toucher hunt SOLVED (live webview nav persistence, not a sync defect; registered for
Caleb) · [sync-mark]/[sync-409]/[sync-apply] structured trails landed (R016's named
signal). **TWO-DEVICE SESSION RUN (same evening): GAP-015 CLOSED** — 9/9 work items
materialized on device B with kind + projection intact (dismissed→parked held live);
fresh @attention capture round-tripped A→server→B; desk-trash arrived as soft-trash
(retention-rule substrate observed). **NEW FINDING P1-F1 [PLEXI-UPSTREAM]:** the
initial-pull truncation gap — fresh devices silently miss the truncated tail forever
(3 evidence rows; mechanism + remediations in the doc). Full record:
[phases/HANDOFFS/p1-live-pass.md](phases/HANDOFFS/p1-live-pass.md).

**DEC-021 EXECUTED (2026-08-25):** operator ruled "Adopt all three" — D1/D2/R008 as
proposed, L2 built the same evening. Shared desks: no unilateral trash (typed refusal
at deleteNode + purge; menu = Archive-for-me [archived made scope-local on shared
sync, both directions] / Leave-share [self-revoke + prune]). Personal delete: ONE
choice dialog — Move to Trash (default, stated contract) / Delete everything
permanently (typed-name confirm → subtree + memory purge via `purgeDeskPermanently`,
the FOURTH sanctioned delete site, + `db/memoryPurge.ts`; adversarially
scope-tested). R008 RATIFIED: no work_item hard-delete ever — both paths preserve
attention items, purge revives them to Attention with a counted notice.

**DEC-022 EXECUTED (2026-08-25, operator QA):** the delete dialog retired for
placement — "Move to Trash" direct everywhere; "Delete permanently" lives on the
Trash page (typed confirm, memory purge, items revive). DesksView/RoomsView adopted
the ONE lifecycle definition (they had drifted — QA caught it): rooms get the same
rules as desks incl. shared branches. Bulk selection landed in the shared index
engine: Select mode + Select all + bulk Move-to-room/Archive/Trash (one undo toast,
shared items skipped from trash with a count).

**DEC-023 EXECUTED (2026-08-25):** capture-from-desk parenting (view-snapshot,
"on <desk>" chip, shared/archived excluded) + the Settings → AI → Attention layer
toggle (live re-probe). Instance B retired (profile removed).
**THE PR PACKAGE IS BUILT:** [UPSTREAM-PR-PACKAGE.md](UPSTREAM-PR-PACKAGE.md) —
paste-ready PR body, layer map, flagged diffs, findings F-1…F-6, preconditions,
drift status (6 upstream commits, ipc/index.ts-only overlap), rollout plan.
**Operator's move:** merge-from-main once on the fork, open the PR with the
package's body, hand Caleb §4 (F-1 matters independently).

**LANDING STATUS (final, 2026-08-26):** the layer **LANDED via PR #4** (main @
`c0e32a0c`, main CI green). The wait-until-finished fork-only rule is FULFILLED
and retired. "Declare ready" was later revealed as a misunderstanding; **DEC-030
ruled LEAVE IT LANDED** — no revert (can't un-reveal; revert-trap), the flag is
the gate, iteration continues in PR-sized rounds. Landing pattern that stands:
branch push + `gh pr merge` as ryanswan313 (raw push to main stays blocked).
Owed: the operator's WIP framing note to Michael + Caleb (drafted, unsent).

**THE FINISH LINE (GA checklist): BUILD COMPLETE ①–⑤.** ① FYI backstop ✔ ·
② item archival ✔ (DEC-024) · ③ multi-intent ✔ (DEC-025) · ④ cleanup rewrite ✔
(DEC-026) · ⑤ composer typeahead ✔ (DEC-027) + **DEC-028 QA round ✔**: the confirm stop
extracted into ONE AttentionConfirmCard; a leading @attention in chat files
INLINE above the composer (never leaves the chat; cancel restores the
message); ⌘K and the home Ask-Plexii bar surface Attention on "@a…" partials
and **Tab arms an accent @attention pill** (query = capture text, Enter
files, Backspace-on-empty disarms); the chat picker inserts a REAL visual
mention chip (onPick skipped — never a stored reference) ·
⑥ **operator smokes remain**: capture-onto-desk → trash desk → item survives
to Detached shelf · a compound capture (secondary chips) · a rambling capture
(tidy offer; needs API key) · chat: @ → Tab → type → send → inline card ·
⌘K and home bar: @a → Tab → pill → Enter · shared-desk menu (whenever a
desk is shared again).

**CR-09 REGISTERED (2026-08-26, ANALYSIS ONLY — nothing built):** contextual
attention — object-marking (widget/desk → deterministically-named item via the
existing confirm card; sourceType/sourceRef already in the manifest), widget
scope control (desk/room/all), the plan-boundary rule (items point, scopes
group, plans are CHOSEN — accumulation only ever SUGGESTS), and the context-menu
IA regroup (additive-only pre-landing lean). Full design space + decision list
D-A…D-E: [analysis/21-CR09-CONTEXTUAL-ATTENTION.md](analysis/21-CR09-CONTEXTUAL-ATTENTION.md).
**PART II added (operator pullback — the full-scope frame):** the two-layer LAW
(manual complete / AI only pre-fills+proposes+enriches), pull-not-push (suggested
items never notify — surfaced at moments of use), the ProposalTray as the one
review discipline (chips generalized), three sources one system (typed / marked /
observed), Living Doc + Meetings as the first observers (both half-built:
meeting vocabulary + approval_state='suggested' shipped in S2/S5), the Layer-0
gap audit (no item editing · no Attention selection mode · no bare manual form),
deferred rails named (tags/cross-ref, delegation→SPEC-027, standup feed).
Decision list now D-A…D-K. Awaiting the operator's brainstorm → DEC-031+.
Recommended post-landing.

**DEC-029 (2026-08-26): taxonomy tests adopted as LAW + R-06 confirmed; the
GROUNDWORK SPLIT LANDED ON MAIN** — PR #3 (CI to Node 22; the repo's CI had
been red on main itself: node:sqlite needs ≥22.5) merged by the operator, then
**PR #2 merged (main @ 5d1ef8d8)**: credits chat, mention-picker keyboard,
room routing, the 409 baseRev floor — all live for Michael + Caleb, with the
repo's FIRST green CI runs (push + PR, 2m33s). Side discoveries recorded:
`ryanswan313`'s token lacks the `workflow` scope (workflow-file ops need the
browser or a scope refresh done while signed in as that account); the
groundwork worktree lives at `~/plexii-groundwork` for future fix splits.
**Fork↔main merge DONE (836e0bb1 + repair 13da3c34):** the branch now contains
main @ 5d1ef8d8; five predicted conflicts resolved keep-branch; the auto-merge
briefly duplicated the F010 functions + a preload property (caught by typecheck,
excised). 2,763 green. The branch is current with everything the team has.

**🏁 LANDED (2026-08-26): the operator declared ready — PR #4 merged, main @
`c0e32a0c`, content delta between branch and main = ZERO files.** 91 commits,
172 files, +16,998/−429, 2,763 tests, DEC-001…029 — from empty planning folder
to landed layer in three days. The layer ships default-OFF; the reveal message
to Michael + Caleb points at PR #4 + UPSTREAM-PR-PACKAGE.md. Post-landing
queue: CR-09 (D-A…D-K brainstorm → DEC-031+), the category alignment stage
(analysis/22), the observers, SPEC-027 routing era. **DEC-030 (same day):
"declare ready" had been a misunderstanding — operator ruled LEAVE IT LANDED;
iteration continues; the WIP note to the team is his to send.**

**DEC-019 IMPLEMENTED (2026-08-25, 2d251f0a):** (a) CR-08 phasing ratified by operator;
(b) ONE capture model — @attention prefix in ⌘K captures directly, single palette
entry, console header 'Attention' + Open page →, ROUTED always stops at the one
confirmation screen (classifier's pick pre-highlighted, Enter files, arrows cycle,
deadline question inline), @attention chat-mention rule, user-facing labels say
Attention; (c) ONE Attention widget with section slider — the seven att-* retired via
registry flag. 2741/2741 tests.

**S6 CLOSED (2026-08-25):** widgets ×7 + L3 staleDesks + ranker v1 +
attentionPrecision wiring + lenses (Queue/Due/Origin + Recently closed) + CR-04(b)
renames complete (GAP-006 closed) + L1-deferred menus via one shared definition +
Attention top-level nav. Operator's three live-QA bugs fixed in-stage (idea trigger,
intentClass end-to-end, Expand via fb:composer-stage) + the year-off schedule-event
bug registered for Caleb. 2741/2741 tests. Ledger:
[phases/HANDOFFS/s6-close.md](phases/HANDOFFS/s6-close.md).

**CR-08 REGISTERED (awaiting ruling):** operator proposes Tasks tab + Plans + Calendar
consolidate into Attention. Pressure-test: adopt the semantics, phase the navigation —
(a) lenses/nav DONE; (b) S7 feeders make desks/plans surface AS attention items, then
the flat tab retires by DEC; (c) Calendar tab's fate = DEC with Caleb (DEC-009 engine
stays); (d) Plans stay per DEC-010, feeding Attention. Attention aggregates by
reference — it must never become the container (the synthesis's own #1 anti-goal).

**S6a SHIPPED (2026-08-25):** C-4 checkpoint PASSED (main drift = 2 commits, zero hot-file
overlap; ipc/index.ts noted for the eventual merge). The Attention page is live: queues
by intent class with per-class closing verbs, due chips, one-line reasons, snooze,
reclassify, open-its-desk, the Detached shelf with MOVE recovery, top-bar headline count
(SPEC-015, zero-silent), sidebar + palette entries. 2736/2736 tests. Remaining for S6
close: seven Home widgets, CR-04(b) renames, ranker+attentionPrecision, L1-deferred
menus, cleanup composer, four-theme pass + native-fit rubric.

**S5 CLOSED (2026-08-25, commit 7554ce86):** capture console (Routed/Unrouted/Expand,
composer-owned Q1 question), deterministic-first classifier (Haiku fallback,
loose-thought floor), closed-loop notifications through S4, Δ3 decay tier, flag-ON
prompt activation (chat catalog + meeting wrapup + voice), executor's real apply path.
**workItems.enabled = ON** (personal scope; org exposure stays behind the P1 checklist).
2731/2731 tests; live on fresh PID. Deferred honestly: opt-in cleanup + multi-intent
secondary cards → S6. Ledger: [phases/HANDOFFS/s5-close.md](phases/HANDOFFS/s5-close.md).

**Intake CLOSED (operator, 2026-08-25):** "part 2 landscape map" was an accidental
cross-thread paste — struck; the synthesis (analysis/20) IS the full list. S5/S6/S7
prompts enriched with Δ1–Δ13. Δ3's v1-simple loose-thought decay proceeds as the
standing strongest-recommendation (14-day dismiss, reason 'decayed') — flagged for veto
in the S5 close.

**L1 SHIPPED (2026-08-25, commit 34acf80f):** the desk lifecycle surfaced — Trash view
(roots + days-remaining + lossless subtree restore), sidebar entry both rail states,
Archive/Trash in the All Desks + All Rooms native action menus, archived shelf chips.
Shared desks/rooms hold lifecycle actions pending D1. Deferred to S6: menus on
StageManagerStrip/DeskGallery/CanvasBreadcrumb (no native affordance exists there).
2702/2702 tests. CR-07's before-Phase-5 direction satisfied for the approval-free half;
L2 still needs D1/D2.

**Synthesis intake part 1/2 DONE (analysis/20):** 12 exact confirmations, 13 detail
deltas queued for S5–S7 prompt enrichment, 0 conflicts, 5 synthesis-open questions
already closed by DECs. **Waiting: part 2 (the current-landscape map) → then enrich
S5/S6/S7 prompts → resume autopilot.**

**S5 HOLD (2026-08-25, operator checkpoint):** the operator flagged that SPEC-001+A1 was
the compiled OUTLINE (scope, 44 items) — the FULL comprehensive product features list
lives in the spec-drafting chat session and has never been intaken here. S0–S4 were
foundation stages built to the approved v2.3 architecture (scope-level items sufficed);
S5–S7 are the product-detail stages where the full list matters. Recommendation
delivered: the list is pasted HERE and the prompts are authored/enriched in this session
(against v2.3 + the as-built code); the other session's role is cross-check, not author.
Process on intake: diff vs SPEC-001+A1 (map the 44, extract detail deltas + new items,
check v2.3 conflicts → crossroads for any) → enrich S5/S6/S7 prompts → resume autopilot.
Meanwhile: lifecycle L1 (approval-free) is buildable and satisfies the CR-07
before-Phase-5 direction; D1/D2/R008/R012 grouped rulings re-surfaced (now timely).

**S4 CLOSED (2026-08-25, commit 235a016e):** the notification substrate — durable
wi_notifications store (UNIQUE dedupe), per-queue hourly caps with one-summary collapse,
mark-then-show delivery, block reminders moved to main (restart-proof; SPEC-024/029
deliverable), decoy retired with its PLX-UX assertions ported, notifyExternal re-pointed
by construction (seven callers, zero edits), DEC-018 A-1 actor seam + A-2 mission queues
reserved+test-locked, attentionBadgeCounts ready for S6. 2700/2700 tests; live table
verified on the real DB. Ledger: [phases/HANDOFFS/s4-close.md](phases/HANDOFFS/s4-close.md).

**S3 CLOSED (2026-08-25, commit 00240bda):** the workItems:* namespace (9 verbs, F008
one-code-path), the renderer store as live-path producer (status never emitted; manifest
attrs only), sync-loop refresh, the fb:command-new-work-item creation seam. 2694/2694
tests. Flag stays OFF until S5/S6 (deliberate — the S0 catalog addendum must not
advertise the verb before its surfaces exist). Ledger:
[phases/HANDOFFS/s3-close.md](phases/HANDOFFS/s3-close.md).

**S2 CLOSED (2026-08-25, commit 2c133165):** the sync contract. Column manifest (one
source, 13 cols) + status projection (never-done pinned) + satellites with orphan sweep +
detach-hook wiring + the ARRIVAL ROUTER (live-path work_item events route to the one db
code path; deletes soft-trash, never tombstone) + allowlist/emit parity by spread + poll-
arm recompute ×3 + the 409 baseRev fix [PLEXI-UPSTREAM]. 2686/2686 tests. **Live:**
schema landed on the real DB (13 cols + wi_local/wi_deliveries, 112/112 rows, FK clean);
**the 409 fix cured the perma-dirty demo rows live** (settle window observed; revs
advance). New P1 lead: a local periodic writer re-touches those demo rows each cycle
(pre-existing). Full ledger: [phases/HANDOFFS/s2-close.md](phases/HANDOFFS/s2-close.md).

**S1 CLOSED (2026-08-25, commits ae0f071e/63b0fc0b/bfaf00ba):** the FOUNDATIONAL stage.
`migrateNodesKindCheckV2` **fired on the live DB and passed every assertion** (112/112
rows, 4-kind CHECK, trigger+indexes survived, FK-check clean, dual restore points);
`nodeLifecycle.ts` owns the closed three-site hard-delete enumeration with
detach-and-revive; C2 + leaf-invariant typed refusals; listNodes exclusion; park-inbound
replaces the sync swallow (GAP-013) [PLEXI-UPSTREAM]; CI delete-site lock armed; NodeKind
union swapped (CR-05a). 2649/2649 tests. Full ledger:
[phases/HANDOFFS/s1-close.md](phases/HANDOFFS/s1-close.md). Deferred per R010: the
sync-side kind round-trip (disposable account, P1 checklist).

**S0 CLOSED (2026-08-25, commit 09e129d9):** vocabulary quarantine executed — shared
vocabulary module + workItems.enabled flag (default OFF, voiceProviderPref pattern);
create-task defined as desk at every model-visible site incl. the meeting-wrapup rule;
`create-work-item` reserved end-to-end (union type, five parser arms, creation gate,
labels, honest executor no-op); gated catalog addendum injected flag-checked at both
consumers; label worklist landed (desk language in action cards, toasts, refusals, Flow
editor); Flow engine honest-default arm. 18 new grep-lock tests; suite 2628 green,
typecheck clean. Renderer half live via HMR; main-process prompt half compiled+tested,
takes effect on next app launch (dev server runs without --watch — normal). Deferred to
S6 per CR-04(b): AllTasksView/segments/Pulse/MakeTaskDialog surface renames. Orphaned
dashboard portlet strings skipped (unreachable UI).

**G2 MET — Phase 2 complete, all seven items:** matrix adversarially verified (12
CONFIRMED / 4 PARTIALLY / 0 REFUTED; two class disputes upheld + corrected; six misses
integrated → GAP-016; verdict in analysis/02). Evidence library: 02, 10, 11, 12, 13, 14,
15, 16 + registers. Per DEC-015's clean-validation condition: **autopilot proceeds into
Phase 3 — strategy + logic-audited architecture** (the real build plan: schema DDL incl.
dual-start migration, SPEC-002 columns + mapping table + assignee reconciliation +
allowlist additions, IPC/preload signatures, notification substrate design, component
decomposition, stage breakdown with verify-commands, then per-stage build prompts).
**Phase 3/4 CLOSED (2026-08-25): ARCHITECTURE.md v2.3 APPROVED — G3+G4 MET with dual
signatures.** Chain: v1 REJECTED (14 findings) → v2 (11) → v2.1 (14, incl. blind
validator's 6 conditions; C1≡F-C1″ found independently = dual validation working) → v2.2
(narrow verify: 11/12 CLOSED, 8/8 code citations exact, 2 propagation slips) → **v2.3
(0 open findings)**. Per §7's rule, per-stage build prompts (S0–S7) are now authorized —
that authoring is the live task.
Risk war-game COMPLETE → analysis/17 (18 risks; top-3: R016 GAP-013-at-fleet-scale if
merged, R001 sync-engine collision with Caleb's churn, R008 work_item delete semantics
undefined). **v2.1 revision after re-gate verdicts** folds in the adoptable risk repairs:
work_items as LEAF nodes at v1 (kills R009), no-hard-delete-at-v1 pending a DEC (R008
fallback), version-stamp column + same-device migration guard (R005/R006), satellite
orphan reconciliation (R017), S5 latency target (R011), config-flag shared-desk guard
(R015), merge-readiness preconditions (R016). Lifecycle track PLAN drafted
(phases/TRACK-LIFECYCLE; deletion bug = pure UI-exposure gap).
**Awaiting operator (grouped for one pass):** D1 shared-desk delete v1 default · D2 purge
semantics · R008 work_item delete contract (or accept the v1 no-hard-delete fallback) ·
R012 the "lifecycle before Phase 5" reading (strict vs. content-only). Sync-fix branch
shipped + cherry-picked; PR command handed to operator.

**G1 MET (DEC-014):** spec captured + inventoried (44 items + SPEC-042/043/044); primary
objective confirmed as drafted; all crossroads ruled (CR-01..07 = standing recommendations;
CR-07 = Option B parallel prerequisite); Q5 shaped (DEC-013); IQ-1 resolved (deliberate
trim); ambiguities Q1–Q4, Q6–Q8 scheduled for Phase 2/3 proposals returned for approval.

**Phase 2 scope + state (updated after the agent returns, 2026-08-24 night):**
1. ~~SPEC-004 classification~~ ✔ **DONE** → analysis/10 (spot-verified 6/6): 223 true
   sites, 44 must-touch, no TS safety net, blast-radius top-8, `listNodes` = highest-leverage
   fix, GAP-013 discovered (cross-version sync swallow).
2. ~~SPEC-044 vocabulary audit~~ ✔ **DONE** → analysis/11 (spot-verified 6/6): 62
   model-visible occurrences, 3 files already correct, riskiest-5 ranked, persistence map,
   label worklist.
3. ~~C1-03 triage~~ ✔ **DIAGNOSED** → analysis/10 §6: enumeration/two-source bug, metadata
   intact; fix shape = product call → G2 docket.
4. ~~Sync proof~~ ✔ **PASSED (2026-08-24 23:21)** — operator-run live round trip:
   server stores + echoes unknown node columns intact → analysis/12. **A-003 VALIDATED
   (0.97); DEC-007's ratification evidence complete.** Kind-value direct confirmation
   scheduled post-migration (Phase 6 stage 1).
5. ~~ACL semantics~~ ✔ **DONE** → analysis/14: three scopes, server-side membership,
   per-person addressing absent → v1 routing = scope-carried + client-filtered with a
   stated visibility contract; four G4 consequences named.
6. ~~Sync reliability~~ ✔ **DONE** (spot-verified 4/4) → analysis/15: THREE transports
   (CRDT-WS live + HTTP poll + Yjs docs, dual-write); **7–8s root-caused** — the
   running-guard silently drops receiver wakes, cycles lengthened by serial PUTs (~6-line
   coalescing-re-arm fix; ownership note: Caleb's subsystem); slide decks non-replicating
   by construction in three places; **GAP-015** — CRDT field allowlists would silently
   drop SPEC-002's routing columns on the live path; 409-loop + version-gate + shared
   refresh named as ranked P1 preconditions. Plus GAP-014 (own DB inspection): live DB
   already CHECK-widened; kind acceptance proven; A-003 → 0.99.
7. Gap matrix DRAFTED → analysis/02 (all 44 + amendments classified with evidence);
   **adversarial verifier agent in flight** (refute-mode, all E/CR claims + ≥30% sample).
   G2 closes when 6+7 return clean. Also delivered: **Q1/Q7 concrete proposals →
   analysis/16, awaiting operator ruling** (due before Phase 5, not blocking Phase 3/4
   foundation). Operative scope baseline: SPEC-001 + A1 (analysis/13; DEC-015).

## Right now

**ARCHITECTURE.md v2.3 is APPROVED (2026-08-25) — the single source of design truth for
the build.** Live task: author the per-stage build prompts (S0–S7 per §7's stage table)
into `phases/BUILD-PROMPTS/`, each self-contained against v2.3 with pre-flight, contents,
key-verify commands, and rubric hooks. Then execute S0 (SPEC-044 vocabulary quarantine)
under DEC-015 autopilot. The lifecycle track's L1 (approval-free additive UI) interleaves
on bandwidth; L2 still needs D1/D2. **Operator ruling set still open (non-blocking):
D1 · D2 · R008 (v1 no-hard-delete fallback already baked in §2.5.10 pending the DEC) ·
R012.** PR for `fix/sync-wake-coalescing` awaits operator's click.

## Execution order

1. ~~Phase 0 — Foundation~~ ✔
2. ~~Phase 1 — Spec intake & decomposition~~ ✔ (G1 MET, DEC-014)
3. ~~Phase 2 — Current-state verification & gap analysis~~ ✔ (G2 MET, dual-validated)
4. ~~Phase 3 — Product strategy & experience design~~ ✔ (merged into ARCHITECTURE per F011)
5. ~~Phase 4 — Technical architecture~~ ✔ (**v2.3 APPROVED — G3+G4 MET, dual signatures**)
6. Phase 5 — Staged build roadmap → per-stage prompts (S0–S7) ← **NOW**
7. Phase 6..N — Execute per-stage loop (DEC-015 autopilot; lifecycle track interleaved)
8. Phase F — Integrate & close

## Recently completed (audit trail — most recent first)

- **2026-08-25 — ARCHITECTURE GATE MET (G3+G4, dual signatures) → v2.3 APPROVED.**
  Four audit rounds + one narrow closing verification; final pass: 11/12 repairs CLOSED,
  8/8 code citations exact, remaining 2 propagation slips + 3 nits fixed in v2.3
  (§7-S1/S2 rows re-anchored to §2.5.4's five cases and §2.4's `detached_from_id`;
  §2.5 renumbered 1–10; writer count six + `ensureSharedContainer`; CI-lock scope pinned
  to nodes-targeting DELETEs + migration's own `DROP TABLE` allowlisted; §2.6 P1 checklist
  carries the prune exclusion). Build-prompt authoring authorized per §7.
- **2026-08-24 (latest) — Vocabulary complete + consumer census.** DEC-012: the surface is
  **"Attention"** (verified convergence with Caleb's existing `AttentionItem`/`ContextObject`
  + `attentionPrecision()`; "Signal" eliminated — the sync transport is the signal server).
  GAP-011 registered with measured census: **305 kind-branching call sites / 99 files** to
  classify in Phase 2 (negations + unfiltered child enumerations = the risk classes).
  All spec-blocking rulings now closed — the spec-drafting session has its green light.
- **2026-08-24 (late) — Five pre-spec rulings approved + Design Fidelity Standard.**
  Operator approved analysis/05-PRE-SPEC-RULINGS.md in full → DEC-007 (schema: widen CHECK,
  work items are nodes), DEC-008 (routing: spec both, self-first), DEC-009 (calendar:
  engine stays, surface licensed, external P2), DEC-010 (plans untouched v1), DEC-011
  (vocabulary: `work_item`, forever). Sync substrate verified (CRDT, server-mediated,
  `nodes` + `time_blocks` on the whitelist) — A-003 0.55→0.85, GAP-008 IN_PROGRESS.
  Design directive codified → [DESIGN-FIDELITY.md](DESIGN-FIDELITY.md).
- **2026-08-24 — Preservation & Rebuild Doctrine codified (Phase 0 addendum, DEC-006).**
  Operator's pre-spec directive locked in: core Plexii is inviolable; rebuilds of existing
  surfaces go through the Crossroads Protocol (operator decides); foundational
  schema/routing changes get the strictest tier; every spec item triaged P0/P1/P2 against
  the operator-confirmed primary objective → [PRESERVATION-DOCTRINE.md](PRESERVATION-DOCTRINE.md).
  Threaded through intake, roadmap gates, rubrics; A-006 (calendar usage) registered.
- **2026-08-24 — Legacy task-branch harvest (Phase 0 addendum).** `ryan-task-system-port`
  (`fd12cc2f`) excavated: data model, production-grade CHECK-widening migration + pinning
  test, 3 polished UI components, measured port costs (small: 10 files, ≤210-line target
  drift, zero new deps). Reference-only per DEC-005 →
  [analysis/03-LEGACY-TASK-BRANCH.md](analysis/03-LEGACY-TASK-BRANCH.md).
- **2026-08-24 — Phase 0 shipped.** Mission-control scaffolded from the agent-os template
  (9 docs, zero raw placeholders); gates G1–G6 adapted; registers seeded (7 gaps + 2 open
  questions, 5 assumptions, 4 decisions); Phase 1 PLAN written; baseline pre-flight PASS.
- **2026-08-24 (earlier today) — Foundation prerequisites.** Branch `ryan-command-center` cut
  @ a92b30cb and pushed to fork; codebase map produced and delivered
  (`.claude/COMMAND-CENTER-MAP.md` + artifact); dev app launched, HMR round-trip verified.

## Open items

See [GAP-REGISTER.md](GAP-REGISTER.md). Non-blocking niceties: Caleb/Michael re-adding
`ryan-swan` as collaborator on origin would allow moving the branch off the fork (DEC-001).

## How this file gets used

Read at session start. Update "Right now" + "Recently completed" at each phase boundary;
regenerate [NEXT-SESSION-PROMPT.md](NEXT-SESSION-PROMPT.md). If "Right now" says X and the
operator asks for Y, surface the conflict before doing Y.
