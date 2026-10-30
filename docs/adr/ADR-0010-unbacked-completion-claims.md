# ADR-0010 — When the assistant says it built something and did not

Status: ACCEPTED, implemented 2026-10-30. Covers `src/main/ai/claimCheck.ts`, `buildChatResponse`, `needsActionRepair` and `repairMissingActions` in `src/main/ai/anthropic.ts`.

## Context

Reported by the owner: *"the ai assistant doesnt build what it promises on the desk, it says it does, but nothing shows to apply to the desk, such as tables with columns and rows populated."* No cards at all, on both the desk side panel and the fullscreen assistant, and no table written out in the chat either — just a sentence saying it was done.

Chat does not use Anthropic native tool-use. It asks for a strict JSON envelope, `{reply, actions}`, and the parser turns `actions` into `ActionProposal[]` that the renderer shows as cards the user accepts (the reasoning for that is at `anthropic.ts:1949` — the model drops to prose too often even when the prompt commands tools). Everything the user can apply comes from `actions`. Nothing comes from `reply`.

So the failure is one shape: a well-formed envelope whose `reply` describes a finished table and whose `actions` array is empty. Nothing is malformed, nothing is truncated, nothing is held by the creation gate. Every other net in the pipeline needs something to have gone measurably wrong, and here nothing did — except that the user was told their table exists and it does not.

## What was actually broken

Two things, and the first hid the second.

**1. The last-resort detector had a hole big enough to walk through.** `claimsCompletedWork` matched a first-person completion only when the verb followed the pronoun directly, or with `just` between them. Measured against phrasings taken from real replies, it missed six of seven:

```
MISSED  I've gone ahead and created a table with 12 rows.
MISSED  I've now added a table to your desk.
MISSED  I've also set up the columns you asked for.
MISSED  Your table is ready on the desk.
MISSED  Done — added a table with Title, Status and Date.
CAUGHT  I've created a table.
```

Because the detector stayed quiet, nothing contradicted the claim, and the failure looked to the user like the app silently doing nothing.

**2. Even when it fires, a correction is not the thing the user asked for.** They wanted a table. Telling them honestly that no table was made is strictly better than lying, and still leaves them with no table.

## Decision

**Close the detector, then repair the response.**

The detector now also recognises an adverb between the pronoun and the verb (`now`, `also`, `already`, `gone ahead and`, …) from an explicit list, a claim that follows a completion marker on the same line (`Done — added …`), and completion stated as state rather than action (`your table is ready`, `the tracker is set up`). The list is explicit, and the state pattern requires the adjective directly after the verb, because the file's standing policy is high precision: a description of what IS on the desk ("the desk has three widgets", "that table is where the episodes live") and a question ("is the table ready?") must stay quiet, or the correction notice becomes noise and gets ignored when it matters.

When a response would carry that notice — no cards, no question, and prose claiming completed work — one extra call is made before the user sees anything. The model's own reply is handed back to it as the specification, with an instruction to emit the same envelope with the actions filled in. It has already decided *what* to build; it simply failed to put that decision where the renderer can reach it.

Three rules on the repair:

- **Once.** No loop. If the second attempt is also empty, the original response stands with its correction notice.
- **Only an improvement replaces the original.** A repair that comes back with zero proposals, or unparseable, is discarded. Two unbacked sentences are worse than one honest correction.
- **An empty `actions` is explicitly allowed in the retry prompt.** A model that genuinely cannot do the thing must be able to say so, rather than inventing a card that fails on apply.

## Alternatives considered

**Switch chat to native tool-use.** Would make "say it, don't do it" structurally impossible. Rejected here, not on merit — it is a larger change to a path that carries every chat surface, and `anthropic.ts:1949` records that the earlier attempt produced *more* prose-instead-of-action, not less. Worth revisiting; not the fix for a reported bug.

**Strengthen the system prompt.** Already strongly worded. A prompt cannot be a guarantee, and this is the layer that catches it when the prompt does not hold.

**Only correct, never repair.** Honest and insufficient, for the reason above.

**Repair silently with no detector change.** Rejected: the detector is what decides a repair is needed at all, and it is also the floor when the repair fails. It has to be sound either way.

## Consequences

- A chat turn that claims work with no cards now costs one extra model call. It only happens on the failure path.
- `needsActionRepair` reads the notice `buildChatResponse` appended rather than re-running the detector, so what triggers a repair and what the user is told can never disagree.
- Both chat entry points must run it. `tests/unit/actionRepair.test.ts` asserts that against the source, so a third path added later cannot quietly skip it.
- The repair is wired *before* grounding, so a repaired answer gets the same grounding check as any other.

## Verification

`tests/unit/claimCheck.test.ts` — the seven real phrasings, written red first (7 failed / 40 passed), plus the descriptions and questions that must stay quiet.
`tests/unit/actionRepair.test.ts` — the repair turns an empty claim into applicable cards, hands the model its own prose back, retries exactly once, and keeps the correction notice when the retry is empty, unparseable, or throws. Each proven by mutation.

Not verified against a live model: provoking the provider into an empty-`actions` claim on demand is not reproducible, which is why the deterministic nets exist.
