# Decisions Log

<!-- APPEND-ONLY and immutable: never edit a past entry — supersede with a new one that links
     back. The value is the "alternatives considered" line. -->

## DEC-001 — Develop on a fork branch, not the shared repo

**Date:** 2026-08-24
**Decision:** All command-center work happens on branch `ryan-command-center`, cut from
origin/main @ `a92b30cb` (v4.1.0), pushed to fork `ryan-swan/focusbuddy`; updates from Caleb
keep flowing in from `origin`.
**Context:** `ryan-swan` has pull-only access to `saasmouth/focusbuddy` (403 on push; the old
PAT is gone from the keychain), and the operator wants full isolation because the feature may
not ship.
**Alternatives:** Push branch to origin — blocked by permissions and weaker isolation;
ask Caleb/Michael to re-add collaborator first — 30-second fix but blocks on another person,
and doesn't isolate. (Getting re-added stays open as a nice-to-have; one push moves the
branch to origin if wanted.)
**Outcome:** Triangular workflow: fetch origin, push fork. Maximum separation at zero cost.
**Made by:** Claude (operator-directed isolation requirement)

## DEC-002 — Mission-control lives in-repo at `planning/`, untracked until asked

**Date:** 2026-08-24
**Decision:** This folder (`planning/plexii-task-command-center/`) sits inside the Plexii
repo per the start-a-new-initiative convention (`<parent_project>/planning/`), left
untracked; committing it to the branch is the operator's call.
**Context:** Feature-scope initiative; the plan should live next to the code it governs.
**Alternatives:** `~/AI/Plexii/` (marketing-repo) — splits plan from code; agent-os
`initiatives/` — that's for system initiatives, and the IP-boundary constraint discourages
cross-tree coupling; committing immediately — operator hasn't asked for commits.
**Outcome:** In-repo, untracked, one `git add planning/` away from versioned.
**Made by:** Claude (convention from the playbook; flagged for operator confirmation)

## DEC-003 — Agent-OS is the governing methodology, not the runtime

**Date:** 2026-08-24
**Decision:** This initiative runs the start-a-new-initiative playbook, phased-build
discipline, quality gates G1–G6 (adapted in QUALITY-FRAMEWORK.md), confidence scoring with
the 0.65 critical-path block, assumption + decision + gap registers — as documents and
dispatch discipline, without wiring agent-os's hook runtime or JSONL meta-logs.
**Context:** Operator: "reference the agent OS file and framework … as starting point and
guide." The agent-os repo's own watchdog logged a FAIL (hook-behavior tests) on 2026-08-24 —
its documentation layer is unaffected; its runtime wasn't going to be wired here anyway.
**Alternatives:** Full runtime symlink into this repo — heavy, entangles Plexii with the
unresolved agent-os IP-boundary constraint, and the hook layer is currently red;
no framework (ad-hoc rigor) — exactly what the operator asked to avoid.
**Outcome:** Methodology + gates + registers here; agent-os tree untouched.
**Made by:** Claude (operator-directed)

## DEC-004 — Analysis before build, spec as the authority

**Date:** 2026-08-24
**Decision:** No code, no schema, no UI until: spec intake (G1) → verified gap matrix (G2) →
approved strategy (G3) → logic-audited architecture (G4) → operator-approved staged roadmap
(G5). Enhancement ideas beyond the spec are proposed and priced, never silently added.
**Context:** Operator: "Don't build anything yet… get the structure and foundation solidly in
place." House rule from agent-os dev pipeline: architecture passes Logic Auditor before code.
**Alternatives:** Start schema work now on the known gaps (GAP-001..003) — tempting, but the
spec decides the task model's shape; building first inverts the authority.
**Outcome:** The pipeline above, with pressure tests at G3, G4, and every Phase 6 stage.
**Made by:** Both (operator framing; Claude formalization)

## DEC-005 — Legacy task branch is reference-only until Phase 4/5 authorizes reuse

**Date:** 2026-08-24
**Decision:** `ryan-task-system-port` (`fd12cc2f`, the distilled task-item slice of
`Ryan-structural-changes`) is harvested as knowledge —
[analysis/03-LEGACY-TASK-BRANCH.md](analysis/03-LEGACY-TASK-BRANCH.md) — but nothing from it
is merged, cherry-picked, or copied into the build until the Phase 4 schema decision and
Phase 5 roadmap explicitly authorize specific artifacts. If reuse is authorized, it happens
by hand-reviewed re-apply from `fd12cc2f`, never a mechanical merge (base is 3.9.8).
**Context:** Operator: "go research that branch… use its knowledge for reference. And
potential to accelerate coding… if it's directly applicable… but do not incorporate anything
yet." Research found the transplant surface is small (10 files; targets drifted ≤210 lines;
zero new deps) and the migration is production-grade with a pinning test.
**Alternatives:** Rebase/merge the branch now — mechanically impossible cleanly (3.9.8 base)
and violates DEC-004's analysis-first order; ignore it — wastes a verified migration and a
polished UX foundation.
**Outcome:** Reference doc written; GAP-001 now carries the branch as exhibit A for the
extend-nodes path; acceleration potential quantified for Phase 5 estimation.
**Made by:** Operator (directive) + Claude (formalization)

## DEC-006 — Preservation & Rebuild Doctrine adopted

**Date:** 2026-08-24
**Decision:** All phases operate under [PRESERVATION-DOCTRINE.md](PRESERVATION-DOCTRINE.md):
(1) Plexii's core critical functionality and UI/UX is inviolable; (2) existing features MAY
be rebuilt when the primary objective needs it, but only via the Crossroads Protocol —
options priced, recommendation given, **operator decides**; (3) foundational changes (schema,
information routing/storage, sync, brain/memory) carry the strictest tier: additive-first,
reversible, dual-validated, regression-guarded. Every SPEC-NNN is triaged P0-core /
P1-supporting / P2-roadmap-later against the operator-confirmed primary objective; the cut
line is operator-approved at Phase 3.
**Context:** Operator pre-spec directive, 2026-08-24: the spec is huge and cross-cutting
(tasks, plans, desks, tools, widgets, command palette, AI/brain, calendar, homepage); triage
matters; current Plexii is excellent and its core must survive; rebuilds are sometimes right
(calendar named as example) but the call is the operator's at each crossroads.
**Alternatives:** Treat every conflict case-by-case without doctrine — exactly the ambient
drift this mission-control exists to prevent; hard "never touch existing code" rule —
contradicts the operator's explicit rebuild license.
**Outcome:** Doctrine doc written; threaded into SPEC-INTAKE (area taxonomy + tier fields +
primary-objective extraction), ROADMAP gates (crossroads docket at G2, cut line at G3,
dual-validated FOUNDATIONAL at G4, regression guard per stage), QUALITY-FRAMEWORK (preservation
rubric dimension), ASSUMPTIONS (A-006 calendar usage).
**Made by:** Operator (directive) + Claude (codification)

## DEC-007 — Schema: widen the `nodes` CHECK; work items are nodes

**Date:** 2026-08-24 · **Made by:** Operator (approving analysis/05-PRE-SPEC-RULINGS.md R1)
**Decision:** The new entity extends the `nodes` table (CHECK widened via a migration modeled
on the harvested, test-pinned `migrateNodesKindCheck`). Replicating metadata = node columns;
purely local state (read cursors, snoozes, delivery records) = satellite local tables.
**Alternatives:** dedicated `work_items` table — rejected: loses free ride on the synced-table
whitelist (`nodes` syncs; a new table needs server-side changes unreachable from the fork),
re-implements org scoping/sharing/IPC/stores.
**Status:** Provisional default the spec may assume behaviorally; **ratified at G4** after
Phase 2 proves new-column passthrough on the sync loop (A-003 residual). If passthrough
fails, this flips to new-table + server coordination and comes back as a crossroads.

## DEC-008 — Routing: spec both scopes; build self-routing P0, person-to-person P1

**Date:** 2026-08-24 · **Made by:** Operator (approving R2)
**Decision:** The spec covers the full routing model (sender clarification, receiver queues,
acknowledgment, closed loops). Build order: self-routing first (P0 — the whole
intent→object→terminal-state model against yourself, zero multi-user variables), then
person-to-person (P1), gated on Phase 2's ACL-semantics verification. The P0 data model is
born routing-shaped: receiver/state fields exist from day one.
**Alternatives:** P2P in P0 — rejected as build-order risk, not feasibility (substrate
verified: messaging/presence/org/ACL-scoped sync all exist); descoping P2P from the spec —
rejected: the data model must be born routing-shaped.

## DEC-009 — Calendar: keep the engine, license the surface, defer the integration

**Date:** 2026-08-24 · **Made by:** Operator (approving R3)
**Decision:** `time_blocks` stays the scheduling engine (it's synced — holds can be
collaborative); Feature-17-style holds/approval land as additive states on it. The Calendar
UI surface carries an operator-granted rebuild license — the specific rebuild-vs-restyle
ruling fires as a crossroads once the specced UX is known. External calendar (Google/CalDAV)
= P2 roadmap.
**Alternatives:** full calendar rebuild incl. data layer — rejected: the engine is good and
synced; external integration now — rejected as P2.

## DEC-010 — Plans: work items parent to desks/rooms; `fb_task_deps` untouched in v1

**Date:** 2026-08-24 · **Made by:** Operator (approving R4)
**Decision:** V1 work items parent to desks and rooms — including Plan-rooms (`isPlan`) —
and do not touch the existing Gantt dependency system (`fb_task_deps` / `projectPlan.ts`).
Deep plan integration (work items as dependency nodes) is P1/P2. The spec includes an
explicit section positioning `work_item` against the existing Plan concept.
**Alternatives:** integrate with fb_task_deps now — rejected: collides with a live system
for a P1/P2 payoff; pretend plans don't exist — rejected: they do (R4 evidence E1).

## DEC-011 — Vocabulary: the entity is `work_item`, permanently

**Date:** 2026-08-24 · **Made by:** Operator ("go with work_item")
**Decision:** Schema/code name: `work_item` / `WorkItem` / `workItemId` (verified
collision-free at a92b30cb). Never `task`/`taskId` (= desk, forever), never "command center"
bare (= ⌘K palette), avoid "Flow" (taken) and "Inbox" (mail exists). New modules refer to
desks as `deskId` in their own signatures, translating to legacy `taskId` only at old-API
boundaries. The spec's §1 defines the full vocabulary. User-facing surface/system naming
(e.g., "Attention") remains open for the spec to propose; the schema name is the forever one
and is now locked.
**Alternatives:** reuse `task-item` from the legacy branch — rejected: still reads as "task,"
and the desk collision zone must shrink, not blur.

## DEC-012 — The surface is "Attention"

**Date:** 2026-08-24 · **Made by:** Operator
**Decision:** The user-facing system/surface name is **Attention** (the Attention Layer) —
rendering as Home widgets, the top-bar collapsed count, and the assistant's conversational
entry. Names the system by what it does, not where it renders.
**Context:** Verified convergence, not collision: `src/shared/context.ts` already defines
`AttentionItem` (evidence-backed, risk-leveled things needing the user: blocked /
review-needed / decision-risk / dependency-changed / stale-context) inside the per-desk
`ContextObject` — alongside `pendingWorkIds` — and `src/main/meta/metrics.ts` measures
`attentionPrecision()`. The new layer is the person-scoped extension of Caleb's desk-scoped
concept; the spec's §1 vocabulary must define that layering explicitly.
**Alternatives:** "Signal" — eliminated: the sync transport is literally "the signal server"
in both `workspaceSync` halves; "Queue" — reserved for the individual queues (using it twice
flattens the hierarchy); location-tied names (dashboard/center) — wrong in two of the three
render surfaces.
**Editorial bonus:** anything that doesn't earn a person's attention doesn't belong in it —
the name is its own feature-creep counterweight.

## DEC-013 — The memory contract's shape (Q5 direction)

**Date:** 2026-08-24 (night) · **Made by:** Operator (direction; detailed design lands at
SPEC-042/043 within the CR-07 lifecycle track)
**Decision:** (1) **Archive is first-class and must ship** — visual cleanup with memory
intact; the default "get this out of my way" action. (2) **Deletion presents an explicit
memory choice**: "preserve this desk's information in your memory" vs. "delete all
information permanently" — the user decides, per desk. (3) **The choice applies to personal
desks.** Shared desks are protected: unilateral deletion is off the table — either all
participants approve, or shared desks cannot be hard-deleted (v1 default pending design;
archive-for-me / leave-share remain available either way).
**Context:** Michael's position — never delete, memory is the value — vs. operator's:
memory value is real AND users need cleanup + genuine deletion agency. The choice dialog
honors both. Repo verification (analysis/09): archive flag + live consumers exist;
trash/restore exists and is already separate from memory; `PERSONAL_ORG_ID` makes the
personal/shared scoping expressible; shared-delete guards don't exist yet and building them
also closes the SPEC-043 trashNode danger for shared desks; memory-purge is new brain-layer
machinery.
**Alternatives:** Michael's never-delete — rejected as sole policy: users without deletion
agency distrust the memory layer ("deletion did not really delete," bug synthesis §3);
always-purge-on-delete — rejected: silently destroys valuable context.
**Note:** this sets the CONTRACT'S SHAPE. Copy, exact flows, purge semantics (what "all
information" includes — brain entries, document content, summaries), and the shared-desk
v1 default are SPEC-042/043 design work, presented for approval before build.

## DEC-014 — G1 batch ruling: crossroads CR-01..07, objective confirmed, IQ-1 resolved

**Date:** 2026-08-24 (night) · **Made by:** Operator ("take your strongest recommendation")
**Decision — all standing recommendations approved:**
- **CR-01 (a):** calendar engine stays; holds render in Attention at v1; surface revisited
  after SPEC-032 ships.
- **CR-02 (a):** Home widget registry is the canonical dashboard; the orphaned portlet
  engine and `ModuleDashboard` are formally deprecated for new work; the dead
  `shared/dashboardRegistry.ts` scaffold is deleted (verified zero importers; the feared
  archived-view dependency was defused in analysis/09 V3).
- **CR-03 (a):** notification substrate lands in main; renderer callers re-pointed; the
  decoy module retired.
- **CR-04 (b):** Pulse and AllTasksView renamed to say "desks" honestly at v1; re-pointing
  at work_items reconsidered at G5.
- **CR-05 (a):** the dead `task-item` declaration is deleted; `work_item` is the only new kind.
- **CR-06 (a):** loose thoughts = classification-only at v1; decay tier P2.
- **CR-07 (B):** desk lifecycle ships as a parallel prerequisite on the fork (resized:
  fix-ratify-expose per analysis/08–09), gated to complete before Phase 5; desks own desk
  state, Attention reads it. DEC-013's memory contract designs within this track.
