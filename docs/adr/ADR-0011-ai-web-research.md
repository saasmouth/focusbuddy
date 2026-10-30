# ADR-0011 — Web research for every AI surface, and the context cards

Status: ACCEPTED, implemented 2026-10-30. Covers `src/main/webPage.ts`, `src/main/ai/research.ts`, `src/main/ai/aiContext.ts`, the nine AI entry points in `src/main/ai/anthropic.ts`, and `ContextCards.tsx`.

## Context

The owner's request: *"Can you make all ai functionality have access to browsing, for example the desk build ai should be able to carry out research to populate tables and widgets."*

Browsing already existed twice, and neither copy could do that.

- `searchWeb` (chat only) returned DuckDuckGo result snippets — a title, a URL, and two sentences the engine chose. No page was ever read.
- `BROWSER_TOOLS` could read a page, but needed a live `<webview>` wired on the canvas, so only a desk agent could reach it.

Everything else — the desk builder, table rows, widget setup, document and design generation, ask-workspace — had the model's memory and nothing else. Ask for a desk tracking the top ergonomic chairs and you got a table of plausible chairs at plausible prices, with no marker anywhere saying which were real. That is the No-Fakery problem wearing a product feature's clothes.

## What the owner asked for, in their words

> "send full prompt along with any context from the users desk and file meta, must be reliable to know its related and may assist the prompt in carrying out the request, user should be able to allow cards to send the context, so add to prompt is the action, and also reject adding so it doesnt it add"

Three requirements, and the third constrains the other two: the prompt goes out, related workspace context may go with it, and **the user decides, per item, by pressing something.**

## Decision

**One research pass, shared by every surface, that searches AND reads.**

`research.ts` derives a query from the prompt, searches, fetches the top pages as text, and returns findings with their real URLs. Surfaces paste the block into the prompt they already send. Deliberately not Anthropic tool-use: the whole AI layer speaks strict JSON envelopes for the reason at `anthropic.ts:1949`, and a pass that returns text leaves every existing prompt and parser intact.

**The query is derived, not rewritten.** `deriveQuery` strips our own product vocabulary and nothing else — "build me a desk tracking indie bookshops in Melbourne" searches for *indie bookshops in Melbourne*. There is no model call in the path: this is the one place the user's words leave the machine, and what the function returns is literally what DuckDuckGo is told, so it is pure and unit-locked. The leading-noun strip requires a connector after the noun ("desk **tracking**…", "table **of**…"), which is what keeps *Table Mountain* its mountain.

**Context is proposed, never assumed.** `proposeContext` scores the desk's widgets and the user's files against the prompt and returns *descriptions* — label, size, why it matched, a preview of what would be sent. It sends nothing. The AI call then receives **ids**, and `resolveContext` assembles only those into text.

That the resolve step takes ids rather than filtering a prebuilt block is the whole design. A filter is one inverted condition away from a leak; a thing that is never assembled cannot leak. Rejecting a card also un-adds it and hides it for the session — ignoring and rejecting both end with the item unsent, but a row of cards you must keep re-reading is how a consent control becomes wallpaper.

**Scoring is the rule that already existed.** `relatedness` is `widgetFileRelevance`'s rule, generalised: a title match is worth three (a title naming the thing is the user pointing at it), a body match one, and a body-only match needs two different words. That threshold is not arbitrary — without it a shared "with" made everything relevant, and Build with AI once pulled a launch date out of an unrelated desk.

**Tables arrive populated.** `AiBuildSuggestion.tableSchema` gained `rows`, and `materializeSuggestion` writes them through `cellsFromAiRow` — the label→column mapper extracted from the add-table-row card so both paths read "Status" the same way. Without this the rest is decoration: a perfectly researched answer still produced an empty grid, which is exactly what the owner reported.

**Chat reads its results now.** The top three results are fetched and their text replaces the snippet in the numbered block. A question whose answer sat in a page's third paragraph was previously answered from memory with a web citation next to it, which is worse than not searching.

