// @vitest-environment node
//
// Replying is commenting, so it needs an account too.
//
// 9d asked for the second line to be PROVEN rather than only read. The first
// line is the panel, which withholds the reply box when commenting is not
// allowed, and docComments.spec.ts asserts that in the running app — it failed
// "Expected: 0, Received: 1" before the fix. What was left unproven is the
// refusal inside the handler, for a caller that does not come through the
// panel.
//
// SO THE DECISION WAS EXTRACTED AND IS CALLED HERE EXACTLY AS THE HANDLERS
// CALL IT. The alternative was rendering DocumentEditorView, which needs four
// stores, a TipTap editor and window.api mocked — a test of the mocks, and a
// weaker statement about the product than the two halves below. The second
// half is what makes the first non-vacuous: a gate nothing calls proves
// nothing, and that is precisely the state replyComment was in.

import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { requireCommentAuthor } from '../../src/renderer/src/components/documents/editor/commentAuthorGate'

const HOST = 'src/renderer/src/components/views/DocumentEditorView.tsx'

/** Source with comments stripped, so prose about the rule cannot satisfy it. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/**
 * One function's body, by name: from its signature to the next declaration at
 * the same indent. Crude, and checked by the length assertions below rather
 * than trusted.
 */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) return ''
  const rest = src.slice(start)
  const next = rest.slice(1).search(/\n {2}(?:async )?function /)
  return next < 0 ? rest : rest.slice(0, next + 1)
}

describe('the gate itself', () => {
  it('refuses when there is no account, and asks for sign-in instead', () => {
    const prompt = vi.fn()
    expect(requireCommentAuthor(null, prompt)).toBe(false)
    expect(prompt, 'the person is told what to do, not silently ignored').toHaveBeenCalledTimes(1)
  })

  it('refuses an undefined account the same way — the store is undefined before it boots', () => {
    const prompt = vi.fn()
    expect(requireCommentAuthor(undefined, prompt)).toBe(false)
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('allows a signed-in account, and does not prompt', () => {
    const prompt = vi.fn()
    expect(requireCommentAuthor({ id: 'acc_1' }, prompt)).toBe(true)
    expect(prompt, 'nothing to ask for').not.toHaveBeenCalled()
  })
})

describe('both of the local host’s write paths go through it', () => {
  // The half that matters. replyComment was unguarded while addComment was
  // guarded, and nothing said so — so this asserts it of EACH path by name,
  // not of the file as a whole, where one call would cover for the other.
  const src = code(HOST)

  it('reads the host and finds both handlers, or the assertions below are empty', () => {
    expect(src.length, 'the host source was not read').toBeGreaterThan(500)
    for (const fn of ['addComment', 'replyComment']) {
      expect(fnBody(src, fn).length, `${fn} was not found in ${HOST}`).toBeGreaterThan(80)
    }
  })

  it('addComment refuses without an account', () => {
    expect(fnBody(src, 'addComment')).toMatch(/requireCommentAuthor\(/)
  })

  it('replyComment refuses without an account — the defect this is here for', () => {
    expect(fnBody(src, 'replyComment')).toMatch(/requireCommentAuthor\(/)
  })

  it('and neither rolls its own check, which is how the two drifted apart', () => {
    for (const fn of ['addComment', 'replyComment']) {
      expect(fnBody(src, fn), `${fn} should call the shared gate, not test account itself`).not.toMatch(
        /if \(!account\)/
      )
    }
  })
})
