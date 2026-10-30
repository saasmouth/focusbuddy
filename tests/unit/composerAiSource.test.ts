import { describe, it, expect } from 'vitest'

// The composer chip switches where AI runs (asked for 2026-10-30:
// "make the on this device button toggle ... between use local ai, and use
// claude, or use chat gpt").
//
// It used to be a DEAD LABEL. Once AI was set to run on this device the chip
// rendered "On this device" as a <span> and offered nothing — so the one
// setting most likely to be switched back was the one the composer refused to
// switch, and you had to know to go to Settings → AI to undo it.

const { readFileSync } = require('node:fs') as typeof import('node:fs')
const { join } = require('node:path') as typeof import('node:path')

const SRC = readFileSync(
  join(__dirname, '../..', 'src/renderer/src/components/assistant/ModelPickerChip.tsx'),
  'utf-8'
)

describe('the composer chip is a switch, not a label', () => {
  it('has no early return that replaces the control with a span', () => {
    expect(SRC).not.toMatch(/if \(aiMode === 'local'\) \{[\s\S]{0,400}?<span/)
    expect(SRC).not.toContain('composer-model-local')
  })

  it('offers all four places AI can run', () => {
    // Asserted on the SOURCE LIST, not on the rendered testid: that id is
    // built from a template literal, so grepping for the finished string
    // reports "missing" for something that is right there. The array is the
    // contract anyway — the testid is derived from it.
    for (const id of ['local', 'byok', 'openai', 'credits']) {
      expect(SRC, `source ${id} missing`).toMatch(new RegExp(`id: '${id}'`))
    }
    expect(SRC).toContain('composer-source-${src.id}')
    expect(SRC).toContain("label: 'On this device'")
    expect(SRC).toContain("label: 'Claude'")
    expect(SRC).toContain("label: 'ChatGPT'")
  })

  it('drives the SAME switch Settings does, rather than a second one', () => {
    // A local copy of this preference is how two controls start disagreeing
    // about where AI runs.
    expect(SRC).toContain('window.api.ai.setMode(mode)')
    expect(SRC).toContain('await syncCredits()')
  })

  it('still shows where it runs on the chip face', () => {
    expect(SRC).toContain("isLocal ? 'On this device'")
    expect(SRC).toContain("isOpenAi ? 'ChatGPT'")
  })

  it('hides the Claude models when Claude is not what answers', () => {
    // Offering Opus while the answer comes from a local model, or from
    // OpenAI, is a menu of things that do not happen.
    expect(SRC).toContain('const showModels = !isLocal && !isOpenAi')
    expect(SRC).toContain('{showModels &&')
  })

  it("treats 'auto' as credits, so the tick is never on nothing", () => {
    expect(SRC).toContain("aiMode === 'credits' || aiMode === 'auto'")
  })

  it('cannot fire two source changes at once', () => {
    expect(SRC).toContain('if (busy) return')
    expect(SRC).toContain('disabled={busy}')
  })
})
