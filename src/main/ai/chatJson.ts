// Pure string helpers for reading the model's { "reply": ..., "actions": [...] }
// chat envelope. Kept free of any DB or Electron imports so the truncation
// recovery logic can be unit tested in isolation (anthropic.ts pulls in the
// SQLite layer and can't load under vitest).

import { decodeReplyFragment, replyQuoteRole } from './streamingEnvelope'

export function extractJson(text: string): string | null {
  // Allow Claude to wrap in markdown ```json ... ``` or just return raw JSON.
  //
  // A fence is the WRAPPER only when it opens before the JSON does. Replies
  // carry markdown inside their strings (a desk's pages, a chat answer with a
  // code sample), and the old "first ``` … ``` pair anywhere" rule returned a
  // widget's code block as the JSON, failing the whole reply.
  const fence = /```(?:json)?[ \t]*\r?\n?/i.exec(text)
  const brace = text.indexOf('{')
  if (fence && (brace < 0 || fence.index < brace)) {
    const body = text.slice(fence.index + fence[0].length)
    // The JSON inside may itself contain fences, so try each closing fence in
    // turn and take the first slice that parses; when none does (a cut-off or
    // broken reply), hand back everything up to the last one for the caller's
    // own recovery.
    let close = body.indexOf('```')
    let last = -1
    while (close >= 0) {
      const slice = body.slice(0, close).trim()
      try {
        JSON.parse(slice)
        return slice
      } catch {
        last = close
        close = body.indexOf('```', close + 3)
      }
    }
    return (last >= 0 ? body.slice(0, last) : body).trim()
  }
  const end = text.lastIndexOf('}')
  if (brace >= 0 && end > brace) return text.slice(brace, end + 1)
  return null
}

// Recover a broken { "reply": ..., "question": {...}, "actions": [...] }
// envelope. Two failure shapes land here: the model ran out of tokens (or the
// stream died) mid-envelope, and the model forgot to escape a quote inside its
// own prose, which breaks strict JSON while every word of the answer is fine.
// We read the reply string tolerantly (the same quote rule as the streaming
// scanner), keep the optional question object only if it closed, then walk the
// actions array keeping every element that parses on its own. Returns null
// only when nothing at all was recoverable.
export function salvageEnvelope(
  text: string
): { reply: string; actions: unknown[]; question?: unknown; replyCut?: boolean } | null {
  // reply — read the JSON string that follows "reply":
  let reply = ''
  // True when the reply ran to the end of the text without a genuine closing
  // quote — the stream died mid-sentence, and the caller should say so.
  let replyCut = false
  // Where the reply's string value ended. The question search starts here so a
  // question SPELLED INSIDE the reply prose can never be salvaged as if the
  // model had asked it — same honesty constraint the streaming scanner applies.
  let replyEndIdx = 0
  const replyKey = text.indexOf('"reply"')
  if (replyKey >= 0) {
    let i = text.indexOf(':', replyKey)
    if (i >= 0) {
      i++
      while (i < text.length && text[i] !== '"') i++
      if (text[i] === '"') {
        i++
        let body = ''
        let esc = false
        let closed = false
        for (; i < text.length; i++) {
          const ch = text[i]
          if (esc) {
            body += ch
            esc = false
            continue
          }
          if (ch === '\\') {
            body += ch
            esc = true
            continue
          }
          if (ch === '"') {
            // An unescaped quote only closes the reply when the envelope
            // genuinely continues after it (the drive defect: an answer cut
            // mid-word at `a clearer "why"`). Same rule as the live scanner;
            // atEnd because this text is final.
            if (replyQuoteRole(text, i, true) === 'close') {
              closed = true
              break
            }
            body += ch
            continue
          }
          body += ch
        }
        replyEndIdx = i
        replyCut = !closed && body.length > 0
        // The body may carry the model's unescaped quotes; the shared
        // decoder handles them the same way the live scanner does.
        reply = decodeReplyFragment(body)
      }
    }
  }

  // question — the optional object between reply and actions. Kept only when
  // it closed before the cutoff; a half-written question is dropped, the same
  // policy as a half-written action. The raw object is returned unvalidated —
  // the caller pipes it through the same sanitiser as the fully-parsed path.
  let question: unknown | undefined
  const qKey = text.indexOf('"question"', replyEndIdx)
  if (qKey >= 0) {
    const colon = text.indexOf(':', qKey)
    const braceAt = colon >= 0 ? text.indexOf('{', colon) : -1
    if (braceAt >= 0) {
      let depth = 0
      let inStr = false
      let esc = false
      for (let j = braceAt; j < text.length; j++) {
        const ch = text[j]
        if (inStr) {
          if (esc) esc = false
          else if (ch === '\\') esc = true
          else if (ch === '"') inStr = false
          continue
        }
        if (ch === '"') inStr = true
        else if (ch === '{' || ch === '[') depth++
        else if (ch === '}' || ch === ']') {
          depth--
          if (depth === 0) {
            try {
              question = JSON.parse(text.slice(braceAt, j + 1))
            } catch {
              /* balanced but unreadable — treat as absent */
            }
            break
          }
        }
      }
    }
  }

  // actions — find the array, then collect complete top-level objects. The
  // array can be missing entirely (the cutoff landed inside the key itself);
  // that no longer aborts the salvage, because a complete question above is a
  // recoverable result on its own.
  const actions: unknown[] = []
  // Searched from the reply's true end, so "actions" spelled inside the prose
  // can never seed a fabricated array (same rule the question search applies).
  const actKey = text.indexOf('"actions"', replyEndIdx)
  let i = actKey >= 0 ? text.indexOf('[', actKey) : -1
  if (i >= 0) i++ // step past '['
  while (i > 0 && i < text.length) {
    while (i < text.length && ' \n\r\t,'.includes(text[i])) i++
    if (i >= text.length || text[i] === ']') break
    if (text[i] !== '{') break
    const objStart = i
    let depth = 0
    let inStr = false
    let esc = false
    let closed = false
    for (; i < text.length; i++) {
      const ch = text[i]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{' || ch === '[') depth++
      else if (ch === '}' || ch === ']') {
        depth--
        if (depth === 0) {
          i++
          closed = true
          break
        }
      }
    }
    if (!closed) break // truncated object — stop here
    try {
      actions.push(JSON.parse(text.slice(objStart, i)))
    } catch {
      // a malformed complete-looking object — skip it but keep going
    }
  }
  // A recovered reply alone is worth keeping — prose answers carry no actions
  // by design, and dropping one turned a single unescaped quote into an error
  // bubble over a perfectly good answer. Null only when NOTHING came back.
  if (reply.trim() === '' && actions.length === 0 && question === undefined) return null
  const out: { reply: string; actions: unknown[]; question?: unknown; replyCut?: boolean } = {
    reply,
    actions
  }
  if (question !== undefined) out.question = question
  if (replyCut) out.replyCut = true
  return out
}