## What is off by default, and what is on

| | Default | Why |
|---|---|---|
| `research` in the model layer | **off** | `researchFor(enabled, …)` — a surface that passes nothing researches nothing. No surface browses by forgetting a flag. |
| `research` in Build with AI | **on** | "Build me a desk tracking X" is a research request far more often than not, and a build from memory is the reported failure. One click turns it off, and the toggle says what it does. |
| context cards | **nothing added** | Your own work leaves the machine only when you press Add. |
| on-device AI | **never searches** | `localOnlyActive()` is checked *before* the request is made. Choosing AI on this device means the work stays here; a search engine is "out". |

## Honesty rules the research pass will not break

1. **Best-effort, never blocking.** Every failure returns a result with no findings and a stated reason. A surface whose research found nothing behaves exactly as it did before this existed.
2. **A failed page is dropped, not summarised.** `fetchPageText` returns a parenthesised reason on failure, and `isFetchFailure` keeps `(could not load …: HTTP 403)` from reaching a model as though it were the article.
3. **The prompt block forbids filling gaps.** It states that these are the only web facts available, that others must not be added from memory, and that an uncovered value is left **empty**. An empty cell is honest; an invented one sitting beside researched ones is indistinguishable from them, which is the worst available outcome.
4. **What was read is shown.** The builder lists each source with its URL, and marks "summary only" where the body could not be fetched. A researched table nobody can check is just a prettier guess.

## Alternatives considered

**Anthropic native tool-use.** The clean answer in the abstract. Rejected for now: it would rewrite nine surfaces' prompts and parsers at once, and `anthropic.ts:1949` records that the earlier attempt produced *more* prose-instead-of-action. Worth revisiting as its own change.

**Send the whole desk as context automatically.** Simpler, better answers, and precisely what the owner ruled out. It also makes every AI call an unreviewed export of the user's workspace.

**Score context with embeddings.** Better recall. Rejected: the proposal runs before the user has approved anything, so it may not itself send the prompt anywhere — and it runs while they are still typing.

**Snippets only, no page reads.** Free and fast. It is also the status quo that produced the complaint.

## Consequences

- A research turn costs a search plus up to three page fetches (~6s search timeout, 9s per page, all in parallel, all best-effort).
- `fetchPageText` now has one implementation, shared by the research pass and the desk agents. The `PlexiDeskDeskAgent` User-Agent moved with it, and the spelling allowlist moved with the string.
- `suggestSetupWidgets` passes `researchSubject` so the desk's own title is searched rather than the brief we wrote around it.
- Nine surfaces must stay wired. `tests/unit/researchSurfaceCoverage.test.ts` asserts that against the source, with the reasoning for the list in the file — a tenth surface that silently skips research would be invisible, because it would just answer confidently from memory like the old ones did.

## Verification

`tests/unit/research.test.ts` — query derivation (including the connector guard, mutation-proven), the prompt block's honesty wording, and the network paths with `fetch` stubbed: too-short, no-results, a 403 page dropped, and an offline throw returning empty rather than escaping.
`tests/unit/aiContext.test.ts` — relatedness thresholds, and the consent rule: with one card added, the widget beside it and the file beside that appear nowhere in the assembled block. Mutation-proven by opening the id set and by loosening the threshold.
`tests/unit/researchedTableRows.test.ts` — label→cell mapping, type coercion, and rows actually written on materialise. Mutation-proven.
`tests/unit/researchSurfaceCoverage.test.ts` — all nine surfaces, the chat page read, the off-by-default rule, and that `localOnlyActive()` is checked before the search.

Full suite: 13,652 passed. Three typechecks and `lint:hooks` clean.

Not verified against live search results: DuckDuckGo's output is not a fixture and asserting on today's web would produce a test that fails next month for no reason. The parser (`parseDdgHtml`) and the ranking were already unit-locked; what this change adds is locked here.
