# ADR-0008 — Suite scope and sequencing for go-to-market

Status: **PROPOSED — awaiting operator ruling.** Raised 2026-09-03 from the
market-readiness review. Follows the Crossroads Protocol: options priced, a
recommendation given, the decision not self-granted.

Related: [ADR-0007](./ADR-0007-native-applications-build-vs-integrate.md) (why the
native editors are built at all), [POSITIONING.md](../../POSITIONING.md),
[MARKET-READINESS-ROADMAP](../MARKET-READINESS-ROADMAP.md).

## Context

This ADR does **not** reopen whether the Office-class editors should exist.
ADR-0007 already answered the §76.3 build-versus-integrate test affirmatively —
contextual continuity needs the event stream an embedded third-party surface cannot
emit, and Objects must be first-class graph participants. That reasoning stands and
is not in question here.

The open question is narrower and entirely about **positioning and sequencing**:
how much of the suite belongs in the go-to-market narrative and in the next two
quarters of roadmap hours.

Two documents in this repo currently sell different products.

**POSITIONING.md** leads with a single, defensible claim: the task-scoped execution
canvas. Its own competitive matrix shows this is uncontested — Notion maps
documents, Miro hosts team workshops, Obsidian stores knowledge, and none gives one
task a persistent working surface. That is a category claim.

**plexii-brochure.html** promises PlexiDesk, PlexiOffice, PlexiBrain, PlexiTeam,
PlexiMeet, PlexiChat, PlexiCam, PlexiMail and PlexiSign — *"ten apps' worth of
work"*, explicitly framed against the incumbent suites.

There is also a tension with the product's own principle. **PLX-PRIN-003** says the
platform *must not position itself as a replacement for specialist applications*.
ADR-0007 honours that for the build decision. The brochure's framing does not
obviously honour it for the marketing one.

## What the evidence says

- The canvas is used heavily and daily: 139 documents, 861 widgets, 163 desks,
  200,851 events in the operator's own workspace.
- The AI layer — the headline differentiator — was, until the September audit, the
  least complete surface in the product: enrichment producing nothing, agent
  delivery delivering nothing, agent runs recording no history. Those are now fixed
  and verified live, but the gap is recent.
- There is **no first-party evidence from any user who is not the operator**.
  POSITIONING.md carries confidence 0.77 with `LOW_CONFIDENCE` and lists *"Real
  users today?"* as an open question. That is still open.
- PlexiOffice consumes real, ongoing capacity: its own electron-builder config, its
  own release pipeline, its own release directory.

## Options

**A — Narrow the narrative, keep the code.** Lead on the canvas exactly as
POSITIONING.md recommends. The Office editors ship and are discoverable, described
as *"and your documents live here too"* rather than as a suite. No code is deleted
and no ADR-0007 reasoning is disturbed.
*Cost:* rewriting the brochure. *Risk:* the breadth story is genuinely part of the
appeal for some buyers, and this drops it from the pitch.

**B — Keep the suite narrative.** Continue positioning against the incumbent
suites.
*Cost:* an ongoing share of roadmap hours in editors that must approach Word and
Excel to be credible, against decades of engineering and enormous switching costs.
*Risk:* invites a comparison that is very hard to win, dilutes an uncontested claim,
and sits awkwardly with PLX-PRIN-003.

**C — Split the products.** Plexii as the canvas; PlexiOffice as a separate
offering with its own positioning.
*Cost:* two GTM stories and two support burdens for a small team.
*Risk:* highest overhead of the three; only sensible if the suite proves demand on
its own.

## Recommendation

**Option A**, until there is user evidence to justify otherwise. It costs a
document rewrite, disturbs no code, keeps ADR-0007 intact, resolves the tension
with PLX-PRIN-003, and concentrates the pitch on the one claim the competitive
matrix shows nobody else can make. It is also cheap to reverse: if the ten-user
evidence round shows people arriving *for* the suite, the narrative can widen again
with something behind it.

## Decision

**2026-10-21, operator:** everything is in one Plexii suite. Option C (split the
products) is rejected and the standalone PlexiiOffice app is retired; it is no
longer built, released or updated. The narrative choice between A and B is still
open.

*Operator to rule. Record the outcome here with a date and a one-line rationale,*
*then reconcile the affected documents:*

- **Option A** → rewrite `plexii-brochure.html` to lead with the canvas; mark the
  suite apps as "included", not headline.
- **Option B** → update POSITIONING.md so the two documents agree, and add a suite
  wave to the market-readiness roadmap with explicit hours.
- **Option C** → new positioning brief for the second product before any further
  suite work.

## Consequences

Whichever is chosen, both documents must then say the same thing. The concrete harm
today is not that either narrative is wrong — it is that the product is being sold
two ways at once, and roadmap hours are allocated by whichever document was read
most recently rather than by a recorded decision.
