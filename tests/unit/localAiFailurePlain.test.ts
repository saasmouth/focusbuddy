// "PlexiiBrain ranks by passage", owner's 4.3.41 check: an answer AND "The
// on-device model could not produce a reply for this request (no JSON object
// was found). Nothing was sent anywhere…". 4.3.41 cannot write that sentence;
// it was saved with a PlexiiAssist turn under 4.3.40 and is shown
// again whenever that conversation is reopened. The two saved copies on the
// owner's machine are replayed here verbatim.
import { describe, it, expect } from 'vitest'
import { plainLocalFailure } from '../../src/shared/localAiFailure'

const SAVED_4340 =
  'The on-device model could not produce a reply for this request (no JSON object was found). Nothing was sent anywhere. Try again, rephrase it, or use your own key for PlexiiAssist and PlexiiBrain answers in Settings → AI.'

describe('a failure line is shown in plain words, including one saved by 4.3.40', () => {
  it('the saved 4.3.40 sentence becomes the current wording, with no parser detail', () => {
    const out = plainLocalFailure(SAVED_4340)
    expect(out).not.toMatch(/JSON/i)
    expect(out).toBe(
      'The on-device model could not write a reply this time. Nothing was sent anywhere. Try again or rephrase it, or use your own key for PlexiiAssist and PlexiiBrain answers in Settings → AI.'
    )
  })
  it('other contracts and reasons in the old template are handled the same way', () => {
    const out = plainLocalFailure(
      'The on-device model could not produce an answer from your documents for this request (the object must have a string "answer"). Nothing was sent anywhere. Try again, rephrase it, or use your own key for PlexiSearch in Settings → AI.'
    )
    expect(out).toContain('could not write an answer from your documents this time')
    expect(out).not.toMatch(/object must have|JSON/)
  })
  it('a parenthesised parser reason in any other line is dropped, the rest kept', () => {
    expect(plainLocalFailure('Something failed (no JSON object was found). Nothing was sent anywhere.')).toBe(
      'Something failed. Nothing was sent anywhere.'
    )
  })
  it('plain messages, including the current ones, are untouched', () => {
    for (const m of [
      'The on-device model ran out of room before it finished a reply. Nothing was sent anywhere. Ask for something shorter or narrower, or use your own key for PlexiiAssist in Settings → AI.',
      'Conversation hit the model context window. Start a fresh session.',
      'Something went wrong.'
    ]) {
      expect(plainLocalFailure(m)).toBe(m)
    }
    expect(plainLocalFailure(null)).toBeNull()
    expect(plainLocalFailure(undefined)).toBeUndefined()
  })
})

describe('the chat store applies it where saved failures are shown', () => {
  it('restored traces, a failure-only turn, and a live failure all go through plainLocalFailure', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'renderer', 'src', 'stores', 'chat.ts'), 'utf8')
    expect(src).toMatch(/error: plainLocalFailure\(t\.error\)/)
    expect(src).toMatch(/m\.content === m\.trace\.error \? plainLocalFailure\(m\.content\)/)
    expect(src).toMatch(/plainLocalFailure\(resp\.error \?\? 'Something went wrong\.'\)\)/)
  })
})

// The real on-device output for every JSON call PlexiiBrain makes on the local
// path, captured with the long-document set-up (LBP-1): each parses on its own
// contract, so none of them can raise the warning on 4.3.41. The warning the
// owner saw is the saved one, replayed above and below.
describe('replay: captured on-device output from every PlexiiBrain entry point', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { parseStructured } = await import('../../src/main/ai/local/structuredOutput')
  const fx = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'localAi', 'brainPassageCaptures.json'), 'utf8')) as {
    ownerStoredWarning: string
    captures: Array<{ _case: string; contract: string; shape: 'object'; text: string }>
  }
  // The marker each call's instructions carry (the contract is recognised from them).
  const SYSTEM: Record<string, string> = {
    'chat-envelope': 'Return a JSON object {"reply": "...", "actions": []}.',
    'brain-answer': 'Schema: {"answer":"string (may include [n] citation markers)","sources":[1,2]}',
    'workspace-actions': 'Return ONLY a single JSON object. Schema: {"actions":[ ... ]}'
  }
  it('there is a capture for each contract', () => {
    expect(new Set(fx.captures.map((c) => c.contract))).toEqual(new Set(['chat-envelope', 'brain-answer', 'workspace-actions']))
  })
  for (const c of fx.captures) {
    it(`${c._case}: parses on its contract`, () => {
      const r = parseStructured(c.text, c.shape, 'chat', SYSTEM[c.contract])
      expect(r.ok).toBe(true)
      expect(r.contract?.id).toBe(c.contract)
    })
  }
  it("the owner's saved warning, as reopened, has no parser detail", () => {
    expect(plainLocalFailure(fx.ownerStoredWarning)).not.toMatch(/JSON|could not produce/)
  })
})
