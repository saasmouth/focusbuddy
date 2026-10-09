# Quality Framework — Gates, Rubrics, Pressure Tests

Adapted from Agent-OS (`.claude/rules/quality-gates.md`, `confidence-scoring.md`,
`simulation-mode.md`, model-tiering) for a solo-operator, single-repo feature initiative.
The gates keep their teeth; the ceremony that only makes sense for the full multi-department
runtime (JSONL meta-logs, contract chain documents) is deliberately not wired.

## 1 · Confidence discipline

Every analysis artifact (feature inventory, gap matrix, strategy, architecture) carries a
confidence block:

```
confidence: 0.00–1.00  · why_not_higher: <specific limiting factor>
assumptions: <what must be true — load-bearing ones go to ASSUMPTIONS.md as A-NNN>
flags: LOW_CONFIDENCE (<0.75) | UNVERIFIED_CLAIM | HUMAN_REVIEW_REQUIRED
```

- **< 0.65 on the critical path = BLOCKED** — the item cannot feed downstream phases;
  it gets more evidence or an explicit operator override (logged as a DEC-NNN risk acceptance).
- Calibration per Agent-OS: ≥0.90 verified + triangulated · 0.75–0.89 strong, minor gaps ·
  0.50–0.74 single-source, flag it · <0.50 do not proceed.
- No confidence inflation: scores trace to evidence (file paths, line anchors, live greps).

## 2 · Gate map (which gate fires when)

| Checkpoint | Agent-OS analog | What must be true |
|---|---|---|
| G1 after spec intake | Gate 1 Intelligence Coverage | All spec items inventoried; overall interpretation confidence ≥ 0.80; ambiguities are logged questions, not guesses |
| G2 after gap matrix | Gate 5 Dual-Agent Validation (matrix = CRITICAL output) | Independent adversarial re-verification of ≥30% sample + all EXISTS/CONFLICTS claims; evidence from the live repo, not memory |
| G3 after strategy | Gate 2 Self-Consistency + pre-mortem | Acid test: executable with no other context; logic-auditor pass; red-team kill scenarios have early warnings + contingencies; operator approves |
| G4 after architecture | House rule: architecture passes Logic Auditor before code | 7-section doc; war-gamed; no code exists yet |
| G5 roadmap approval | Pre-flight Gate 6 | Operator green light; deps/tools/inputs verified per stage |
| Per-stage (Phase 6) | Gate 3 internal review + Gate 4 dimensional rubric | No first-draft passes; rubric below; tests + typecheck + live verification |
| **G-LIVE before any release** | *(new — see §6)* | Every capability the release touches is observed PRODUCING OUTPUT on a copy of the real database. `npm run verify:liveness` exits 0 |
| Final | Gate 5 on the whole | Consistency audit; every gap CLOSED or deferred with rationale |

**Three-strike rule (adapted):** an artifact rejected 3× at the same gate = stop retrying;
it's a spec/prompt problem, not an execution problem — rediagnose upstream, log a DEC-NNN.

**Crossroads escalation (PRESERVATION-DOCTRINE):** any conflict between a new feature and
existing functionality — found in Phase 2 or discovered mid-build — halts that thread and
goes to the operator as a priced options-set (preserve/refactor/rebuild/descope + recommendation).
Never self-granted, never silent. Rulings are DEC-NNN entries.

## 3 · Rubrics (Gate 4 dimensional scoring, 1–5, no dimension compensates for another)

**Analysis artifacts** (inventory, matrix, strategy, architecture):
accuracy-of-evidence · completeness · internal consistency · actionability · honesty-about-unknowns.

**Product/UX decisions:**
elegance (does the simple path stay simple) · intuitiveness (guessable without docs) ·
native fit (reads as Plexii — **scored against [DESIGN-FIDELITY.md](DESIGN-FIDELITY.md)'s
six-point check: tokens-only color, primitives composed, corners/motion/type from tokens,
all four themes verified, nav through existing seams, focus/feedback intact**) ·
AI-appropriateness (AI acts only with evidence + consent; deterministic fallback always
exists; never fabricates) · human agency (the human decides where it matters) ·
collaboration soundness.

**Code stages:**
correctness · house-fit (wiring conventions, naming — no new `taskId` overloads) ·
test coverage (success + adversarial per stage) · performance (no dashboard jank; scheduler
correctness when app closed/reopened) · reversibility (migrations additive; feature can be
gated off) · **preservation** (existing core flows unbroken: current suites pass, adjacent
surfaces smoke-checked live — mandatory ≥4 for RESHAPE/FOUNDATIONAL stages, per
PRESERVATION-DOCTRINE).

APPROVE = all ≥ 4 · CONDITIONAL = all ≥ 3 with named improvements · REJECT = any < 3 with
per-dimension feedback.

## 4 · Pressure-test roster (who attacks what, when)

