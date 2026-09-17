// A generated widget that was cut off mid-write used to be saved as a finished
// one.
//
// Found in the user's own workspace: a "Route Optimizer" widget, 2894 bytes,
// ending mid-attribute (`id="sDepotLng" in`), with no <style> and no <script>
// at all. It rendered as unstyled markup that did nothing, and nothing anywhere
// said why — because a truncated generation passes every check there was: it is
// not empty, it does contain markup, and it is under the byte cap.
//
// The parts arrive in one order — markup, then styles, then behaviour — so a cut
// lands after the markup and before either of the other two. That is precisely
// "ugly, squished together, and half of it doesn't work".
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = readFileSync(
  join(__dirname, '..', '..', 'src', 'main', 'ai', 'customWidget.ts'),
  'utf-8'
)

describe('the generator refuses an unfinished widget', () => {
  it('checks stop_reason, which is the authoritative signal', () => {
    expect(SRC).toContain("stop_reason as string) === 'max_tokens'")
  })

  it('refuses rather than saving, and says what to do instead', () => {
    const at = SRC.indexOf("=== 'max_tokens'")
    const block = SRC.slice(at, at + 700)
    expect(block).toContain('ok: false')
    expect(block).toContain('has not been saved')
    expect(block).toMatch(/simpler|two steps/)
  })

  it('has room for a whole small application, not a fragment of one', () => {
    // 8000 was not enough for a widget with markup, a stylesheet AND behaviour.
    const m = /max_tokens: (\d+),\n\s*system: systemPrompt/.exec(SRC)
    expect(m, 'the widget generation call should be findable').toBeTruthy()
    expect(Number(m![1])).toBeGreaterThanOrEqual(16000)
  })

  it('has a second net that does not depend on the provider reporting one', () => {
    expect(SRC).toContain('came back unfinished')
  })
})

// The mid-tag detector, exercised directly. This is the fallback for a provider
// that does not report a stop reason, so it has to be right on its own.
function stoppedMidTag(code: string): boolean {
  const lastClose = code.lastIndexOf('>')
  return lastClose < code.length - 1 && code.slice(lastClose + 1).includes('<')
}

describe('detecting markup that stops inside a tag', () => {
  it('catches the exact shape that shipped', () => {
    expect(stoppedMidTag('<div class="a"></div><label class="f"><input id="x" in')).toBe(true)
  })

  it('catches a tag opened and never closed', () => {
    expect(stoppedMidTag('<p>hello</p><div')).toBe(true)
  })

  it('passes a complete document', () => {
    expect(stoppedMidTag('<div><p>hi</p></div>')).toBe(false)
  })

  it('passes markup with trailing text or whitespace', () => {
    expect(stoppedMidTag('<p>hi</p>\n\n')).toBe(false)
    expect(stoppedMidTag('<p>hi</p> trailing words')).toBe(false)
  })

  it('does not flag a comparison operator inside a finished script', () => {
    // `a < b` after the last tag would be a false positive; the last `>` is the
    // script's own closing tag, so there is nothing after it.
    expect(stoppedMidTag('<script>if (a < b) { go() }</script>')).toBe(false)
  })

  it('handles an empty or markup-free string without claiming truncation', () => {
    expect(stoppedMidTag('')).toBe(false)
    expect(stoppedMidTag('just words')).toBe(false)
  })
})

describe('the host gives the body padding rather than asking for it', () => {
  it('sets it in the injected theme', () => {
    const sandbox = readFileSync(
      join(__dirname, '..', '..', 'src', 'shared', 'customWidgetSandbox.ts'),
      'utf-8'
    )
    expect(sandbox).toContain('padding: 12px')
  })

  it('stops telling the model to add its own', () => {
    // ADR-0009's own principle: a control the model has to remember to include
    // is not a control. A widget flush to every edge is that failure, smaller.
    expect(SRC).not.toContain('padding of your own')
    expect(SRC).toContain('already has 12px of padding')
  })
})
