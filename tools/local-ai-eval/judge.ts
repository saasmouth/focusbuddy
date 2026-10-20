// The quality judge: a cloud model scores one output against a rubric and the
// source material. Used only by the eval harness, never by the app, and its
// spend is the evaluator's, not a user's. The key comes from the environment
// (ANTHROPIC_API_KEY) and is never printed or written anywhere.
//
// The judge sees the task, the rubric, the source facts and the output, and
// must answer with {"score": 1-5, "reason": "..."}. A score of 4 or 5 passes.
// It does NOT see which model produced the output.

import Anthropic from '@anthropic-ai/sdk'

export const JUDGE_MODEL = 'claude-sonnet-5-5'
export const JUDGE_PASS = 4

export interface Verdict {
  score: number
  reason: string
}

const SYSTEM =
  'You are a strict evaluator of an AI assistant inside a work app. You are given a task, a rubric, ' +
  'the source material the answer must be faithful to, and the assistant output. Score 1-5:\n' +
  '5 = fully meets the rubric, accurate, nothing invented.\n' +
  '4 = meets the rubric with minor issues a user would accept.\n' +
  '3 = partly useful but misses something the rubric requires, or has a noticeable flaw.\n' +
  '2 = mostly fails the rubric.\n' +
  '1 = wrong, empty, or invents facts not in the source.\n' +
  'Any invented fact, figure, name or claim of having done something caps the score at 2. ' +
  'Judge only against the rubric and source; do not reward length. ' +
  'Reply with ONLY a JSON object: {"score": <1-5>, "reason": "<one sentence>"}.'

let client: Anthropic | null = null

export function judgeAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY)
}

export async function judge(input: {
  task: string
  rubric: string
  context?: string
  output: string
}): Promise<Verdict> {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 4 })
  const user =
    `TASK:\n${input.task}\n\nRUBRIC:\n${input.rubric}\n\n` +
    (input.context ? `SOURCE MATERIAL:\n${input.context.slice(0, 60000)}\n\n` : '') +
    `ASSISTANT OUTPUT:\n${input.output.slice(0, 60000) || '(empty)'}`
  const resp = await client.messages.create({
    model: JUDGE_MODEL,
    // Sonnet 5.5 thinks adaptively by default; a small budget is spent before
    // any answer is written (measured: empty or cut-off verdicts at 400).
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{ role: 'user', content: user }]
  })
  const text = resp.content.map((b) => ('text' in b ? b.text : '')).join('')
  const m = text.match(/\{[\s\S]*\}/)
  try {
    const v = JSON.parse(m ? m[0] : text) as { score?: unknown; reason?: unknown }
    const score = Number(v.score)
    if (!Number.isFinite(score)) throw new Error('no score')
    return { score, reason: String(v.reason ?? '') }
  } catch {
    // A verdict cut off mid-reason still states its score first.
    const s = /"score"\s*:\s*([1-5])/.exec(text)
    if (s) return { score: Number(s[1]), reason: text.replace(/^[\s\S]*?"reason"\s*:\s*"/, '').slice(0, 300) }
    return { score: 0, reason: `judge reply unparseable: ${text.slice(0, 120)} (stop: ${resp.stop_reason})` }
  }
}
