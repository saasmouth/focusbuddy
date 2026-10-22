// Pure grounding helpers, dependency-free so they unit-test without pulling in
// the Anthropic SDK or Electron. Used by askWorkspace / askWorkspaceStream to
// build the per-source block sent to the model.

// One grounding source handed to the workspace-ask answer. The optional metadata
// fields come from local-model enrichment (documentRetrieval joins them onto the
// retrieved sources); when present they frame the source for the model.
export interface GroundingSource {
  docId: string
  title: string
  docType: string
  text: string
  summary?: string
  category?: string
  dates?: string[]
  entities?: string[]
}

// Build the grounding block for one source: a compact header from enriched
// metadata (category, dates, key entities, summary) then the body. Header lines
// appear only when their metadata is present, so an un-enriched source renders
// exactly as it did before this feature: "[n] title (type)\n<text>".
export function groundingBlock(s: GroundingSource, i: number): string {
  const lines = [`[${i + 1}] ${s.title} (${s.docType})`]
  if (s.category) lines.push(`Category: ${s.category}`)
  if (s.dates && s.dates.length) lines.push(`Dates: ${s.dates.slice(0, 8).join(', ')}`)
  if (s.entities && s.entities.length) lines.push(`Mentions: ${s.entities.slice(0, 8).join(', ')}`)
  if (s.summary) lines.push(`Summary: ${s.summary}`)
  return `${lines.join('\n')}\n${s.text}`
}

// Per-source ceiling for the chat prompt's RETRIEVED MATERIAL block (M1 defect
// #1). Matches what rankSources/selectPassages pack, so the passage selection
// upstream is what reaches the model instead of being re-cut. The old cut was
// 600 characters — the whole workspace grounded an answer on ~3.6 KB while a
// single open canvas widget could ride at 8000.
export const SOURCE_PROMPT_CAP = 6000

/**
 * Total characters of retrieved material one answer may carry.
 *
 * The real constraint is the prompt, not the source count, so this is where
 * thoroughness is actually bounded. ~140k characters is roughly 35k tokens: large
 * against a 200k context, and deliberately so — a question that touches a dozen
 * files should be answered from a dozen files. Twenty short notes cost a fraction
 * of two long contracts, and a source COUNT cannot tell those apart, which is why
 * capping the count was the wrong lever.
 */
export const RETRIEVAL_TOTAL_CHAR_BUDGET = 140_000

/**
 * Characters per token assumed when sizing a prompt for the on-device model.
 * Measured on the shipped Qwen3 4B over the real chat prompt: 30,264 characters
 * were 7,648 tokens and 67,162 were 16,673 (about 4.0). 3.5 errs on the side
 * of leaving room, because running out of room is the failure being avoided.
 */
export const LOCAL_CHARS_PER_TOKEN = 3.5

/** Tokens kept free for the on-device model's reply when packing its prompt. */
export const LOCAL_REPLY_RESERVE_TOKENS = 2048

/**
 * The retrieved-material budget, in characters, for a call that runs on the
 * on-device model: what its context window has left once the rest of the
 * prompt (`fixedChars`: instructions, conversation, attachments) and the room
 * for the reply are set aside. RETRIEVAL_TOTAL_CHAR_BUDGET is sized for a 200k
 * cloud context; on a 16k window it let a few long documents push the prompt
 * past the end, so the reply was cut short or never started (4.3.40: "The
 * on-device model could not produce a reply … (no JSON object was found)").
 * Never above the cloud budget, never negative. Pure; exported for tests.
 */
export function localRetrievalBudget(contextTokens: number, fixedChars: number, replyReserveTokens = LOCAL_REPLY_RESERVE_TOKENS): number {
  // 256 tokens for the chat template and the per-turn wrapping.
  const freeTokens = contextTokens - Math.ceil(fixedChars / LOCAL_CHARS_PER_TOKEN) - replyReserveTokens - 256
  return Math.max(0, Math.min(RETRIEVAL_TOTAL_CHAR_BUDGET, Math.floor(freeTokens * LOCAL_CHARS_PER_TOKEN)))
}