| Stage | Dispatched agents (available in this session's Agent tool) |
|---|---|
| G1 spec intake | `Explore` (live-repo evidence) — intake itself is done inline for full context fidelity |
| G2 gap matrix | independent `Explore`/`general-purpose` verifier prompted to REFUTE classifications |
| G3 strategy | `product-strategist` (build) → `logic-auditor` + `red-team-agent` + `assumption-auditor` (attack) → `audience-calibrator` (new-user read) |
| G4 architecture | `architecture-designer` (build) → `logic-auditor` (mandatory pass) + `risk-analyst` (3-scenario) |
| G5 roadmap | `task-architect` + `priority-architect` (build) → `success-criteria-builder` (rubrics per stage) |
| Per-stage code | `code-reviewer` (4-dimension review) + `test-engineer` (adversarial tests) |
| Final | `consistency-auditor` across all shipped artifacts |

Rule: builders never grade their own work; every pressure test runs in a fresh context with
the artifact + the refutation mandate, not the builder's reasoning.

## 5 · Verification discipline (from Agent-OS verification-and-quality)

- Every "verified" claim ships with a verify-command the operator can run independently
  (`npm run typecheck`, `npm run test:unit`, a grep, a screenshot of the live app).
- Adversarial tests are mandatory for anything that gates or schedules (notification
  scheduler, consent flows): build it, break it on purpose, confirm the break is caught.
- Live verification: the dev app runs on this branch with HMR proven — every renderer stage
  ends with the change observed in the running app, not assumed.

---

## 6 · The liveness gate (G-LIVE) — "does it actually run?"

Every gate above asks whether the code is **correct**. None asks whether the
capability **produces anything**, and that is where a whole class of defects has
lived. Found in a single audit against the real workspace, all of them shipped
through green gates:

| Capability | State found | Why the suite missed it |
|---|---|---|
| Document enrichment | Built, consumed by the grounding path, **0 rows for the life of the product** | Reachable only from a Settings button nobody pressed |
| Agent delivery to a wired widget | Wired, format-hinted, **delivered nothing** | The wire was a prompt hint; no code ever wrote |
| Desk-agent run history | **No invocation ever recorded** | `runDeskAgent` never called `recordInvocation` |
| Agent outcomes | **0**, so quality could not improve from use | Nothing plumbed the invocation id to the surface |
| `focus-widget` / `drill-in-widget` / `navigate-to` | Implemented in the executor, **never offered to the model** | Nothing tests which actions a prompt lists |
| 63 of 139 documents | Extracted to nothing → invisible to retrieval, embedding, memory | Two body shapes the extractor did not handle |

Every one is a **wiring** failure. A unit test verifies the code you wrote; it
cannot tell you whether anything calls it. This repo already knows the shape of
this problem — CLAUDE.md's *"every cap in this repo was once declared and never
called, which is a comment, not a cap"* — G-LIVE is that lesson turned into a gate.

**The rule.** A stage is not done when its tests pass. It is done when its
capability has been **observed producing output**. Run:

```bash
npm run verify:liveness          # copies the real DB, runs the app, reports what came alive
```

It exits non-zero when a capability has work available and still produced nothing.

### 6.1 · Verify against real data, not a fresh profile

Every defect in that table is **invisible on an empty profile**. Enrichment looks
correct when there is nothing to enrich. Retrieval looks correct with three
documents. The extraction gap only appeared against a real 139-document corpus.

So "live verification" in the Phase-6 gate now means a **copy of the operator's
real database**, never a fresh one:

```bash
P=$(mktemp -d); cp ~/Library/Application\ Support/plexii/focusbuddy.db "$P/"
FB_TEST_USER_DATA="$P" npm run preview
```

CLAUDE.md already says measuring live data is encouraged and has caught defects a
green suite could not. This makes it the default rather than the exception. The
copy is read-write and disposable; the live database is never the target.

---

## 7 · Process weight scales with reversibility

Phases 0–6 with dual validation, adversarial passes and the Crossroads Protocol are
right for work that can corrupt data or break a shared surface. They are overhead
for a prompt tweak or a new widget kind — and a process heavy enough to discourage
cheap experiments becomes the reason none get run.

| Tier | What it covers | Path |
|---|---|---|
| **REVERSIBLE** | Additive and feature-gated: a new widget kind, a prompt line, a copy change, a new probe rule. Nothing existing changes shape; reverting is deleting. | Build → typecheck + unit → **G-LIVE** → ship. No crossroads, no dual validation. |
| **RESHAPE** | Changes an existing surface or contract: an IPC signature, a rendered widget, a stored config shape. | Full per-stage gate + PRESERVATION-DOCTRINE regression guard. |
| **FOUNDATIONAL** | Schema, sync semantics, the event store, retention, anything migration-bearing. | Everything in RESHAPE, plus architecture review before code (G4) and a war-gamed contingency. |

The tier is declared **when the stage is opened**, not argued afterwards. Getting it
wrong upward wastes hours; getting it wrong downward is what PRESERVATION-DOCTRINE
exists to catch, so when a REVERSIBLE stage turns out to touch a shared surface it
halts and re-opens at the higher tier — the same rule as a mid-build collision.