**Also settled at G1:**
- **Primary objective CONFIRMED as drafted** ("one honest answer to 'what needs me right
  now,' assembled from work that lives where it was created") — operator adopted the
  drafting session's every-word-load-bearing defense without amendment. All triage binds to it.
- **IQ-1 RESOLVED:** bug-synthesis sections 7/8/13/14/17 were deliberately trimmed by the
  operator as redundant — they covered the tasks/calendar/notifications pains whose solution
  IS this build's core objective. The conflict register may claim completeness.
- **GAP-012 refinement adopted (from the drafting session):** the `status` coarse projection
  is DERIVED, never independently writable — single source of truth is `work_item_state`,
  `status` computed at write; SPEC-002 carries the explicit fine→coarse mapping table,
  including that `dismissed` and `reclassified` are NOT completions (never project to `done`).
**Alternatives:** itemized per CR in 00-SPEC-RAW §7 and 07-BUG-CONFLICT-REGISTER §3.

## DEC-015 — Conditional autopilot through the foundation build; SPEC-001+A1 is the strategy baseline

**Date:** 2026-08-24 (night) · **Made by:** Operator
**Decision:** (1) The compiled SPEC-001 + amendment record A1 (analysis/00 + analysis/13)
is the operative **scope baseline** — what and why, deliberately not how; A-01 (protocol
quarantine, never rename `create-task`) and A-02 (`work_item_state` authoritative; `status`
a derived coarse projection) supersede the raw spec's §1.1/§1.5 wherever they conflict.
The actual build plan — schema DDL, IPC signatures, component decomposition, stage
breakdown with verify-commands, and the per-stage build prompts — is **Phase 3's output**,
written against this scope only after Phase 2's evidence, and the per-stage prompts are
written against *approved architecture*, never against the spec directly (operator
clarification, 2026-08-24 night). Q1 (clarification threshold) and Q7 (system
notifications) get concrete proposals returned to the operator DURING Phase 2. (2) **Conditional autopilot:** if the three
remaining Phase 2 items (ACL semantics, sync reliability, gap matrix + adversarial pass)
validate clean and meet the recommendations, proceed directly into Phase 3 (strategy +
logic-audited architecture) and Phase 4 (foundation build: SPEC-001/002/003/005) without
further per-gate operator sign-off — the G3/G5 approvals are satisfied in advance by this
mandate, conditioned on clean validation. (3) The scaffolding still wins on exceptions:
any REJECT-grade finding, new crossroads, deviation from the standing recommendations, or
FOUNDATIONAL surprise halts and presents per the Crossroads Protocol. (4) Open questions
Q1–Q4/Q6–Q8 come due at the phase that consumes them (Phase 5 capture/surface work), not
before; the shared-desk delete v1 default still returns for design approval per DEC-013.
**Context:** Operator: "if you get through these remaining three items without any issues
and things are validated and look clean and meet the recommendations and optimal outcomes
then just continue to work on what's below unless you have other clear directives based on
the scaffolding."
**Alternatives:** strict per-gate pauses — rejected by the operator's explicit instruction;
unconditional autopilot — rejected: the condition ("clean, validated, meets
recommendations") and the scaffolding's exception paths are retained deliberately.
**Made by:** Operator (directive) + Claude (formalization)

## DEC-016 — Q1 and Q7 approved as proposed

**Date:** 2026-08-25 · **Made by:** Operator ("Approved on Q1 and Q7")
**Decision:** Q1 — SPEC-009's single clarifying question fires only on (a) named-recipient
ambiguity with intent confidence < 0.70, or (b) an unanchored deadline phrase on an
actionable class; silence otherwise; hard at-most-one per send; 0.70 is a named constant
recalibrated against `attentionPrecision()` (analysis/16 §Q1 verbatim). Q7 — system events
(agent escalations, cost caps, build-complete) are a distinct **System queue inside
Attention**: same SPEC-006 substrate, own widget in SPEC-014's set (now Tasks · Reviews ·
Calendar · Awaiting Ack · Completed · Stale Desks · System), tagged `origin='system'` on
existing intent classes, **excluded from the headline top-bar count**; CRITICAL system
events may still push OS notifications (analysis/16 §Q7 verbatim).
**Alternatives:** priced in analysis/16 (over-clarifying thresholds; separate tray).
**Consumed by:** Phase 3 architecture (SPEC-009 rule, SPEC-014 widget set, SPEC-015 count
semantics).

## DEC-017 — Phase 6 green light

**Date:** 2026-08-25 · **Made by:** Operator ("Green light — start S0")
**Decision:** Build execution (ROADMAP Phase 5→6 gate) is authorized. DEC-015's autopilot
covers stage-to-stage execution S0–S7 without per-gate sign-off; new scope still stops.

## DEC-018 — Dispatch alignment: all six adoptions

**Date:** 2026-08-25 · **Made by:** Operator ("Adopt all six and continue into S4")
**Context:** analysis/19 — the Dispatch brief (A6 built / A7 planned, paused for this
build) compared against the Attention layer. Verdict: convergent; we are D4's named
critical path.
**Decision:** adopt A-1..A-6 verbatim from analysis/19 §2:
**A-1** per-change attribution reserved in the three work_item write cores (optional
`actor` param — kind/agentRef/missionRef; threaded now, storage decided at D4). This is
a v2.3 §2.3 amendment (recorded there). **A-2** S4's notification substrate is the
Dispatch rail (doc contract; queues `mission-needs-you`/`mission-done` reserved; no
"dispatch/dispatcher" naming in S4). **A-3** `source_type='mission'` reserved (S5 enum).
**A-4** "Dispatch" + "mission" join the vocabulary quarantine; S6 must not use them;
`agentDispatcher.ts` name collision noted for Caleb. **A-5** S6 ships a "By origin"
lens. **A-6** D4 integration doctrine joins the merge-readiness preconditions: agents
write work items ONLY through the workItems module.
**Alternatives:** defer all six to D-phase time — rejected: A-1 retrofit cost multiplies
with every S5+ caller; the rest are documentation-weight now.
**Conflicts registered, not resolved** (analysis/19 §3): C-1 mission-undo vs
no-hard-delete → DEC at D1; C-2 monitor/Attention composition → D1 design; C-4 pre-S6
main-diff checkpoint scheduled.

## DEC-019 — CR-08 ratified + the unified Attention capture model

**Date:** 2026-08-25 · **Made by:** Operator
**Decision (three parts):**
**(a) CR-08 phasing ADOPTED as pressure-tested** — adopt the semantics, phase the
navigation; the anti-goals (aggregate-by-reference, no second silo, restraint) stand;
S7 feeders absorb the flat Tasks tab before it retires; Calendar-tab fate = DEC with
Caleb; Plans stay (DEC-010) and feed Attention.
**(b) One capture model, "Attention" at the top of the hierarchy.** The separate
"Capture a work item" / "Open Attention" entries merge into ONE universal entry:
@attention (or the single palette action, the assistant, the page's own button)
opens the same console everywhere, with Routed/Unrouted/Expand intact. ROUTED
CHANGES: the classifier's pick is no longer silently filed — the console ALWAYS
shows the classification selection with the inferred class PRE-HIGHLIGHTED, so
Enter confirms in one keystroke and a different chip is one click/arrow away
(the deadline question joins the same screen when triggered — still one stop).
User-facing language says "Attention"; the internal work_item schema name is
unchanged (DEC-011).
**(c) One Attention widget** replaces the seven: a single home-canvas widget with a
section slider (All/Tasks/Reviews/Coming up/Acknowledgments/Completed/Stale desks/
System). The seven att-* ids retire via the registry's retired flag (stored
layouts keep loading; the gallery stops offering them).
**Alternatives:** silent-file with post-hoc reclassify (rejected by live QA: first-
touch accuracy is the trust surface); seven separate widgets (rejected: canvas
sprawl — the synthesis's own widget-bloat warning).

---

## DEC-020 — The nav retirement: plan due dates feed Attention; three tabs leave the sidebar
**Date:** 2026-08-25 · **Status:** APPROVED + IMPLEMENTED (operator, verbatim: "Retire
the tabs and add plan due dates to the feeders first")
**Decision:** Executes CR-08(b) in the order the operator chose:
**(1) Plan due dates joined the feeders FIRST.** `deskDueSignals` widened: a plan
root (`kind='folder'` + `is_plan`) with a due date emits a `plan-due` signal
("Plan due tomorrow") opening the plan dashboard; a due desk INSIDE a plan
(parent chain resolved through nested folders, 20-hop cycle guard) also emits
`plan-due` with the plan's name on the line ("Due in 2 days · Launch") opening
the desk. Plain desks stay `desk-due`. Distinct kind ⇒ independent whole-kind
mutes and Δ10 offers. Feeders stay computed, one-directional (F006), out of the
headline badge (DEC-016).
**(2) Then three sidebar tabs retired, both rail states:** "Desks (flat)" /
all-tasks, Plans, and Calendar left the sidebar (expanded NavRows + collapsed
icons). Absorption, not deletion: every view stays routable — MainPane cases
untouched, ⌘K palette carries "All tasks", "Calendar", and a NEW "Plans" entry
(the palette had no direct Plans opener; added before the tab went). Calendar
ENGINE untouched per DEC-009 — blocks, reminders, scheduling all live; only the
nav row is gone. Plans/AllTasks/Calendar views + their code: unchanged.
**Caleb note (merge precondition list updated):** the Calendar tab is a shared
surface — upstream merge must either carry this retirement or re-add the row;
flagged in the G6 ledger.
**Alternatives:** hide Plans without feeder coverage first (rejected — a due
date must never lose its surface, even for one build); delete the views
(rejected — palette reachability is the escape hatch while Attention earns
trust).

---

## DEC-021 — The delete contract: D1 + D2 + R008 adopted as proposed
**Date:** 2026-08-25 · **Status:** APPROVED (operator: "Adopt all three") + IMPLEMENTED (L2)
**D1 — shared desks are never trashed unilaterally in v1.** The lifecycle menu
offers **Archive for me** (the `archived` flag made genuinely SCOPE-LOCAL for
shared rows — stripped from shared sync in BOTH directions, or one side would
silently overwrite the other's choice) and, on received shares, **Leave share**
(self-revocation via the access API + local prune; server-decline leaves
nothing half-removed). The trash entry renders disabled with the reason; the
db layer backs it with a typed refusal (`SharedDeskTrashRefusedError`) at
`deleteNode` AND the purge. All-participants-approve deletion = P1 flow.
**D2 — the delete choice dialog.** Deleting a personal desk/room asks once:
**Move to Trash** (default — today's exact behavior, 7-day window + undo,
memory untouched, now STATED in copy) or **Delete everything permanently** —
immediate hard-delete of the whole subtree (trashed descendants included)
plus its memory: `fb_memory` facts (subject/`<type>:<id>` refs), `fb_chunks`
derivations (room- and widget-keyed) + extraction ledger, and context review
points — behind a typed-name confirmation, with a logged `[purge]` summary.
Scope is adversarially tested: exactly the subject's rows die, bystanders
bit-identical. The purge is the FOURTH sanctioned hard-delete site
(`purgeDeskPermanently`, nodeLifecycle.ts), carrying its own
detach-and-revive + CI allowlist marker; the lock's enumeration widened 3→4.
**R008 — RATIFIED: no work_item hard-delete, permanently.** Dismiss/reclassify
is the lifecycle; BOTH delete paths preserve attention items (trash sweeps
them restorably; permanent purge detaches them back to the Attention page —
the dialog says so, and a post-purge notice counts them). Re-opener: a
privacy-erasure requirement.
**Alternatives:** consent-based shared deletion at v1 (rejected — needs
infrastructure P1 builds anyway); purging work items with their desk
(rejected — R008's whole point; a routed item is not desk property).

---

## DEC-022 — Delete reshape (operator QA) + bulk selection on the indexes
**Date:** 2026-08-25 · **Status:** APPROVED (operator QA directive) + IMPLEMENTED
**(a) The D2 choice dialog is retired; placement over prompting.** Operator QA:
the delete-time two-choice dialog never appeared on the index pages (they had
NEVER adopted the shared lifecycle definition — exactly the drift it exists to
prevent) and reads as redundant. Ruling: archive ≠ trash stands (archive =
keep-but-hide forever; trash = discard, 7-day clock, memory persists), but the
CHOICE moves to where the trash lives: **"Move to Trash" is direct everywhere**
(undoable, no dialog), and **"Delete permanently" is a per-item action on the
Trash page** (OS empty-trash shape) — typed-name confirm, immediate purge +
memory erase, attention items still revive (R008). The memory contract is
stated in the Trash page's header copy. DEC-021's db layer (purge site 4/4,
memory purge, guards) is unchanged — only the affordance moved.
**(b) The index pages join the ONE lifecycle definition.** DesksView and
RoomsView now build lifecycle actions from `lifecycleIndexActions` (same
source as the card/breadcrumb menus): personal → Archive/Trash; shared →
Archive-for-me / Leave-share / the D1 reason (rooms included — same rules as
desks, as directed).
**(c) Bulk selection (both index pages, one engine).** RoomsDesksIndex gains
a selection mode: a **Select** button in the toolbar (gallery/list/table),
click-to-toggle with visible checks, Select all/none, and a selection bar
carrying the page's bulk actions — desks: **Move to room… / Archive / Move to
Trash**; rooms: **Archive / Move to Trash**. Bulk trash = ONE undo toast over
every subtree (`removeMany`); shared items are skipped from trash with an
honest count (D1); archive applies scope-local to shared rows.
**Alternatives:** per-card persistent checkboxes (rejected — noise outside
selection mode); dialog kept at delete time (rejected — operator QA, and the
Trash-page placement answers the discovery failure directly).

---

## DEC-023 — V2 first picks: capture-from-desk parenting + the Settings toggle
**Date:** 2026-08-25 · **Status:** APPROVED (operator: "do the two V2 quick wins") + IMPLEMENTED
**(a) Capture-from-desk parenting.** The capture console snapshots the view at
open time: over a live, personal desk view, the filed item is PARENTED to that
desk — a visible "on <desk>" chip with a one-✕ opt-out files standalone
instead. Conservative by construction (`lib/captureContext.ts`): only
`view.kind === 'task'`, desk live, not archived, NOT shared (§2.6 keeps work
items personal at P0). Desk surfaces stay blind to the item (quarantine
unchanged); what parenting buys: the By-origin lens, honest provenance, and
desk-trash → detach-and-revive semantics now reachable from real usage (this
also creates the parented items the last live GAP-015 arm needs).
**(b) The Settings toggle.** Settings → AI → "Attention layer":
`workItems:setEnabled` IPC over the persisted pref (attestations preserved),
honest copy (off = no capture, no AI filing; captured data stays). Applies
live — vocabulary reads the pref per call; the ⌘K entry re-probes on
`fb:workitems-toggled`; the badge rides `fb:workitems-changed`.
**Also this session:** instance B shut down + its throwaway profile removed;
the UPSTREAM-PR-PACKAGE.md deliverable produced (paste-ready PR body, flagged
diffs, findings F-1…F-6, preconditions checklist, drift status: 6 upstream
commits, no sync-engine collisions, ipc/index.ts only).

---

## DEC-024 — Polish stage 1: the FYI deadline backstop + work-item archival
**Date:** 2026-08-26 · **Status:** APPROVED (operator: "Start the polish stage") + IMPLEMENTED
**Push rule in force:** fork branch only until the operator declares Attention
fully ready; `saasmouth main` untouched (the earlier landing never executed —
confirmed and kept that way by the operator's wait-until-finished directive).
**(a) FYI deadline backstop.** A dated FYI now gets ONE quiet nudge when its
date ARRIVES — never "due soon" (FYIs aren't due), inbox layer not
interruptive, same `wi-due:{id}:{day}` dedupe and substrate caps, with a 24h
lookback so pre-feature dates stay silent. Second arm in
`postDeadlineNudgesCore`; the restraint doctrine holds (still exactly one
proactive trigger family).
**(b) Work-item archival.** New terminal state `'archived'` — "keep it, done
looking at it": projects to `parked` (never done), leaves the queues and the
Detached shelf, is NOT a loop closure (no notification — source-locked), stays
out of Recently closed, never decays or nudges, and lives on a collapsible
**Archived** shelf on the Attention page with one-click Unarchive (state →
open). Archive verb on every queue row. Rides sync via the existing
state-column manifest; un-updated peers coarsen it to 'open' until they
update (accepted, noted in the enum).
**Alternatives:** an orthogonal archived FLAG beside state (rejected —
"archive an in-progress item" is not a real need at v1 and the flag doubles
every visibility predicate); interruptive FYI nudges (rejected — restraint).

---

## DEC-025 — Multi-intent captures
**Date:** 2026-08-26 · **Status:** APPROVED (operator: "Start multi-intent") + IMPLEMENTED
**Decision:** A compound capture ("call Bob Thursday and review the deck") is
TWO loops wearing one sentence — and now files as such, still in ONE stop.
**The splitter (deterministic, `intentRules.splitCompound`):** strong
separators (newline, semicolon) always cut; weak joiners (and/then/also/plus)
cut ONLY where the right side independently trips a hard trigger — so
compound OBJECTS ("call Bob and Alice") never split, making a false secondary
structurally rarer than a missed one. **Secondaries** (≤3, rules-only, never
a model call): own class, own title, own ANCHORED date (an unanchorable
phrase files dateless — Q1 stays at-most-one and belongs to the primary,
DEC-016 intact). **The primary classifies on its own first segment** (title,
date, Q1 all from segment 1; notes keep the full capture verbatim).
**Console:** the confirm stop shows "Also caught …" as PRE-CHECKED chips —
one Enter files the primary plus every checked secondary (uncheck = opt out);
the filed toast counts them; desk-context parenting (DEC-023) applies to all.
**Alternatives:** model-driven splitting (rejected — latency + R011, and the
trigger discriminator is the honest precision boundary); a second confirm
screen per secondary (rejected — DEC-019's one-stop rule).

---

## DEC-026 — The opt-in cleanup rewrite (Δ6)
**Date:** 2026-08-26 · **Status:** APPROVED (operator: "Start cleanup rewrite") + IMPLEMENTED
**Decision:** Messy brain-dump captures get an OFFERED tidy — never a silent
rewrite. A deterministic messiness gate (`needsCleanup`, pure + tested: 30+
words, filler-dense, or an 18+-word unpunctuated run-on) decides whether the
capture even qualifies; a Haiku call (new purpose `capture_cleanup`, routed +
shown in the model picker's Auto table) extracts a crisp ≤90-char title and a
1–3-sentence gist — facts only, nothing invented, writer's language kept.
**Latency contract:** the proposal is requested async AFTER the confirm
screen is already up — a capture never waits on it; slow/failed proposals
simply never appear (null on every failure mode; a seq guard drops stale
arrivals after re-edits). **Approve-before-apply:** it renders as an offer
row ("Tidied: … — Use tidied / ✕"); using it swaps the title, adds the gist
as the notes' lead, and keeps the capture verbatim below "— as captured —";
one-click Undo before filing. The verbatim text is NEVER lost, tidied or not.
**Alternatives:** blocking tidy on the classify path (rejected — R011's
budget); silent auto-tidy above a confidence bar (rejected — first-touch
trust is the product; Δ6 said propose-and-approve and it stays that way).

---

## DEC-027 — The composer @attention typeahead + deterministic interception
**Date:** 2026-08-26 · **Status:** APPROVED (operator: "Start typeahead") + IMPLEMENTED
**Decision:** The chat composer finally knows "attention" — as a **command,
not a mention**. The @ picker offers "Attention — capture what follows"
(top row while `attention` matches, capability-gated with live re-probe);
picking it inserts the literal text `@attention ` — NEVER a chip, honoring
the mentions doctrine's own rule that a kind with no resolver must never
become a reference. On send, a **leading** `@attention` is intercepted
deterministically in `submitComposer`: the message never reaches the model —
the remainder routes through the one `fb:command-new-work-item` seam into the
capture console (DEC-019's single model: same confirm stop, chips, tidy,
desk-context parenting). Mid-sentence @attention keeps the AI proposal path;
a mode-locked Search stays literal (interception sits after the search
branch). Diffs into Caleb's mentions machinery kept additive + minimal:
one command branch, one picker row source, a widened label union.
**Alternatives:** a real 'attention' mention KIND with chips (rejected —
no resolver → lying chips, plus wire-shape churn in Caleb's shared types);
send-then-AI-files (the old path — kept as the mid-sentence fallback, but the
leading imperative now never pays model latency or model judgment).

**WITH THIS, THE GA CHECKLIST'S BUILD ITEMS ARE COMPLETE (①–⑤).** Remaining
before the reveal: the operator's ⑥ live smokes, then the landing command.

---

## DEC-028 — @attention everywhere: inline chat card, Tab-to-arm, the Slack-style pill
**Date:** 2026-08-26 · **Status:** APPROVED (operator QA directives) + IMPLEMENTED
**(a) The confirm stop is now ONE component.** `AttentionConfirmCard` extracts
DEC-019's confirm flow (classify, pre-highlighted chips, ←/→/Enter, DEC-025
secondary chips, DEC-026 tidy offer, Q1 date) — the console overlay and the
chat both render it; the flow can never fork again.
**(b) Chat files INLINE.** A leading @attention send renders the card in a
bordered box above the composer — the operator never leaves the chat. Cancel
restores the message (via fb:composer-stage) exactly as typed; filing shows a
4s confirmation line in place. deskCtx snapshots at send.
**(c) Keyboard-first on every @ surface.** Chat picker: Attention rides FIRST
while "a…" prefixes it; Tab already selected (Enter‖Tab). ⌘K: "@a…" partials
surface the entry on top; **Tab ARMS a pill** — the query then IS the capture
text, Enter files, Backspace-on-empty disarms. Home bar (StartOrAskPlexi):
same grammar — Attention row atop the @ picker, Tab/pick arms, armed Enter
routes to the card, Esc/Backspace disarms.
**(d) The Slack-style visual cue.** Chat: picking Attention inserts a REAL
mention chip (accent pill, "@attention") — visual only: onPick is skipped so
it is never a stored reference (the no-resolver doctrine holds); its title
serialises to "@attention" so the interception fires. ⌘K + home bar: an
accent "@attention" badge sits in the input while armed.
**Alternatives:** a stored 'attention' mention kind (rejected again — wire
churn + lying chips); popping the console from chat (the operator's exact
complaint — retired).

---

## DEC-029 — Taxonomy law + the groundwork split
**Date:** 2026-08-26 · **Status:** APPROVED (operator) + EXECUTED (split); law recorded
**(a) The five taxonomy tests (T-1 infinitive · T-2 single axis · T-3 life
stability · T-4 honest parent · T-5 distinct question sets) + the
anti-collision rule are adopted as STANDING LAW** for all category/vocabulary
decisions, per the operator's eight-category synthesis and analysis/22's
review. **R-06 confirmed as doctrine:** recipient-presence triggers the
mandatory-clarification lane (P1/SPEC-027); self-capture always keeps the
one-keystroke bail-out (shipped as Unrouted). Everything else in the synthesis
— the rename to the eight primaries, To Decide, the Respond consolidation,
reserved `intent_sub`, the clarification engine, R-01…R-05/R-07 — is
sequenced POST-LANDING per analysis/22 §5 (alignment stage first, engine with
SPEC-027, R-04 gets its own analysis before any ruling).
**(b) The groundwork split (operator: fixes to main now, Attention continues
on the fork):** four Attention-independent fixes were extracted onto
`groundwork-fixes` (branched from main 7be3be4c, surgical patches — not file
copies): ① chat/workspace-ask non-streaming on credits, ② mention-picker
keyboard selection (F-9), ③ room→scoped-desks routing, ④ the permanent-409
baseRev floor (F010) with the [sync-409] trail. Main's own suite green
(2,604) + typecheck clean. Branch pushed to `saasmouth/focusbuddy` and opened
as **PR #2** (https://github.com/saasmouth/focusbuddy/pull/2) — merge is one
click for any co-owner; fast-forward-clean. NOT separable (stay on the fork):
lifecycle/delete contract, bulk selection, sync widenings, park-inbound —
all entangled with the work_item schema. Known cost: when the fork branch
next merges main after PR #2 lands, the six shared files conflict textually
(branch is the semantic superset — resolve keep-branch).

---

## DEC-030 — Leave it landed; iteration continues on main's substrate
**Date:** 2026-08-26 · **Status:** RULED (operator)
**Context:** After PR #4 merged, the operator revealed "declare ready" had been
a misunderstanding — he believed he was confirming the groundwork split
(DEC-029b), not authorizing the full landing, and his standing intent had been
wait-until-finished (the fork-only rule). He asked whether reverting the
Attention layer off main was feasible without pain.
**Analysis given:** (1) a revert cannot un-reveal anything — PR #4's diff, the
shared-repo branch, and the in-repo planning corpus are permanently visible in
history; the real usage gate is `workItems.enabled` default-OFF; (2) reverting
a merged branch plants the revert-then-re-merge trap (git treats the 91 commits
as already-in-history; re-landing later requires revert-of-the-revert); (3) the
layer is dormant for Michael + Caleb until they toggle it.
**Ruling:** **"Leave it landed, let's keep working through the attention
layer."** The landing stands. Future Attention work iterates on the branch and
lands in rounds via PRs when the operator chooses — no revert, no freeze.
**Owed:** the operator sends Michael + Caleb the WIP framing note (drafted in
session: the big PR is the Attention layer, work-in-progress, off by default,
don't toggle it on yet).
**Process lesson (standing):** before any big irreversible or outward-facing
action, the assistant restates CONCRETELY what is about to happen ("this
merges 91 commits into main, visible to the team immediately") and gets fresh
explicit confirmation — never executes off a pre-agreed codeword alone.
**Numbering note:** the CR-09 brainstorm rulings (D-A…D-K, analysis/21) will
record as DEC-031+; older pointers saying "→ DEC-029/030" mean "the next DEC."



---

## DEC-031 — @attention is deterministic ANYWHERE in the message
**Date:** 2026-08-26 · **Status:** RULED (operator: "yes to all three — do them") + IMPLEMENTED
**Context:** DEC-027 made a LEADING @attention deterministic and deliberately
left mid-sentence/trailing on the AI proposal path. Operator live QA broke that
premise: "i need to create a pitch deck for cetra by friday @attention" produced
only a create-page card — the item never reached the queue. A prompt rule the
model can ignore is not a capture guarantee.
**Ruling:** the token is an ADDRESS, not a topic. Wherever it sits, the capture
happens deterministically. What position still decides is the fate of the REST
of the message: **leading** = pure capture (the model never sees it, DEC-028's
inline card); **inline** = capture AND still send the message with the token
stripped, so a "build me X @attention" gets both halves — the build action the
operator liked AND the tracking item he was missing.
**Implementation:** ONE shared grammar (`lib/attentionCommand.ts`) read by the
chat composer, ⌘K, the home bar, and the chat store — four private regexes
could not be kept honest. Two bypasses were found only by driving the real UI:
(a) ⌘K's omni rows hard-score "Ask Plexii" at 2000 and outranked the capture
entry (the operator's exact 30s path) — omni rows now yield while the token is
present; (b) ⌘K/home/voice call `chatStore.send()` DIRECTLY, bypassing the
composer where the interception lived — `send()` is now the last-mile guarantee.
The composer strips the token before calling it, so double capture is
impossible by construction.
**Alternatives:** strengthening the prompt rule only (rejected — tried first
this same session; it is a nudge, and the operator asked for a guarantee);
pure-deterministic with no message sent (rejected — it would have silently
removed the buildable half he explicitly valued).

---

## DEC-032 — desk-placed proposals carry their own target
**Date:** 2026-08-26 · **Status:** RULED (operator) + IMPLEMENTED
**Context:** operator QA: "It's making me manually select the desk even though
it already identifies the right desk." True, and structural — `create-page`
carried no desk field at all, so the card genuinely could not know; a desk named
in the model's PROSE is not machine-readable. Off a desk, every desk-kind card
dead-ended into the chooser.
**Ruling:** desk-placed proposals may name their destination. Optional `deskId`
on create-page / create-widget / create-todo-list / create-table; the model is
shown a real desk ROSTER (ids + titles, capped at 25, newest first) in both the
chat and agent-loop prompts, and is told to use an exact id and never invent
one. The card resolves id-then-title against the live node store and applies
there without asking.
**Safety rule:** an id (or title) matching nothing live resolves to null and the
normal chooser runs — a stale or hallucinated id must NEVER silently retarget a
different desk. Pure resolver in `lib/proposalDesk.ts`, unit-tested including
that refusal.
**Cost noted:** the roster rides the cached system prefix; desks change rarely
enough for that to hold, and it is capped.

---

## DEC-033 — the ask-latency trail (and what it already proved)
**Date:** 2026-08-26 · **Status:** RULED (operator) + IMPLEMENTED + MEASURED
**Context:** operator QA: a ⌘K ask "took over 30 seconds" with no visible
progress, and nothing in the app could say where the time went.
**Ruling:** instrument before optimising. `[ask-latency]` in `sendChatStream`
reports total / retrieval / time-to-first-token / generate, the system-prompt
size, token counts, cache reads, the model, and — decisively — whether the turn
actually STREAMED.
**First measurement on the operator's own setup:** `total=7350ms
retrieval=831ms ttft=6518ms generate=1ms streamed=false in=660 out=252`.
**What it proves:** retrieval is not the problem (<1s). `streamed=false` is: the
PlexiDesk-credits proxy rejects streaming outright (a known constraint, see the
credits arm in `sendChatStream`), so the ENTIRE answer is generated before a
single character reaches the screen. At ~40 output tokens/sec, the operator's
"thorough" answer was simply ~30s of generation with **zero feedback by
construction** — not a hidden inefficiency, and not something a code fix in
this repo can shorten.
**Open (needs a ruling, not yet built):** the honest levers are (a) BYOK — his
own Anthropic key streams, and the wait becomes visible progress; (b) a real
progress affordance for credits mode; (c) trimming output size for simple asks.
(a) is the only one that removes the wait rather than dressing it.



---

## DEC-034 — Capture is task + optional notes, then a PREVIEW of the finished item
**Date:** 2026-08-26 · **Status:** RULED (operator, from his own queued items 3+4) + IMPLEMENTED
**Context:** two of the operator's own captured to-dos, built as one round because
they are one flow. (3) "There should be an optional notes section on attention
items… write the task, hit tab, add some additional context, then hit enter."
(4) "instead of the button being 'Classify' it should just be 'Enter'… the next
section should be an example of the tidied up version… formatted how the final
task will look, and if the user approves all they have to do is click enter,
otherwise… 'Enter As Is' which doesn't clean up any of the title or notes."
**Ruling + implementation:** the console gains a second, optional NOTES field
(Tab into it, Enter from either field files; Shift+Enter still newlines). The
button says **Enter ↵** — "Classify" named an implementation detail and
mis-described the key. The confirm card stops ASKING what the capture will
become and instead PREVIEWS the finished item — class icon, title, notes, due
chip, target desk — laid out as it will sit in the queue.
**The tidy moved INTO the preview** (amends DEC-026's presentation, not its
principle): it used to sit beside the card as a "Use tidied" offer; it now
lands in the preview when it arrives, marked "Tidied · undo", with **Enter as
is** filing the operator's own title and notes untouched. Approve-before-apply
still holds — approval is now the Enter he was already pressing. "Enter as is"
appears ONLY when a tidy actually changed something, else both buttons file an
identical item.
**Latency contract intact (R011):** the tidy is still requested AFTER the screen
is up; a capture never waits. A slow or absent tidy means the preview shows the
operator's own words — a correct outcome, not a degraded one. The tidy now reads
the notes too, so a crisp task line with a rambling note qualifies and the note
is cleaned rather than replaced by a summary of the title.
**Preservation:** verbatim capture is never lost on any path — tidied items keep
the original under "— as captured —"; untidied ones keep BOTH the notes and the
typed text whenever the derived title dropped part of it (a stripped "fyi:", or
only the first sentence becoming the title). Letting notes win alone would have
silently discarded the rest; caught in review, pinned by test.

---

## DEC-035 — Grouping + manual order in the queue (the six-dot handle)
**Date:** 2026-08-26 · **Status:** RULED (operator, his queued item 2) + IMPLEMENTED
**Context:** "if I have 2 tasks created at different times but they end up being
related there should be that six dot icon thing next to the tasks that allow me
rearrange tasks, move them to other sections, or even attach to already existing
tasks for grouped tasks/related task or subtask."
**The architectural constraint that shaped it:** work items are LEAF nodes
(§2.5 leaf invariant — nothing nests under a work item, enforced at create AND
at sync apply), and `parent_id` already means "the desk this lives on". A
subtask via parent_id was therefore structurally unavailable.
**Ruling:** grouping is a **SIBLING reference** — `group_id` = the leading
item's id — joining the column manifest, so it syncs / is allowlisted / is
emitted without touching a transport by hand. **Exactly ONE level**, enforced
at the DB and not merely in the UI: a leader can never be grouped, self-grouping
refused, a non-item leader refused, and grouping onto a CHILD flattens to that
child's leader. A group can never become a tree, whatever writes it.
**Three gestures, one handle:** drop on a row's middle = attach; top/bottom =
reorder; on a section header = move sections (a reclassify, machinery that
already existed). Native HTML5 drag — the house pattern; there is no dnd
library in this codebase.
**Ordering:** manual placement beats the ranker ONLY where the operator placed
something (`sortOrder` 0 = never dragged → keeps its ranked position); a drop
renumbers the whole queue from 1, which keeps order stable and tie-free as items
come and go. `sort_order` is a base nodes column already in the sync body, so a
hand-ordered queue travels between devices without joining the manifest.
**The failure mode it must never have:** a child whose leader leaves the queue
(completed / reclassified / snoozed) is **PROMOTED to standing alone, never
hidden** — an item vanishing because of something that happened to a DIFFERENT
item would be unforgivable. Pinned by test.
**Scope:** Queue lens only; Due and Origin answer a different question and stay
ranked. Deferred: multi-select drag, cross-queue grouping.



---

## DEC-036 — Double-click opens the whole item for editing
**Date:** 2026-08-26 · **Status:** RULED (operator) + IMPLEMENTED
**Decision:** double-clicking a queue row opens an editor over the ENTIRE item —
title, notes, classification, due date, urgency, tags, and the desk it lives on.
Closes the oldest Layer-0 gap (analysis/21 §12 "no post-creation editing").
Only CHANGED fields are written, so editing one field can never restamp another;
the desk change is a node MOVE (the Detached-shelf recovery's own call), not a
work-item field. Guard lesson: "ignore double-clicks on buttons" blocked nearly
the whole row (the title and expander ARE buttons) — the exemption is scoped to
the action cluster only, pinned by test.

---

## DEC-037 — Context chips (derived) + tags/urgency (chosen), and the two doors
**Date:** 2026-08-26 · **Status:** RULED (operator) + IMPLEMENTED
**Decision:** every row shows what it is ABOUT, in two deliberately different
kinds. **DERIVED** (never typed, never stale): the desk it lives on, the PLAN
enclosing that desk, what it was marked from — plan chip opens the plan, desk
chip opens the desk. **CHOSEN** (never mandatory): `wi_urgency`
(low/normal/high/urgent — 'normal' renders NO chip; a badge every row wears
says nothing) and free-form `tags` (new manifest column; comma-delimited,
normalized, capped; empty = NULL). A tag bar shows the vocabulary in use with
counts; one tag filters at a time — narrowing to a thread of work, not a query
language. **The two doors (the Notion finding):** the desk button opens a
CANVAS, and what the canvas hosts does its own thing — marking a Notion tool
and pressing "desk" launched the external Notion app. "Open it here" now puts
the marked object into Focus Mode full-screen inside Plexi; the desk button
remains the whole-canvas door. Verification note for the record: a manifest
column can EXIST in the DB while main still runs pre-column code — reads come
back undefined and look like a write failure; restart first.

---

## DEC-038 — "Start it with Plexii" = a PREFILLED CHAT, staged never sent
**Date:** 2026-08-26 · **Status:** RULED (operator: "start it should open a
prefilled chat") + IMPLEMENTED
**Decision:** the bridge from a captured intent to the work itself. Each row
gains "Start it with Plexii"; a Select mode (the index pages' own bulk shape)
gains "Get started with Plexii" over a multi-selection. The prompt is composed
from what was ALREADY captured — title, notes verbatim, desk, plan, due,
urgency, tags — with a PER-CLASS ask (deciding is not doing: to_decide lays
out options and costs, to_respond drafts a reply, to_review says what to look
at first…). No model call builds it; it works with the key removed.
**The hard rule:** it is STAGED in the composer (fb:composer-stage — the same
seam Expand uses) and NEVER auto-sent; the assistant must not start acting
because the operator glanced at his queue. Pinned by test (the hand-off
contains no .send call). A single-item start navigates to the item's desk
first so the chat carries that desk's context; a multi-start lists the items
with their context and asks for sequencing, deliberately NOT inlining N
notes-paragraphs. **Verification:** prompt composer + stage-not-send are
unit/pin-tested; the live click-through was not visually confirmed — the
operator was actively using the app and driving it further would have
interrupted him.



---

## DEC-039 — Capture-time context: urgency + tags on the preview; tags become @-MENTIONS
**Date:** 2026-08-26 · **Status:** RULED (operator) + IMPLEMENTED (P0 half)
**Decision:** the confirm card's preview screen carries the chosen context —
an urgency row and ONE shared TagMentionInput — so an item can arrive in the
queue already tagged; both ride the CREATE itself, not a follow-up patch. The
same input serves the manual form and the item editor, so the @ grammar
cannot fork. Grammar: a plain word is a free-form tag; "@" opens a typeahead
over the PRIMARY GROUPINGS — people (org directory), desks, rooms, plans —
and picking one attaches a TYPED mention ({kind,id,title} in the new
`mentions` manifest column; JSON, defensively parsed — the column rides sync
and a peer could write anything; title frozen at pick time so a dangling
mention degrades to text, never a blank).
**Chips:** mention chips render on rows after tags. Desk/room/plan mentions
NAVIGATE (goTask/goRoom/goProject). A PERSON mention is stored and shown with
honest copy — "notifications arrive with routing" — because pinging them is
SPEC-027; the reference is captured NOW so nothing is re-entered when the
rails land.
**THE BIGGER PROGRAM (registered, not built):** the operator's directive —
@-mentions of people/desks/rooms/plans THROUGHOUT the app (docs, sticky
notes, messaging, any surface) to bring someone's attention to a thing. This
is the cross-reference rail (analysis/21 §13) + SPEC-027 routing converging:
mention-in-any-surface → a to_respond item in the mentioned person's queue.
The chat composer's mention machinery (tiptap MentionSuggestion) and this
input's grammar are the two seeds; unifying them + the routed-notification
half is its own initiative with Caleb's surfaces involved (docs/stickies are
core PlexiDesk). Sequenced with SPEC-027; nothing else rides it quietly.
**Session note (two sessions, one worktree):** a second Claude session was
mid-flight on tidy/auto-arrange in this SAME working tree. Its four files
(FloatingPill, autoArrange, two tidy tests) were left untouched and
uncommitted here; its two failing tests are its own WIP, not this round's.
One earlier commit (`1d0ac432`) had already swept 28 additive lines of its
autoArrange work via a broad `git add` — disclosed, harmless (suite was
green), and staging is explicit-file-list from now on.



---

## DEC-040 · DEC-041 — (parallel session) tidy geometry + widget-menu honesty
**Date:** 2026-08-26 · **Status:** IMPLEMENTED by the PARALLEL session, recorded here for continuity
A second session working this same branch shipped two rounds without log
entries: `860644fd` "tidy stops stretching widgets, and square grid picks its
own shape" (claims DEC-040) and `e846113e` "the widget menu only offers what
it can actually do" (claims DEC-041). Numbers honored as theirs by commit
order. Cross-check done here: the Attention menu row (CR-09 D-A) survived
their contextMenu changes; resolver + preset suites green after their commit.

---

## DEC-042 — Notes on EVERY capture path; the tidy always attempts on real content
**Date:** 2026-08-26 · **Status:** RULED (operator) + IMPLEMENTED
**⚠ Numbering note:** commit `bbe2c397` and its code/test comments say
"DEC-040" — written before the parallel session's commits surfaced and took
040/041. THIS log is canonical: the notes/tidy round is **DEC-042**.
**Finding 1 — "I lost the ability to add a note… in the ai chat… sometimes
I see it."** The notes stage lived on the console's textarea screen; the
chat's inline card and every prefilled console open (armed ⌘K pill,
@attention) render the confirm card DIRECTLY and never visit that stage.
**Fix:** the preview itself carries an editable notes area on every path.
Enter inside it = newline; ⌘/Ctrl+Enter files. Card-typed notes are the
operator's own words: the tidy never clobbers them (notesEdited guard) and
"Enter as is" keeps them while reverting only the AI's title rewording. The
bare manual form gains a notes field (it never had one).
**Finding 2 — "sometimes I get the tidied up version, other times I don't."**
The DEC-026 messiness gate only requested a tidy for 30+ words / filler /
run-ons; medium captures showed raw. Per the operator's restated contract
(Enter → ALWAYS the tidied version → Enter files the cleaned version),
`qualifiesForTidy` now fires on 8+ words, multi-sentence text, attached
notes, or the messiness signs; tiny fragments still skip ("call Bob
Thursday" IS its own tidy). The armed second Enter waits (4s cap) for the
in-flight tidy so it files the cleaned version. Regex lesson pinned: the
first multi-sentence probe used `[.!?;]\S` and missed normal prose — the
slice(0,-1) trick from needsCleanup is the correct test.



---

## DEC-043 — A page per class; on-brand subtle colors; drag-only reclassify; light tidy
**Date:** 2026-08-26 · **Status:** RULED (operator) + IMPLEMENTED
**(a) Tabs.** The eight classes become PAGES: a tab row (All + the eight, with
counts) above the queue. A class tab shows only that queue — no scrolling past
the others; All is the old full-list view. Tabs are DROP TARGETS, which is what
makes drag-reclassify work on a single-class page. Due/Origin lenses still show
everything. **(b) Colors from the ONE palette:** each class takes a PlexiSuite
brand-family hue (tokens.css — the product groups' own accents): To Do sky,
Review violet, Decide amber, Respond teal, Meet green, Discuss indigo, Remember
lightbulb yellow, Know neutral slate. Subtle by construction — icon tints, a
10%-alpha wash + soft underline on the active tab, never a colored panel.
**(c) The row reclassify button is REMOVED** per the ruling; the two paths are
drag (section or tab) and the editor's class chips. **(d) Tidy calibration:**
the model-tidy bar drops 8→5 words, and BELOW it a deterministic light tidy
capitalizes every derived title (first letter, standalone "i", weekdays/months
with "may" excluded, a name after a person-verb unless stopword) — "call bob
thursday" → "Call Bob Thursday" with zero model calls; only ever ADDS capitals,
idempotent, reaches secondaries.



---

## DEC-044 — A highlight IS the capture: full selection → notes, on every surface
**Date:** 2026-08-26 · **Status:** RULED (operator) + IMPLEMENTED
**Finding:** marking a highlighted passage ("Add to Attention" on a desk page)
produced a good title and EMPTY notes — the mark used the widget-level preset
and never read `ctx.selection`; the highlighted text was dropped. And the AI
chat's selection menu offered only sticky/note/copy — no attention option.
**Ruling + implementation:** `presetForSelection` — the selection's first line
titles the item ("+N more" when a list was highlighted), the FULL selection
rides the notes verbatim; one-line selections keep empty notes rather than
repeating the title; class still from the host kind. The notes travel the whole
path (menu → seam's new `notes` field → console store `initialNotes` → notes
field → card → item), pinned at every hop. The chat menu gains "Add to
Attention…" as its FIRST row, deliberately NOT desk-gated (an item files
standalone; sticky/note need a canvas). Class call worth recording: an AI-chat
selection routes to the DEFAULT to_do, not chat→to_respond — a highlighted AI
answer is something to act on; nobody awaits words back from a bot.



---

## DEC-045 — The Attention widget on any desk (CR-09 D-B, ruled)
**Date:** 2026-08-26 · **Status:** RULED (operator) + IMPLEMENTED
**Decision:** 'attention' becomes a real CANVAS widget kind — catalog entry
(Tools, 380×340), picker row, renderer case — so the home screen's
command-center face is placeable on any desk. **Scope:** defaults to THIS
desk's items; a two-chip header control (This desk · N / All) widens it, and
the choice persists per-widget in `widget.content` ({"scope":"desk"|"all"}).
**The fallback is the operator's own rule:** a desk holding no active item
shows everything with an honest "nothing here yet — showing all" line, never
a blank box beside a full queue. **One component, not a fork:** the desk
variant WRAPS the home AttentionWidget (itemsOverride + per-widget section
storageKey), so look-and-feel cannot drift. Stale-desks (a global feeder)
hides in desk scope per CR-09's own lean — a desk's widget reporting that
desk's staleness is circular. Cross-version: old builds render an unknown
kind as nothing; the row itself syncs like any widget.



---

## DEC-046 — A highlighted LIST becomes several items (pressure-tested shape); the tidy formats
**Date:** 2026-08-26 · **Status:** RULED (operator, with an explicit "decline if
problematic" bar) + IMPLEMENTED in the shape that survived the pressure test
**The pressure test, and what it killed:** rendered lists (pages, the AI chat)
usually arrive FLATTENED — the browser's selection serializer strips markers
and indentation, so header-vs-child structure is unrecoverable there. A model
could guess it, but that fails BOTH of the operator's stated bars (as fast as
today; high accuracy). Model inference was therefore rejected.
**The shape that shipped — deterministic, previewed, capped:**
- Markdown-source selections (markers + indentation survive): header bullets
  → PRIMARY items, sub-bullets → CHILDREN grouped under them via DEC-035's
  one-level sibling grouping. Numbered lists, checkboxes, continuation lines,
  and mid-list orphan children (promoted, never dropped) all handled.
- Flattened selections: 3+ short entry-like lines → SIBLINGS. Nesting is
  never guessed.
- PROSE never splits (short/punctuated-line heuristics, tested).
- Cap 12; over it falls back to one item + full notes.
- The split ALWAYS renders as the confirm card's pre-checked chips (DEC-025's
  pattern) before anything files — a wrong split costs one uncheck, not a
  wrong item. Filing preserves the previewed structure: children group under
  the item their header created; a child whose header was unchecked stands
  alone. List rows inherit the primary's class chip and the marked source.
**Formatting (the second finding):** selection notes are whitespace-normalized
deterministically (the "two or three spaces between items" complaint), and the
tidy prompt now treats FORMATTING as part of the job — multi-point notes come
back as "- " bullet lines, not a paragraph. Marked captures with substantial
prose notes (the chat-summary case) now request the tidy too, for its
formatting: the note lands as bullets, the preset title stands, and operator-
edited notes are never overwritten.



---

## DEC-047 — Desk ⇄ Attention: the derived shape (analysis/23 D-1…D-6, ruled "proceed with all")
**Date:** 2026-08-26 · **Status:** RULED (operator: "your plan is better, proceed
with all your recommendations") + IMPLEMENTED
**D-1/D-2 — desk clusters, DERIVED:** in the Queue lens, items sharing a
`parentId` render under a desk header (title · "Desk: <status>" — prefixed per
the naming caution · due · open count · click opens the desk). A desk clusters
only at ≥2 rows in a section (a single item's chips already name its desk).
Pure `clusterByDesk` over the already-ordered rows — the ranker still decides
what leads; storage untouched; the rejected stored-grouping trap is PINNED
rejected (the cluster function provably never writes groupId).
**D-3 — suggestions, never writes:** closing the LAST active item on a
still-open desk offers "mark the desk done?" once, right then; accepting uses
the same user-owned status write every desk surface uses. Plan-promotion at
accumulation stays with CR-09 D-C (its threshold is that brainstorm's DEC).
**D-4 — All-Desks reverse signal:** each desk card's meta line gains
"N open · M due" (48h window), derived with the queues' own active-set rules;
the status groups are untouched.
**D-5 — capture-time status:** items can be BORN open / in progress / waiting /
blocked (`CAPTURE_STATES` + `initialWorkItemState`, unit-pinned: terminal at
birth refused — it would skip closure notifications; 'suggested' still
approval-driven). Compact status rows on the confirm card and the manual form.
**D-6 — coordination:** desk `status` remains user-owned; nothing here
auto-writes it, and any future change to how it is WRITTEN goes to Caleb first
(core-surface field, preservation doctrine).

---

## DEC-048 — The Attention COMMAND CENTER (overhaul, operator-ruled 8-part spec)
**Date:** 2026-08-26 · **Status:** IMPLEMENTED (both parts)
**The ruling:** the Attention page becomes a personal dashboard/command center
— wide grid, widget blocks, analytics, bulk operations, real nesting — "the
most useful personalized command center possible: everything needing
attention, prioritized, most important first, including AI recommendations on
where to start."

**Part 1 — layout, blocks, analytics (commit `DEC-048 (part 1)`):**
- Two-column grid (queue column at a readable measure + 340px block rail);
  firmer row dividers (`--edge-firm`) and more row breathing room.
- ONE component per widget, `variant="compact" | "full"`
  (`attentionBlocks.tsx`): Pulse, Overdue radar, Today's agenda, Recent
  activity, Analytics, Start here. The Attention page renders full; the home
  dashboard's four cases render the SAME components compact — the legacy
  task-data-backed renderers are gone, so the surfaces cannot drift.
- `attentionAnalytics.ts`: every number derives from work_item_state +
  timestamps only (no pretend event history). Honesty rule: a claim that
  would need a real event log is NOT made. Status breakdown per class ×
  state; plain-language trends (closing streaks, week-over-week class swings,
  arrival/closure balance, oldest untouched); `startRecommendations` = the
  queues' own ranker, top-3 with reasons, one-click Start-with-Plexii.

**Part 2 — nesting + bulk (this commit). SUPERSEDES DEC-035/DEC-047's
one-level rule by explicit operator instruction:**
- **Nesting to depth 3** (`MAX_GROUP_DEPTH` in shared/workItems.ts). The db
  guard walks UP from the new parent (level + cycle refusal) and DOWN through
  the item's own subtree (it rides along): `level + height ≤ 3` or the write
  refuses — whatever writes it (drag, agent, sync replay). Dropping onto a
  child now genuinely nests (the DEC-035 flatten is gone).
- `orderWithGroups` renders the tree (depth 0/1/2, childCount, descendants);
  an absent parent PROMOTES its subtree (never hides), cycles render flat.
- **Collapsible parents:** "N subtasks" fold on every parent row, persisted;
  `visibleRows` is the pure filter. Verified live (8→7→8 rows).
- **Drop planners mirror the cap:** planDrop/planDropMulti refuse over-deep
  or cyclic drops, and the dwell affordance never ARMS an illegal nest
  (`canNestUnder`). Cross-queue drops reclassify the WHOLE subtree — children
  follow their parent, never strand.
- **Marquee selection:** Shift+drag sweeps a rectangle (Shift because bare
  drag = reorder); auto-enters Select mode; the post-sweep click is
  swallowed.
- **Bulk verbs:** Complete all (each item's OWN queue verb — honest record),
  Dismiss all, Archive all. "Delete" maps to dismiss BY DESIGN: work items
  have no hard delete; parked and recoverable.
- **Bulk drag:** dragging a selected row moves the whole selection — reorder,
  reclassify, or drop ON an item to nest them all as its subtasks (selection
  tops re-parent; internal structure rides).
- **Parent completion accounts for subtasks:** closing a parent with open
  descendants offers close-all-with-it / just-this-one / cancel — an offer,
  never a silent cascade, and closures use each child's own queue verb.

**Gates:** suite 2,963 green (attentionGrouping rewritten, 30 tests;
workItemsVerbs guard block rewritten for depth/cycle/subtree; analytics 9);
typecheck clean; live CDP smoke — zero console errors, blocks live, real
nested data rendering, collapse verified.

---

## DEC-049 — Command-center LAYOUT: KPI band, the day top-right, a short rail
**Date:** 2026-08-26 · **Status:** RULED (operator, on the DEC-048 build:
"way too many widgets along the right-hand column… you have to scroll down too
far… analytics should be across the top, think KPI metrics on a CRM
dashboard… top right should be today's agenda or today's calendar, underneath
the primary banner header… with analytics is where the start here section
should be — that should be the AI prompt and recommendation") + IMPLEMENTED
**The arrangement** (pinned in tests so it cannot silently drift):
- **Analytics across the top** as a `variant="band"` — six KPI tiles (Open,
  Due today, Overdue, In progress, Waiting, Closed·7d) with a closed-per-day
  sparkline and any honest trend lines beneath, plus a "Breakdown" disclosure
  that opens the per-class stacked bars two-up. Pulse is GONE from this page:
  its numbers ARE the KPI tiles, so the widget count drops instead of
  duplicating (Pulse still serves the home dashboard compact).
- **Start here sits with analytics**, directly beneath the band, and is now an
  AI strip: a prompt box ("Ask Plexii about your queue") that stages the
  question together with the ranked top-3 and their reasons, plus the three
  recommendation cards. Staged, never sent (DEC-038 holds).
- **Today, top right, under the banner** — and it is the real CALENDAR now:
  `dayTimeline` merges today's time blocks (meeting blocks marked) with the
  work due in the day. It loads today's range ONLY when the store's window
  doesn't already cover it, so the Calendar view's own range is never
  clobbered.
- **The rail is two blocks and STICKY** (Today + Overdue radar, ~180px): it
  no longer scrolls away, which is what made the old six-widget column feel
  long. Recent activity moved to the FOOT of the working column beside the
  other history shelves (Recently closed, Archived) — history belongs with
  history, live work belongs in the rail.
**KPI tiles are filters.** Pressing a tile narrows the queues; the count and
the rows come from the SAME predicate (`KPI_FILTERS`, exported and used by
both), so they can never disagree — unit-pinned. A narrowed queue always says
"Showing <what> only" with a Clear beside it. Closed·7d opens the
Recently-closed shelf instead (it is not a queue filter).
**Variant rule extended:** `BlockVariant` gains `'band'` — still ONE component
per widget, one more display branch, never a per-surface fork.
**Gates:** 2,974 green (KPI/timeline math + count-equals-filter honesty +
layout pins); typecheck clean; live CDP — 6 tiles, ask box, 3 recommendations,
rail computed `position: sticky` at 181px, tile-click filter verified against
its own count, zero console errors.

---

## DEC-050 — Item rows get real project-tool anatomy (ClickUp/Jira grammar)
**Date:** 2026-08-27 · **Status:** RULED (operator: "the items shouldn't be
stacked seamlessly together… there needs to be either a line or even a tiny
bit of spacing… it should look and feel more like a true project management
app like ClickUp or Jira — incorporate those UI/UX elements") + IMPLEMENTED
**The bug underneath the complaint.** The list DID carry
`divide-y divide-[var(--edge-firm)]` — and drew nothing. `clusterByDesk`
wraps rows in one div PER DESK, so the dividers landed between clusters; a
queue rendering a single cluster (the common case) got zero lines. Separation
was never a taste question — it was broken and invisible in review because
the class looked correct.
**Rows are now cards.** Each row is its own rounded, bordered surface with a
6px rhythm between them, a hover lift (a low-alpha accent wash — `sunken`
would read as recessed on a raised card, and no `--surface-hover` token
exists), and a 3px spine down the left edge in the QUEUE's colour, so what
kind of work a row is stays readable without reading. Nesting reads as a
26px indent per level (capped with the DEC-048 depth rule). The desk-signals
shelf and the detached shelf follow the same rhythm — one page, one grammar.
**The anatomy, borrowed deliberately:**
- **Completion circle first** (the ClickUp gesture): closes with the QUEUE's
  own verb, so one click never mislabels a Meet item as "done".
- **Subtask chevron in a fixed slot** so every title starts at the same x
  whether or not the row has children, plus a **progress bar + "2/5
  subtasks"** counted over the WHOLE subtree (`subtaskProgress`, pure and
  tested).
- **An always-visible meta rail** aligned down the right: priority flag ·
  interactive status pill · due chip · assignee avatars (initials from person
  mentions, +N overflow). Always visible — not hover-only — because a list
  you cannot scan is not a command center.
- **Status changes in place** (`ItemStatusPill`): Not started / In progress /
  Waiting / Blocked / Delegated, plus the queue's own closing verb. Colours
  come from the derived projection, so a state added later can never render
  unstyled. Picking the closing verb routes through `closeWithOffer`, so the
  desk-done offer and the open-subtask accounting fire the same as the
  circle — a status change can never bypass them.
- Hover actions (copy, open here, desk, Plexii, snooze, archive, open) stay
  where they were; the old duplicate "Done" button retired, since the circle
  and the pill both close.
**Gates:** 2,977 green (subtask progress + row-anatomy and pill pins);
typecheck clean; live CDP — 8 card rows at 6px separation with correct
indents, 8 pills, 2 progress bars, the pill menu opened with REAL mouse input
and a full round-trip verified (menu click → db write → re-render), zero
console errors.

---

## DEC-051 — Widget parity (one row renderer) + the credits streaming 400
**Date:** 2026-08-27 · **Status:** IMPLEMENTED (operator: "now do the same for
the desk and home widget versions" + "im getting this error" — a raw
`400 {"error":…"Streaming is not supported on PlexiDesk credits."}` printed
where the chat answer belongs)

### A. The streaming 400 — a race, not a config problem
Both streaming call sites already guarded against the credits proxy (which
rejects streaming outright). The guard asked POLICY:
`shouldUseCredits() && getCreditClient() === c` — and policy is re-derived
long after the client was chosen, so it drifts inside a single turn:
1. `c = getClient()` at the top of `sendChat` → the credits proxy.
2. `prepareChatCall()` runs retrieval, whose own AI calls update the credit
   cache (balance → 0 flips auto-mode to BYOK) or a settings change calls
   `invalidateCreditClient()` (breaking the `===` identity check).
3. The guard now answers "not credits" while `c` still IS the proxy → it
   streams → the proxy 400s → the raw error lands in the transcript.
**Fix:** ask the CLIENT, not policy. `isCreditClient(c)` reads the instance's
own `baseURL`, which cannot drift out from under the request it is about to
make (prefix-matched against SIGNAL_BASE, so a look-alike host cannot spoof
it). Both sites now use it. **Plus a safety net:** `isStreamingUnsupported(e)`
matches only that refusal, and the site re-runs the SAME request body
non-streamed — so any future route that reaches a streaming-refusing endpoint
answers instead of erroring. The `[ask-latency]` trail now logs what actually
happened (`streamed=${streamed}`), not what was planned — the old field would
have logged a lie through a fallback, which is part of why this stayed
invisible.
*(Unchanged and deliberate: the BYOK-vs-credits billing choice is still the
operator's. This makes credits work correctly, it does not switch modes.)*

### B. Widget parity — ONE row renderer
`ItemLines` is the row for every widget in the family (the four queue
widgets, and the big `AttentionWidget` that the DESK widget delegates to), so
upgrading it upgraded all three surfaces at once. Widget rows now carry the
DEC-050 anatomy at widget scale: a bordered card with the queue's colour as a
left spine, a working completion circle, the due date, and status — the full
`ItemStatusPill` in roomy widgets, a coloured status dot (with the same
label as its tooltip) in small ones, via a `dense` prop.
**The bug that blocked it:** `WidgetShell` wrapped the ENTIRE widget in one
`<button>`, so nothing inside could be interactive — nested buttons are
invalid and every inner click became "open Attention". The header keeps that
job; the body is now free to hold controls.
**Closing is one code path.** `useCloseWorkItem` (new) owns the DEC-047 D-3
desk-done offer and the DEC-048 open-subtask accounting; the page and both
widgets call it. Forking that logic per surface is exactly how a widget
quietly stops asking about subtasks while the page still does — so it is now
impossible by construction, and pinned.
### C. The agenda stops re-ranging the shared calendar
Found by inspection while wiring the widgets: DEC-049's AgendaBlock called
`useTimeBlockStore.loadRange()` to fetch today. That store holds ONE range for
whatever surface last asked, and `WeekTimeGrid` loads a whole WEEK into it —
so a mounted agenda widget could narrow the range to today underneath an open
calendar, blanking the rest of its week until it remounted. The block now
fetches today's blocks straight from `window.api.timeBlocks.list()` into local
state and never writes the store; it re-fetches when the calendar's block
count changes and when the day rolls over. Pinned.

**Gates:** 2,992 green (9 new credit-streaming tests incl. the drift race and
"other 400s still surface"; widget-parity, one-renderer, and read-only-agenda
pins); typecheck clean. **Live verification was not possible this round:** the
dev app opens a window and then loses it (0 windows, main process idle, CDP
unreachable) — and it reproduces with ALL of this work stashed, at the
DEC-050 commit, so it is not caused by these changes. Flagged to the operator
rather than worked around.

---

## DEC-052 — Calendar: the operator's full ruling on Analysis 24
**Date:** 2026-08-27 · **Status:** RULED (operator, in full) — build begins

**(1) Coordination overruled.** The nav row does NOT need to go through Caleb.
"We can solve whatever needs to be solved in service of this feature as long
as it doesn't ruin other critical developments that already exist." A-006
("nobody uses the calendar") is confirmed FACTUAL by the operator; the
calendars are barely usable and the user base is small and knows this is
active development. Rewiring is pre-approved; a destructive approach is also
on the table IF it serves the best outcome — but only with a clear plan laid
out first: what is lost, and the downstream effects, for the operator to
decide. Default remains rewire.

**(2) OAuth audit performed (operator asked for a double check).** Verdict:
NO reusable OAuth exists. Mail = IMAP + app-specific passwords (safeStorage);
zero token storage in main; zero provider SDKs; popupRouter's "OAuth" is
popup ROUTING so sign-ins complete inside webviews — sessions live in the
webview cookie jar, the app never holds a token, and cookies cannot
authenticate Calendar API calls. Foundation must be laid fresh.

**(3) External sync: design + foundation ONLY, no build now.** Schema fields
and the connector contract land so it layers in later; the sync itself waits.

**(4) Research consensus + Analysis 24 recommendation = the direction.**
Everything not explicitly addressed in the operator's message is approved
as written.

**(5) Calendar pollution is THE problem being solved.** Neither a calendar
chock-full of blocks nor an empty one. The model: users explicitly drag what
they WANT time-blocked; for the rest, two AI modes, both preview-first —
(a) "Let Plexii plan your day": fill empty slots by priority/urgency/due;
(b) intent-driven: describe the day in natural language ("I'm feeling
motivated to take on the CETRA project today"), the system compiles the
relevant open items, previews a schedule, the user rearranges/accepts, and it
lands as time blocks with clear deliverables.

**(6) THE most important thing: completion clears the task — with approval.**
When work is completed in Plexi, the system offers "complete this task or
leave it?" — one keystroke. NEVER auto-complete without approval; the human
stays in the loop about everything happening on their behalf. This is the
feature that removes list maintenance as a job.

**(7) Unlogged work counts.** A user who works a desk without ever logging an
attention item should still see completions in analytics — "things completed
and desks closed based on the work that was done rather than checkboxes
ticked." The attention layer watches silently; it surfaces only when needed.

**(8) The philosophy, verbatim spirit:** attention goes where the user needs
it, when they need it. The layer sits silently in the background — collecting,
watching, interpreting, ready — and stays out of the way otherwise.
Flow state is sacred: if the user is active and getting things done, even if
it isn't what the calendar intended, the system recognises that rather than
nagging about the plan. Balance freedom and organisation through
ADAPTABILITY, not forced structure. The quality bar: a perfect executive
assistant at a CEO's side. Treat with the respect that implies.

**Build order (per Analysis 24, now unblocked):** Track A (calendar tells the
truth + rail row + day column) → B1 (drag-to-schedule) → B2/C-foundation
(schema) → B3 (plan-my-day, preview-first) → D (completion loop, in-Plexi
first). D is elevated in importance by ruling (6) but still sequenced after
the surface exists.

**Build status (same day, four commits, both remotes):**
- **Foundation** `9900e80c` — scheduling+sync columns (origin/locked/
  push_policy/transparency/visibility/external_*), status → 4 states via a
  dynamic CHECK-drop rebuild (FK restated by hand; live DB migrated clean,
  backup `focusbuddy.db.bak-20260827-pre-dec052`), work_items.source_url.
- **Track A** `786530c8` — CalendarView rebuilt on work items + rankScore
  (second ranker gone); queue rail drags with `text/fb-workitem`; grid
  parameterised (days 1/3/7, compact) with the deadline band and
  drop-books-immediately; Attention rail = the same grid narrow; Calendar
  back in the sidebar (both states). A-006 → CONFIRMED.
- **Track B** `cdbe25e8` — the planner: pure engine (honesty filter: waiting/
  blocked never scheduled; 330-min ceiling; gaps; session cap; clock floor;
  momentum by desk), Plan-my-day + intent mode (Haiku select w/ stopworded
  keyword floor), dashed-ghost preview, Accept = ONE undo batch, replan-
  undone marks missed + re-proposes (never moves), 1-hour grace.
- **Track D tier 1** `5068a7d4` — the typed ledger (wi_signal +
  wi_signal_match; device-local; once-ever pairing as a DB guarantee), four
  emitters (block done, focus finished, chat message sent, desk closed),
  pure matcher, the Enter-to-complete toast through useCloseWorkItem, and
  quiet-wins analytics ("counted from the work, not the checkboxes").

Gates across the day: suite grew 2,992 → 3,041 green; typecheck clean at
every commit; live smokes on the real DB (calendar surfaces, planner ghost
preview with zero writes). Remaining under this ruling: working-hours
settings UI (engine reads them; no editor yet), Track D tiers 3a/3b (email
via IMAP, then Slack behind the shared OAuth layer), Track C itself.

---

## DEC-053 — Calendar QA round one + the premium row pass
**Date:** 2026-08-27 · **Status:** RULED (operator live QA, seven items) + IMPLEMENTED

**(1) Planner settings editor** — a gear on the plan bar opens the editor:
day start/end (12-hour options), planned-work ceiling, longest sitting,
breathing room. Writes the same persisted settings the engine reads on every
plan run.
**(2) Drag-to-create** — Google-style: press empty grid, drag a span at the
15-minute snap (live overlay shows the range), release → the composer opens
at exactly that length. A press that never travels stays a plain click.
**(3) 12-hour clock** — the gutter reads 6 AM…9 PM (compact: 6a…9p). No
military time anywhere.
**(4) Today's column** — raised surface with a purple ring, replacing the
too-faint purple wash; other days stay grayed. Ruled colour treatment.
**(5) Drag a block back to the list** — a block pointer-dragged onto the
queue rail UNSCHEDULES it (the rail lights "Drop here to unschedule" during
the drag; delete is undo-able; the item resurfaces in To-schedule by
construction). A LOCKED block refuses — the pin means what it says.
**(6) Classification dropdown + New** — a class filter (All + the eight)
that narrows the rail, the deadline band, the month lens and the planner
pool together, persisted; a New button beside it opens the capture console.
**(7) The rows** — the operator: "text isn't centered; too blocky… needs to
feel premium like ClickUp." Root cause measured, not guessed: the row was
`items-start`, so the 18px title top-aligned against 26–28px controls.
Now: vertically centred, min-h 42px, py-1.5, rounded-md, slimmer hover
actions (h-6), the desk chip suppressed inside its own desk cluster
(the header already says it), spacing kept, no dividers (per ruling).

Suite 3,047 green (six new DEC-053 pins + the DEC-050 card pin updated to
the new anatomy); typecheck clean.

---

## DEC-054 — One visual system: Attention + Calendar adopt the Home material
**Date:** 2026-08-27 · **Status:** RULED (operator: "adopt the UI, UX and design
principles of the home page… dotted texture, shadowing so widgets pop… start
to feel like a unified app") + IMPLEMENTED

**The material, shared not copied.** Home's ground is `.paper-texture` (a
dotted radial-gradient over `--surface-base`, theme-aware) and its widgets ride
`.fb-widget-tile` — a Liquid Glass fill with a four-layer depth shadow and an
inset highlight. Attention and Calendar now sit on the SAME paper, and their
cards use a new `.fb-glass-card` (plus a quieter `.fb-glass-row` for list
rows). Card and tile read the identical tokens — `--glass-pillow-fill`,
`--glass-pillow-blur`, `--shadow-inset-highlight` — so a change to the
material reaches every surface at once.
**Why a second class rather than reusing the tile:** `.fb-widget-tile > *`
forces its children into a flex column, because a widget INTERIOR must
distribute its rows. A page card owns its own layout — applying the tile
would have turned every card header into a stacked column. One material, two
jobs, no drift.

**The sidebar problem, root-caused.** The left panel reserves its width with
PADDING on `<main>`, so the window width is identical whether it is open or
closed — which means Tailwind's `xl:` breakpoints (viewport-based) fired the
same either way, and the two-column pages simply got ~260px narrower with no
layout response. That is the "clunky when the menu opens" the operator saw.
Both pages now use **container queries** (`container-type: inline-size` +
`@container`): the grid columns and the rail's visibility respond to the space
the page ACTUALLY has, at 1040/1360px for Calendar and 1080/1400px for
Attention. Verified at both sidebar states.

**Calendar toolbar breathes.** The header is two stable rows — title/actions,
then a toolbar — instead of one that reflowed. Mode buttons carry a min-width
and `whitespace-nowrap` so Day/3-Day/Week/Month can never compress; the class
filter has a min-width; nav controls sit at h-9 with real spacing.

**Legibility fixes (operator: "some things get cut off").** The hour gutter
widened (w-14 / w-8 compact) so "12 PM" cannot clip; day headers carry a full
title attribute and their own tint for today; blocks show two title lines and
the start time when tall enough and truncate cleanly when short (instead of
clipping both); ghosts and deadline chips follow the same rule; month cells
grew to 104px with larger chip text.

Suite 3,061 green (six DEC-054 pins; the DEC-049 rail pin and DEC-050 row pin
updated to the new chrome); typecheck clean for these files.

*(The React max-update-depth warning from the CRDT sync layer is being fixed
in a separate session — untouched here.)*

---

## DEC-055 — The queue box, the tight left edge, the rail panel
**Date:** 2026-08-27 · **Status:** RULED (operator live QA, five items) + IMPLEMENTED

**(1) One box around the queue, (2) rows touching with a hairline between**
— reversing DEC-050's spaced cards, and this time fixing the CAUSE rather
than working around it. The first divider attempt drew nothing because
`clusterByDesk` wrapped rows in per-desk `<div>`s: `divide-y` on the list
then only fell BETWEEN clusters, so a queue with one cluster had no lines at
all (DEC-050 shipped spacing instead). The per-desk grouping is now a
**Fragment**, so every row is a direct child of the box and the dividers
reach all of them. Rows lost their own card, gap and hover-lift; the box owns
the surface, the row owns a hover tint.

**(3) The dead space left of the checkbox** was a column reserved for a
hover-only affordance: the drag handle sat in the flex flow at all times,
even at opacity 0. It is now absolutely placed in the spine gutter, the
chevron slot narrowed to 3.5, and the row's left padding dropped — the
completion circle now sits near the edge where the eye expects it.
Nesting moved from `marginLeft` to `paddingLeft` so an indented row still
spans the full box and its divider runs edge to edge; the spine and the
floating handle step in with the indent so hierarchy still reads.

**(4) The calendar's queue rail is a solid panel** — new `.fb-glass-panel`
(the same family as the card, but sitting on `--surface-raised` at 94%
rather than a translucent fill), so a standing column of items reads as its
own surface instead of text lying on the dotted paper.

**(5) The rail filters by CLASSIFICATION, not free text.** The "Filter items…"
input is gone, replaced by a dropdown (All open items + the eight classes).
It writes the SAME `classFilter` the header control shows — one truth, two
places to reach it — so the two can never disagree, and the empty state names
the class it filtered to.

Suite 3,061 green (three DEC-055 pins; the DEC-050 card and indent pins
rewritten to the superseding truth, keeping the divider-bug history in the
comment); typecheck clean.

## DEC-072 — Plan reasons state checkable facts
**Date:** 2026-08-30 · **Status:** EXECUTED (operator: "make them say something real") · committed `d5a47571`

DEC-071 made `reason` visible, and visibility exposed it: both blocks in the
operator's test read "Top of the queue" — the fallback was doing most of the
talking, because `reasonFor` asked only two questions (due within 2 days?
momentum ≥2 on the desk?) before giving up. Most items have neither.

The rewrite (`attentionPlanner.ts`): the reason is the item's strongest
CHECKABLE fact, strongest first — deadline (now with day counts, "Overdue by
2 days", and weekday names out to 7 days) → the person's own urgency call
("You marked it urgent" — chosen outranks derived, DEC-037) → momentum
(strings deliberately unchanged — pinned since DEC-052) → already-started →
days waited → then WHY-THE-PLAN-CHOSE-IT: a replan says "Slipped earlier —
proposing a fresh slot", intent mode says "Matches your intent", and ranked
mode does the day arithmetic — "Nothing else needs today" only when no other
schedulable item is due by the planned day's end, "Everything due already has
a slot" only when each such item verifiably has one (dragged or proposed
ahead of this row). The generic tail ("Next by rank") survives only for the
mixed case none of those cover. **Found while wiring it:** both intent mode
and replan-undone pass `onlyItemIds`, so the two were indistinguishable
inside the planner — a replanned block would have claimed an intent match.
`PlanDayOptions.source` now names the mode.

Same honesty pass on the start strip (`attentionAnalytics`): its fallback
claimed "Waiting the longest" on up to three cards at once and "Top of the
queue" on cards #2–3 — superlatives only one card can hold. Now day counts
("Waiting 9 days"), and only card #1 says "Top of your queue".

Verified two ways: 15 new pins (suite 3,196 → 3,211, both typechecks clean)
and LIVE over CDP 9223 — the planner module run read-only against the real
store (107 items, 15 schedulable, 2 blocks already booked) returned seven
proposals with SIX distinct reasons and zero generic strings: "Overdue by a
day" / "Overdue by 2 days" ×2 / "Due tomorrow" / "Waiting 3 days" / "Already
started — finish it" / "Everything due already has a slot". `planDay` is
pure; the check wrote nothing.

## DEC-073…076 — The operator's four-feature build round
**Date:** 2026-08-30 · **Status:** EXECUTED (operator spec, verbatim asks) · committed `e781d7d8`

**DEC-073 — "New Desk": named, prefilled, and it OPENS.** The header button
said "New" with a tooltip claiming "New room" while creating a desk; creation
called `setActive` but never changed the VIEW, so the desk was born off-screen
and had to be found under All Desks. Now: the button says **New Desk**, the
set-up dialog pre-fills the title with the moment ("Aug 30, 12:52 PM" —
`lib/deskDefaults.ts`), the field arrives focused with the text SELECTED so
overwriting costs one keystroke, Enter files it, and creation navigates
straight in (`goTask`). The prefill rides every create-desk entry (⌘K pill,
Stage Manager) by construction — same dialog; Rooms and edits keep their text.

**DEC-074 — calendar items open and complete in place.** Double-click a queue-
rail row, a grid block, or a deadline chip → the DEC-036 item editor (centre
peek); a desk-linked block's double-click opens the desk. The rail rows grew a
visible completion circle; the grid block's check, on a work-item block, now
closes the ITEM — each queue's own verb (PRIMARY_ACTION), through the ONE
close path with its subtask and desk-complete offers — and marks the block
done only if the close actually happened (the subtask offer can be cancelled;
the store's setState refreshes the row before resolving, so re-reading it is
the authoritative test). Undo on a done block stays calendar-local: it revives
the block; the item reopens from Attention, never from here.

**DEC-075 — missed items greet the launch.** Blocks still 'planned' whose
whole span lies before today are "untriaged" — DERIVED, never stored
(`lib/missedTriage.ts`; 14-day lookback so the first run can't wall the user
with pre-feature history; a block straddling midnight is not missed — its day
is not over). One prompt per app session (`MissedTriagePrompt` at App level):
per row **Done** (item closed with its verb + block done), **Today** /
**pick-a-day** (the original flips to 'missed' — the honest record, DEC-052 B4
— and a FRESH block lands in the day's first opening, same clock time visibly
overlapping if the day is full, never dropped), selection + **Complete
selected**, **Add all back to the calendar** (first openings today→+7d, one
undo batch), and **Later**, which costs nothing and returns next launch.
Intra-day slips stay DEC-052 B4's replan flow; this owns the day boundary.

**DEC-076 — the widget bell.** Every WidgetFrame header carries a bell:
outlined = not in Attention, filled = a LIVE work item points at this widget —
DERIVED from the queue's own rows (`lib/widgetAttention.ts`: sourceType
'widget'/'widgets', comma-joined multi-marks honoured, exact-id match, newest
live mark speaks), so the operator's "two-way sync" holds by construction
rather than by events. An outlined bell runs the SAME flow as the context
menu's "Add to Attention…" (preset → confirm console → item points at the
widget; nothing files without Enter). A filled bell opens the queue.
**Interpretive choice, flagged:** the spec said only "clicking adds" — a
filled bell re-adding would duplicate, so filled-click = open the queue; say
the word to change it. The check beside it appears ONLY when there is
something to complete, and closes through the one path. Gated on
workItemsEnabled(), like the menu.

**Gates:** suite 3,211 → **3,244** (33 new: missedTriage 12, widgetAttention 7,
wiring pins 14), both typechecks clean. **Live (CDP, read-only):** "New Desk"
in the DOM; both mounted grid blocks carry the complete control; prefill
returns the real moment; **the triage prompt fired itself on the HMR remount
and found 4 genuinely-slipped Thursday blocks on the live DB** — the launch
behaviour, observed. Widget bells: no desk canvas was mounted at verify time —
23 live widget-marked items exist, so bells will light on first desk open;
pinned by tests, awaiting the operator's eyes.

## DEC-077 — The refinement round: one circle, a bell that fills, rows that drag themselves
**Date:** 2026-08-30 · **Status:** EXECUTED (operator QA on DEC-073…076) · UNCOMMITTED · committed `e88ee5c3`

**(a) The bell now actually fills.** Root cause was a brand-system collision:
`Icon`'s `filled` prop is a deliberate no-op for Plexii brand icons (they are
line SVGs; "state is carried by color at the call site") — and 'notifications'
maps to one, so the active bell only recoloured its outline. Fix: `BellIcon`
in WidgetFrame renders the SAME brand path (one source, `PLEXII_ICONS`) with
`fill: currentColor` when active. Icon itself is untouched — honoring `filled`
globally would have restyled every brand-mapped `filled` call site in the app.

**(b) ONE completion circle.** The queue's DEC-050 form factor is extracted to
`attention/CompleteCircle.tsx` and adopted by all four surfaces — the
Attention queue (byte-identical rendering), the Calendar rail, grid blocks
(now a VISIBLE 12px circle on active work-item blocks; the hover cluster's
check narrows to plain blocks + done-undo), and the widget header. The
component swallows mousedown/pointerdown/dblclick because every host is a
gesture surface — a completion click must never start a drag or open an
editor.

**(c) Bell + circle moved beside the title** in the widget header, out of the
right-side control array where they got lost — the pair reads as the widget's
attention state, not two more chrome buttons.

**(d) The six-dot handle is RETIRED from both queues; the row drags itself.**
Calendar rail: the icon was decoration (the row was already draggable).
Attention queue: the handle owned dragstart — `draggable` moved to the row,
payload contract unchanged (`text/fb-workitem` — the calendar still reads
it), DEC-048 multi-drag preserved, and DEC-035's setDragImage plumbing died
with the handle (the row IS the source, so the browser ghosts it natively).
**Boundary: an EXPANDED row does not drag** — its notes are selectable
(DEC-030 read/copy) and a draggable ancestor would eat the selection;
collapse to move. Three DEC-055/070/035 pins rewritten to this superseding
truth, histories kept in their comments.

**(e) Nesting feedback lights the WHOLE target row** — accent tint + inset
ring while the drag dwells "into", unmistakable against the before/after
placement lines. Found while wiring: the row could carry TWO bg-* utilities
at once (select-mode + into), resolved by stylesheet order, not intent — the
backgrounds now live in one ternary chain, one owner per state.

**Gates:** suite 3,244 → **3,254** (net +10; 4 superseded pins rewritten,
dec077Refinements adds 9), both typechecks clean. **Live (CDP, real DOM,
view driven and then RESTORED via the real Back button):** Attention — 15
rows, 14 draggable (the non-draggable one is expanded/detached, the designed
opt-outs), ZERO six-dot handles, 15 circles at 18×18 round; Calendar — 15
rail circles at 15×15, 10 blocks with 4 carrying the visible circle (exactly
the active work-item ones), zero handles. Bell fill awaits the operator's
desk (no canvas was mounted); the mechanics are pinned.

## DEC-078 — The calendar breathes: its own scroll window, uniform days, a real outline
**Date:** 2026-08-30 · **Status:** EXECUTED (operator QA, three verbatim asks)

**(1) Taller hours, fewer on screen.** `HOUR_PX` 44 → 56. Forty-four showed
all seventeen rows at once and every one was cramped; the scroll window owns
how many are visible now (eleven at the operator's viewport).

**(2) The hours scroll in their OWN window (Google-style).** The grid split
into a pinned band (day headers + deadline chips) over a time area that is
its own scroll container — `overflow-y-auto overscroll-contain`, bounded
`max(280px, calc(100vh − 380px))`, opening with the current hour one row
below the top edge. Hover the grid and the wheel moves through the day;
outside it, the page scrolls as before. Side effect worth naming: the
deadline band used to live INSIDE each column, so a tall chip stack pushed
its own column's canvas out of line with the others — pinned, that class of
misalignment is gone. The rail's compact mode keeps its full-height habit
(no scroller; its card owns it).

**(3) No graying; today is an outline ALONE.** Every day column is the same
raised surface now; the sunken wash that made the week read as
six-sevenths disabled is gone, and today carries a light accent outline
(`ring-accent/35`) as its only column-level differentiator.

**Found while verifying (3): DEC-053's today ring NEVER painted.** The class
was `ring-[rgba(var(--accent),0.45)]`, which substitutes to
`rgba(124 58 237,0.45)` — space-separated RGB with a comma alpha, invalid
CSS — so the ring's box-shadow computed to `none` from the day it shipped.
The suite stayed green throughout because source-pins pin strings, not
paint. Measurement over CDP caught it (the DEC-056 lesson shape again). The
sanctioned form is the CONFIGURED accent with slash opacity
(`accent: 'rgb(var(--accent) / <alpha-value>)'` → `ring-accent/35`); all
nine `rgba(var(--accent),…)` occurrences in this round's two files were
converted (rings, hover washes, the mode-switcher active state, an inset
shadow). **The same broken pattern exists in ~10 more files → GAP-018** —
registered for its own sweep, not absorbed mid-round (several sit in the
parallel session's working set).

**Verification (live, CDP, by measurement):** hour row 56.0px · scroller
`overflow-y: auto` + `overscroll-behavior: contain`, window 618px = 11.0
hours · auto-open scrollTop 334.7 vs 335 expected (clamped at max,
mid-afternoon) · commanded −150px moved the columns exactly −150px while
the header band's y held and the PAGE scroll position was unchanged ·
all day columns computed the same background (one distinct value) · today's
ring computes `rgba(124,58,237,0.35) 0 0 0 2px` — it paints. Suite 3,255
(one net new pin; the DEC-053 ring pin rewritten to the superseding truth
with its history).

**Follow-up (same day, operator): the day runs MIDNIGHT TO MIDNIGHT.**
`START_HOUR` 6 → 0, `END_HOUR` 23 → 24. The old 6am–10pm window silently
HID anything booked outside it — an early flight or a late call rendered
off-canvas with no hint it existed; the scroll window is what decides how
many of the 24 hours are visible, which is why this is safe now and wasn't
before DEC-078. Measured live: 24 gutter labels 12 AM → 11 PM, grid 1344px
(= 24×56), auto-open landed at the current hour UNCLAMPED for the first
time (704.7 vs 705.6 expected). Live bonus proof: the operator clicked a
3 PM slot mid-verification and the composer opened at exactly 3:00 PM —
the y→time math holds on the new origin. The compact rail grows to
24×30px full-height by the same constants (its card scrolls; acceptable,
revisit only if the operator flags it).

## DEC-079 — Calendar QA round two: the rail windows, a swipe pages the range, 12 AM breathes
**Date:** 2026-08-30 · **Status:** EXECUTED (operator, three verbatim asks)

**(1) The rail's Today widget windows twelve hours.** Midnight-to-midnight
(DEC-078 follow-up) made the rail's full-height habit a 720px column of
mostly night. The compact grid now gets the same scroll window as the big
one — `12 * hourPx` = 360px, all 24 hours a scroll away — and the
autoscroll's compact guard was removed, so the rail opens at the current
hour too (clamped to the bottom in the evening, same as the big grid).

**(2) Trackpad horizontal swipe pages the range.** One swipe = one
`shift()` — the same function the chevrons call, so day/3-day/week page by
their span and month by month with zero new range math. The handler sits on
the calendar surface (plan bar + both views): horizontal-DOMINANT deltas
only (vertical belongs to the time window), accumulated to a 120px
threshold, fired ONCE, and the gesture's momentum tail swallowed until the
stream is quiet for 250ms. Swipe left = forward in time.

**(3) The 12 AM clip.** The first gutter label translates 6px up to sit ON
its hour line (as every label does), and the DEC-078 restructure removed
the old header padding that had been its headroom — so its top half clipped
at the scroll edge (operator's screenshot). `pt-2` on the time window is
the headroom; the label now sits at a designed 2px inset, both surfaces.

**Verified live over CDP against the REAL handler and both surfaces:** a
12-event 300px synthetic swipe paged exactly once (Aug 30–Sep 1 →
Sep 2–Sep 4); a 6-event tail inside the same gesture changed nothing; the
back-swipe returned; 12 vertical-dominant events with sideways drift paged
nothing. Rail: window 360px exact, scrollH 729 (all 24h reachable),
opens clamped-to-now, `12a` at 2.0px inset. Big grid: `12 AM` at 2.0px
inset at scrollTop 0. Operator's view restored to Calendar after. Suite
3,256; the two DEC-078 pins the restructure superseded were rewritten with
their history.

## DEC-080 — The Book time dialog: spec steps 1–9, edit mode, the option-B grammar
**Date:** 2026-08-30 · **Status:** EXECUTED (operator spec, reviewed pass by pass) · committed `34feaab1`

The drag-select dialog rebuilt to the operator's book-time spec across five
reviewed passes. The shape: the mode slider IS the header (Cmd+M; Framer
thumb + reveal, reduced motion honoured); the title is the act of intent —
empty commits the RESOLVED placeholder (attached → guest names → "Meeting" →
room → "Focus"), with the refusal of date/time defaults pinned alongside its
deliberate DEC-073 divergence (a block carries its time; a desk doesn't);
one time row (pickers, the 15/25/30/45/60/90/120 cycling end chip with
DEC-053's display-as-is + nearest-step entry, Repeat never says "Does not
repeat"); meeting-only fields behind the reveal with the ENTER GUARD (chips
commit on Enter/comma/Tab, suggestions ranked by recency of shared meetings
from real past invitees; Where autofocuses its revealed input; agenda takes
Shift+Enter). Commit closes FIRST, toasts Booked/Scheduled through the house
recordWithToast with Undo, and meeting invites HOLD a stated 10s window Undo
cancels — nothing sends (CR-08/09), the expiry callback is the future send
site. The Attendant-proposed state is native (same dialog, accent-soft
banner, countdown that BOOKS at zero, Esc dismisses; manual trigger only —
hold-time unruled). Inline create ships FLAGGED OFF by operator ruling: a
drag-highlight opens the FULL dialog; the flag opts into naming-in-place.
Double-click on any meeting or plain block reopens the dialog seeded with
everything; Save patches in place, preserves the block's own roomId, Undo
restores every prior field. Work-item and desk blocks keep their DEC-074
routes.

**Step 5 ruled OPTION B:** one shared token grammar (`parseBlockTokens`) —
durations strip and set, #room resolves and attaches (unmatched #words stay
visible), meet/call/sync/1:1 flip mode WITHOUT being stripped, every effect
echoed; deliberately NO @ tokens (@ stays Attention's in ⌘K and mentions' in
chat — @-as-guest is its own later ruling). Parsing fires on token
completion or blur, so "45min" is never clipped at "45m". Acceptance live:
"Roadmap sync 30m " → "Roadmap sync", 30m, Meeting on Plexii Meet, echo
"Set 30m, meeting".

BlockComposer deleted per the spec's own step 9; the DEC-063
link/location/end-time pin rewritten to the superseding surface with its
history. `TimeBlockMeeting.agenda` added (JSON payload, no migration).
Attach stays stubbed on desk_block (unruled; the stub id can never reach a
real block). Every pass live-verified over CDP with real input events;
suite closed at 3,310.

---

## DEC-081 — The name is Plexii: two i's, everywhere, enforced
**Date:** 2026-08-30 · **Status:** EXECUTED (operator ruling) · committed `327523f4`

70 standalone single-i occurrences fixed across 36 files — "Plexii Meet",
⌘K's "Opens in Plexii", chat/browser hints, "Plexii proposed an action",
the changelog, the slide theme's display name (stable id untouched), and
the wordmark's screen-reader label, which said "Plexi" while the logo
renders *plexii*. Functional catch: the wake word `/(hey )?plexi\b/` could
never match a transcript spelled "Plexii" — now `plexii?\b`. Fused legacy
identifiers (PlexiDesk, PlexiSuite, PlexiOffice…) deliberately stay
single-i pending their own ruling. Enforcement is mechanical: a grep-lock
test fails on any standalone Plexi in src, and the root CLAUDE.md carries
the convention for every future session (plus the operator's memory).

## DEC-082 — Plexii Meet video: two real defects and one OS verdict
**Date:** 2026-08-30 · **Status:** EXECUTED (operator: "root cause unknown… needs investigation") · committed `4f5e92c2`

The investigation, all measured live over CDP against the running app:

**The OS verdict (not a Plexii bug, and the reason nothing "turned on"):**
camera permission looked granted — because our own `setPermissionCheckHandler`
answers granted for anything not denylisted, so `navigator.permissions` was
never evidence. The TCC log has the truth: the dev app launched from inside
Claude Code inherits the LAUNCHING app's TCC identity
(`com.anthropic.claude-code` as the responsible process), and that identity is
**denied kTCCServiceCamera with "Policy disallows prompt"** — every capture
silently refused at the OS layer. getUserMedia still resolves: the track
arrives readyState 'live', enabled, and **muted forever** (zero frames — the
requestVideoFrameCallback probe counted none from either camera). Mic works
because Claude Code holds microphone permission; camera it does not.
**Operator's move (I cannot change security settings):** System Settings →
Privacy & Security → Camera → enable the app Plexii was launched from — or
launch the dev app from Terminal so TCC attributes to Terminal and prompts.
Packaged builds are unaffected (NSCameraUsageDescription already declared).

**Defect 1 — tiles never played (fixed).** Even with frames, the meeting and
call tiles could stay black: `autoPlay` does not start playback in this
Electron build when `srcObject` lands after mount — measured `paused: true`,
readyState 0, live track attached. VoiceRecorderWidget had already learned
this and plays explicitly; MeetingOverlay + CallOverlay tiles now do too,
with a loadedmetadata retry.

**Defect 2 — the silent black tile (fixed).** An OS-muted track rendered as a
pure black rectangle with no error anywhere. `useVideoBlocked` (new lib)
listens to the track's mute/unmute — Chromium's own "no frames" signal — and
both overlays now show the avatar plus an amber "Camera blocked by macOS"
note whose tooltip names the System Settings path. Verified live against the
currently-blocked camera: note rendered, ZERO black video tiles; the moment
the grant lands, unmute flips the hook and the play() fix takes over.

---

## DEC-083 — Meeting-born items link back to their meeting
**Date:** 2026-08-30 · **Status:** EXECUTED (operator ask #2) · committed `4f5e92c2`

An action item approved from the end-of-meeting wrap-up now POINTS at the
meeting whose transcript produced it, and the queue links back.

**Write side.** The wrap-up's Meeting record was created fire-and-forget, so
its id was unknowable at approve time — now awaited (`wrapup.meetingId`; a
failed save degrades to the old unlinked behaviour, never blocks the review).
`applyProposal` gained `ctx.workItemSource`; the executor stamps
`sourceType/sourceRef` from it with 'chat' as the unchanged default, so the
model contract and every other surface are untouched. ProposalCards threads
the prop (the toFiles document path deliberately omits it — it never files
items), and WrapupOverlay passes `{sourceType:'meeting', sourceRef}`.

**Read side.** The queue's source chip, for meeting-born items only, is now a
LINK (groups icon, data-testid item-meeting-link): `openMeeting()` navigates
via `goMeetings()` and hands the meeting id to PlexiMeetView with the same
post-navigation handoff pattern `openHere` uses for widgets
(`fb:open-meeting`, 250ms); the view selects it even if its list is still
loading. `sourceLabel('meeting')` says what the click does. A deleted
meeting degrades to the view's own empty selection — never a crash.

**Gates:** suite → **3,332** (dec078_079Meet adds 9; a parallel session's
capture rebuild landed alongside), full typecheck clean. **Live:** the exact
`openMeeting` flow driven through the app's own `__fbView` store against a
real meeting — PlexiMeet mounted, the meeting selected, transcript visible,
operator's view restored. **Deliberately NOT started:** the Fireflies-level
transcript UI rebuild — the operator gated it on this report.

## DEC-084 — Capture rebuilt as Book time's sibling
**Date:** 2026-08-30 · **Status:** EXECUTED (operator spec) · committed `5b88490c`

The Attention capture window rebuilt: no tab bar (Enter classifies,
Cmd+Enter files verbatim — destinations on the commit, not modes; Expand
left the dialog), two labelled fields with the rotating category
placeholder (built — the old one was static), and the confirm step as FOUR
labelled pills (CATEGORY/URGENCY/WHEN/DESK) opening one question-led drawer
at a time on the SHARED AttentionConfirmCard (DEC-028 — chat's inline
confirm inherits the look). Number keys 1–8; two-stage Esc; "back to your
words" refocuses the words. CONFIDENCE is honest: accent = machine-guessed
(category / inferred when / context desk); urgency can never light because
nothing infers it. Status removed from capture (supersedes DEC-047 D-5 —
a new item is open; W covers waiting). The @ input lives in the Desk drawer
on the DEC-039 grammar. "File it" toasts with an R008-honest Undo. The New
item button + inline form DELETED — capture is the only door. Title
scaffolding ("remind me to…", "todo:") stripped from derived titles
(main-process; takes effect on restart). Mid-verification the card was
found deaf to keyboards (the rebuild dropped the old chip-autofocus) — it
now takes focus on mount. Five superseded pins rewritten with history.

**Recorded honestly:** during verification, a re-drive script skipped its
surface assertions and typed into the operator's live Messages composer —
two stray messages sent to a real conversation (operator handling them).
The standing rule since: NO synthetic keystroke without an asserted,
focused target — the corrected drives abort otherwise, and one such abort
fired correctly the same hour.

---

## DEC-085 — Selecting Attention in ⌘K opens the Capture window
**Date:** 2026-08-30 · **Status:** EXECUTED (operator ruling) · committed `f31c7e24`

⌘K → mention Attention (typed or clicked) → Capture opens; typing happens
there. The DEC-028c armed pill is RETIRED from ⌘K (chat + home bar keep
theirs; "@attention <text>" still files directly per DEC-031). The drive
exposed the real bug underneath: the omni "Ask Plexii" row (score 2000)
only yielded to the literal token, so Enter on plain "attention" asked the
model — the yield now covers every Attention mention via one shared
`attnAddressed` predicate. Live-proven with focus-asserted input both ways;
the full Esc chain closes clean; zero strays.

## DEC-086 — GAP-018 swept: the accent color always paints
**Date:** 2026-08-30 · **Status:** EXECUTED (operator: "do the GAP-018 sweep")

43 `rgba(var(--accent),…)` occurrences converted across 9 files — the
register's census had missed **globals.css**, where fourteen of them were
the futuristic/gemstone theme glows: accent-tinted background gradients,
card glows and grid lines that have NEVER painted. Stylesheet instances
became `rgb(var(--accent) / X)`; class utilities became the slash forms;
embedded shadow/style occurrences became `rgb(var(--accent)/X)`.

**The sweep exposed a sibling bug of the same species:** Tailwind's opacity
modifier scale is multiples of 5 — `bg-accent/14` generates NO utility and
paints nothing, silently (measured: transparent probe, no rule in the
sheet; `/35` and `/45` work because they are on the scale). The sweep's own
first pass produced seventeen such bare off-scale modifiers — caught by the
live probe before commit and converted to arbitrary form (`accent/[0.14]`).
Files that already used the arbitrary form (LiveDeskSharing, LiveDocSharing,
NewNodeDialog) were correct all along and untouched.

Both classes are grep-locked (`tests/unit/accentColorLock.test.ts`): no
`rgba(var(--accent` anywhere in ts/tsx/css, and no bare non-÷5 accent
modifier, ever again. Verified live: `/[0.14]`, `/10`, `/5` probes all
computed real rgba values; zero old-pattern classes in the mounted DOM.
Four superseded pins rewritten with history. Suite 3,334 / 312.

<!-- Append below; increment DEC-NNN. -->

## DEC-056…061 — The platform arc (one investigation, six landings)
**Date:** 2026-08-27 → 08-28 · **Status:** EXECUTED · **Shipped separately to `main` as PR #5**

Began as "the app won't boot" and became six defects, all one shape: **a guard
that checked the request instead of the outcome.**

- **DEC-056** (`1253aac3`) — the remote-change emitter fired one Event per
  cascade-delete descendant. 596,754 of 768,169 Events were WidgetDeleted /
  DeskDeleted that nothing can consume (a deleted object has no "changed since
  your last visit" frame to light). Deletions now emit nothing; updates emit once
  per object per pass. `pruneOutbox()` added — the outbox is delivery
  bookkeeping, not history, so capping it destroys nothing PLX-EVT-030 protects.
- **DEC-057** (`690aba29`) — `pruneActivity`/`pruneHistory` had **zero call
  sites** since the initial commit. Wired, but only after a policy change: a
  table-wide cap would have evicted 2,088 rows of real history to make room for
  telemetry. Per-kind + per-org instead (`browser_nav` 2,000/org, 90-day ceiling).
- **DEC-058** (`674ed227`) — the nav fan-in. Four webview events into one
  unguarded recorder wrote 39,762 rows in 19 hours. `navTrail.ts` dedupes.
- **DEC-059** (`4af921c1`, `7c363379`) — **the launch blocker.** `applyRemote`'s
  tombstone branch had no echo suppression though the upsert branch three lines
  below does. Re-applying a held tombstone is a no-op UPDATE, which is exactly
  what `widgets_mark_dirty` fires on → dirty → pushed → server bumps rev →
  tombstone returns. Measured at `sync_rev 7,319` on one widget and **10 server
  writes/minute, forever**. Fixed with the guard the upsert branch already had.
  Part 2: replayed writes declare `WriteOrigin`, so a replay stops minting
  "user did this" Events. Clean boot went ~2,500 → **4 Events**.
- **DEC-060** (`0bd8a77b`) — the boot hang. `emitObjectEvent → localActor() →
  loadAccountState() → safeStorage`: every Event did a synchronous macOS
  Keychain decrypt, to read `cachedEmail` — a field stored in PLAINTEXT. The
  first one blocked the main thread behind an authorization prompt with no
  visible parent. Cold boot: indefinite hang → **3s**, verified over three restarts.
- **DEC-061** (`0e5d8a4e`) — `browsing_history.visit_count` corrupt from the same
  handler (one Slack channel at 14,096 "visits", a number that is user-visible
  AND fed to the LLM). Counter gated; counts repaired from the activity log,
  which is their exact provenance (763 rows matched, zero disagreed).

**The load-bearing lesson, recorded because it recurred:** every one of these
was invisible to the test suite, which was green throughout. They were found by
*measuring the live database*, not by reasoning about the code.

---

## DEC-062…067 — Sub-item chrome: four rounds that were the wrong approach
**Date:** 2026-08-28 → 08-29 · **Status:** SUPERSEDED BY DEC-070 — kept for the lesson

Operator QA on the queue's sub-item rows. Shipped in order: a clickable expander
(the drag handle was absolutely positioned in the chevron's gutter and swallowed
its clicks); an elbow connector; desk-cluster folding; queue-coloured desk
headers; an inset block per indented row; a page-coloured gutter; the elbow
raised onto the parent/child boundary; the elbow aligned to the parent's spine.

**Each round fixed a seam and produced another.** The cause was structural and
took four rounds to see: *the hierarchy was drawn as per-row line SEGMENTS*, and
segments painted by different rows cannot be guaranteed to join. 1px offsets,
corner touches that antialias into breaks, a bend repeated once per child.
DEC-070 is the reset.

**What survived the reset:** the expander z-order fix, desk-cluster folding, and
queue-coloured desk headers. Those were real and are still in.

---

## DEC-063/064/068 — Meet items point at a meeting
**Date:** 2026-08-28 → 08-29 · **Status:** RULED (operator: "go with option 2") + EXECUTED

Operator ruling: a Meet item **points at** a meeting rather than **being** a time
block. His own case decided it — *"the RSVP if it is for responding to"* is a
meeting that is not on your calendar, so there is no block for it to be.

- **DEC-063** (`9205d56d`) — six manifest columns (start, duration, join URL,
  location, attendees, RSVP). `meet_start_at` is deliberately NOT `due_at`: a
  meeting's start is not a deadline, and collapsing them would drop every
  invitation into the overdue radar. Rows render as invitations — time, a Join
  button labelled by provider read from the link, address, attendee count, and
  the RSVP inline. Guarded by `isInvite`: a bare "meet with Sam" stays a plain row.
- **DEC-064** (`48e5f8f3`) — the capture flow, and **the manifest gap it
  uncovered**: `PATCHABLE` and `rowToNode` both hand-listed the manifest, so a
  new column got DDL, sync, CRDT allowlists and emit — but no way in or out.
  `source_url` had been **write-only since DEC-052**. Both now derive from
  `WORK_ITEM_COLUMNS`, with an explicit `NOT_PATCHABLE` refusal list that must
  state its reasons.
- **DEC-068** (`ac8dcd0c`) — the calendar link. `TimeBlock.taskId` already
  pointed at a node, so the association needed nothing new; the translation is
  `meetSchedule.ts`. Refuses rather than guesses (no start time → nothing to
  reserve), and matches "already scheduled" on the LINK, never the time.

---

## DEC-065 — The item editor fits the screen it opens on
**Date:** 2026-08-29 · **Status:** EXECUTED (`a590ce86`)

Regression from DEC-064: the dialog was pinned 14vh from the top with no height
cap, so a Meet item ran **172px past the bottom** of a 997px laptop viewport with
Save unreachable. Centring alone could not fix it — content was taller than the
screen — so Join link and Location were paired onto one row and Notes trimmed.
1029px → 924px. The max-height with internal scroll is the FLOOR beneath the
sizing, not the fix: content that cannot be reached is worse than content that
scrolls.

---

## DEC-069/070 — The re-baseline: one animated group, one dashed connector
**Date:** 2026-08-29 · **Status:** RULED (operator called the reset) + EXECUTED (`72cd7199`)

Operator, after four rounds: *"this colored vertical / horizontal line thing is
really starting to piss me off… we need to refresh and reset to get this down
right from the beginning"* — with an inspiration component supplied.

**The re-baseline.** A parent and its subtree are now ONE animated group holding
ONE dashed connector spanning it. A single element has no joins to misalign, so
the seam category is gone *by construction rather than by care*, and because the
connector lives inside the height-animated wrapper it grows and shrinks WITH the
expansion.

What it bought beyond the bug: `nestRows()` turns the flat depth list into a tree
once instead of every consumer re-deriving it; the box's `divide-y` now separates
UNITS so a hairline never cuts through a subtree; desk clusters get the same
connector language as subtasks (one grammar for "these belong together"); the
solid queue spine became a TOP-LEVEL cue only, since an indented row's colour cue
is its group's connector and having both put two vertical lines beside every
sub-item. Motion: height 0 ↔ auto, staggered children, `AnimatePresence` so a
collapse animates rather than snaps, `prefers-reduced-motion` honoured.

Also fixed the drag handle, which floated at the INDENT column — a coordinate
belonging to the previous depth — so on sub-items it hung in the parent's gutter.

**The pins now assert the ABSENCE of the segment machinery**, so nobody
reintroduces it.

**LIVE VERIFICATION 2026-08-30 (the owed photograph, done by measurement):**
the prior session shipped this pinned-and-tested but never saw it on a
multi-sub-item case — none was mounted (cause found: the one real group was
COLLAPSED, persisted in `attention.collapsed`). Verified on the operator's
live data over CDP 9223 — a real leader ("Add in-browser video streaming…")
with THREE open sub-items, expanded via its own chevron (the DEC-062
click-fix path), all geometry by getBoundingClientRect/getComputedStyle at
dpr 1.7, full-viewport screenshot only:
· ONE dashed connector per group — a single element, h=114px spanning all
  three 40px child rows; inset 14.0px (= 8 + ind·28 + 6 exact); top gap 0.0;
  bottom gap 6.0px (bottom-1.5); rgba(14,165,233,0.5) = queueTint(to_do, .5).
· Children tile the wrapper exactly (718.3→838.3, zero gaps), borderTop 0px
  on every child — no hairline cuts the subtree; the next UNIT gets the
  divide-y hairline (0.588px = 1px @ dpr 1.7). Child pads 36px (= 8+28).
· Spine is TOP-LEVEL only: leader carries the 3px sky bar (2.996px computed
  — device-pixel snap), children carry none.
· Drag handle rides its own row's depth: children 14px (= 8+28−22, ON the
  connector line by design), leader 2px. Zero stray vertical-line elements
  in the subtree — the old segment machinery is absent from the DOM, not
  just the code.
· Collapse unmounts children + wrapper (AnimatePresence exit), re-expand
  reproduces identical geometry (inset 14, h 114 both passes) — no drift.
· The DESK-CLUSTER variant (LakeDash, 3 rows) measured too: same grammar —
  one connector, h=135.3px unbroken across the run, 6px bottom inset, pads
  36px, no spines, zero strays. A 0.6px inter-row offset there is
  device-pixel rounding of fractional row heights (nothing paints in it:
  borders and margins all 0px), not a seam.
No data writes; the one state change is the group now sits EXPANDED on the
operator's screen (the toggle path updated `attention.collapsed`), which is
what the verification required. DEC-069/070's construction claim holds on
the real thing.

---

## DEC-071 — The day plan is reviewable before it is accepted
**Date:** 2026-08-29 · **Status:** EXECUTED (`4dc603de`)

Three failures in one flow, all the same shape: the plan had the information and
nowhere to put it.

The intent prompt was a single-line `<input>`, so a real sentence scrolled out of
sight while being written — now a textarea that grows and shrinks, capped at ~7
lines, Enter plans / Shift+Enter newlines. The summary line truncated, which made
it *an assurance wearing the clothes of an explanation*. And the ghosts on the
grid are not real blocks, so the plan was un-inspectable **by construction** — a
proposal you cannot examine is a prompt to trust it.

A landed plan now opens a centre-peek review (DEC-065's shape) showing the prompt
in full, the note in full, and every block grouped by day with time, duration and
**the `reason` the planner had computed all along and never displayed**. Blocks
can be dropped individually; accept takes what remains, still ONE undo batch.
Opening it books nothing — DEC-052's propose-never-apply stance holds.

Also: the note's `slice(0, 120)` was a DISPLAY limit at the DATA layer, cutting
mid-word ("…Cetra pitch deck—all high-cr"). Widened, word-boundary aware,
ellipsised, still bounded because it is model output.

---

## DEC-087 — Phase 1 of the demo-feedback plan: the three blockers
**Date:** 2026-08-30 · **Status:** EXECUTED · **Plan:** analysis/27

Caleb's demo surfaced 20 items; analysis/27 consolidates them into 12 threads
across 5 phases. Phase 1 is the three that made the demo stumble, and each
turned out to be one honest mechanism, not mystery:

**(a) The capture card ran off the screen.** `fb-card` had no height cap and
no internal scroll, so the Desk drawer + mention input rendered below the
viewport with nothing to grab. Now: `max-h-[76vh]` (the card already sits
16vh down; 86vh would overhang), header pinned, body scrolls
(`min-h-0 flex-1 overflow-y-auto overscroll-contain`).

**(b) "Plan my day" at 6pm reported a full day.** Two truths compounding:
`freeSlots` floors at *now* against a `dayStart..17:00` window, so an evening
plan has zero slots by construction — and intent mode picked *items* but
never the *day*, so "before noon tomorrow" still planned the viewed day. Two
pure functions in attentionPlanner: `parsePlanDay` (tomorrow/today/tonight/
weekday → local-midnight target; same-weekday means NEXT week) and
`effectivePlanDay` (a requested TODAY with no usable slot rolls to tomorrow).
CalendarView wires them into runPlan and SAYS what happened — "Today's
working window has closed — this plans tomorrow instead." — because a rolled
plan that pretends to be today's plan would be a lie with a calendar.

**(c) Editing a block duplicated it or grew it.** Three compounding causes,
measured: single click on a block did NOTHING (stopPropagation only), so
people clicked, got silence, clicked beside it — and the column's plain-click
booked a NEW slot. The 6px resize lips snapped ±15min off a ~7px slip
(`Math.round` over a 56px hour). And any 1px jitter counted as a drag. Now:
a 5px dead zone before ANY block drag engages (move and both resize modes —
below it the press stays a click); a drag that actually moved consumes the
click event that follows pointerup (`dragConsumedClickRef`); and a clean
single click routes through the SAME ladder as double-click (meeting/plain →
Book time dialog, work item → item editor, desk link → jump). Double-click
stays for habit.

Verified live over CDP (record in analysis/27): capture card capped at
exactly 76vh with the drawer reachable; a 22:19 Plan-my-day produced
tomorrow's proposals with the honest note; scratch-block matrix — click
opens editor, 3px slip moves nothing and still opens it, 56px drag moves
60min and opens nothing, lip wobble resizes nothing. 13 new pins in
tests/unit/dec087DemoFixes.test.ts; 3,347 green; scratch blocks deleted.

Also this round: a stray `npx prettier --write` reformatted CaptureConsole to
prettier defaults (double quotes/semis — not house style; the repo has no
prettier config). Caught by diff size, reverted, re-applied by hand. Rule
absorbed: no formatter passes in this repo, the house style is the file.

## DEC-088 — Phase 2 of the demo-feedback plan: the People workstream
**Date:** 2026-08-30 · **Status:** EXECUTED · **Plan:** analysis/27 (#2 #3 #4 #6 #12)

The demo's people complaints were one decision wearing four costumes: the @
field lived inside the Desk drawer, so people looked buried, missing, and
inconsistent all at once. Three builds, one workstream:

**PEOPLE is its own pill.** The confirm stop now has five dimensions —
CATEGORY / URGENCY / WHEN / PEOPLE / DESK, who before where. The People
drawer asks "Who is this about or with?", offers the org directory as
one-click chips (filter appears past six), shows the item's person mentions
as removable chips, and states the honest boundary in place: *"A mention
keeps the person with the item — it doesn't send them anything yet."*
Routing TO a person remains SPEC-027; nothing here pretends otherwise. The
Desk drawer keeps the full DEC-039 @ grammar (one input, grammar never
forks) — person chips render in both because the state is one array.

**Capture text seeds mentions — directory-grounded, deterministic.** New
`src/main/ai/peopleExtract.ts`: full names, then handles, then single
names, word-boundary matched against the directory the app genuinely
loaded (peopleDirectory's honesty contract: empty directory extracts
nobody, ever). Names that are also English words ("Will", "Mark", "Grace")
match only in their capitalized form, so "will follow up" never becomes a
person — and every suggestion arrives accent-marked at the confirm stop,
which is the real safety net. `classifyCapture` carries the scan on all
three paths (rules/model/fallback) at zero model cost; marked captures —
which skip the classifier by design — get a dedicated `workItems:scanPeople`
IPC, so a highlighted "Caleb needs to…" also arrives pre-mentioned. Self is
filtered renderer-side by account email (a mention of yourself is noise).
The directory prefetches when capture opens (attempted-guarded, never
awaited): a cold first capture may honestly offer nobody — capture never
waits (R011).

**Ambiguity is the question, not a guess.** Two Calebs and a bare "caleb"
produce NO mention and ONE clarify: the People drawer auto-opens asking
"Which Caleb?" with both candidates (handle as the hint). A full name binds
its person and SATISFIES later bare references — "Caleb Swan… remind
caleb…" never silently binds the other Caleb. One clarify max, and the
deadline question still outranks it at auto-open (DEC-016: one question) —
outranked, the lit pill carries it until opened. This is demo item #4 — the
one-off "Is this Caleb from your workspace?" behavior — made a system.

Boundary noted: meeting-WRAPUP proposals (the transcribe→deliverables
pipeline) don't ride this yet — that surface is Phase 4's transcript
rebuild, gated on the operator's go, and gets mention-wiring there.

Verified live over CDP after a full restart (main-process round): five
pills render; empty-directory drawer shows the honest "Nobody to offer" +
boundary line; with a scratch directory published-then-reset — "ask
michael…" filed the card with PEOPLE = Michael Roe in accent; "ask
caleb…" auto-opened the drawer with both Calebs, picking Swan set the pill
and killed the accent; "Caleb Swan owns this; remind caleb monday"
suggested Swan alone. 20 new tests (extraction matrix + wiring pins); one
DEC-084 four-pill pin rewritten to five with history; 3,367 green; both
typechecks clean.

## DEC-089 — The plan review is a workbench; widget chrome survives dark mode
**Date:** 2026-08-30 · **Status:** EXECUTED · **Trigger:** operator live QA off
the DEC-087 review sheet + the dark-mode desk

**(A) The review sheet stopped being read-only.** The operator's ask: move
things, change times, change lengths — without leaving the approval moment.
Three additions, one honest rule each:

- **Drag to reorder** — whole row is the drag surface (the Attention queues'
  grammar, DEC-077). The SLOT LADDER HOLDS: the times the planner found (plus
  any hand edits) keep their positions; items reassign over them, each
  keeping its own duration (`reorderOverSlots`, pure, in attentionPlanner).
  Dragging never invents new times.
- **Inline when/duration** — click the time range → date + time inputs in
  place (focus leaving both commits); click the duration → minutes input
  (Enter/blur commits, snapped to 5). Accept books exactly what the rows say.
- **Overlap warnings, not auto-fixes** — a longer item in a tighter slot, or
  a hand-set time over an existing block, shows "Overlaps another block" on
  every row involved. The sheet never silently reflows the day; the
  operator's own edits are the repair tool.

Rows carry client uids (itemId repeats on session splits; startMs is mutable
now) — dropProposal and the editors key on them. Live-verified over CDP: 11
draggable rows; duration 30→45 in place; start 9:00→8:00 in place; dragging
row 3 before row 1 gave it the FIRST slot (the edited 8:00) with everything
else stepping down one slot, times unmoved; a 240-min row lit 5 overlap
warnings; Discard booked nothing.

**(B) Widget chrome in dark mode.** The bell and completion circle weren't
low-contrast by accident — the header wash under them was `bg-stone-200/70`
(and 25 siblings), light-only, so dark mode floated LIGHT ink on a LIGHT
wash. Every header wash now carries a dark companion (26 call sites + the
default; hue identity kept — violet stays violet). The resting frame edge
gets a real 1px `--edge-firm` border in dark (the 9%-white hairline melts
into the canvas); the idle bell drops its extra dimming (ink-50 @ 80%).
Measured on a live desk: header rgba(255,255,255,0.09) / violet 0.25, bell
ink-50 @ 0.8, frame edge white 19%.

**Found while measuring: GAP-019.** Two widget headers (Table, MindMap) had
NO wash at all — `bg-[var(--edge-firm)]/60` is invalid CSS (an opacity
modifier on an opaque var() token) and paints NOTHING, both themes. Fixed
those two under this round; the ~40-site repo-wide disease is filed as
GAP-019 with live paint-probe evidence, its own sweep round. The DEC-089
lock already forbids the pattern in headerAccent, and the four-pill→
five-pill DEC-084 pin got its history note last round.

13 new tests (reorder math + editability pins + the two-clause chrome lock);
3,380 green; both typechecks clean.

## DEC-090 — The plan intent stops hallucinating and learns to tell time
**Date:** 2026-08-30 · **Status:** EXECUTED · **Trigger:** operator live QA
("cetra partners, first half of tomorrow" pulled random items; "later in the
day" packed the morning)

**The hallucination had a mechanism, not a mystery.** planSelect's model was
already told an empty selection was valid — but the CODE overrode an empty
answer with the keyword fallback (`if (!ids.length) return fallback()`), and
the fallback's stopword list was so thin that scaffolding words ("items",
"open", "related", "first", "half") matched dozens of unrelated items. The
model said "no Cetra items are open"; the code replaced that honesty with
noise and confidently scheduled it. Three fixes:

- An EMPTY model selection now SURVIVES — only a FAILED call falls back.
- The stopword list grew planner scaffolding + all time language, and moved
  to `src/shared/planLanguage.ts` (ONE list, shared with the renderer's
  topic detector, or the two drift).
- The zero lands as the operator ruled it: the model's own note ("No items
  found related to Cetra Partners…") plus a one-click offer — **Plan the
  rest of the day instead** — rather than the intent silently doing that
  anyway. The offer plans the full queue and does NOT echo the no-match ask
  above unrelated blocks.

**Time language now goes somewhere.** Two deterministic parsers join
DEC-087's parsePlanDay: `parsePlanWindow` ("first half", "before noon",
"later in the day", "after 2pm", "between 2 and 4", morning/afternoon/
evening — each with a speakable label folded into the note) narrows the
slot window by overriding dayStart/dayEnd for that plan; `parsePlanSpread`
("across/throughout the week", "over the next few days") switches to
`planSpread`, which plans up to five WORKDAYS (weekends skipped, each item
placed once, stops when the queue is exhausted). effectivePlanDay now runs
against the WINDOWED settings, so "this evening" at 6pm keeps today instead
of rolling to tomorrow.

**Topic-less intents never reach the model.** "spread my open items across
the week during work hours" names no topic — every token is scheduling
language. `intentNamesTopic` routes such intents straight to the full queue
deterministically; live QA showed even the sharpened prompt could misread
"my open items" as a topic search and return zero. Selection is only paid
for — and can only come back empty — when a topic is actually named.

Live-verified across two restarts: the Cetra intent → 0 rows, the model's
own note, the offer; the offer → the full 11-block plan; "fantasy football
league work, later in the day tomorrow" → 4 fantasy items starting 2:00 PM
(not 9:00); "spread my open items across the week" → 21 blocks over Monday
+ Tuesday, day-grouped, "Spreading across the week." noted. 16 new tests
(window/spread/topic matrices, the operator's verbatim failing intent
selecting nothing, honest-empty pins); six DEC-052/087 pins rewritten to
the superseding truth with history; 3,396 green; both typechecks clean.

## DEC-091 — Phase 3 of the demo-feedback plan: context fidelity
**Date:** 2026-08-31 · **Status:** EXECUTED · **Plan:** analysis/27 (#7 #11 #14)

**(#7) A mark freezes the page it was made on.** `source_url` had been in the
schema since DEC-052 and written by NOTHING (DEC-064 fixed the read side and
noted it was write-only). Now both mark dispatchers — the widget bell and
the right-click / highlight menu — freeze the browser widget's live URL
onto the item at mark time (`browserMarkUrl`: only webview/browser kinds,
only real http(s); a browser's `content` IS its current URL via
persistNavUrl). The item then deep-links back: a queue-row action ("Open
the source page") and a Source row in the item editor, both through
`files:openExternal` — because the WIDGET may have browsed away since, and
the frozen URL has not. This is the Slack-thread gap: mark a message view,
and the item carries the exact page, not just the widget. Verified live on
the 759 desk: the bell froze `sleeper.com/leagues/…/team` into the mark
event; a scratch item's URL survived write→readback; queue + editor both
rendered the link. (Follow-up noted, not built: "Open it here" could also
re-navigate the widget to the frozen URL.)

**(#14) Created documents announce themselves.** New house primitive: the
NOTICE toast (stores/notice.ts + NoticeToast.tsx) — asserts a fact, offers
a door, leaves. Deliberately not the UndoToast (reverses things) nor the
CompletionToast (awaits a decision); bottom-right, steps above the
completion offer when both are up, never takes focus. All four document
success paths (create-blank, widget-fill, to-Files, desk-widget) raise
"Created/Filled {kind} “{title}”" with Open → goDocument. A DEV-only drive
seam (fb:dev-notice, the __plexiiProposeBlock precedent) makes it
verifiable without a model call.

**(#11) Mail: the recipient stop and the sent fact.** The first Send now
ARMS: a strip states every recipient in full (to/cc/bcc) and the button
becomes "Confirm send"; the second press sends. Editing ANY field disarms.
Mail has no undo — the honest moment to catch a wrong address is before
the wire. On success the dialog no longer just vanishes: the notice states
"Sent to …" (with the cc/bcc count); failure says "nothing left your
mailbox". The AI compose path was already draft-only (unchanged). Verified
live without sending: arm → strip named probe@example.com + "Confirm
send"; a focus-asserted edit disarmed both; Discard sent nothing. (The
first disarm probe failed its focus assertion — the armed strip re-centres
the modal and stale coordinates missed the field; the DEC-084 abort rule
caught it, coordinates re-measured, verified clean.)

13 new tests; 3,409 green; both typechecks clean. Renderer-only round (the
preload change is type-level) — no restart was needed.

## DEC-092 — The planner learns the calendar it is writing into
**Date:** 2026-08-31 · **Status:** EXECUTED · **Trigger:** operator live QA
(a replan crammed items against existing blocks; "reschedule my day, split
between tomorrow and wednesday" answered "No open items match that"; the ii
mark floated high in the intent bar)

**Breathing room is now the calendar's, not just the plan's.** freeSlots
padded NOTHING around existing blocks — a slot began the instant a block
ended, which is exactly the cramming in the operator's screenshot. Every
planned block now carries the house gap on BOTH sides, and an actual
MEETING (a block with a meeting payload) carries `meetingBufferMin`
(default 15, adjustable in the planner popover, floor-ed at the gap so
"off" never gives a meeting less room than a plain block). Done blocks get
no padding — history needs no breathing room. When a target day holds
meetings, the plan note says "Kept 15 min clear around your meetings."

**Placement stopped being first-fit.** Each item now scores every open
interval: an earliness prior keeps days front-loaded, and NEIGHBOR AFFINITY
pulls related work together — the existing block bordering a slot (or the
proposal just placed in it) scores by `relatedness` (same desk 3, shared
tag 2, shared mention 2, same class 1). The after-border only counts by
PROXIMITY (landing at the start of a three-hour slot is not "beside" the
block at its far end — the first test caught exactly that flaw).
Discretionary pool items also CLUSTER (`chainRelated`): one desk-mate may
be pulled forward after each head, but never across an item due by day's
end — deadline-first is a promise; the rest is preference. When affinity
places something, the reason SAYS so: "Grouped beside “…”." — live QA
showed a 759-desk item landing right after the done 759 block, labelled.

**"Reschedule my day" is a MOVE, not a topic search.** The operator's
verbatim prompt reached the selection model, which honestly found no "day
off" items and answered nothing. A new route runs FIRST: `parseReschedule`
(a move verb + a reference to today) + `parsePlanDays` (EVERY named day —
"between tomorrow and wednesday" is two) → `movableToday` (future, planned,
item-linked; meetings and pinned blocks are untouchable by construction) →
`planSplit` (round-robin across the named days, then per-day planDay with
all buffers and affinity). The review states the contract: "Moving N of
today's blocks — tomorrow + Wednesday. Accepting removes them from today."
plus who stays and what didn't fit. Accept books the new blocks AND removes
the sources in ONE undo batch; a dropped row keeps its old block — nothing
is ever silently unscheduled (a source block whose item got no proposal
stays put). Live QA found the empty-reschedule trap: passing `placedIds`
excluded the very items being moved (scheduled today by definition) —
fixed and pinned.

**On the operator's "call a more powerful model if needed":** placement
stays deterministic on purpose. The observed failure was mechanical
first-fit, not a knowledge gap — a scoring rule is instant, testable, and
explains itself in the reasons, where a model placement is none of those.
The selection step already routes through modelRouting and can be upgraded
per-purpose if selection quality ever lags; placement earns a model only
if a failure appears that rules cannot express.

Also: the ii mark in the intent bar now centres on the textarea's first
line (measured 0.1px off; was ~6px high — items-start is deliberate for
the growable field, the mark just needed the first-line offset).

Verified live: the verbatim day-off prompt → 3 blocks split Tue + Wed with
the honest note and leftover count, discarded clean; affinity grouping
visible in a real reason. 19 new tests; three DEC-052-era pins rewritten
to the padded truth with history; 3,428 green; both typechecks clean.

## DEC-093 — Deadline chips drag onto the grid
**Date:** 2026-08-31 · **Status:** EXECUTED · **Trigger:** operator live QA
("the items that live above the time slots aren't able to be moved, but I
should be able to drag those onto my calendar")

The deadline band (DEC-052) rendered due items above the grid as click /
double-click affordances only — the one thing you'd reach for, dragging a
deadline into a time slot, was the one thing it refused. The receiving half
already existed: day columns have accepted `text/fb-workitem` drops from the
queue rail since DEC-052, booking a 30-minute linked block on the spot (the
drag is the decision; undo covers regret). So this is one payload and one
drop handler with a second source — not a new mechanism.

The chip keeps its click (open Attention) and double-click (details); its
title now teaches all three gestures. Deliberately NOT firing
`onBlockDragActive`: that rings the queue rail as an UNSCHEDULE target
(DEC-053), which would be a lie for an item that has no block yet.

The chip STAYS after the drop — it marks the due date, which booking time
does not move. (A "this is now scheduled" mark on the band is a separate
question; the new block appearing under the pointer is its own feedback.)

Also: the hour scroller now autoscrolls at its edges during a work-item
drag. The band sits above a window showing about half a day, so without it
you could only drop onto hours that happened to be in view — the feature
would have been half-usable. 56px edge zones, speed scaled by depth.

Verified live: a `[TEST]` LakeDash chip carried the payload, the drop
created one linked 30-minute block (14 → 15), and the probe's block was
deleted after. 5 new pins; 3,433 green; both typechecks clean.

## DEC-094 — The plan review joins the family
**Date:** 2026-08-31 · **Status:** EXECUTED · **Scope:** presentation only,
by operator ruling

The operator sent a full redesign spec (native-picker replacement, a
computed cascade with pinning, locked already-booked rows, a capacity line
from velocity history, a keyboard map) and then cut it back: *"forget all
that back-end stuff… anything that contradicts what currently exists takes
preference to the way it's currently built so you don't risk side effects.
Just change the visual interface."* So: every handler, every model and every
behaviour from DEC-071/089/092 is byte-for-byte intact. Nothing was added
that needed data the dialog doesn't already hold.

What changed is what it looks like:

- **Header** — the mark sits in an accent tile (this dialog is Plexii
  speaking); the title carries real weight; the subtitle speaks in hours
  ("25 blocks · 12h 30m across 3 days") instead of raw minutes, naming the
  day span only when there is one. DEC-071's promise sentence is unchanged.
- **Prompt echo** — the labelled grey block became one quiet italic quoted
  line. The requirement it existed for (the prompt is shown, in full, beside
  the plan it produced) is unchanged.
- **The planner note** — now an accent-tinted panel with an info mark, so it
  reads as a note rather than as body copy.
- **Rows** — ONE start time in a fixed 82px tabular column (the range said
  one fact twice and wrapped; the end time moved to the tooltip). The title
  takes the weight. Duration became a real chip. An overlap became an amber
  "overlaps" chip instead of a sentence competing with the reason.
- **Gap rules** — the empty time between consecutive rows, which the list
  hid completely, is now a thin rule carrying the span; 30m+ reads "open" in
  stronger ink. Computed from data that was already there.
- **Day headers** — a hairline rule with the day's total as a span.
- **Footer** — its own rule, a quiet two-line hint, a de-emphasised Discard,
  and "Accept plan ↵" as an unmistakably primary button.
- **Native pickers stay** (spec wanted them replaced; replacing them is new
  interaction code and would have removed arbitrary-duration typing). They
  now wear `accent-color`, so the OS chrome picks up the brand.

Found while looking at the result: DEC-092's affinity note concatenated bare
onto the lateness clause ("Due Saturday Grouped beside “…") and clipped
mid-word inside its quotes. Separated with a middot and clipped on a word
boundary (`clipTitle`) — a copy defect the polish made visible.

Two DEC-071 pins rewritten to the superseding presentation with history.
15 new pins (including a behaviour-untouched clause listing every DEC-089
control); 3,448 green; both typechecks clean.

## DEC-095 — The Attention analytics band, made of material
**Date:** 2026-08-31 · **Status:** EXECUTED · **Scope:** presentation only

Same ruling as DEC-094: the numbers, the filters and every handler are
untouched; this is what they look like. The KPI tiles were flat swatches —
a single flat tint, no edge, no depth, and nothing at all on hover.

The house recipe, now in globals.css as `.fb-kpi-tile`: a tone-tinted
gradient (160°), a hairline ring in the same tone, the shared
`--shadow-inset-highlight` every fb-card uses, and a gloss sweep across the
top 42% — theme-aware (28% white in light, 7% in dark), pointer-events off,
and painted UNDER the content by z-order. Hover lifts 2px and deepens the
tint and ring; active settles back; `prefers-reduced-motion` drops both.
The selected state (DEC-049 — a tile is also the queue filter) closes the
ring to 1.5px and holds the tint at hover strength, so "this one is on"
reads without hovering it, and its label takes the tone.

The tone rides in as `--kpi-tone`, a SPACE-separated RGB triplet via a new
`toneTriplet()` — the `rgb(var(--x) / a)` form is the only one that survives
an alpha modifier (GAP-018/019: a comma triplet or a complete colour there
paints nothing). `queueTint` is untouched and still serves the inline fills.

Also: the 14-day sparkline gained rounded caps and a vertical gradient, and
its EMPTY days now read as absent (a neutral stub) instead of a sliver of
the same success green. The status bars sit in a recessed track with a
highlight on each segment. The "Breakdown" toggle became a chip that turns
accent when open, rather than loose caption text.

**Found while measuring: GAP-020.** `--ink-80` (52 uses), `--ink-45`,
`--ink-55`, `--ink-35`, `--ink-25` and `--ink-300` are referenced but never
defined — the declaration is invalid, so those elements silently inherit
their parent's colour (paint-probed live: `var(--ink-80)` resolves to
ink-100). Defining or rewriting them changes text colour in ~68 places at
once, so it is its own round; two fixes I had already made outside this
component were REVERTED to keep that diff whole. `accentColorLock` now
freezes the offender set — it may shrink, a new one fails the build.

11 new pins; 3,460 green; both typechecks clean.

## DEC-096 — GAP-020 swept: the ink scale is whole
**Date:** 2026-08-31 · **Status:** EXECUTED · **Closes:** GAP-020

Define, don't rewrite: the ~60 sites referencing `--ink-80/55/45/35/25`
all WANTED an in-between step — the authors were writing against a scale
they assumed existed. So the five steps now exist, in all three themes
(:root, .dark, .atelier), each the midpoint of its neighbours on that
theme's own scale. The visible change is the intended one: text that had
been silently inheriting its parent's colour (usually full ink-100) now
renders at the weight its author chose — including DEC-094's own prompt
echo, which had been quietly using undefined `--ink-55`. ink-35/ink-25
inherit ink-30's documented caveat (decorative-leaning, not body text).

The `--ink-300` sites (8, across ExternalMdEditorView and AgenticOpsView)
were Tailwind gray-300 muscle memory meaning "muted secondary" — rewritten
to `--ink-60`, the house token for exactly that.

The lock (accentColorLock.test.ts) is strict again: any undefined ink step
anywhere fails the build, and a second clause requires every theme block to
carry the full 13-step scale — a NEW theme cannot ship a partial one.

Verified live across all three themes by computed-style probe: every step
resolves; `var(--ink-80)` paints 79% in dark (its own step) where it used
to paint 96% (inherited ink-100). 3,461 green; both typechecks clean.

## DEC-097 — GAP-019 swept: every wash finally paints
**Date:** 2026-09-01 · **Status:** EXECUTED · **Closes:** GAP-019 ·
**Branch:** ryan-next (first round on the new branch)

The register said each site needed a judgment call. It didn't — the right
fix made the judgment unnecessary: `[var(--x)]/N` rewrote mechanically to
`[color-mix(in_oklab,var(--x)_N%,transparent)]`, which is the SAME token at
the SAME opacity the author wrote, as valid CSS. No site's intended look
was re-decided; the intended look simply started rendering. 117
occurrences, 57 files, every property prefix (bg/border/divide/via, plus
hover: and group-hover: variants), one regex.

The census had said ~40 sites — the real count was 117. Translucent panel
washes, hover states, frosted `backdrop-blur` cards whose tint never
painted behind the blur, a scrim gradient's mid-stop: all silently
transparent in both themes, some likely since they were written.

Verified live after HMR: 34 color-mix rules generated; 17 elements on the
current screen, all painting; and the definitive pair — a probe div wearing
the OLD class computes `rgba(0, 0, 0, 0)` while the NEW class computes
`oklab(0.145 … / 0.6)`. The oklab mix space keeps the token's perceived
hue and lightness on the way to transparent.

Locked repo-wide beside its siblings in accentColorLock.test.ts (GAP-018
accent forms, GAP-020 ink steps, now GAP-019 var()+modifier): any
slash-modified var() token anywhere in renderer source fails the build.
The edges-codemod FIXTURE keeps one deliberately (it is sample input to an
AST scanner, not app source) — the lock scopes to src. One DEC-089 pin
rewritten to the superseding hover-wash form with history.

3,462 green; both typechecks clean. All three paint-integrity gaps are now
closed: the accent family (GAP-018/DEC-086), the wash family
(GAP-019/DEC-097), the ink scale (GAP-020/DEC-096).

## DEC-098 — M1: the Stage, honest consent, per-track capture
**Date:** 2026-09-01 · **Status:** EXECUTED · **Plan:** analysis/28 (SPEC-003)
· **Branch:** ryan-next

The first Meet phase, and the one that fixes a live liability. Three builds:

**Consent (S3-DEC-024).** Recording had TWO silent-start paths: any
participant's toggle captured every stream with nobody told, and a saved
preference started capture at join. Both are gone. Starting a recording now
prompts every participant over the existing meetingSignal relay (zero
server changes): accept / accept-without-transcript / decline. Until
someone answers they are 'pending' and not a sample of theirs is captured;
a decline is honoured BY CONSTRUCTION (their stream is never tapped — the
recorder's tap() is the single choke point, gated on `mayCapture`). The
header names the state in words, continuously, in both layouts —
"Recording · 1 of 3 consented — Dana has not responded" — never an icon
alone. Late joiners are prompted before capture; the initiator alone stops
it; the initiator leaving stops it for everyone, said out loud. The
whisper preference no longer touches meetings (it still governs 1:1
PlexiCam calls — the SAME consent hole exists there and is a named
follow-up; the consent lib was built reusable for it).

**Per-track capture (C1, operator-ruled foundation).** "I do not want AI
guessing at speaker 1 versus 4." It never will again for native meetings:
MeetingTrackRecorder records one attributed, audio-only take per consented
participant on one shared clock, alongside the mixed blob that still feeds
the legacy wrap-up. Attribution is exact by construction — each take IS a
known accountId. M2 transcribes the tracks; the mixed blob then becomes a
convenience artifact.

**The Stage (SPEC-003 §3.3).** A notepad, not a transcript viewer, grafted
into MeetingOverlay's stage layout (C9 — no fourth surface): blank by
default, your words verbatim and never rewritten, ⌘⇧M marks a moment
(clock offsets — no recording and no model required; they resolve into
transcript anchors in M2), ⌘⇧T answers honestly ("the transcript arrives
after the call"). Notes + moments survive every path: with a recording
they ride the wrap-up (saved FIRST, never gated on transcription
succeeding); without one they are still saved as the meeting's record —
notes-first, recording-optional.

Verified live via the store's e2e handle (a real two-party handshake needs
the operator's two-machine QA session — flagged): the Stage renders with
the notes pane open; typed notes land verbatim in the store; a REAL ⌘⇧M
keystroke marked a moment and ⌘⇧T toggled the honest line; the worded
header rendered "Recording · 1 of 2 consented — Sam Oak has not
responded" from a mixed consent map; the decline button wrote 'declined'
under the operator's real accountId. Driving quirk for the record:
synthetic clicks don't transfer element focus while the Electron window is
unfocused — Page.bringToFront + asserted programmatic focus is the
pattern (the DEC-084 rule's substance, an asserted focused target, held
throughout). A missed-triage dialog (z-330) over the meeting overlay
(z-200) intercepted the first probe — real data, not a defect chased now.

24 new tests (the consent decision table in full, wire-envelope kinds,
recorder degradation, choke-point and no-auto-start pins); 3,486 green;
both typechecks clean.

## DEC-099 — M2a: transcript truth
**Date:** 2026-09-01 · **Status:** EXECUTED · **Plan:** analysis/28 (SPEC-003
M2, first half) · **Branch:** ryan-next

The transcript stops being a string. Everything provenance promises later
(S3-DEC-021's heard-requires-anchor, moments, Recall citations) resolves
against what this round built:

**Both engines yield timestamps.** Cloud has requested `verbose_json` since
day one and the parser THREW THE SEGMENTS AWAY — they are now parsed, with
`exp(avg_logprob)` as the engine's own 0–1 confidence. Local flips
`return_timestamps: true` and parses the chunks; transformers.js exposes no
logprobs, so local confidence is an HONEST NULL — a fabricated confidence
is exactly the confidently-wrong sin the field teardown documents, and we
never invent one.

**The attributed pipeline (C1 pays off).** The wrap-up transcribes each
per-track take separately and merges on the shared clock
(`lib/transcriptMerge.ts`, pure and matrix-tested): interleaving is
arithmetic, not inference — attribution came from capture and stays exact.
A track whose engine gave text only degrades to one attributed span
(attribution survives even when in-track timing is lost). The summariser
now reads `[m:ss] Name: words` — real attribution replaces the old
"AI guesses Speaker 1–4 from prose" mode on this path. Speaker names are
resolved from the roster at leave time, before teardown erases it.

**Meeting audio never leaves the machine (CR-11, ruled).** The track path
pins the on-device engine (`forceLocal`) with NO cloud fallback — failing
honestly beats a silent second disclosure; the error says exactly that.
The meeting handoff marks even its legacy mixed-blob fallback
`forceLocalTranscription`. The local model warms when recording STARTS
(a bare `voice:preloadLocal` channel that never touches the provider
preference), so the ~80MB whisper-tiny download happens during the meeting,
not appended to its end. Calls (PlexiCam) keep the provider preference
until their own consent round — same boundary as DEC-098.

**The segments have a home.** `fb_transcript_segments` (speaker accountId
nullable for genuinely unattributed speech, start/end ms, text, confidence
REAL NULL), written atomically per meeting after the record exists, read
back sorted. Live round-trip on the real build: three drafts saved out of
order → read back clock-ordered with null confidence and null speaker
intact; atomic replace 3 → 1. The round-trip CAUGHT a real defect —
deleting a meeting orphaned its segments — fixed (explicit cascade in
deleteMeeting), pinned, and the stray row cleaned.

Ops note for the record: the first restart's app couldn't bind :9223 (an
orphaned Electron held it) and the probe talked to the OLD build — the
"preload functions undefined" symptom. Port-holder kill via lsof before
relaunch is now part of the restart ritual.

16 new tests; 3,502 green; both typechecks clean. M2b (the Record object,
three renderings, provenance CSS, meeting-node container, export,
retention) is next.

## DEC-100 — M2b: the Record — one object, three renderings
**Date:** 2026-09-01 · **Status:** EXECUTED · **Plan:** analysis/28 (SPEC-003
M2, second half) · **Branch:** ryan-next

**The Record object (§3.4).** `record_json` on fb_meetings: provenance-
tiered spans (`yours / heard / inferred`), each heard span carrying a
segmentId anchor. Built by the Enhance pass at wrap-up — best-effort and
NON-BLOCKING: a failed enhance leaves summary and deliverables intact and
the Record simply absent.

**The rule that makes the middle tier honest (S3-DEC-021), enforced in a
pure layer.** `lib/recordSpans.ts`: a heard span whose anchor does not
resolve to a real segment is DOWNGRADED to inferred, anchor nulled — the
tier can never be asserted, only proven. A model-forged `yours` is a
forgery, downgraded too: only `buildYoursSpans` mints yours, from the
user's notes, verbatim, byte-for-byte. The anchor's timestamp is always
taken from the SEGMENT, never trusted from the model. The Enhance prompt
states the contract in the model's own terms ("a heard claim without its
segmentId will be discarded as unproven") — and the FIRST live call
honoured it: four spans back, both heard ones carrying real segmentIds.

**Three renderings, Commitments default (S3-DEC-022).** A segmented
control (1/2/3, §3.10) in the meeting detail: Commitments (the existing
action items — owners and Attention routing arrive with M3's extractor),
Brief (yours leads at full ink; heard renders with a hairline left rule,
the timestamp on hover, and a click that jumps to the moment in Thread;
inferred in lighter ink — the same accent-vs-ink doctrine as capture, its
third tier), and Thread (the real segments: clock position, speaker, text,
with sub-50% engine confidence dimmed and every row carrying an honest
tooltip — "Engine confidence 31%" / "unknown (on-device)").

Verified live on the real build: record round-trip (3 spans); a REAL
Enhance call over scratch segments (contract held); Commitments default;
yours measured at ink-100, inferred at ink-50, heard's rule and hover
timestamp rendered; the heard click landed in Thread on the anchored
segment; the low-confidence row dimmed; scratch meeting deleted with its
segments (DEC-099's cascade doing its job).

Still open in M2 (M2c): the meeting-node container (C5), templates,
export, audio retention (CR-13). 12 new tests; 3,514 green; both
typechecks clean.

## DEC-101 — M2c: container, templates, export, retention — M2 complete
**Date:** 2026-09-01 · **Status:** EXECUTED · **Plan:** analysis/28 (SPEC-003
M2, final third) · **Branch:** ryan-next

**Retention (CR-13), exactly as ruled.** Meeting audio lives at
userData/meeting-audio/<meetingId>/ — per-speaker takes plus a take.json of
offsets — and NEVER leaves the machine. Modes 0/7/30/90/keep, default 30,
set from the Meet view. Zero means zero: the wrap-up skips the save call
entirely, so the takes die with renderer memory at the end of the Enhance
pass, not at a nightly sweep. The per-meeting "Keep" override is a flag
file; the boot sweep honours both it and keep-mode. A declined participant
has no take to save (DEC-098 never captured one). Deleting a meeting
deletes its audio — the same cascade rule as its segments.

**Export (Part V §6, the non-negotiable).** Markdown and JSON from the
meeting detail, through the OS save dialog. Provenance SURVIVES the file:
your notes lead, commitments are checkboxes, heard spans export as
timestamped quotes, inferred spans are marked "(inferred)", and the
transcript is the attributed segment list. JSON carries the full object —
meeting, record, segments, audio manifest. Audio itself is already open
files on disk; a Reveal button shows them in Finder rather than
re-encoding anything.

**Templates (§3.5).** The four ruled: Decisions & Actions (default),
Client Call, 1:1, Interview — a section-list registry, not a second
template mechanism. The wrap-up briefs under the default; the Brief view
offers one-click rebuilds under any of the four, and every rebuild
preserves the yours spans byte-for-byte — the user's words survive every
template. Commitments is never templated: its shape is the product.

**The container (S3-DEC-020), first honest increment.** A recorded MEETING
mints a desk node at wrap-up, holding the transcript document as a widget,
with desk_node_id on the meeting row and a "Desk" door in the detail
header. Calls stay lightweight; a failed desk never blocks the review. The
Record itself still renders in the Meet view — the Record WIDGET on the
desk is the remaining sliver of C5, deferred to ride with M3's sourceUrl
anchors rather than shipped as an empty shell now.

**And the preference finally tells the truth.** The old toggle said
"Transcribe & summarise my meetings" while DEC-098 had made meeting
recording consent-only — it now says what it governs (1:1 calls) and that
meetings never auto-record.

Verified live on the real build: the full audio lifecycle (two takes
saved with offsets, keep-flag flip, default 30, audio gone with the
meeting's delete); export surface present (the OS dialog needs a human
hand — honest limit of solo verification). 14 new tests; 3,528 green;
both typechecks clean. **M2 is complete** — M3 (routing into Attention)
is next.

## DEC-102 — M3: commitments route into Attention — the loop closes
**Date:** 2026-09-01 · **Status:** EXECUTED · **Plan:** analysis/28 (SPEC-003
M3, C6 C7) · **Branch:** ryan-next

**The extractor is anchored or it is honest.** `ai:extractCommitments`
(main/ai/extractCommitments.ts) reads the attributed segments and returns
commitments with a `segmentId` that must be verbatim-or-null — the prompt
says why in the model's face: an unanchored item "will be marked
unverified, which is honest; a wrong anchor is not." Owners come ONLY from
the meeting roster, deadlines only if someone said one, and zero
commitments is a valid answer. `validateCommitments` (lib/commitments.ts)
then enforces it in pure code: an unresolvable anchor downgrades to
inferred, `mine` = ownerless-or-self, and intent classes are canonicalised
with `to_do` as the floor.

**The confirm stop is the batch variant of the card we already trust.**
MeetingCommitmentsCard sits atop the wrap-up review (and behind "Find
commitments" on any past meeting): checkbox list, class chips that cycle
on click, due dates, and the header that states the contract — "nothing
files until you say so." Your own commitments start CHECKED; other-owned
start UNCHECKED with an amber "owner is X, not you" note, and filing one
attaches the owner as a person MENTION — never a send (C7, the SPEC-027
boundary). Anchored rows quote their line — `[m:ss] Speaker: "…"` behind
the heard rule; unanchored rows say so in words. Filed items land as one
undo batch: parentId = the meeting's desk node, sourceType 'meeting' +
sourceRef = the meeting id (DEC-079's chip route opens the meeting from
Attention), wiOrigin 'ai', confidence 0.95 anchored / 0.6 inferred.

**C6 split, as planned.** When commitments exist, create-task proposals
are filtered OFF the wrap-up's ProposalCards — commitments own tasks now;
artifact deliverables (docs, lists, links) stay on the cards. And the
host gets the **To Know brief** — a machine-authored to_know item titled
for the meeting, wiOrigin 'ai' (DEC-014-exempt by spec ruling); Q14's
per-series opt-in for other attendees stays deferred to M5.

**Live, on the real build:** a REAL extractCommitments call over scratch
segments honoured every clause first try — Dana's "I will send Doug the
revised contract by Friday" came back owner-attributed and anchored, the
group's March decision came back ownerless and anchored, and the
small-talk line was left alone. The Meet-view door rendered the card
("Plexii found 2 things in this meeting"), Dana's row defaulted
unchecked, "File 1 item" filed exactly the checked one — sourceType
'meeting', to_decide, wiOrigin 'ai', confidence 0.95 — and the scratch
item was dismissed (R008) and the meeting deleted clean, segments gone
with it. One honest sliver deferred: the filed item points at its MEETING
(sourceRef → the DEC-079 door); the per-item MOMENT anchor (jump straight
to the quoted segment from Attention) rides with the C5 Record-widget
round, where sourceUrl anchors get built once for both.

13 new tests (m3Routing); 3,541 green across 326 files; both typechecks
clean. **M3 is complete** — M4 (Recall, G2/G3 spikes first) is next on
the operator's go.

## DEC-103 — M4: Recall + the live transcript — the corpus pays out
**Date:** 2026-09-01 · **Status:** EXECUTED · **Plan:** analysis/28 (SPEC-003
P4 + C8's deferred half; G2/G3 spikes ruled first) · **Branch:** ryan-next

**The G2 spike reversed the plan's caution — with numbers.** analysis/28
budgeted for live decode being too expensive and Recall shipping alone.
Measured on this machine over REAL speech (a `say`-generated 19.3s clip,
16kHz mono, whisper-tiny through the repo's own @xenova/transformers):
batch RTF 0.09, and live-style 5s chunks at ~0.6s each — a ~15% duty cycle
of one core. Not ugly; live shipped. **G3 (MCP) ruled to its own round**,
as the plan allowed: no MCP server surface exists in the app, and one
means a transport + auth design (a GUI app can't speak stdio), not a
route on anything existing.

**Recall — the citation IS the answer.** fb_segments_fts (FTS5, the same
trigger-synced pattern as fb_chunks_fts, with a backfill for pre-M4 rows
at IPC-register time) mirrors the segment table WITHOUT flattening it:
where the chunk index cuts paragraphs, this keeps segment identity, so
every hit is a speaker + a timestamp + a door. Org-scoped through the
meetings join; an orphaned segment is not a citable answer; searches
degrade to [] rather than throwing through an ask (the chunkIndexActive
precedent). Three consumers:
- **The Meet view's search box** now answers from the corpus: "FROM THE
  TRANSCRIPTS" hits under the query, each an attributed line, and
  clicking one opens that meeting's Thread scrolled to the exact segment
  (fb:open-meeting learned an optional segmentId for the same trip).
  Pure FTS — no model call between the question and the quote.
- **The assistant grounds on what was said**: a meetings pool rides
  retrieveSources round-robin, its grounding text the attributed lines
  themselves, so the model cites who said it and when.
- **A meeting citation routes**: sourceTarget 'meeting' → PlexiMeet via
  the DEC-079 door, with its own trace identity (video_call, office tone).

**The live transcript — ⌘⇧T finally shows the words.** A ScriptProcessor
PCM tap rides the recorder's OWN taps — consent is inherited, not
re-decided: processors exist only on taps, and taps exist only for
participants the M1 choke point allowed. Cost is view-driven: the tap
attaches when the initiator opens the pane and detaches when it closes or
the recording ends — nothing decodes while nobody watches. Chunks decode
serially in main (whisper-tiny, 16kHz, linear resample); a backlog SHEDS
the oldest chunk rather than lagging — the pane is a courtesy, the
wrap-up's per-track pass writes the Record. Every branch of the pane is
honest: idle says nothing is being recorded; a non-initiator is told only
the recording machine hears the room; live is labelled "rough and local".

Verified live on the real build: searchSegments ranked Dana's
countersignature line first with full attribution and left the small talk
alone; the typed query rendered both Recall hits and clicking one landed
the Thread scrolled to the exact segment, visible in-viewport; a silence
chunk through voice:transcribeLive came back ok-and-empty (the honest
decode); deleting the meeting swept its FTS rows through the trigger
cascade. Not driven live: a full grounded ask citing a meeting (the pool
is pinned + unit-proven over real FTS5) and the in-call speak→pane loop
(needs a real mic in a real room — rides the operator's two-machine QA).

26 new tests (m4Recall real-FTS5 + m4Live); 3,567 green across 328 files;
both typechecks clean. One M1 pin rewritten to the pane's new truth (the
static "arrives after the call" note became three honest branches). **M4
is complete** — M5 (Prep + series) next on the operator's go; MCP is a
named follow-up round.

## DEC-104 — M5: Prep + series — the meeting remembers
**Date:** 2026-09-01 · **Status:** EXECUTED · **Plan:** analysis/28 (SPEC-003
P5, Q12/Q14) · **Branch:** ryan-next

**Series identity is a column, not a guess.** fb_meetings gained series_id
and block_id, stamped at wrap-up from the calendar origin (the Join button
on a booked block now sends blockId, seriesId, agenda and invitees along).
From there, everything M5 promises is an INDEXED LOOKUP: the previous
instance is the latest sibling row, and "carried from last time" is the
still-ACTIVE work_items that instance filed — M3's own output, read back.
External-calendar series matching stayed deferred by plan: title-matching
would fake a memory the store does not have.

**The staging (P5).** meetings:prep assembles pure database facts — agenda
from the booking, the previous instance, its still-open items, and each
attendee's open items (invitee email matched humbly against mention names;
a miss is a quiet miss). No model call builds prep. It renders in the
Stage's notes pane as a collapsible PREP section the moment a room joined
from a booked block opens: what to settle, what last time left open, what
is open with each person in the room.

**"Carried from last time" leads both ends (the crown jewel).** Atop the
wrap-up review — before even the confirm stop, because the room's first
question is "did we move?" — and atop the Record's Commitments view, with
the previous meeting named and dated. The one verb is Done: a carried item
resolved in the room is closed right there (house terminal state
'completed', one hover button).

**Q14, wired honestly.** meeting-series-prefs.json (the retention-pref
precedent) holds one knob per series: whether the wrap-up mints the host's
To Know brief. Default ON; the toggle lives on the series meeting itself
("Brief me after each meeting in this series"); the wrap-up asks before
minting. Briefs FOR OTHER ATTENDEES remain a named follow-up — they need
an out-of-room delivery channel (the meetingSignal relay dies with the
room, and the wrap-up finishes after everyone has left).

**Live verification caught a real bug.** The Done button first shipped
calling setState(id, 'done') — but the house terminal state is
'completed', and setWorkItemState REJECTS an unknown state by resolving
FALSE without throwing: the strikethrough stood over an item still open, a
false completion the catch-only handler could never see. Fixed ('completed',
and a false return now un-strikes the row) and pinned. The rest held
first try: series stamped through create; prep returned the previous
instance, the carried item, the Dana-by-email-local-part attendee match
(ghost invitee quietly missed) and the agenda; prefs defaulted on, turned
off, persisted off, and the detail's toggle rendered that persisted state;
CARRIED FROM LAST TIME rendered named and dated atop the Record. Scratch
data cleaned. Not driven live: the Stage PREP pane inside a real joined
room (origin-driven; pinned + the assembly proven by the same IPC the pane
calls) — it rides the operator's two-machine QA.

15 new tests (m5PrepSeries: real-SQLite prep queries, prefs, pins);
3,582 green across 329 files; both typechecks clean. **M5 is complete** —
M6 (Guest Capture) starts with the G1 ScreenCaptureKit spike, on the
operator's go.

## DEC-105 — M6: Guest Capture — SPEC-003 lands complete
**Date:** 2026-09-01 · **Status:** EXECUTED · **Plan:** analysis/28 (SPEC-003
P6, CR-12 · G1) · **Branch:** ryan-next

**G1 answered YES, with numbers.** The spike everything was gated on:
an armed display-media grant (primary screen + `audio: 'loopback'`,
ScreenCaptureKit under Electron 37) returned a track literally labelled
"System audio" — RMS 0.000 in silence, 0.369 while the Mac spoke through
its own output. Real loopback, proven through the PRODUCTION handler, no
virtual driver, no picker. The arming is one-shot over IPC: screen SHARE
keeps the native system picker; exactly one armed request bypasses it and
the handler re-registers the picker path the moment it fires.

**Reduced mode, exactly per CR-12.** Guest Capture records an EXTERNAL
meeting (Zoom/Meet/Teams) with no roster handshake — guests are not
Plexii users; the person responsible is the one who presses record, and
the disclosure bar on their screen is NON-DISMISSIBLE: two verbs (⚑
moment, Stop), an elapsed clock, and a mode line that names exactly what
is heard. Attribution is by construction, never by guess: mic = "You",
system audio = "Them" — and guests NEVER enter the extractor roster
(wrap-up filter), so nothing is owner-attributed to or sent toward
someone who never consented into the system. A guest's spoken commitment
still surfaces — ownerless, behind its "[m:ss] Them: …" anchor.
**Mic-only is the honest floor**, named in the bar as ruled: "Plexii can
hear you, not them." The vehicle video track is stopped the instant the
stream arrives — nothing visual is ever recorded.

**Everything rides the existing foundations.** MeetingTrackRecorder
(shared clock, per-track takes), CR-11 local-only transcription, the same
wrap-up (Record, commitments confirm stop, To Know brief, retention), and
series identity stamped from the calendar origin — an external weekly
booked with a joinUrl gets prep and "carried from last time" exactly like
a native meeting. Doors: a Record button on external-joinUrl calendar
blocks (explicitly separate from Join — recording is its own act, never a
side effect of opening a link) and "Record external" in the Meet view.

**The live round caught an M2-era latent bug worth the whole exercise:**
the ai:transcribeAudio IPC handler DROPPED forceProvider — the renderer
forced 'local' (CR-11), the bridge never passed it, and the cloud
PREFERENCE answered instead. On this machine (preference: cloud) every
real per-track meeting wrap-up would have errored — failing CLOSED only
because meeting callers send samples without bytes, so nothing could ever
have leaked to the cloud; it just failed. Fixed at the seam and pinned.
The re-run then proved the whole pipeline: door → bar (mode 'both') →
real speech through loopback → ⚑ → Stop → on-device wrap-up → a meeting
record with attributed segments — "You" from the mic (which heard the
room acoustically) and "Them" from loopback (which heard it electrically),
the same sentence transcribed twice by two different physical paths.
Scratch data cleaned (item dismissed per R008, meeting deleted).

12 new tests (m6GuestCapture: mode behaviours + contract pins incl. the
CR-11 seam); 3,593 green across 330 files; both typechecks clean.

**SPEC-003 is COMPLETE: M1–M6 all landed** (DEC-098…105). Still owed,
named: two-machine consent QA (live pane, Stage PREP, real-room guest
coexistence); PlexiCam 1:1 calls consent round; C5 Record widget +
per-item moment anchors; Recall-over-MCP round; briefs for other
attendees (out-of-room delivery).

## DEC-106 — PlexiCam calls consent — the M1 hole closed in its 1:1 form
**Date:** 2026-09-01 · **Status:** EXECUTED · **Plan:** named follow-up from
DEC-098/DEC-101 (the meetings audit found the same defect in calls) ·
**Branch:** ryan-next

**The hole.** One side's whisper preference silently recorded BOTH voices
the moment a call connected — `ConversationRecorder` mixed local + remote
and the peer was never told, never asked. Identical in kind to the
meetings hole M1 closed; it survived because DEC-101 could only rename
the preference honestly, not rebuild the flow.

**The close, mirroring M1 exactly.** The preference now expresses MY
intent only: at connect it starts a per-track recorder (the M1/C1
foundation, reused), taps MY mic, and sends a consent-request over the
existing callSignal relay — an opaque-JSON kind, zero server changes,
old clients ignore it. The peer's stream is tapped when their
consent-response arrives, never before (capture-on-answer); a decline is
honoured by construction — never tapped, the call continues, the record
holds only my side. Late media (renegotiation) applies the standing
answer, not a new grab. The peer's own standing preference answers FOR
them — someone who ticked "transcribe my 1:1 calls" has already said
yes, so both-on calls record on both machines, each side consented;
everyone else gets a modal that names the machine and the stakes
("recorded and transcribed on their machine… decline and your voice is
never captured; the call continues either way" — the verbs are "Yes,
transcribe" and "Not my voice").

**Named in words, continuously (§3.8 reduced).** The requester's window:
"Recording · asking NAME…" → "you and NAME consented" / "only you — NAME
declined (not recorded)", with a requester-only Stop (the take-so-far
still wraps up at call end, via a held take). The consenting side's
window: "NAME is transcribing this call — their machine, not yours."

**Calls ride the meeting pipeline now.** The wrap-up gets per-track
takes with speakers { You, peer's name } and forceLocalTranscription —
a consented recording must not grow a silent third-party disclosure, so
call audio joins meeting audio in never leaving the machine. That buys
calls the whole M2–M4 stack for free: attributed segments, the Record,
the commitments confirm stop, Recall. ConversationRecorder — the silent
mixer — is deleted from the tree. The preference copy tells the new
truth: "Transcribe & summarise my 1:1 calls (the other person is asked)."

Verified: 9-pin suite over the closed hole (blind-capture gone,
capture-on-answer, decline-never-tapped, standing-pref auto-answer,
worded states, held take, meeting-grade handoff, dead recorder gone);
clean boot on the real build with the new preference copy rendered. The
live two-party round-trip inherently needs two machines — it joins the
operator's two-machine QA (with meetings consent, the live pane, Stage
PREP and guest capture).

9 new tests; 3,602 green across 331 files; both typechecks clean. The
PlexiCam follow-up is CLOSED; remaining named rounds: C5 Record widget +
moment anchors, Recall-over-MCP, briefs for other attendees, two-machine
QA (operator-owed).

## DEC-107 — C5 closed: the Record widget + per-item moment anchors
**Date:** 2026-09-01 · **Status:** EXECUTED · **Plan:** named follow-up
(S3-DEC-020's last sliver, deferred at DEC-101; the moment anchor named at
DEC-102) · **Branch:** ryan-next

**The Record stands on its desk.** New widget kind 'meeting-record'
(content = meeting id): the wrap-up mints it FIRST, beside the transcript
doc, and it READS the meetings store live — never a copy — so the desk
shows the same truth PlexiMeet shows, provenance tiers intact: yours at
ink-100 leading, heard behind its timestamped quote rule, inferred
visibly quieter. Every heard line is a DOOR — click it and PlexiMeet
opens with the Thread scrolled to that exact segment. Honest states for
the not-yet ("written at wrap-up") and the gone ("the Record went with
it"). The kind is deliberately absent from the hand-add catalogue, so
the empty shell S3-DEC-020 warned about can never be placed by hand; an
unknown kind on an older client falls into Canvas's default case.

**The moment anchor, closed where DEC-102 left it.** A new internal URL —
plexii://meeting/<id>?seg=<segmentId> (lib/meetingLink, build + parse
unit-pinned) — rides the DEC-091 source_url column. MeetingCommitmentsCard
stamps it on every ANCHORED commitment it files; unanchored items keep the
meeting-level door only, the honest asymmetry. The Attention chip now
PARSES before it opens: an internal moment routes inside Plexii
(openMeeting + segmentId → M4's fb:open-meeting listener → Thread scrolled
to the line, icon my_location, title "Jump to the spoken moment"); any
other URL is DEC-091's web mark, still opened externally, untouched.

Verified live on the real build, both doors: the Attention chip landed
the Thread on Dana's exact line ("[0:30] Dana: the contract must be
countersigned by Friday", visible in-viewport); the desk widget rendered
its DECISIONS section with all three tiers and its heard line landed the
same segment the same way. Scratch data cleaned (item dismissed per
R008, meeting deleted with segments, desk trashed).

9 new tests (c5RecordWidget: URL round-trips + wiring pins); 3,611 green
across 332 files; both typechecks clean. **C5 is fully closed.**
Remaining named rounds: Recall-over-MCP; briefs for other attendees;
two-machine QA (operator-owed); analysis/27 Phase 4/5.

## DEC-108 — Recall over MCP — G3 closed
**Date:** 2026-09-01 · **Status:** EXECUTED · **Plan:** named follow-up
(G3, deferred at DEC-103: "a transport + auth design, not a route on
anything existing") · **Branch:** ryan-next

**G3's cost collapsed on contact with the codebase.** The deferral read
"no MCP server surface exists" — true — but PlexiAPI already existed:
127.0.0.1-only, scoped bearer tokens, Origin rejection, a DNS-rebind host
guard, enabled only by the user. Transport and auth were SOLVED problems;
only the protocol layer was new. So Recall-over-MCP is POST /mcp on that
server, behind every guard PlexiAPI already enforces — asking for the
READ scope explicitly, since MCP speaks POST for reads and the server's
method-based write gate would have demanded the wrong thing.

**The protocol layer is hand-rolled and dependency-free** (mcpRecall.ts):
JSON-RPC 2.0 — initialize with honest version negotiation (a known offer
is echoed; an unknown one gets our default, not a lie), ping, tools/list,
tools/call, notifications answered 202 with no body, batches tolerated
for older clients. Stateless by design; plain JSON replies, which the
Streamable HTTP spec permits. The full SDK would have been a dependency
for three read-only tools.

**Three tools, every answer attributed:** recall_search (segment FTS —
"[0:15] Dana: … — in 'Weekly sync' (meetingId: …)"; an empty result says
"an honest zero, not a failure"), recall_meeting (title, date, summary,
action items, the attributed transcript — truncation announced, never
silent), recall_recent_meetings. **The refusals, stated where enforced:**
READ-ONLY forever — no tool on this surface writes, files, or sends; no
audio — bytes never leave the machine (CR-11/CR-13), MCP gets text;
loopback only, token required — both inherited from PlexiAPI, both real.
The PlexiAPI view documents the endpoint and teaches the client config
(`claude mcp add --transport http plexii-recall …`).

**Verified live over real HTTP against the running app:** 401 without a
token; 403 with a forged Origin header; initialize echoed 2025-06-18 and
named the server at the real app version; the initialized notification
got its 202; tools/list returned the three; recall_search answered with
Dana's attributed line and its meeting identity; recall_meeting rendered
the full record. Scratch meeting deleted, probe token revoked, server
disabled back to its prior state — the port answers nothing again.

13 new tests (mcpRecall: the JSON-RPC contract on fakes + wiring pins);
3,624 green across 333 files; both typechecks clean. **G3 is closed.**
Remaining named rounds: briefs for other attendees (out-of-room
delivery); two-machine QA (operator-owed); analysis/27 Phase 4/5.

## DEC-109 — Briefs for other attendees — Q14 completed
**Date:** 2026-09-01 · **Status:** EXECUTED · **Plan:** the last named
follow-up (deferred at DEC-102, machinery half-built at DEC-104: "needs an
out-of-room delivery channel") · **Branch:** ryan-next

**The channel was in the house all along.** The blocker read "the
meetingSignal relay dies with the room, and the wrap-up finishes after
everyone left" — true, but PlexiChat DMs are server-persisted and
delivered live or on next open: the same channel "record a message for a
teammate who is away" already trusts. The brief rides it as a READABLE
message — prose first, one plexii://brief marker as the last line
(meetingLink build/parse, unit-pinned) — so an attendee on an old client
gets a useful DM; the machine layer degrades to prose, never to noise.

**Two-sided sovereignty, both defaults honest.** The HOST opts in to SEND
per series — a new shareBriefs knob, default OFF because sending is its
own act (the SPEC-027 doctrine), toggled on the series meeting itself
("Send the brief to the other attendees too"). The RECIPIENT opts in to
FILE per series — followBriefs, default null meaning never-asked: the
first arriving brief raises a notice that IS the opt-in ("Dana shared the
meeting brief for 'Weekly sync'" → "File it + follow this series"), and
NOTHING files until they say so — the confirm-stop doctrine reduced to
one toast. Following files quietly with the door OUT on the same notice;
declining leaves the chat message readable and does nothing else. The
filed item is sourceType 'note' — the meeting row lives on the host's
machine, and a chip pointing at a meeting this client does not have would
be a dead door dressed as a live one.

**The plumbing.** The roster (with handles) survives room teardown into
the wrap-up; the outbox speaks messagingClient DIRECTLY (the store's
startDm would hijack the user's open conversation mid-wrap-up) and skips
self; ingestion feeds from BOTH points a message can arrive — the live
socket and every history load — made exactly-once by a capped
processed-id ledger. SeriesPrefs widened to {briefs, shareBriefs,
followBriefs}; DEC-104's pin rewritten to the wider truth with history.

**Verified live:** the widened prefs round-tripped through the real IPC
(default {briefs on, share off, follow unasked}; both directions
persisted); both toggles rendered on a series meeting with share
correctly unchecked; clean boot with the new ingest hooks. The full
sender→server→recipient loop inherently needs two signed-in accounts —
it joins the operator's two-machine QA, with the wire format and the
whole recipient decision table proven by unit (13 tests incl. the
never-asked/following/declined table, idempotence, self- and
deleted-message guards).

13 new tests; 3,637 green across 334 files; both typechecks clean.
**Q14 is complete — and with it, every named build round from SPEC-003 is
closed** (DEC-098…109). Remaining: the operator's two-machine QA sweep;
analysis/27 Phase 4/5 on the operator's go.

## DEC-110 — #16 AI-suggested tags — analysis/27 Phase 4 opens
**Date:** 2026-09-01 · **Status:** EXECUTED · **Plan:** analysis/27 Phase 4
(item #16; the phase was gated on operator go — "keep going" was the go) ·
**Branch:** ryan-next

**The ruled shape, built exactly.** Tags stay deliberately never-mandatory;
the fix is SUGGESTED tags at the confirm stop, accent-marked as inferred
like every other inference. And the DEC-088 people pattern is the template,
applied whole: suggestions are DETERMINISTIC and grounded in what already
exists — a tag is suggested only when the capture's own words (whole-word,
punctuation-folded) match a tag ALREADY IN USE on live work items, ranked
by the user's own usage counts. No model call — the rules fast path stays
model-free. No invented taxonomy — the module can never mint a vocabulary,
only echo the user's back (the DEC-029 taxonomy law holds). Empty whenever
the workspace's tag population is: honesty over recall.

**Discoverable the house way.** Tags live in the DESK drawer, so waiting
suggestions LIGHT the desk pill (accent + "No desk · 3 tags?") — the
DEC-088 pill doctrine: accent means an inference is waiting and the
operator hasn't touched the dimension. Inside the drawer, suggestions are
accent-bordered chips under the tag input; a CLICK accepts one into the
chosen set, an accepted chip stops being a suggestion, and nothing ever
applies on its own.

**Two live-caught fixes worth the round:** (1) hyphenated tags never
matched — the text side folds punctuation to spaces and the tag side
didn't; tokenization aligned and pinned ('test-seed' now matches both
"test-seed" and "test seed" in prose). (2) the first placement was
invisible — suggestions sat in a closed drawer with no signal; the lit
pill closed the gap. Verified live against the operator's REAL vocabulary:
"Call the LakeDash client about the rush order" suggested exactly
#client, #lakedash, #rush (usage-ranked); the pill lit with the count;
clicking #lakedash accepted it and the suggestion row shrank to two —
the filter reading the chosen set is itself the proof the state took.
Escape closed the card; nothing filed.

**Phase 4 ledger:** #16 DONE (this entry). **#13 "transcript UI rebuild"
is SATISFIED by SPEC-003** — the Fireflies-level rebuild it queued is
DEC-099…103's attributed Thread, provenance Record, moment anchors and
Recall; marked in analysis/27, no separate build owed. **#17 home
widgets / live doc embed stays gated**: "new product build" is a shaping
question (which home? embedding what, for whom?) the operator owns
before any code does.

10 new tests (p4TagSuggest: real-SQLite vocabulary + scoring + the
tokenization drift + pins); 3,647 green across 335 files; both
typechecks clean.

## DEC-111 — main merged back (4.2.2) + the review → landing package
**Date:** 2026-09-01 · **Status:** EXECUTED · **Plan:** analysis/27 Phase 5
(Caleb checkout note · Michael review → landing) · **Branch:** ryan-next

**Michael kept shipping while we built.** origin/main moved to 4.2.2
(4.2.1: mail-list selection scrolling + PlexiOffice notarised; 4.2.2:
page-respecting tables, code blocks and images). The standing promise —
ryan-next stays zero-conflict mergeable — was re-earned: main merged back
(`9e26b73c`), ZERO conflicts (his work is doc-pagination/mail; ours is
meetings — disjoint by construction), and the merged tree runs **3,655
tests green across 336 files** (his tableHeaderRepeat suite beside ours),
0 type errors. Pushed to both remotes.

**analysis/29 is the landing package** — written for its two readers:
Michael's review guide (the commits in order with the five places review
attention pays most: the consent invariants, the forceProvider seam fix
that touches every wrap-up, the /mcp surface behind PlexiAPI's guards,
the all-additive schema deltas, the shared-surface touches outside
PlexiMeet) and Caleb's checkout (the two-line instruction + the flags
note resolved: the Settings work-items capability toggle). Plus the
two-machine QA sheet in one place, and the deliberately-deferred list so
nothing reads as forgotten.

Phase 5 ledger: checkout note DONE · review package DONE (Michael's
actual review + merge is his act) · taxonomy ruling still waits on real
queue-usage data (the [TEST] seeds would poison a snapshot taken today) ·
synced-docs QA rides the two-machine session.

## DEC-112 — PlexiMeet wears the house material
**Date:** 2026-09-01 · **Status:** EXECUTED · **Plan:** operator request
("this page still feels very vibe-coded") · **Branch:** ryan-next ·
**Scope rule:** DEC-094's — presentation ONLY; every testid, handler and
copy string exactly where it was, proven by the untouched m1–m6 suites.

**The recipes, applied whole.** The view now sits on the desk paper (the
dotted house texture every canvas wears, with its dark/futuristic
variants for free); the rail is a raised color-mix panel with the
display-type header and a rose identity chip; the primary is glossy rose
(gradient + inset highlight + fb-press — the kpi-tile gloss language on a
button); the recording preferences gather into ONE eyebrowed fb-card
("RECORDING") instead of loose labels; the four actions sit on a 2×2
grid of uniform h-8 fb-btn-surface buttons; search is a sunken field with
an accent focus ring; rows carry fb-press and an inset-highlight selected
state; the detail header is a sticky raised bar over the paper; the three
Record renderings are a sunken segmented TRACK with a glossy accent
active pill; and every rendering reads as an editorial max-w column.

**Two live-caught layout wraps** fixed in the round: the retention label
colliding with its select (nowrap + bounded select) and four actions
squeezed into one flex row (the grid).

**A verification lesson worth keeping:** three dark-mode screenshots in a
row showed light patches over correctly-dark computed styles — stale
compositor tiles in the OCCLUDED window (throttled rendering reuses
cached textures for layerized elements; the backdrop-blur rail and
resizable textareas each own layers). The definitive capture is
`captureBeyondViewport` + a display-none/restore damage nudge — dark mode
was then fully correct on the first honest frame. Recorded so the next
CDP visual round doesn't chase ghosts. Light and dark screenshots
delivered to the operator.

7 material pins (meetHouseMaterial — paper, chip, gloss, eyebrow, track,
sticky bar, column); 3,662 green across 337 files; both typechecks clean.

## DEC-113 — the transcription bug: `task:'transcribe'` was poisoning whisper
**Date:** 2026-09-01 · **Status:** EXECUTED · **Plan:** operator bug report
(a real test meeting came back as one sentence looped a dozen times; "Find
commitments" then honestly found nothing) · **Branch:** ryan-next ·
**Commit:** cca8693a

**Root-caused by measurement on the operator's OWN saved take** (36.5s of
clear speech, decoded off disk). The decode passed `task: 'transcribe'`;
on transformers.js 2.17.2's whisper models that option forces a decoder
path that collapses real speech into "So So So…" loops. Omitting it — the
library default — transcribes the same audio near-perfectly. The
commitments extractor was never broken: it correctly found nothing in the
loop mush (an honest zero over garbage).

**The full fix, each part proven on that take:**
- Drop `task: 'transcribe'`. The one load-bearing line.
- whisper-base for wrap-up truth (tiny genuinely loops on this audio);
  tiny stays only for the live ⌘⇧T pane, a labelled courtesy the wrap-up
  rewrites afterward.
- Belt and braces: explicit 30s windows + 5s stride + a 3-gram repeat ban,
  and a pure collapse-repeat net (whisperCore.collapseRepeatRuns) that
  folds any surviving loop to one honest segment.
- Decode quality: the renderer decodes at native rate then resamples via
  OfflineAudioContext, instead of a forced-16kHz AudioContext whose
  in-decode resampler muddied the first seconds.
- Recovery: a "Re-transcribe" button on any meeting with retained audio
  re-runs the saved takes through the current engine (segments, transcript
  and summary rewritten, the commitments door reopened). Audio never
  leaves the machine — the same local decode path as the wrap-up.

**Honest note on the detour:** a long bisection wrongly blamed the Electron
main process / onnxruntime threadpool and briefly moved transcription to a
child process — every "clean" comparison run had simply happened to omit
`task`. That machinery was fully reverted; the engine stays simple and
in-process. Pure logic lives in whisperCore.

Verified live on the operator's broken meeting: a clean 6-segment
transcript, a coherent summary, and both stated deliverables ("follow up
with Caleb on timestamp/clip", "make the video meeting feel in-desk") now
surface as commitments. 10 new tests (whisperQuality); one M2a pin
migrated to whisperCore; 3,672 green.

## DEC-114 — Stage + wrap-up wear the house material
**Date:** 2026-09-01 · **Status:** EXECUTED · **Plan:** operator request
(the DEC-112 companion — "bring the Stage and wrap-up into the house
material too") · **Branch:** ryan-next · **Scope rule:** DEC-094's —
presentation only.

**Wrap-up** (the review overlay after every recording) now carries the
same finish as the restyled PlexiMeet: a rose identity chip, the display
title, eyebrow section headers (SUMMARY / DELIVERABLES), and a glossy
accent-primary "Done" (Close stays quiet). Already an fb-card on the house
scrim; this made it read as the same product as the rest. **Stage** (the
live video surface — legitimately dark, like every video app) got the
premium treatment where it belongs: control buttons gain the house press,
an inset gloss highlight and a danger gradient; the notes-pane header gets
the chip-and-eyebrow treatment. The dark video stage stays dark by design.

3 material pins added (wrap-up chip + display, glossy Done, premium Stage
controls); 3,675 green across 338 files; both typechecks clean. Light and
dark wrap-up screenshots delivered.

## DEC-115 — The meeting Record reorganised: transcript beside the renderings, links both ways
**Date:** 2026-09-06 · **Status:** EXECUTED · **Plan:** operator request
(three reference screenshots of a mock transcript page — "this is not the
trump card; this is just a design direction") · **Branch:** ryan-next ·
**Scope rule:** UI/UX first, plus the linking the operator named as
important ("linking to certain sections and instructions from a
transcript"); core function unchanged; the transcription engine itself
NOT re-tested this round (the operator's caveat stands — DEC-113 is
verified on one real meeting).

**What the operator asked to keep from the reference:** everything
organised, bulleted and categorised; transcripts tagged by person,
searchable and linked; action items with a checkbox and a bell into
Attention; analytics filterable by person; transcripts broken out cleanly;
the existing "Find commitments" button; all of it in the Plexii house
material, not the reference's styling.

**The frame.** Two columns. LEFT: the Record's renderings in the sunken
segmented track — Overview (1), Action items (2 — still the DEFAULT per
S3-DEC-022, now carrying a count), Analytics (3). RIGHT: the transcript,
ALWAYS on screen — the Thread tab is gone because the transcript stopped
being a destination. Lines are tagged by speaker (colour by order of first
appearance, accent leads), searchable (`/` lands in the box; hits are
`<mark>`ed; an honest empty line when nothing matches), filterable by
speaker chip, every timestamp a link, the active line highlighted; DEC-100's
confidence dimming and its hover truth survive verbatim. Above both: a meta
strip (state pill, when, duration — seconds under a minute, "0 min" for a
24-second call was a lie — speaker initials) and a speaker TIMELINE of
proportional bands with markers (heard spans filled, action items hollow);
clicking it moves through the call. No fake play button: there is no audio
player and the Record does not pretend to be one.

**Overview** = the Brief organised by section: SUMMARY field, "Brief as"
templates, YOUR NOTES, then sections with heard rows (hairline rule +
timestamp → jump) and inferred rows (lighter, labelled) — the M2b
provenance treatment untouched; plain transcript text folds away once
segments exist. **Action items**: Find commitments kept (its confirm stop
unchanged); IN ATTENTION lists the work items that POINT at this meeting
(DEC-079's sourceRef) — each with a circle checkbox that sets the house
terminal state `completed` (and back to `open`), the class chip, due date,
a "m:ss in transcript" moment link (DEC-107's anchor, parsed) and the bell
mark; FROM THE SUMMARY lists the legacy lines with a hollow circle, a bell
that files a human-origin, already-approved item pointing back at the
meeting (no silent assignment), and Desk. A filed line is PROMOTED, not
duplicated — it leaves the summary list for the checkbox list, and comes
back if dismissed from Attention. **Analytics**: Duration / Speaker changes
/ Questions asked / Lines tiles, "Who spoke" as per-speaker share bars
(click = filter the transcript), Moments chips. SPEC-003's refusal holds
and is now a banned-word pin: neutral facts, never a ranking, a score or a
mood. **Links both ways**: a transcript line that anchors a Brief entry or
an action item wears a chip ("In Brief · Decisions", "Action item") that
opens the rendering and scrolls to the entry — the reverse of the jump.

**Code:** `lib/meetingRecordStats.ts` (pure figures, unit-tested — speaker
order/colour/initials, spoken time, hand-offs, questions, bands, seek,
filter, clock/duration); `PlexiMeetView.tsx` MeetingDetail rewritten
(1,272 → 1,860 lines; every functional pin from M1–M6, the calls round, C5
and the briefs round survives verbatim). Superseded pins rewritten with
history: m2b's tab tuples (Thread → Analytics, Overview leads) and
DEC-114's 780px editorial column (→ the two-column frame). New suite
`tests/unit/meetRecordLayout.test.ts`.

**Verified live** over CDP on a scratch meeting (six attributed segments,
yours/heard/inferred spans, a legacy line): 42 checks — search, speaker
filter, timeline seek, heard-row jump that clears a hiding filter without
switching tab, keys 1/2/3 and `/`, bell → one work item (meeting source,
human origin, approved), checkbox → `completed` → `open`, promotion and
return on dismissal, anchored-item moment link + hollow marker + reverse
chips, Export menu. Scratch meeting removed; the items my bell filed were
DISMISSED through the house path (work items are never deleted —
`WorkItemDeleteRefusedError` — so the probe cleans up the way a person
would). Light + dark screenshots via the DEC-112 honest capture. Suite:
3,693 tests / 339 files; both typechecks clean.

**Caught live, fixed in-round:** (1) the renderer store never sees a
raw-IPC write, so a dismissal made elsewhere (the queue in another session,
a snooze expiry) would not show on reopen — the Record now re-reads work
items on every open; (2) a sticky "already sent" bell state would go stale
after a dismissal — replaced by an in-flight guard, the promotion carries
the truth; (3) the pills carried both a count and a key digit — the digit
moved to the tooltip. **Probe lesson:** `textContent` includes Material
ligature names ("article") — match labels, never equality.

## DEC-116 — PlexiMeet on Home's substrate: paper-texture, hero header, floating kit cards
**Date:** 2026-09-06 · **Status:** EXECUTED · **Plan:** operator request
("make the entire PlexiMeet page background design, textures, and colors
look and feel more like the main home screen", with Home and Meet
screenshots side by side) · **Branch:** ryan-next · **Scope rule:**
presentation only — every testid, handler and copy string stays; the
DEC-115 Record is unchanged in function.

**What was actually different from Home.** Not the dots: Meet already sat
on `desk-paper` (DEC-112). Home sits on `paper-texture` — the dashboard
deliberately avoids desk-paper because its time-of-day overlay and
custom-background override caused Home's mid-screen seam and light-in-dark
bug — with a 28px dot grid on the themed `--surface-base`, scrolling with
the content. The real differences were structural: Meet's rail was a
full-height bordered panel, its detail had a sticky raised header bar, its
primary was a glossy rose block, and its cards had no headers. Home is a
single scrolling page (`max-w-[1440px] mx-auto px-8 pt-8 pb-8`) with a hero
greeting, quiet surface-button doors, one accent primary, and floating
cards with icon-tile titles.

**What changed.** The view root is `paper-texture` — the SAME substrate
as Home — inside Home's page shell. A hero header (Home's idiom: display
title, quiet subtitle, doors right) carries the rose module chip and
"PlexiMeet"; Record notes / Record external / Message / Add are Home's
surface buttons (`h-9 px-3.5 fb-t-body fb-btn-surface`), and "Start or
schedule a meeting" is Home's ACCENT primary (the Customize → Done glow) —
a judgment call recorded here: Home's only saturated element is accent, so
the module colour retreats to the chip. The rail became two floating kit
`RailCard`s (Meetings — search + list, sticky beside the Record; the
RECORDING preferences, eyebrow kept). The meeting title sits on the paper
with its facts beneath (no sticky bar); Desk / Export / delete are surface
buttons. The three Record panels are `RailCard`s with icon headers —
Timeline (clock + legend in the header), Record (the sunken segmented
track in the header, unchanged), Transcript (line count in the header,
sticky). The empty state (no meeting selected) is the module dashboard,
now `embedded` so the page keeps one hero.

**Kit growth, additive:** `RailCard` gained `trailing` (header controls),
`bodyClassName` (self-managed scroll regions) and `testId`; existing
callers — Home's Rooms/Continue cards, every module dashboard — render
pixel-identical (defaults unchanged). `ModuleDashboard` gained `embedded`.

**Caught live, fixed in-round:** the operator's real "Test" meeting has
two heard Brief entries citing the SAME transcript line — the DEC-115
marker keys collided (`h-<segmentId>`; React duplicate-key warning ×180
per render). Keys now carry the span index, and a line shows ONE chip per
door (two entries under the same section open the same place). **Probe
lesson:** after a renderer reload the app lands on the desk sidebar; the
Meet door lives in the OFFICE sidebar — probes switch context first.

**Superseded pins rewritten with history** (meetHouseMaterial): desk-paper
root → paper-texture + Home's shell; raised rail panel → kit cards; 15px
rail header → hero; glossy rose primary → Home's accent primary; sticky
detail bar → title on the paper; the DEC-115 `data-testid` panel pins →
`testId` on RailCards. Verified live: 42/42 CDP checks on a scratch
meeting (created, removed, its items dismissed the house way), light +
dark screenshots. Suite: 3,695 tests / 339 files; both typechecks clean.

## DEC-117 — The New meeting dialog is the Calendar composer's twin
**Date:** 2026-09-06 · **Status:** EXECUTED · **Plan:** operator request
("make the Start or schedule a meeting button and the window that pops up
look more like the booking page from making a calendar invite… it could be
nearly identical… just make sure the relevant functionality exists for
actually scheduling and booking a meeting") · **Branch:** ryan-next ·
**Scope rule:** BookTimeDialog's material verbatim, Meet's behaviour intact
and completed where the twin exposed gaps.

**The twin.** `NewMeetingDialog` is rebuilt on `BookTimeDialog`'s own
strings: the header slider with the sliding thumb (Start now / Schedule —
both meetings; there is no Focus here), the 23px title with placeholder
resolution ("Meeting" → the guests' names → the attached desk) and the
"Leave blank and it saves as" hint, the date / start → end chips (end
cycles the duration, Shift+click shorter; Start now shows today · Now), the
quiet Repeat chip, GUESTS as chips on a filled field with suggestions ranked
by shared-meeting recency, WHERE as one segmented question (Plexii Meet /
Paste link / In person / None — the chosen branch reveals and autofocuses),
AGENDA (Shift+Enter newline), the Attach row, the Esc / ↵ footer, the
keyboard map (Esc discards, Enter commits, Cmd+M flips the mode, guests and
agenda guard Enter). `meetDialogTwin.test.ts` holds ~30 recipe strings in
BOTH files at once, so the twin cannot drift quietly.

**Meet's behaviour behind it.** Start now opens the live room, RINGS the
online teammates you picked (green-dot chips; an "Online now" strip under
the field, and they lead the suggestions) and EMAILS the join link to
everyone else. Schedule writes a real meeting block — room id minted,
guests, external link or place, agenda (which the Stage's PREP pane already
reads), the attached desk as `taskId`, repeat — and emails the invites with
the honest mailbox note; the dialog closes itself after the note, as
before. A typed, uncommitted address still counts at commit. Entitlements
(`meet`, `meet_schedule`) gate exactly as before.

**Two places the twin is MORE than the composer, deliberately.** Attach is
REAL: a picker over open desks from the store, and the block links to the
one picked (the composer's Attach is still the DEC-019 stub). And the
composer's known-false line ("Guests join in the browser — no account
needed", the CR-08/09 stub copy) is NOT copied — the twin states what
happens: the link is emailed; anyone with it joins in PlexiDesk. The invite
email itself now knows where the meeting is (`composeInviteBody`, pure and
unit-tested: an external link is THE join line with the Plexii room as the
PlexiDesk door; a place is stated with the room as the remote option; a
plain Plexii meeting reads exactly as it always has).

**Verified live** over CDP, 18/18: both modes; guest chip commit / remove
with the placeholder following the guest and the primary counting the
invite; duration cycling; the Repeat menu; Paste link revealing its field
focused; a real desk attached (Staged); then ONE scratch meeting scheduled
with NO email guests (a connected mailbox would send real mail) and the
block read back — room id, link, agenda, desk, 45 min, no repeat — and
deleted. e2e NM-1/2/3 updated to the twin's ids and `aria-selected`.
Suite: 3,737 tests / 340 files; both typechecks clean.

**Probe lessons:** an OCCLUDED window never fires requestAnimationFrame, so
a probe that awaits a frame hangs — bound the wait, and let the damage
nudge do the capture (the DEC-112 lesson's other half); `[attr!=v]` is not
CSS — `:not([attr=v])`. The Meet door lives in the Office sidebar.
**Probe lesson, the costly one:** a probe must RESTORE the theme class it
toggled, never strip it — the app applies `.dark` itself (`lib/theme.ts`,
`applyTheme` → `classList.toggle('dark', …)`, following the system in
`auto`), so a blind `classList.remove('dark')` on a system-dark evening
left the operator's running app in light tokens until re-applied. Both
probes now record `contains('dark')` before and `toggle('dark', had)` after.

## DEC-118 — Record notes and Record external open the composer's twin too
**Date:** 2026-09-06 · **Status:** EXECUTED · **Plan:** operator request
("Now do the same for the Record notes and Record external buttons") ·
**Branch:** ryan-next · **Scope rule:** DEC-117's — BookTimeDialog's
recipes verbatim; only fields that land somewhere.

**The dialog.** `RecordDialog` — the same header slider (Record notes /
Record external), the 23px title with placeholder resolution, a time row
that states the one fact a recording has (today · Now → Until you stop),
NOTES, the Attach row, the Esc / ↵ footer; `recordDialogTwin.test.ts` holds
the recipe strings in both files. Neither door records anything until
Start; the dialog closes on success and, when the microphone refuses, says
so and stays.

**What each mode honestly carries.** *Record notes*: the title of the
meeting the recording becomes (was `Meeting · <date>`), NOTES minted as
`yours` spans on its Record (`buildYoursSpans` — the recorder's own words,
never rewritten), and a REAL desk (a picker over open desks; the meeting's
`deskNodeId`). *Record external*: the title; WHERE — "A call on this Mac"
(mic + system audio, You / Them) or "In the room" (mic only — the loopback
picker is never raised; the honest floor chosen on purpose, not reached by
failure); NOTES carried to the wrap-up as its notes (the same `yours` spans
a live meeting's notes become). No Attach there: the wrap-up mints that
meeting's desk itself (S3-DEC-020). The CR-12 disclosure is stated IN the
dialog, before anything runs, in the floor's own words ("Plexii can hear
you, not them"), and the bar's non-dismissibility is named.

**Store growth, additive:** `guestCapture.start` gained `notes` and
`micOnly`; the M6 floor, its wording and its pins are untouched. The
calendar's own block-level Record external door is unchanged (it carries
the block's series identity and agenda).

**Verified live** over CDP, 12/12 with the microphone STUBBED TO REFUSE
for the whole run — nothing was ever recorded on the operator's machine:
both doors open the dialog (external lands in external mode); notes mode
has NOTES + Attach and no WHERE; a real desk attaches (Staged, the
placeholder takes its name); Start with the mic refused shows the honest
error and leaves no recording state; external mode shows the two answers
with their disclosure lines; Start capturing with the mic refused raises no
disclosure bar; Esc discards. One live-caught fix: a desk attached in notes
mode kept naming the title after switching to external — the placeholder is
mode-aware now. Suite: 3,759 tests / 341 files; both typechecks clean.

## DEC-119 — The Message door opens the composer's twin; Meet's dashboard loses Customize and sits level with the rail
**Date:** 2026-09-06 · **Status:** EXECUTED · **Plan:** operator request
("Now do the same for the Message button. Also, get rid of the customize
button on the PlexiiMeet page and shift things upwards so the top row is in
line with the top of the left column") · **Branch:** ryan-next · **Scope
rule:** DEC-117's — BookTimeDialog's recipes verbatim; only fields that
land somewhere.

**The dialog.** `MessageDialog` — the header slider is the one real choice
(Video message / Voice message: it sets the capture), the 23px field is the
message TEXT (sent with the recording — blank sends the recording alone),
the time row says now → until you stop, TO is one teammate as a chip on
the filled field (from live presence, with the online-now strip; a DM
needs an account, so no addresses), the "how" line states the capture and
the delivery ("recorded on this Mac, then sent as a direct message in
PlexiChat — they see it when they are back"), the Esc / ↵ footer.
`messageDialogTwin.test.ts` holds the recipe strings in both files.

**Meet's flow behind it.** The popover picker is gone. The Message door
opens the dialog; once the camera / mic are live it closes and the door
becomes "Stop & send to <name>" (red, pulsing) until you stop; the sent
note lands beside busy / error. The kind decides `getUserMedia`'s video
flag (video asked for but denied still sends a voice message, honestly;
no mic at all is reported IN the dialog, which stays); the text rides the
DM as its body. Start with no recipient says "Pick a teammate".

**The dashboard.** `ModuleDashboard` in `embedded` mode renders no header
row at all — no title, no Customize, no actions — and the tile grid drops
its top margin, so the first row of tiles begins at the rail's own top
edge (measured live: 149 px both). The Customize door still exists on
every non-embedded module landing.

**Verified live** over CDP, 10/10 with camera / mic stubbed to refuse —
nothing recorded, nothing sent: no Customize, tiles level with the
Meetings card; the dialog opens in video, focus in the text; the
online-now strip (Michael) or the honest empty line; Start with no
recipient refuses; picking a teammate chips them and names the primary;
Voice flips the how-line to mic only; Start with the mic refused shows the
error in the dialog and raises no Stop & send; Esc. e2e: plexiMeetLive #2
now expects the dialog and its empty-state placeholder; moduleDashboard's
Meet case expects NO customize door. Suite: 3,778 tests / 342 files; both
typechecks clean.

## DEC-120 — The assistant's header comes first: the sidebar's wordmark, four doors, tabs below
**Date:** 2026-09-06 · **Status:** EXECUTED · **Plan:** operator request
(the floating Plexii panel: "the menu options for today, chat, agent, tasks,
activity, work need to come below the plexii wordmark menu items… at the
very top… from right to left minimize, display mode, What was I doing?…
take body double off of this page entirely… take your conversations off of
these menu bars and keep new chat… replace the Plexii wordmark where it
says Plexii your space with just the plexii logo and wordmark with the
animated bouncing eyes from the top left of the left panel menu. Start
there and then we'll keep going.") · **Branch:** ryan-next.

**What changed.** A new `AssistantHeader` is the panel's FIRST row on every
tab: the desk sidebar's own `PlexiiLogo` (the same `PlexiiMark`, the same
blink-once-and-wink-on-hover motion — one wordmark, one component) where
"Plexii / your workspace" stood, and on the right, left→right, New chat ·
What was I doing? · Display mode · Minimize — i.e. from the right exactly
as asked. Body double left the bar (its doors in the app header and the
command centre stay); Your conversations left the bar (the list stays the
fullscreen rail; the narrow-mode overlay lost its only door and went with
it). The tab strip now sits under the header. The Chat tab keeps the
conversation's own context as a slim strip only when there is something to
say — the focused desk thread, the Discovery badge, the linked desk, and
Clear chat when messages exist. The hub page (`PlexiiHubView`) wears the
same bar without the two chrome doors (it is not re-dressable).

**Plumbing.** "What was I doing?" moved into the chat store (`recap`,
`recapping`) so the overlay header and the hub share one implementation;
`ChatPanel` lost its header, `onCollapse`, the chrome mode menu, the
body-double hook and the history overlay — 190 lines of header for a
30-line context strip. Existing testids survive where the doors survive
(`assistant-new-chat`, `assistant-mode-toggle`, `assistant-mode-<mode>`,
`assistant-minimize`, `chat-linked-desk`, `chat-mode-badge`);
`assistant-recap` and `assistant-header` are new.

**Verified live** over CDP, 10/10, the panel restored exactly as found
(closed, floating, Chat): the header is the first row and the tab strip
begins at its bottom edge (171→219→219 px); the header holds the SVG
wordmark and no title; the four doors sit in order by x; no history toggle,
no body-double button, four buttons total; the header persists across
Today and Agent; Display mode lists Sidebar · Floating · Full screen; New
chat lands on Chat; Minimize returns to the pill. Suite: 3,785 tests / 343
files; both typechecks clean.

## DEC-121 — The assistant's tabs rearranged: Attention, Chat, Agent (+ desk agents), Tasks, PlexiChat
**Date:** 2026-09-06 · **Status:** EXECUTED · **Branch:** `ryan-assistant`
(new — the operator's AI-assistant series, branched from DEC-120; the Meet
work shipped as PR #6 on `ryan-next`, see the branch note below) · **Plan:**
operator request ("Replace the today button with an attention button… a
view of all your attention items… similar to the home screen attention
widget… replace the Activity Bar with Plexi Chat functionality… consolidate
agent and work… a sub tab… within the agent button to see the desk agents").

**Branches, first (operator instruction).** `ryan-next` rewound to DEC-119
(`c9da6993`) so the ship excludes the assistant work, and opened as **PR #6
ryan-next → main** on saasmouth/focusbuddy — zero conflicts against 4.2.2,
green, marked ready to ship, visible to Michael and Caleb. Landing on main
stays Michael's move per the standing rule (the operator can say "merge
it"). `ryan-assistant` created from DEC-120 (`dea4fccb`) on both remotes;
this and every following assistant round lives there.

**Attention.** The tab IS the home Attention widget — the same
`AttentionWidget` the home canvas and the desk render (section pills, rows
with the queue spine, the closing verb, the doors) — uncapped and
scrolling (`limit` / `scroll`, additive; the home and desk slices are
untouched) under its own remembered section (`attention.assistant.section`)
so the panel and the widget never fight over which slice is open. The daily
standup (Today) keeps its home on the Home page.

**PlexiChat.** The tab IS the Office Chat view — `MessagesView`, the same
messaging store, conversations, groups, channels, search, activity,
briefing, calls — in a `compact` dressing: no paper of its own and one pane
at a time (the list, then the thread with a back arrow), because the panel
has no width to give two. Every door into a conversation goes through one
`openConv`, so the thread shows however you arrive; back never touches the
store's active conversation (the Office page shares it).

**Agent + Work.** The autonomous agent stays exactly as it was; the desk
agents the Work tab listed are a sub-view inside Agent (a sunken segmented
control: Autonomous agent · Desk agents). The Work and Activity tabs are
gone; a tab saved before this round still lands somewhere sensible
(Today → Attention, Activity → PlexiChat, Work → Agent); the default is
Attention. AF-5's e2e geometry now counts the DEC-120 header.

**Verified live** over CDP, 13/13, panel restored as found: the strip
reads Attention · Chat · Agent · Tasks · PlexiChat and nothing else;
Attention renders the widget's pills, label and count in the panel with
the scrolling list; PlexiChat mounts compact, one pane at a time, the list
with its New / Search / Channels doors (8 conversations), a conversation
opens to its thread with a way back, back returns; Agent keeps the
autonomous surface with the sub-tabs, Desk agents lists the desk agents,
and back; Tasks unchanged. Suite: 3,793 tests / 344 files; both
typechecks clean.
**Addendum (probe residue, and a sync hazard to look at).** The Attention
capture showed seven open "Send the revised numbers to Dana by Friday"
items — my own DEC-115/116 probe residue, every one filed by the bell
(through the STORE, which emits the create over the sync substrate) and
then dismissed in each run's cleanup over RAW IPC (which emits nothing).
`workspaceSync` applies remote rows as a plain `ON CONFLICT(id) DO UPDATE`
upsert, so the substrate's copy — still `open` — came back and won; the
raw-IPC-created "Book time with legal" items had no synced copy and stayed
dismissed. Cleaned by dismissing exactly those seven through the store
(`useWorkItemStore.setState`, which emits the attr), guarded by title,
source and the scratch meeting no longer existing; rows re-read read-only
at +8 s and +20 s: dismissed, stable. Probe rule from here: create and
dismiss through the SAME path, and re-read the rows after the sync has had
its turn. **To look at (not asserted):** main's decay path writes
`work_item_state = 'dismissed', reason_code = 'decayed'` in raw SQL with no
sync emit — by the same mechanism a later upsert of that row could reopen a
decayed item. Worth a read of the upsert's guard before ruling it.

## DEC-122 — The strip: the double-ii mark · Attention · PlexiiMessage · Agents
**Date:** 2026-09-06 · **Status:** EXECUTED · **Branch:** `ryan-assistant` ·
**Plan:** operator request ("change the tab named chat to the animated
double ii logo, which represents AI functionality, then change the name of
plexichat to PlexiiMessage but make sure there are 2 i's in Plexii. And
we're removing the tasks tab altogether since everything is now
consolidated under Attention. Then… from left to right… Plexi AI with just
the double ii animated logo, then Attention, then PlexiiMessage, lastly
Agents").

**What changed.** The conversation tab is the brand's own sign for the AI:
`PlexiiMark` alone — the double-ii, one blink on mount and a wink on hover
(the kit's `once+hover`; there is no "breathe" mode yet, so nothing
pretends to think) — with "Plexii AI" as its accessible name and tooltip,
no text. PlexiChat is **PlexiiMessage** (two i's, per the spelling rule).
Tasks is gone — its list lives under Attention now — and a saved Tasks tab
lands on Attention. Agent reads **Agents**. Order: mark · Attention ·
PlexiiMessage · Agents; the default for a fresh install is the
conversation, first in the strip. `AssistantTasksTab.tsx` deleted.

**Verified live** over CDP, 7/7, the panel restored as found (it was open
on PlexiiMessage): the strip's titles read Plexii AI · Attention ·
PlexiiMessage · Agents; the first tab is an SVG with no text; PlexiiMessage
carries two i's; no Tasks tab; each tab still opens its body. Suite: 3,794
tests / 344 files; both typechecks clean.

## DEC-123 — PlexiiMessage in the panel: one Meet door, no translate menu, the doors fit
**Date:** 2026-09-06 · **Status:** EXECUTED · **Branch:** `ryan-assistant` ·
**Plan:** operator request ("merge the call and meet button into one meet
button because they do the same thing… get rid of the translation drop
down… shift everything left so that it all fits in the menu bar because
right now it gets cut off") — scoped to the PlexiiMessage tab.

**What changed (compact mode only — the Office Chat page is untouched).**
The thread header in the panel is two rows: the back arrow and the name on
the first, left-aligned; the doors on their own full-width row beneath,
left-aligned and wrapping, at the panel's tighter size (h-7), so nothing is
ever clipped at 420px. Call and Meet are one **Meet** door: in a DM it
meets the person now (the 1:1 video call the Call button made); in a space
it opens PlexiMeet, as Meet always did. The translate menu is gone from the
panel (the per-message Translate link still uses the stored language).

**Verified live** over CDP, 5/5, panel restored as found: a DM open in the
panel; one Meet door and no Call; the door's title reads "Meet with Caleb
Wilton now — a video call"; no translate menu; the doors start at the
header's left edge, all on one row, right edge 1256 px inside a pane edge
of 1409 px, no horizontal overflow. Suite: 3,795 tests / 344 files; both
typechecks clean.

## DEC-124 — The bell means Attention: PlexiiMessage's header bell retired, a bell on every message
**Date:** 2026-09-06 · **Status:** EXECUTED · **Branch:** `ryan-assistant` ·
**Plan:** operator request ("there is currently a bell icon which stands
for notifications, which is misleading because we're using the bell icon
for the attention AI layer now, so just remove it altogether. Then on any
given message, there needs to be the ability to click a bell icon and have
it route to the attention cue, most likely to the respond tag. But like
all the attention layer stuff, it should prompt you and ask you how you
want to classify it").

**What changed.** In the panel, PlexiiMessage's notification-level bell is
gone (it stays on the Office Chat page). Every message — mine or theirs,
in the list and in a thread — wears a bell on hover that opens the HOUSE
capture prompt (`fb:command-new-work-item` → the capture console → the
Attention confirm card): the message prefilled as the capture, the sender
and conversation as its notes, opening on **Respond** (the preset table's
class for chat), and the card asks how to file it — category, urgency,
when, people, desk — exactly as every other bell in Plexii. Nothing files
from the bell itself. The item it files points back at the message:
`sourceType 'message'`, the conversation as `sourceRef`, and a new internal
moment link `plexii://message/<conversationId>?m=<messageId>`
(`lib/messageLink.ts`, the meeting-moment pattern); the Attention page's
source door opens the conversation on the Chat page and lands on the
message, and the source reads "From a message — open it to reply in the
conversation".

**Verified live** over CDP, 6/6, panel restored as found: the header
bell gone, a bell on all 12 messages of a DM, the bell's title says what it
does, the prompt opens prefilled with the message's words and "Plexii read
it like this… Respond", and cancelling through the console's own door
leaves the work-item count unchanged. Suite: 3,803 tests / 346 files; both
typechecks clean. (The figure was first written as 3,827 — a guess made
before the run finished, corrected here; the log stays honest.)

## DEC-125 — The message bell is the desk bell: it fills when marked, a circle checks it off; the meta row leaves the bubble
**Date:** 2026-09-06 · **Status:** EXECUTED · **Branch:** `ryan-assistant` ·
**Plan:** operator request ("that bell icon functionality should work the
same way it does as a widget, tool, or app on a desk. So when I click it,
the bell fills with color, and the checkbox opens up next to it, so I can
check it off. The bell then gets unhighlighted again, so I can see in line,
in chat, what messages I need to attend to or respond to. Additionally, we
need to clean up the buttons within the messages themselves… the timestamp
for a message should not be in the colored message box. It should be just
below but still on the left side. Next to it should also be the translate
button… followed by the pin button, but just use the icon of the pin…
and then the last thing along the right edge, just below the colored
message box, should be the full reply thread").

**What changed.**
- **One bell.** The desk widget's bell (DEC-076/077) moved out of
  `WidgetFrame` into a shared `attention/BellIcon.tsx`; the frame and the
  message row both render it, so a bell means the same thing everywhere.
  On a message: empty on hover → the house capture prompt (DEC-124,
  unchanged — it still asks how to file). Once an open item points at the
  message (`lib/messageAttention.ts` — `liveItemForMessage`: sourceType
  `message`, not terminal, not detached, the moment link's messageId is
  this message; newest wins), the bell fills solid and stays visible
  without hover, with the shared `CompleteCircle` beside it. The circle
  closes the item with its queue's own verb through the one closing path
  (DEC-051 `useCloseWorkItem`, `PRIMARY_ACTION[queueOf(item)]` — Respond
  closes as "Responded"), and the bell empties again. A filled bell opens
  the Attention page. The list and the thread panel (parent + replies)
  carry it; the marked state is derived from the work-item store, never
  kept on the row.
- **The meta row, outside the bubble.** Under the bubble, full width: the
  time (· edited) at the left; Translate beside it (one door — Translate /
  Show original / Show ‹language›; revealed on hover until a translation
  exists); the pin as the icon alone (filled when pinned; the words ride
  the aria-label); the reply thread at the right edge ("N replies" always,
  "Reply in thread" on hover). The in-bubble time/translate block and the
  in-bubble toggle are gone. The hover reveal on the doors is the DEC-124
  convention carried over — a judgement call, one class each if the
  operator wants them always visible.

**Verified live** over CDP, panel restored as found, in two probes. Read-only
(5/5): the message the operator's own open item points at (filed from my
prompt in DEC-124, never touched) shows a filled bell visible without hover
with the circle beside it; an unmarked message's bell is empty, hover-only,
no circle; the meta row sits under the bubble at its left edge, no time
inside the bubble, the pin an icon, the thread at the right edge. Then the
check-off itself (7/7) on ONE scratch item created through the store,
tagged `test-seed`, pointed at an unmarked message: the bell filled and the
circle appeared; the circle's title read "Responded — complete …"; clicking
it closed the item as `answered` in the store AND on disk, and the bell
emptied; the operator's own item was still open after. The scratch row
(`97f7bd0f…`, state `answered`) stays on disk as a closed test-seed —
dismiss by tag with the others. Suite: 3,809 tests / 347 files; both
typechecks clean. Pins rewritten with history, never deleted: DEC-076/077's
frame-bell pins now point at the shared definition; DEC-124's `CaptureBell`
pins → `MessageBell`; e2e P2100-6's translate toggle → the meta-row door.

## DEC-126 — A message's doors: centred on the bubble, the time on hover, Translate in the ⋯ menu, click-away closes
**Date:** 2026-09-06 · **Status:** EXECUTED · **Branch:** `ryan-assistant` ·
**Plan:** operator request ("make the time stamp invisible unless I'm
hovering over it; the emoji icon and the bell icon and the ellipses need to
be centered on the message they are in reference to — right now they're
slightly off center, so if it's a one-line message it's hard to know
exactly what message they're associated with; get rid of the translate
button visible on screen and instead add it to the drop down menu within
the ellipses; when I click on the ellipse button or the emojis button, the
only way to get rid of those menus is to click on it again — I should be
able to click anywhere off screen to get rid of those things").

**What changed** (`MessagesView.tsx`, every message — list and thread).
- **Centred on the bubble.** The row centred its doors against the whole
  column (bubble + the DEC-125 meta row + reactions), so on a one-line
  message they sat a few pixels low. The doors — reaction palette, bell,
  ⋯ — are now one cluster hung off the bubble alone: absolutely positioned
  beside it (left of yours, right of theirs) on its vertical centre, so
  nothing that rides under the bubble can push them off the message they
  name. One cluster serves both sides; the theirs-side doors after the
  bubble are gone.
- **The time on hover.** The meta row's time (with "· edited" and, when a
  translation is showing, "· translated") is opacity-0 until the row is
  hovered or focused — opacity, not display, so nothing jumps. The pin
  (when pinned) and the reply count (when there are replies) stay
  visible, as before.
- **Translate in the ⋯ menu.** The visible Translate button left the meta
  row. The ⋯ menu is on EVERY message with words now — "Translate to
  ‹language›", then "Show original" / "Show ‹language›" — with Edit and
  Delete still only on your own; a message with no entries has no ⋯. While
  a translation is in flight the meta row says "translating…" (the menu
  has closed).
- **Click-away.** A new `hooks/useClickAway.ts` — the house pattern from
  SettingsPanel / ThemeBuilder, extracted: armed 50 ms after opening,
  mousedown on window (so the outside target's own click still lands —
  opening another row's door closes this one in the same gesture), and
  Esc. Both the palette and the ⋯ menu use it. The composer's emoji and
  GIF pickers already closed this way; unchanged.

**Verified live** over CDP, 16/16, panel restored as found, no data
touched: on a one-line message on each side the cluster sits on the
bubble's vertical centre to the pixel (dy 0) and on the correct side; the
time is opacity 0 at rest and 1 with `:hover` forced through CDP (an
occluded window never sees a real pointer); no Translate on screen at rest;
their ⋯ menu holds "Translate to English" alone, mine holds Translate ·
Edit · Delete; an outside mousedown closes the menu and the palette, Esc
closes both, and opening the palette on another row closes the open menu in
the same gesture with the click landing. Known and accepted: when the
bubble is narrower than the meta row (short messages), the row extends
beyond the bubble on the far side on hover — the time keeps the bubble's
near edge on theirs, the thread keeps it on yours. Suite: 3,817 tests / 348
files; both typechecks clean. Pins rewritten with history: DEC-124's bell
usage lines → the one cluster; DEC-125's Translate label → the menu's;
e2e P2100-6 opens the ⋯ menu before looking for Translate.

## DEC-127 — The way back: an Attention item opens the floating assistant on PlexiiMessage, on the person, at the message
**Date:** 2026-09-06 · **Status:** EXECUTED · **Branch:** `ryan-assistant` ·
**Plan:** operator request ("when I add a message to the attention queue…
it needs to link me back to that exact message with that exact person. And
it should open up in the PlexiiMessage tab within the AI assistant menu
that follows you from page to page… it should automatically open up in
the floating box with the PlexiiMessage tab opened to the person that it
came from").

**What changed.**
- **One router** — `lib/openMessage.ts`: `openMessageInPanel(conversation,
  message, parent)` asks the messaging store to land on the message
  (`landOn`), opens the conversation, then opens the persistent assistant
  on its PlexiiMessage tab. `openMessageLink(url)` routes an internal
  `plexii://message/…` link and returns false for anything else, so every
  caller falls through to its own door for web marks. DEC-124's Chat-page
  route (`openConversationAt`) is retired.
- **The store carries the landing** — `messaging.landOnMessage`
  `{messageId, parentId, at}`; MessagesView consumes it once, in an effect
  declared AFTER its pin-to-newest effect so the landing wins the scroll:
  in the panel it shows the thread pane first (a list pane sent back by
  the arrow is brought forward), for a reply it opens the parent's thread
  first and lands inside it, and a message that never appears expires
  after 8 s instead of firing weeks later. The landing is the Recall
  citation's own `jumpToMessage` — centred, flashed.
- **A reply names its parent** — `buildMessageUrl` / `parseMessageUrl`
  gained `p=` (backward compatible; the bell files `m.parentId` for a
  thread reply).
- **Every door on the Attention page routes**: the row's `message` chip is
  a button now (the DEC-079 meeting chip, for messages;
  `item-message-link`), the row's source door (forum icon; title "Open the
  message in PlexiiMessage — the conversation, at this message"), and the
  item editor's Source link (reads "The message, in PlexiiMessage", no
  external-link mark; DEC-091's web deep links still open externally).

**Verified live** over CDP, 9/9, DOM-read only (after a store file is
hot-swapped a probe's own `import('/src/stores/…')` is a stale instance —
the DOM and the real buttons are the truth), the operator's data untouched,
panel and page restored: from a closed panel the chip and the source door
each open the floating assistant on PlexiiMessage on Caleb with the exact
message in view and flashed; with the panel already open on the Attention
tab and the thread pane sent back to the list, the chip switches the tab,
brings the thread pane back and lands; the editor's Source link reads as
designed and lands the same way. Not exercised live: a reply inside a
thread (no such item exists yet) — the thread-first landing is pinned by
messageLanding.test.ts. Suite: 3,828 tests / 349 files; both typechecks
clean. Pins rewritten with history: DEC-124's `openConversationAt` pins →
the router; DEC-124's parsed-link shapes gained `parentId: null`; C5's door
pin → the fall-through.

## DEC-128 — The Attention widget's row: three depths in place (home, desk, the assistant's Attention tab)
**Date:** 2026-09-06 · **Status:** EXECUTED · **Branch:** `ryan-assistant` ·
**Plan:** operator request ("if I click on an attention item on a widget in
the home screen or a desk, it takes me straight to the attention page, and
it doesn't actually show me which attention item I clicked on… I should be
able to click an attention item, get a drop-down for a quick summary, just
like I can on the attention page itself, double-click for a full view of
that item on the same page that I'm existing on, or have the ability to
take me to… the title of that item visible with maybe the due date… when I
click it, I get a drop-down [with] the different action items… that's going
to need to apply in the Plexii app as well as the widget on the home screen
and widgets that I add onto a desk").

**What changed.** One component — `attention/WidgetItemRow.tsx` — is the
row for every face of the widget family (`ItemLines` renders it for the
five faces; the desk widget and the assistant tab are the same
`AttentionWidget`), so the three hosts cannot drift.
- **At rest**: the title and the due date — DEC-050's anatomy kept (queue
  spine, completion circle through DEC-051's one path, status pill or dot,
  date). A subtle chevron on hover says it opens.
- **One click**: the page's quick summary IN PLACE — notes, the reason, the
  chips (priority, due, plan, desk, meeting / message / source, mentions,
  tags), a Meet invitation's when · where · RSVP, subtask progress — and the
  page's row actions: the source door (a meeting moment → PlexiMeet at the
  line; a message → the floating assistant at the message, DEC-127; a web
  mark → the browser), the desk, Start with Plexii, Snooze until tomorrow
  (the page's 9 am rule), Archive, Open the item, and one door to the
  Attention page. The title click no longer navigates anywhere.
- **Double-click**: the full item — the page's own `AttentionItemEditor`,
  with the page's desk choices — over the page you are on, portalled to
  `<body>` so the floating panel (overflow-hidden, z-120) cannot clip it.
- **Shared doors, not copies**: `lib/startWithPlexii.ts` (desk first, the
  panel on chat, the prompt staged twice, never sent) and
  `lib/openMeeting.ts` (PlexiMeet, then the hand-off once mounted) are
  extracted from the page, which now delegates to them. Every widget list
  scrolls instead of clipping, so an open summary has room in a sized
  widget; DEC-121's `scroll` prop stays for its callers.

**Verified live** over CDP, 13/13, DOM-read, nothing closed / snoozed /
archived, page and panel restored: on the home canvas, in the assistant's
Attention tab, and on the LakeDash desk's widget, a row sits closed at rest
in a scrolling list; one click opens the summary in place with the six
actions (message door · Start · Snooze · Archive · Open · the page) and the
message chip, and the view does not change; a double-click opens the editor
portalled to `<body>`, on top (element-from-point), the view unchanged; the
editor closes through its own door; from the panel, the summary's page door
is the one trip to Attention. Suite: 3,838 tests / 350 files; both
typechecks clean. Pins rewritten with history, never deleted: DEC-051's row
anatomy pins follow the row to its file; DEC-121's overflow pin → every host
scrolls; the start-flow and DEC-079 hand-off pins → the shared libs.

## DEC-129 — The Today tile's meeting and calendar items: three depths in place, like the Attention widget
**Date:** 2026-09-07 · **Status:** EXECUTED · **Branch:** `ryan-assistant` ·
**Plan:** operator request ("Now do the same for the meeting and calendar
items") — DEC-128's row behaviour, for the calendar blocks (meetings and
focus time) and the dated work the home Today tile lists.

**What changed.**
- **A calendar block as a widget row** — `attention/CalendarBlockRow.tsx`.
  At rest: the camera (a meeting) or the clock (focus time), the title, the
  start time; happening-now pulses; done / missed / skipped show. One
  click: the summary in place — the time range and the relative when, the
  agenda, the chips (status · where: the provider or the Plexii room ·
  location · who's invited · the desk or item it is booked for · repeats ·
  pinned · this meeting's Record · last time in the series) — and the
  calendar's own doors: Join (an external link wins, the minted room is the
  fallback), Record an external meeting, Start (a focus session on its
  desk — the grid's rule for what can be started), Done, Skip, Open the
  block, Delete (undo in the toast, the store's own path), and the Calendar
  page. Double-click: the calendar's own `BookTimeDialog` in edit mode,
  seeded from the block, portalled to `<body>`; saving runs through a new
  `lib/blockEdit.ts` (`saveBlockEdit` — the grid's toast, undo and redo,
  extracted; the grid delegates to it).
- **The Today tile is made of rows.** Its calendar lines are
  `CalendarBlockRow`, its dated work is DEC-128's `WidgetItemRow`; the
  Overdue radar's lines are `WidgetItemRow` too. `MiniRow` (a plain line
  that jumped to the Attention page) is retired; the tile holds the real
  `TimeBlock` rows so a row has every field; the list scrolls.
- **Judgement call, stated:** `dayTimeline` now places work due BEFORE
  today behind the day's timed shape (as undated work rides), oldest first,
  ahead of the Meet items. Sorting overdue work by its past date put the
  operator's backlog (23 lines, August dues) ahead of the blocks actually on
  today's calendar, and a four-line tile never reached them — the rows
  this round adds would have been unreachable. The Overdue radar is the
  backlog's place; on the Today tile it follows the day. Pinned in
  attentionAnalytics.test.ts; DEC-049's own cases still hold.

**Verified live** over CDP, 8/8, on the home Today tile with TWO scratch
blocks (a Google-Meet meeting with agenda, location and an invitee; a
focus block) created and then removed through the time-block store (none
left on disk), nothing joined, recorded, started or marked, the page and the
open panel restored: both rows closed at rest with title, time and a
different glyph each, in a list that scrolls; one click on the meeting
opens the summary in place — range, agenda, "Google Meet", the location,
"1 invited", "Planned", Join and Record-external, no Start — and the view
does not change; the focus row offers Start and no Join, plus Open, Delete
and the Calendar door; a double-click opens the block dialog seeded with
the title, portalled and on top, the view unchanged; the dialog closes
through its own door; the summary's Calendar door is the one trip to the
Calendar page. Suite: 3,846 tests / 351 files; both typechecks clean. Pin
rewritten with history: the grid's save-toast pin → the shared helper.

## DEC-130 — The recording audit: a silent microphone, an engine that derails, and every door made honest
**Date:** 2026-09-07 · **Status:** EXECUTED · **Branch:** `ryan-assistant` ·
**Plan:** operator report ("I tried testing out the record notes button on
the PlexiMeet page, and it didn't work. It didn't capture the transcript.
So, do a full audit of the record notes, record external, and start or
schedule a meeting buttons… that transcripts can actually be captured").

**What was found.** The 08:04 attempt is meeting `ded4a88d` ("Notes"):
177 s recorded, transcript "you you you you you you", a 477-character AI
summary of nothing, no segments. Root cause, measured: the microphone
delivers DIGITAL SILENCE to this app — `getUserMedia` succeeds, the track
reads enabled and unmuted ("Default - MacBook Pro Microphone"), and every
sample is zero (peak 0, RMS 0, 511 bytes of opus per 1.5 s). The dev app
was launched from inside Claude Code and inherits the launcher's macOS
microphone permission (the same TCC identity DEC-078 found blocking the
camera); macOS hands such an app silence, never an error. Both engines
transcribe a synthetic voice perfectly, so transcription was never the
fault — and nothing in the app said any of this: the cloud engine
hallucinated on silence, the summary summarised it, a meeting was filed.

**A second fault, found on the way.** Driving Record notes with a
SYNTHETIC microphone (the `say` voice looped into a MediaStream), the
on-device engine (whisper-base) returned "Thanks for watching." for takes
the cloud engine read perfectly — 4 of 5 runs. Pinned by trimming: the same
take transcribes fully at 0–9 s and derails at 0–10.5 s; one window, a few
hard seconds at the end (a word cut mid-syllable), the whole decode lost.

**What changed.**
- **The microphone is asked, listened to, and watched** — `lib/micHealth.ts`.
  Every recording door (Record notes, Record external, and the dialog
  behind them) asks the system first (`media:micStatus` / `media:askMic`,
  a main-process bridge over `systemPreferences` — effective once the dev
  app restarts; `electron-vite dev` here runs without `--watch`), then
  LISTENS for 1.2 s before recording: digital silence refuses to start and
  says why, with the one door that fixes it (System Settings › Privacy &
  Security › Microphone; `record-error[data-reason=mic-silent]` +
  `record-mic-settings`). While recording, a level pill (`MicLevelPill`:
  five bars, or "No sound is reaching Plexii" after 3 s of zeros with the
  same door) sits on the PlexiMeet bar and the guest-capture bar.
- **Record notes is the same recording as every other door.** The
  per-track `MeetingTrackRecorder`, transcribed on this machine at the
  wrap-up (CR-11 — the old path shipped meeting audio to the cloud engine),
  which writes SEGMENTS (the Record's Thread, Recall, commitments and
  analytics all read segments; a plain transcript lit none of them),
  retains the take (CR-13, so Re-transcribe has fuel) and refuses to file
  on silence. The desk picked in the dialog is the origin
  (`markDeskOrigin`) and the container (`begin({ deskNodeId })` — no desk
  minted over it). The cloud-path `transcribeAndSave` is gone.
- **A transcript that is not a transcript is refused** —
  `lib/transcriptSanity.ts`: "you you you you", the stock phrases, a long
  take with almost no text. The wrap-up stops there with the honest line
  (and the microphone hint) instead of summarising and filing.
- **The derail net** — `lib/audioSplit.ts` + `transcribeRecording`: when
  the on-device first pass looks like that and the audio plainly has
  sound, the take is cut at its own pauses and the pieces decoded; every
  piece the engine can read is kept, timestamps moved onto the take's
  clock, nothing invented, still no cloud. The saved failing take:
  "Thanks for watching." → 174 characters, five segments.
- **Decode at opus' own rate** — the first decode stage names 48 kHz
  instead of following the output device (16 kHz on a headset in its call
  profile is the low-quality path by another door); the recorder's mix
  likewise.
- **Start or schedule**: audited, no change needed — Schedule writes the
  block with a minted room; Start now opens the live room.

**Verified live** over CDP, on the operator's own app, everything the tests
made removed through the stores and bridges (meetings, blocks, desks →
Trash, folders and transcript docs → Trash, briefs dismissed): the real
microphone probe (2.5 s: peak 0, every sample zero); both engines on a
synthetic voice (115 characters, identical); Record notes end to end with a
synthetic microphone — the dialog, the 1.2 s listen, the level pill lit,
Stop, the on-device wrap-up, a meeting with the spoken words, segments, a
speaker, a summary, a desk and a retained take — 10/10 on the looped voice
and 10/10 on a voice with natural pauses, after the derail net (4 of 5
runs derailed before it); Record notes and Record external with the REAL
microphone refused before recording with the reason and the settings door;
Schedule booked a real meeting block; Start now opened the room and left.
Suite: 3,871 tests / 354 files; both typechecks clean. Pins rewritten with
history: DEC-118's door contract and mic text, the DEC-099 decode-rate pin,
the guest-capture booleans, the page's busy banner; e2e plexiMeet #6
follows the dialog.

**Left on the operator's word.** Meeting `ded4a88d` ("Notes", the silent
177 s) is the operator's own — untouched. The tests' residue sits in the
Trash (seven desks, folders and transcript documents named "[TEST] DEC-130
…") and as dismissed "Meeting brief — [TEST] DEC-130…" items — purge is a
destructive act, so it waits. The microphone itself: launch Plexii from the
Dock, or allow the microphone for the app that launches it.

## DEC-131 — The assistant panel: Message's header and composer, a + on Attention, and a Calendar tab
**Date:** 2026-09-07 · **Status:** EXECUTED · **Branch:** `ryan-assistant` ·
**Plan:** operator request (the PlexiiMessage screenshot round: "change the
Plexii message to just 'message'… get rid of the meeting icon… keep gif, keep
the emojis, move the record a voice note to inside the actual message bar
itself on the right side, and then keep attachments… make the write a
message box bigger… move the meet recall and pin buttons to the right of the
actual name… the members button is redundant… if I were to have multiple
people in this chat that should just show me both names… Within the
attention tab, there needs to be a plus button so I can capture a new
attention item… add a new tab… for a calendar tab. This should default to
today's calendar, similar to the Today widget on the main Attention page…
toggle between days and get a quick month calendar view… click a day…
having the booking page pop up").

**What changed.**
- **Message.** The tab reads "Message". In the panel the thread header is
  ONE row: the people, then Meet · Recall · pin at its right (DEC-123's
  own-row placement retired). A DM reads as the person; a space reads as
  everyone else in it, so the members button is gone from the panel (the
  Office page keeps it, with Pulse and Schedules). The panel's composer:
  no meeting camera (the header's Meet is that door), the voice-note mic
  INSIDE the message box at its bottom-right, attach · emoji · GIF kept
  under a three-line box that fills the width (`ChatComposer compact`).
- **Attention +.** `AttentionWidget` grew `onCapture`; the assistant tab
  wears a + at the right of the section pills that opens the house capture
  prompt (the Attention page's Capture door — classify first, then file).
- **Calendar tab** (`assistant/tabs/AssistantCalendarTab`, after Attention
  in the strip): opens on today as the Attention rail's own day column
  (`WeekTimeGrid`, one day, compact — blocks drag and resize in place);
  ‹ Today › walks the days; a toggle shows the month at a glance (six
  weeks, today filled, a dot on every day with something booked, read into
  local state — never the shared range); clicking a day opens the Book-time
  dialog on it (the composer's own, portalled above the panel: 9:00 on
  another day, the next half hour today) and lands the tab on that day; a
  Book button does the same for the shown day; a door opens the Calendar
  page. Booking runs the grid's own path — `lib/bookBlock.ts`
  (`bookBlockWithToast`: create, the undo toast, the stated invite hold),
  extracted from the grid, which now delegates. The tab's pure parts
  (`lib/monthGrid.ts`: the 42 cells, the default slot) are unit-tested.

**Verified live** over CDP, 12/12, DOM-read, panel restored, the one
scratch block removed through the store: the strip reads ii · Attention ·
Calendar · Message · Agents; the + opens the capture prompt and closes
clean; the Calendar tab opens on today with the day column, › walks to
tomorrow and Today returns, the month shows 42 cells with today filled and
seven booked days dotted, a click on the 9th opens the dialog on "Wed,
Sep 9" above the panel, and Book it writes a real block at 9:00 that day
and lands the tab on it; the Message tab shows the name with Meet · Recall
· pin on the same row at its right and no members button, and the composer
is a 77px box at 92% of the pane with the mic inside it at the right, no
camera, attach · emoji · GIF present. Suite: 3,880 tests / 355 files; both
typechecks clean. Pins rewritten with history: the tab order and labels,
DEC-123's own-row header, the DEC-121/128 widget mounts, the grid's booking
pins → the shared helper.

**Addendum (same day) — the column fills the tab.** Operator: "Fill up the
full window on the calendar tab so that it doesn't cut off before the
bottom, and so you can see more on screen." The rail's compact window caps
at twelve hours (DEC-079), which in the taller panel left the bottom
empty. `WeekTimeGrid` grew `fill`: the hour window takes all the room left
under the day headers and the host owns the height; the Calendar tab passes
it. Measured live: the window ends 8 px above the tab's edge (its padding),
499 px tall, 16.6 hours on screen, the rest a scroll away. DEC-078's
window pin follows the class.

## DEC-132 — Home tiles scroll instead of clipping; the standup and navigator pin their headers
**Date:** 2026-09-07 · **Status:** EXECUTED · **Branch:** `ryan-assistant` ·
**Plan:** operator report ("On the home page, individual widgets get cut off,
and there's no ability to scroll… 'Your Stand-Up'… 'worth a look'… gets cut
off… 'Rooms & Desks'… doesn't actually show me all of the rooms and
desks… either it needs to stop before something gets cut off mid-row, or
there needs to be the ability to scroll").

**What changed.**
- **Every live tile scrolls.** The home grid's tile wrapper clipped
  (`overflow-hidden`); it scrolls now (`overflow-y-auto overflow-x-hidden`),
  so no widget can ever be cut off without a way to reach the rest. The
  drag ghost keeps clipping (it is a picture).
- **RailCard `fill`.** In a sized host the header stays pinned and the
  body takes the rest and scrolls; a body with its own `bodyClassName`
  gets the room and manages its own regions; unsized hosts (PlexiMeet,
  People, the Office shell) are pixel-identical. The three RailCard tiles
  (Rooms and desks, Continue, Quick actions) pass it.
- **Rooms and desks**: the rooms column and the desks column each scroll
  on their own, under the pinned header — the last room and the New desk
  button are always reachable.
- **Your standup**: the title row stays pinned; the narrative, "Worth a
  look" and "Completed since last time" scroll beneath it.
- **The command-center blocks** (Today, Pulse, Overdue radar, Recent
  activity) scroll their body.
- **The status menu rides a portal.** `ItemStatusPill`'s menu was
  absolutely positioned inside its row; in a scrolling list a pill near
  the edge opened clipped. It now renders in `<body>` at the pill's own
  coordinates, below the pill when there is room and above it when there
  is not, and closes on a click anywhere outside or Esc.

**Verified live** over CDP on the home page, 5/5, view restored: all ten
live tiles scroll rather than clip; the standup's title row stays put while
its body scrolls and the last "Worth a look" row is fully reachable; the
navigator's ten rooms scroll in their column with the last room reachable,
the desks column reaches New desk, the header pinned; a status menu opened
from the Attention tile lands through its portal fully inside the viewport
and on top, and Esc closes it. Suite: 3,886 tests / 356 files; both
typechecks clean.

## DEC-133 — The same rule for the Attention widget and desk widgets; the standup's Save chip
**Date:** 2026-09-07 · **Status:** EXECUTED · **Branch:** `ryan-assistant` ·
**Plan:** operator request ("Now do the same for the Attention widget and
desk widgets. Also, fix the save button design glitch on your stand-up
section").

**What changed.**
- **Desk widgets scroll, never clip.** `WidgetFrame`'s body scrolled only
  for the auto-growing kinds; it scrolls vertically for EVERY widget now
  (`overflow-y-auto overflow-x-hidden`), so content stays reachable whenever
  the frame cannot grow to fit it. A widget whose root fills the frame never
  shows a bar (measured: none of LakeDash's four grew one).
- **The Attention widget** already carried the rule from DEC-128 — section
  pills and the count pinned, the list scrolling — on the home tile and on
  a desk. Verified rather than changed: with three rows opened the home
  tile's list scrolls under pinned pills and the last row is reachable; the
  desk widget's list scrolls the same way.
- **The Save chip.** `StandupOutputPicker`'s button wore `icon-btn` (a
  fixed 24 px square) beside `fb-btn-surface`, so the surface hugged the
  icon while "Save" spilled outside it — the glitch in the screenshot. It is
  a surface chip sized by its content now, like the header's other doors.

**Verified live** over CDP, 4/4, view restored: the Save chip is one 64×28
surface with the icon and the word inside it; the home Attention tile
scrolls under pinned pills once rows open; LakeDash's four widget bodies all
scroll rather than clip with no unneeded bar; the desk Attention widget's
list still scrolls. Suite: 3,888 tests / 356 files; both typechecks clean.

## DEC-134 — The same rule for the Calendar and Meet pages: windows, not scrolls
**Date:** 2026-09-07 · **Status:** EXECUTED · **Branch:** `ryan-assistant` ·
**Plan:** operator request ("Now do the same for the Calendar and Meet
pages") — the DEC-132/133 rule ("either it needs to stop before something
gets cut off mid-row, or there needs to be the ability to scroll"), applied
page-wide.

**What was wrong.** Neither page clipped at the operator's window size with
today's data, but both bounded their tall regions with 100vh arithmetic:
the hour grid at `max(280px, calc(100vh - 380px))`, the queue rail's list at
`calc(100vh - 268px)`, the meetings list at `max(240px, calc(100vh - 460px))`,
the sticky transcript at `calc(100vh - 140px)`. Those numbers assumed a
header height and a footer the layout could not see — so a wrapped header,
a longer rail or a shorter window put a region's bottom edge under the
footer with nothing to scroll (the calendar rail was sticky, so even the
page scroll could not reveal its last rows). The assistant's Calendar tab
had already been ruled onto `fill` (DEC-131 addendum: "so that it doesn't
cut off before the bottom, and so you can see more on screen").

**What changed.**
- **Calendar is a window.** The root is a flex column; the title row and
  the toolbar are pinned; the rail/grid area takes the rest. The rail hugs
  a short list and caps at the window (`max-h-full` of its grid area), its
  list scrolling under the pinned title and class filter; it no longer
  sticks, because the page no longer scrolls past it. The grid column
  stretches to the floor: the plan bar stays put, the week/3-day/day grid
  runs `fill` (DEC-131's mode — pinned day headers and deadline chips, the
  hours window taking the rest), and the month pins its weekday row and
  shares the height across the six weeks (`minmax(max-content, 1fr)` rows:
  never shorter than a cell's content, taller when there is room, scrolling
  when the window cannot hold them). A 240px floor on the grid and month
  cards keeps the old `max(280px, …)` guarantee: below it the page root
  scrolls instead of the window collapsing.
- **Meet is a window on a wide screen.** The hero is pinned; the rail
  stands as tall as the floor and no taller — the Meetings card hugs a
  short list and shrinks for a long one (the list scrolling under the
  pinned title and search) while the Recording card keeps its height —
  and the column beside it scrolls on its own (the dashboard) or hands its
  height to the open Record, which pins its header and Timeline and lets
  the two panes hug short content and cap at the floor: the Record
  scrolling its renderings under the pinned title and segmented control,
  the Transcript scrolling its thread under the pinned search and speaker
  chips. Nothing is sticky any more. Below `lg` the columns stack and the
  page scrolls, as before (the meetings list capped at 60vh there).
- Nothing else moved: every testid, handler and copy string is where it
  was; `WeekTimeGrid`'s non-fill callers (the Attention rail column) are
  untouched.

**Verified live** over CDP on the operator's running app, 16/16 twice, view
restored, at the real window (2021×1105) and at an emulated 1400×640:
Calendar — the page does not scroll, the regions do; the week grid ends at
the page floor with its window scrolling the hours (11 AM–11 PM on screen,
one hour more than before) while the title stays put; the rail hugs its
three rows; the month card ends at the floor with all 42 cells at 129px
(above their 104px floor); at 640px the hours window still scrolls and ends
at the floor, the month's six weeks scroll inside their card, and a
page-wide sweep finds no element clipping content it cannot scroll. Meet —
the root is `overflow: hidden` with the main column the scroller; the rail
and the Recording card sit inside the window; with "Test" open the Record
and Transcript panes end inside the window, the Record body and the
transcript thread are the scrollers, and at 640px all of rail, Record and
Transcript end inside the window with the thread scrolling; no clipping
anywhere. Suite: 3,896 tests / 356 files; both typechecks clean.

## DEC-135 — The meeting detail header sits on a house card
**Date:** 2026-09-07 · **Status:** EXECUTED · **Branch:** `ryan-assistant` ·
**Plan:** operator request, with a screenshot of a meeting open in PlexiMeet
("the title card where it says 'Test', Transcribed, the date, the amount of
time, the speaker, all the way extended to the right with Desk, Export and
the trash icon — add a filled-in colored block behind it similar to the
timeline block, just for that header title field").

**What changed.** The detail header (`meet-detail-header`) wears the
Timeline card's own material — `fb-card`: the raised fill, hairline, soft
shadow and card radius — edge to edge with the Timeline and the panes below
it, one card gap apart (`mb-4`), padded like the cards (`px-4 py-3.5`).
Everything it held stays where it was: the editable title, the status pill,
the date, the duration, the speaker stack and count on the left; Desk,
Export and Delete on the right. The overlapping speaker avatars ring in the
card's fill (`--surface-raised`) instead of the paper's, so their separators
stay clean on the new ground. DEC-116's "title bare on the paper" pin is
rewritten with this history; nothing else moved.

**Verified live** over CDP on the operator's running app with "Test" open,
4/4, view restored: the header's computed background, box-shadow and radius
equal the Timeline card's; its left and right edges match the Timeline's and
the Record pane's, 16px apart; the title, the meta line, Desk, Export and
Delete all lie inside the card; the avatar ring colour equals the card's
fill. Suite: 3,896 tests / 356 files; typecheck clean.

## DEC-135 · addendum — "Now do the same for the Notes and New meeting headers" (verification only, no code)
**Date:** 2026-09-07 · **Status:** VERIFIED, NOTHING TO CHANGE · **Branch:** `ryan-assistant`
The detail header is one component (`MeetingDetail` → `meet-detail-header`),
rendered for every meeting, on the Meetings page and inside the Office
shell's Meet surface alike (`PlexiOfficeShell` mounts the same
`PlexiMeetView`). Opened "Notes" (transcript pasted, no desk, no speakers)
and "New meeting" (notes only) on the operator's running dev app: both
headers already sit on the DEC-135 card — title, status pill, date (and
duration where there is one) on the left, Export and Delete on the right —
with the Record and Transcript panes directly beneath (no Timeline, since
neither has segments). Only the dev instance is running (PID 97113, CDP
9223) and no packaged Plexii is installed, so there is no second build that
could show the old bare header. Screenshots `peek-notes.png` /
`peek-new-meeting.png` sent to the operator. A probe-harness fault surfaced
here and is fixed in the verification memory: the finally-block restored
only four view kinds and left the operator on Home when they had been on the
Office view — restore the whole view object from now on.

## DEC-136 — The Record's section titles in Overview and Analytics sit on a filled band
**Date:** 2026-09-07 · **Status:** EXECUTED · **Branch:** `ryan-assistant` ·
**Plan:** operator request ("Now do the same for the Overview and Analytics
tabs") — DEC-135's filled block behind a title field, carried into the
Record's two renderings.

**What changed.** Every section title in the Overview and Analytics
renderings — Summary, Your notes, each Brief section (Background, Signals,
Concerns, Where this leans, …), the Plain-transcript toggle, Who spoke,
Moments — sits on one band: the pane's own in-card fill (the sunken
surface the segmented track and the fields already sit on), field radius,
spanning the rendering's content width, the title inside it at 13.5px
semibold ink. Just the title field: the section's content stays on the pane
beneath it. One constant (`RECORD_SECTION_BAND`) and one component
(`RecordSectionTitle`) carry it; the transcript toggle is the same band as
a button, chevron kept. The Summary and Your-notes eyebrows (10.5px
uppercase grey) became titles in the band, so the Overview reads as one
family of sections. The Action items tab was not asked for and is as it
was (its In Attention / From the summary eyebrows stay). Every testid and
anchor (`data-brief-section`, `meet-who-spoke`, `rendering-*`) is where it
was, so Brief-chip jumps and Recall still land.

**Verified live** over CDP on the operator's running app with "Test" open,
4/4, the whole view object restored: Overview shows Summary, Background,
Signals, Concerns, Where this leans and Plain transcript text on bands;
every band's computed background equals the segmented track's sunken fill,
spans the rendering's content box edge to edge, stands 32px, and its
section content sits below it; Analytics shows Who spoke and Moments the
same way; Action items has no band and keeps its eyebrows. Suite: 3,897
tests / 356 files; typecheck clean.

## DEC-137 — The Action items tab's section titles wear the same band
**Date:** 2026-09-07 · **Status:** EXECUTED · **Branch:** `ryan-assistant` ·
**Plan:** operator request ("Now do the same for the Action items tab") —
DEC-136's band, carried into the Record's third rendering, so all three
read as one family.

**What changed.** "In Attention" and "From the summary" sit on the band
(`RecordSectionTitle`), and so does "Carried from last time" — which lives
in `MeetingCommitmentsCard` and is shared with the wrap-up, so it takes a
`band` prop: the Record asks for the band, the wrap-up keeps its eyebrow.
To share the band across the two files it moved into its own module,
`components/RecordSectionTitle.tsx` (the constant and the component, one
source of truth; the DEC-136 pins follow it). The confirm-stop card
("Plexii found N things in this meeting") is its own accent-tinted block
already and is untouched; every testid and anchor is where it was.

**Verified live** over CDP on the operator's running app with "Test" open,
4/4, the whole view object restored (the operator was on Attention and was
returned there): the Action items rendering shows "In Attention" on a band
filled with the segmented track's own colour, spanning the rendering's
content box, its list below it, and no eyebrow remains; Overview and
Analytics unchanged from DEC-136 (six and two bands). Suite: 3,898 tests /
356 files; typecheck clean.

## DEC-096 — The liveness gate, real-data verification, and process weight by reversibility
**Date:** 2026-09-03 · **Status:** EXECUTED · **Trigger:** market-readiness review +
a capability audit against the operator's real workspace

**Every gate we had asked whether the code was correct. None asked whether the
capability produced anything.** The audit found six wiring failures that all shipped
through green gates: document enrichment built, consumed by the grounding path, and
sitting at **zero rows for the life of the product**; agent delivery wired and
delivering nothing; desk agents recording no invocation history, so outcomes could
never be attributed; `focus-widget` / `drill-in-widget` / `navigate-to` implemented
in the executor and never offered to the model; and 63 of 139 documents extracting
to nothing — invisible to retrieval, embedding and memory alike. 3,460 tests were
green throughout, and had to be: every one is a *wiring* failure, and a unit test
verifies the code you wrote, not whether anything calls it.

This is the shape CLAUDE.md already names — *"every cap in this repo was once
declared and never called, which is a comment, not a cap"*. **G-LIVE** turns that
lesson into a gate: a stage is done when its capability has been OBSERVED producing
output, not when its tests pass. `npm run verify:liveness` copies the real database
into a throwaway profile, runs the app, and exits non-zero if anything with work
available still produced nothing.

**Verification moves to real data.** Every one of those defects is invisible on a
fresh profile — enrichment looks correct when there is nothing to enrich, retrieval
looks correct with three documents, and the extraction gap only appeared against a
real 139-document corpus. "Live verification" in the Phase-6 gate now means a COPY
of the operator's database, never an empty one. The live file is never the target.

**Process weight now scales with reversibility.** Phases 0-6 with dual validation
and the Crossroads Protocol are right for anything that can corrupt data or reshape
a shared surface, and they are overhead for a prompt line or a new widget kind — a
process heavy enough to discourage cheap experiments becomes the reason none get
run. Three tiers (REVERSIBLE / RESHAPE / FOUNDATIONAL), declared when a stage opens,
not argued afterwards; a REVERSIBLE stage that turns out to touch a shared surface
halts and re-opens higher, the same rule as a mid-build collision.

Also reconciled: the market-readiness roadmap had not been updated since 2026-06-05
and contained none of the work actually done since — the Attention layer (this
initiative), real-time collaboration, or PlexiOffice as a distributed product. A
roadmap that does not contain the work is not managing it. **Wave 1.5 (Evidence)**
was inserted before the monetization wave, because Wave 2 spends 4-6 weeks building
pricing around a value proposition no user outside the operator has yet tested.

Suite scope is raised as [ADR-0008](../../docs/adr/ADR-0008-suite-scope-and-gtm-sequencing.md),
PROPOSED with options priced — POSITIONING.md and the brochure currently sell
different products, and roadmap hours are being allocated by whichever was read most
recently rather than by a recorded decision. Not self-granted: the Crossroads
Protocol applies, and the ruling is the operator's.

Audit state at close: **2 findings, both low, both operational calls on the live
database** (a VACUUM's worth of free pages, and the append-only event store's share
of the file). Zero high or critical. `capability-liveness` clean — all five
capabilities producing output, including agent outcome learning, which had been at
zero since the feature was built.
## DEC-138 — Landed on main; `ryan-v1-beta` opened for the v1 beta refinement
**Date:** 2026-09-07 · **Status:** EXECUTED · **Branch:** `main` → `ryan-v1-beta` ·
**Plan:** operator ("Check GitHub to see if there's been any other developments
pushed to main… See if Michael has done anything recently. If not, I want to
go ahead and push all of our updates to main and then create a new branch…
refining the app, getting rid of all the noise and unnecessary features to
get this thing production ready for v1 launch in beta"; "don't push anything
until you confirm with me"; "go, name it ryan-v1-beta").

**What was checked first.** Main's last commit was Michael's Release 4.2.2
of 2026-09-01; no commits, branches, reviews or comments by Michael or Caleb
since, and the repo's event stream since then held only our pushes.
`ryan-next` stood 31 ahead / 0 behind main, `ryan-assistant` 53 ahead / 0
behind and containing `ryan-next` — conflict-free. Caleb's branches were
untouched since August (`Caleb-4.3-ui` fully in main; `Caleb-4.1-brain` 13
old commits, 504 behind). PR #5 (`fix/platform-stability`) was found
superseded: DEC-056…061 reached main inside the ryan-command-center merge as
different commits, and merging it would have conflicted in 12 files. All of
this was reported before anything moved.

**What was done, on the operator's go.** PR #6 (`ryan-next` → main) merged
with a merge commit (`80592846`); PR #7 (`ryan-assistant` → main,
DEC-120…137) opened, CI green (typecheck-and-unit), merged (`8579cbaf`);
PR #5 closed with the reason. Main now carries everything through DEC-137.
Landing is not a release — Michael cuts the version and the notarised
builds. `ryan-v1-beta` branched from main `8579cbaf` and pushed to both
remotes; `ryan-next` and `ryan-assistant` are landed and frozen. The rules
are unchanged: main only via PR, never a direct push; the dual-push ritual
for every branch.

**The new branch's mission.** Refine the app for the v1 beta launch — take
out the noise and the unnecessary features, make it production-ready.
Nothing of that has started; the next session begins by taking stock of
what counts as noise with the operator before removing anything.


## DEC-139 — The widget-delete `origin` bug: found here, fixed by Michael on main, our commit dropped
**Date:** 2026-09-07, superseded 2026-09-08 · **Status:** SUPERSEDED — the fix on main is `c86111fa` (Michael Dean) · **Branch:** was `ryan-v1-beta` ·
**Plan:** found by the v1-beta audit's main-process map and fixed on sight, because it was a one-token defect in a shipped build.

**The defect (both of us diagnosed it identically).** `widgets:delete`
(`src/main/ipc/index.ts`) carried DEC-059's real-delete guard — `if (origin
!== 'sync' && isRealDelete(before))` — without declaring the `origin`
parameter that `nodes:delete` declares and the preload already passes. It
typechecked only because the node project's default lib includes DOM's global
`origin`; in the main process the name does not exist. On every widget delete
the row was soft-deleted FIRST, then the handler threw `ReferenceError: origin
is not defined`, so the renderer's `await window.api.widgets.delete(id)`
rejected and nothing after it in `stores/widgets.ts remove` ran: no CRDT
tombstone, no store prune, no undo toast, no `WidgetDeleted` event. The widget
stayed on the canvas while the data was already gone. 53 crash rows in the
operator's database between 2026-09-01 and 09-07; shipped inside v4.2.0.

**What happened.** We committed the one-token fix plus a source-walking pin
here as `ecc15ff9` on 2026-09-07 and pushed it to both remotes. About fifteen
hours later, on 2026-09-08, Michael landed the same fix directly on `main` as
`c86111fa`, independently and with the same diagnosis, adding two behavioural
regression specs (that the IPC RESOLVES, and that the widget leaves the canvas
through the real Remove → Delete path), a regenerated `ipcContracts.generated.ts`,
and a manual sweep of `src/main/ipc` confirming no other handler has the shape.
He also recorded that the contract test could not have caught it, because the
contract was derived FROM the broken signature.

**The ruling (operator, 2026-09-08: "drop my delete fix and rebase onto
main").** `ecc15ff9` was dropped and `ryan-v1-beta` rebased onto
`origin/main`. Michael's fix is the one of record; there is no duplicate and
no conflict. This entry stays because the append-only log keeps the reason a
thing has its shape, and because the crash-row evidence above is the only
record of how long the bug was live in the operator's own install.

**One thing did not carry over.** Our commit also held
`tests/unit/ipcHandlerOriginDeclared.test.ts`, a pin that walks all ~500
`ipcMain.handle` callbacks and refuses any that reads `origin` without
declaring it — the automated form of the sweep Michael did by hand. It was
dropped with the commit rather than kept behind the operator's back; it
survives on `backup/pre-rebase-2026-09-08` and can be added as its own commit
on his word.

## DEC-140 — The v1 beta inventory: 168 surfaces audited, put in front of the operator to rule
**Date:** 2026-09-07 · **Status:** AWAITING OPERATOR RULINGS · **Branch:** `ryan-v1-beta` ·
**Plan:** the handoff's first hour (`planning/plexii-v1-beta/HANDOFF.md` §9 step 5) —
"rebuild the inventory from the code and put it in front of Ryan as a
Keep / Hide / Remove / Defer table with a first-guess column."

**Pre-flight (reported before anything moved).** `ryan-v1-beta` at `0e3546ee`
on both remotes; `origin/main` still `8579cbaf` (Michael's Release 4.2.2 of
2026-09-01) with no commits, branches, reviews or PRs since — the event
stream holds only our own pushes. `fork/main` is 272 behind and carries
nothing of its own. Suite green at the start: both typechecks clean,
3,898 tests / 356 files. The operator's dev app was already running
(PID 97113, CDP 9223) and was NOT navigated — one DOM read and one
screenshot only.

**The audit.** Nine read-only passes over the tree and the operator's live
database (`mode=ro` throughout), by family: the Desk segment and Rooms;
Brain; People; Office and the standalone PlexiOffice build; all widget
kinds; the shell, chrome, palette and onboarding; connected apps, the
browser stack and Settings; the assistant, AI providers, voice and the
legacy FocusBuddy stack; and the main-process map (IPC families, tables,
background work, external services, the signal-server dependency map,
packaging). Full write-ups are in the session scratchpad
(`audit-1-desk-rooms.md`, `-2-brain-people`, `-3-office`, `-4-widgets`,
`-5a-shell`, `-5b-apps-settings`, `-5c-assistant-legacy`, `-6-main-data`).

**The deliverable.** A published ruling sheet — 168 surfaces in ten
families, each with how it is reached, what it does from the code, its
end-to-end health, its tests, its data, its coupling to the core loop, its
authorship, whether it is already gated, a first-guess ruling and what
hiding it would take — plus 21 verified findings. Rulings are made on the
page itself (Keep / Hide / Remove / Defer, keyboard K/H/R/D) and persist to
the artifact's own store, so this session can read them back.
**https://claude.ai/code/artifact/b3b5ad7c-318a-48be-90ce-27789500d41b**

**Corrections to the handoff's §5 inventory, from the code.** The widget
union has **45** literals, not 44 (plus a 46th out-of-union `task-list`
with three live rows that render as nothing). The PlexiSuite catalogue has
**27** products, not 32 — the handoff counted group names. The Desk segment
has **no sidebar door at all** (DEC-020), and the ⌘K palette — the escape
hatch that ruling assumed — has no row for Rooms, the Plexii hub or the
Attention view.

**The mechanism the cull will ride.** `VIEW_CAPABILITY`
(`src/renderer/src/lib/viewCapability.ts`) is the only thing in the tree
that already hides a nav door AND locks its surface from one map, across
MainPane and six navigation surfaces. Three things it does not cover, all
of which the removal method must handle: the four segment shells take over
the pane without mounting MainPane (`App.tsx:634-648`), so a capability
never reaches them; the command palette gates only three entries; and no
main-process background loop is gated by any view, capability or setting
except the activity tracker, the updater and the API server.

**Nothing has been removed.** The next round starts with the operator's
rulings, outside in, one DEC per batch, each verified live and landed
small.

## DEC-141 — Why streaming services will not play in the browser widget: no Widevine
**Date:** 2026-09-07 · **Status:** DIAGNOSED, FIX PROVEN, AWAITING OPERATOR + MICHAEL · **Branch:** `ryan-v1-beta` ·
**Plan:** operator report ("I can't stream streaming services within Plexii
through a browser — Netflix, Amazon Prime Video, live sports. Figure out why.
If there is an obvious fix, fix it. If not, let me know what the issue is").

**The cause, measured.** Not Plexii's code. Plain Electron ships **no Widevine
content decryption module**, and Netflix, Prime Video, Disney+, Max, Hulu and
essentially every paid live-sports service require Widevine on desktop
Chromium. Probed on a `file://` page (a secure context — a `data:` URL is not
one and hides the EME API entirely, which gives a false "API missing" reading;
the first run here did exactly that and was re-done):

| | `electron@37.10.3` (shipped) | `castlabs/electron-releases#v37.10.3+wvcus` |
|---|---|---|
| `com.widevine.alpha` | **NotSupportedError** | **SUPPORTED**, `createMediaKeys` ok |
| robustness | — | SW_SECURE_CRYPTO ok · SW_SECURE_DECODE ok · **HW_SECURE_ALL no** |
| `decodingInfo` + Widevine | `supported:false` | `supported:true, smooth:true` |
| `org.w3.clearkey` | supported (nothing commercial uses it) | supported |
| CDM | absent from the bundle | 4.10.3050.0, fetched by `components.whenReady()` |

**Everything else in the path was checked and is fine.** All codecs pass
(H.264, AAC, VP9, HEVC, AV1 — MSE true, `canPlayType` "probably"); the
permission denylist (`src/main/index.ts:147`) does not deny
`protectedMediaIdentifier`; the webview presents a clean desktop-Chrome UA
(`src/main/userAgent.ts`); the widget is a real `<webview>` with a persistent
partition. **Clear video already works** — YouTube, Vimeo, Twitch-style HLS.
The failure is exactly and only the DRM gate.

**Why the fix was NOT applied.** It replaces the runtime in every user's
binary and is not ours alone to decide: production playback needs **VMP
signing** through castLabs' EVS, which requires an account and acceptance of
castLabs + Google Widevine terms (not something an agent creates or accepts);
it reorders **Michael's notarised release lane** (code sign → VMP sign →
notarise); and the GitHub tarball install **loses macOS framework symlinks**
on this machine (dyld "Library not loaded: @rpath/Electron Framework" —
repaired here by recreating `Versions/Current` and the top-level links in
every `*.framework`), so a naive `npm install` would break local dev. Even
signed, desktop Widevine is L3, so Netflix caps at 720p.

**Where it connects.** The operator's Attention queue already carries "Add
in-browser video streaming for multiple concurrent streams in Plexii". The
*concurrent streams* half is a separate, performance question — each webview
is a full renderer.

**Nothing in the repo was changed by this round.** The probes ran in the
session scratchpad against an isolated castLabs install.

## DEC-142 — The orphan-widget retry loop: the client stops retrying the impossible, and a permanent delete tells the workspace
**Date:** 2026-09-08 · **Status:** EXECUTED · **Branch:** `ryan-v1-beta` ·
**Plan:** operator, on opening the dev environment and being shown the boot
log ("dig into it", then "do 1 and 2" of the three offered fixes).

**What was wrong.** The dev app logged a `widgets:create` FOREIGN KEY
failure 888 times a MINUTE while sitting idle — 33,823 of the log's 34,622
lines; the previous session's log was 205,877 lines and 12 MB of the same
thing. Traced live: one desk, "SMOKE Trash Test", created and permanently
deleted on 2026-08-26. The purge only ever ran against this device's
database, so the workspace still holds five widget snapshots naming that
node. Every twenty-second poll re-offers them; each fails the FK because
`widgets.task_id REFERENCES nodes(id)` and the node is gone; the retry
buffer burns its budget on each and forgets them; the next poll re-arms the
same five. Evidence: the sync frames were captured off the socket (63 parent
task ids, exactly one absent from `nodes`), and the dead node's history was
read from the event store ("Permanently deleted … (memory purged)").

**What changed.**
- **The client parks what cannot work** (`lib/crdtSync.ts`). A create that
  exhausts its retry budget is parked against the id it is waiting for, and
  the poll stops re-arming it; it is released the moment THAT id is created,
  so a genuinely late parent still lands its dependents. A widget parks on
  its `taskId` — the id its foreign key names. A create whose dependency is
  unknown keeps the old behaviour exactly.
- **A permanent delete tombstones what it erased.** `deleteNodePermanent`
  already computed the purged node and widget ids and threw them away; it
  returns them now, the preload contract carries them, and both permanent-
  delete doors (`deleteDeskFlow`'s per-item flow and the Trash view's bulk
  arm) call the new `tombstonePurged` — widget deletes first, then their
  nodes. This stops the NEXT deleted desk from leaving orphans behind.

**A wrong turn worth keeping.** The first version released parked creates
whenever any node create succeeded. `nodes.create` is create-if-missing, so
every already-present node reports success on every poll: the release fired
constantly, nothing stayed parked, and the measured rate DOUBLED to 1,776 a
minute. Parking against the specific id is the whole fix, and the test says
why so it cannot be "simplified" back.

**A pre-existing fragility this surfaced.** `dec071PlanReview.test.ts`
awaited `import('…/planSelect')` inside five 5-second tests. Adding any one
more test file to the pool tipped the first over its timeout — it failed in
the full suite and passed alone. Proven mine by parking the changes and
re-running green, then proven NOT the source change by restoring it and
running green without the new test file. The import is hoisted to
`beforeAll`; the cases are untouched.

**Verified live** on the operator's running app, restarted so main and
preload reload: 888 failures while the budget is spent once at boot, then
**0 over two idle minutes** (before the fix, the same window cost 5,172 and
47,095 log lines). The new IPC contract was checked non-destructively —
`deletePermanent` on a non-existent id returns `nodeIds: []` / `widgetIds:
[]` with the trash count and node count unchanged. The app renders Home
normally, no uncaught renderer errors. Suite: 4,203 passed / 2 skipped
across 382 files; both typechecks clean.

**Not done, and why.** The five orphans ALREADY on the workspace are still
offered on every boot, so the one-off 888 stays until they are tombstoned
there — that was the third option and it writes to shared state, so it waits
on the operator's word. The tombstone emit path is covered by pins and its
contract proven live, but not exercised end to end: doing so means
permanently deleting a real desk.

## DEC-143 — The dead desk's leftovers tombstoned on the workspace
**Date:** 2026-09-08 · **Status:** EXECUTED · **Branch:** `ryan-v1-beta` ·
**Plan:** operator ("clean up the five orphans") — the third option offered
in DEC-142, the one that writes to shared state, on his explicit word.

**The count was wrong, and reading the raw payloads fixed it.** DEC-142 said
five orphan widgets. The dead desk "SMOKE Trash Test"
(`4832f885-610c-4663-915a-0d84251293a2`) actually left SIX objects of three
kinds on the workspace, and the earlier walk had mistaken two of them for
widgets because a table snapshot also carries a `taskId`:
- **3 widgets** — `eb31e590…` (table), `d8dbcf94…` (table), `d8c24989…`
  (note). These are the FOREIGN KEY failures.
- **2 tables** — `e65d07d0…`, `3d6c9df0…`, both "Untitled table", zero data
  rows.
- **1 work_item** — `7a62b873…`, "SMOKE remind me to test the detach shelf".
  **Left alone.** It is alive locally under a different parent, state
  `completed`: detached and revived exactly as R008 requires. Its workspace
  snapshot still names the dead desk, but work_item creates route through
  `workItems.applySyncEvent`, never the FK path, so it was never part of the
  noise. Tombstoning it would have destroyed one of the operator's own
  items.

**What was done.** The three widgets were tombstoned through DEC-142's own
`tombstonePurged` (which also exercises that path end to end for the first
time). The two tables were soft-deleted through the app's own door
(`tables.delete` sets `trashed_at`; it is not a hard delete) and tombstoned
with `crdtEmitTableDelete`. Five outbound `field:"delete"` frames were
captured on the signal socket, one per object — proof of send, not
inference. Nothing else was touched.

**Verified live** by restarting the app and measuring:

| | FK failures at boot | over the following idle minutes | log |
|---|---|---|---|
| before DEC-142 | 5,172 | 888/min | 47,095 lines |
| DEC-142, orphans still present | 888 | 0 | 8,165 lines |
| after this cleanup | **3** | **0** | **199 lines, 16 KB** |

The residual three are one attempt per widget on the first sync pass, before
the delete tombstone lands in the same pass; the tombstone stops every
attempt after that. The app renders Home normally (41 nodes, 12 tiles) and
the log carries no other handler error.

**Two findings left on the table, neither acted on.**
1. **Nine more orphan table rows** sit in `fb_tables` from other permanently
   deleted desks (46 rows, 11 orphaned, 2 of them now ours and trashed).
   `purgeDeskPermanently` cascades widgets through the FK but nothing
   cascades tables, so every permanent delete has been leaving them behind —
   the same class of gap DEC-142 closed for the sync layer, still open in
   the purge itself.
2. **`crdtEmitTableDelete` had never been called by anything.** It is
   defined in `crdtBridge` and, before this round, referenced nowhere in the
   renderer: deleting a table has always been local-only, exactly the bug
   DEC-142 fixed for desks. A future round should wire it into the real
   table-delete path rather than leaving it to a cleanup script.