/**
 * Take as many sources as the budget allows, in the order they were ranked.
 *
 * Must run BEFORE the sources are numbered. The numbered list in the prompt, the
 * citation chips in the UI and the text the model can actually read have to be
 * the same set: drop a source afterwards and the model can legitimately cite [25]
 * having never been shown it, which is indistinguishable from a hallucinated
 * citation and impossible to debug.
 *
 * Always keeps at least one source. A single item over budget is still better
 * grounding than none, and the per-source cap already bounds how bad that gets.
 */
export function packSources<T extends { text: string }>(
  sources: T[],
  budget = RETRIEVAL_TOTAL_CHAR_BUDGET
): { kept: T[]; dropped: number } {
  const kept: T[] = []
  let used = 0
  for (const s of sources) {
    const cost = Math.min(s.text.length, SOURCE_PROMPT_CAP)
    if (kept.length > 0 && used + cost > budget) break
    kept.push(s)
    used += cost
  }
  return { kept, dropped: sources.length - kept.length }
}

/** Below this many characters a passage says too little to ground anything on. */
export const MIN_FITTED_PASSAGE = 400

/**
 * packSources for a hard window (the on-device model): the same ranked packing,
 * but the cost is the whole rendered line (title and numbering included), and
 * nothing is kept "anyway" past the budget — on a 16k-token window one 6,000
 * character passage over budget is the difference between an answer and a
 * refusal. When the best match alone does not fit it is shortened to fit
 * (never below MIN_FITTED_PASSAGE, else nothing is kept), and marked as
 * shortened in the text the model reads. Pure; exported for tests.
 */
export function fitRetrievalSources<T extends { title: string; text: string }>(
  sources: T[],
  budget: number
): { kept: T[]; dropped: number; shortened: number } {
  const kept: T[] = []
  let used = 0
  let shortened = 0
  for (const s of sources) {
    const overhead = s.title.length + 24 // "[nn] (type) title: " and the newline
    const body = Math.min(s.text.length, SOURCE_PROMPT_CAP)
    if (used + overhead + body <= budget) {
      kept.push(s)
      used += overhead + body
      continue
    }
    if (kept.length === 0) {
      const room = budget - overhead - 24 // " [shortened to fit]"
      if (room >= MIN_FITTED_PASSAGE) {
        kept.push({ ...s, text: `${s.text.slice(0, room)} [shortened to fit]` })
        used = budget
        shortened = 1
      }
    }
    break
  }
  return { kept, dropped: sources.length - kept.length, shortened }
}

// One numbered source line of the chat retrieval block. Pure and exported so a
// unit test can assert what ACTUALLY reaches the prompt — the gate the defect
// audit demanded after the 600-char cut survived invisible to every spec.
export function retrievalSourceLine(
  s: { docType: string; title: string; text: string },
  i: number
): string {
  return `[${i + 1}] (${s.docType}) ${s.title}: ${s.text.replace(/\s+/g, ' ').slice(0, SOURCE_PROMPT_CAP)}`
}

/**
 * The workspace-ask sources that fit `budget` characters of grounding blocks,
 * in ranked order (the ask paths number them after this, so the [n] the model
 * cites and the list the person sees are one set). The first source is always
 * kept; when it alone is over budget its text is shortened to fit (never below
 * 1,000 characters), because one source read in part beats none. `dropped`
 * counts what was left out, so the prompt can say the answer may be partial.
 * Pure; exported for tests.
 */
export function fitGroundingSources<T extends GroundingSource>(sources: T[], budget: number): { kept: T[]; dropped: number } {
  const kept: T[] = []
  let used = 0
  for (const s of sources) {
    const cost = groundingBlock(s, kept.length).length + 8 // the "---" separator
    if (kept.length === 0 && cost > budget) {
      const room = Math.max(1000, s.text.length - (cost - budget))
      kept.push({ ...s, text: s.text.slice(0, room) })
      used = budget
      continue
    }
    if (used + cost > budget) break
    kept.push(s)
    used += cost
  }
  return { kept, dropped: sources.length - kept.length }
}
