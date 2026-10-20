// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

// Every prompt in anthropic.ts that ASKS the model something already forbade
// inventing facts. The prompts that make the model WRITE did not, and one of
// them pushed the other way: generateDocument told it to produce "a genuinely
// useful first draft ... not an outline of placeholders", and the two sheet
// prompts demanded "realistic, useful values (never 'example 1')".
//
// That is not a harmless nudge. tools/local-ai-eval scored the CLOUD reference
// 4/9 on the office family against the shipped 4B's 6/9, and the judge's
// reasons were all confabulation: "states unsupplied facts about the team's
// wiki", "invented facts about the studio", a fabricated power-drill
// statistic, and design copy that added "Spring Sale" and "in store" to a
// brief containing neither. A stronger model follows an instruction more
// effectively, so the better the model, the more it invented.
//
// This test pins the fix and, more importantly, the SHAPE of the fix: write
// the prose freely, never assert an unsupplied specific as fact. A bare
// "invent nothing" would produce the empty skeleton the original clause was
// right to guard against.

const ROOT = join(__dirname, '..', '..')
const AI = join(ROOT, 'src', 'main', 'ai', 'anthropic.ts')
const src = readFileSync(AI, 'utf8')

// The rule TEXT lives in its own SDK-free module so the local provider can
// import the same strings instead of keeping a copy that drifts. The prompts
// that consume it stay in anthropic.ts, so this test reads both files.
const RULES = join(ROOT, 'src', 'main', 'ai', 'groundingRules.ts')
const rulesSrc = readFileSync(RULES, 'utf8')

/**
 * The retired phrasings are quoted in comments on purpose — the comment above
 * GROUNDING_RULE explains what went wrong by naming the clause that caused it.
 * Only the prompts themselves matter here, so strip comments before scanning
 * for a phrasing that must not come back.
 */
const code = (src + '\n' + rulesSrc).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/**
 * The model routes that produce content a person then reads, edits or sends.
 * A function reaching one of these is writing, not answering, so it needs a
 * grounding rule in its system prompt.
 */
const CONTENT_ROUTES = ['document', 'living_page', 'doc_rewrite'] as const

/**
 * Writers that carry their own grounding sentence instead of the shared
 * constant. Each is exempt for a stated reason, not by omission.
 */
const SELF_GROUNDED: Record<string, string> = {
  regenerateLivingPage:
    'Carries its own: "If the source material does not contain enough to answer, say so in one sentence — do not invent."',
  rewriteSelection:
    'Carries its own, narrower rule: a rewrite may only carry over facts already in the passage.',
  planDesignLayout:
    'Chooses a layout style id and page geometry for an outline that already exists. It is handed ' +
    'the content and writes no prose, so it has no opportunity to assert a fact.',
  suggestSheetColumns: 'Proposes column HEADERS, not data. No facts are asserted.',
  suggestFormula: 'Produces one spreadsheet formula. No facts are asserted.'
}

/**
 * Individual prompts inside a writer that assert no facts, keyed by id so that
 * moving one does not silently exempt a different prompt. The line number is
 * part of the id on purpose: if it shifts, the exemption is re-examined.
 */
const PROMPT_EXEMPT: Record<string, string> = {}

const GROUNDING_TOKENS = ['GROUNDING_RULE', 'SHEET_DATA_RULE']

interface Fn {
  name: string
  body: string
  node: ts.FunctionDeclaration
}

/** One system-prompt string built inside a writer, identified for the failure message. */
interface Prompt {
  fn: string
  varName: string
  line: number
  text: string
  id: string
}

/** Every top-level function declaration in the file, with its body source. */
const sourceFile = ts.createSourceFile(AI, src, ts.ScriptTarget.Latest, true)

function functions(): Fn[] {
  const out: Fn[] = []
  for (const st of sourceFile.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) {
      out.push({ name: st.name.text, body: st.body.getText(sourceFile), node: st })
    }
  }
  return out
}

/**
 * Every system prompt built inside a writer, one entry per declaration.
 *
 * Per-FUNCTION granularity is not enough and this is not hypothetical: a
 * mutation that stripped the rule from generateDocument's "doc" branch passed
 * a per-function check, because its other three branches still referenced one.
 * generateDocument builds four separate prompts, and fillSheetRange builds a
 * primary and a retry prompt, so each declaration is checked on its own.
 */
function prompts(): Prompt[] {
  const names = new Set(['system', 'baseSystem', 'strictSystem'])
  const out: Prompt[] = []
  for (const fn of writers()) {
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && names.has(n.name.text) && n.initializer) {
        const line = sourceFile.getLineAndCharacterOfPosition(n.getStart(sourceFile)).line + 1
        out.push({
          fn: fn.name,
          varName: n.name.text,
          line,
          text: n.initializer.getText(sourceFile),
          id: `${fn.name}/${n.name.text}@${line}`
        })
      }
      ts.forEachChild(n, visit)
    }
    ts.forEachChild(fn.node, visit)
  }
  return out
}

/** Functions that route to a content model — i.e. the writers. */
function writers(): Fn[] {
  const routes = new RegExp(`resolveModel\\((?:'|")(?:${CONTENT_ROUTES.join('|')})(?:'|")\\)`)
  return functions().filter((f) => routes.test(f.body))
}

describe('the shared grounding rules', () => {
  const grounding = rulesSrc.slice(
    rulesSrc.indexOf('export const GROUNDING_RULE ='),
    rulesSrc.indexOf('export const SHEET_DATA_RULE =')
  )
  const sheet = rulesSrc.slice(rulesSrc.indexOf('export const SHEET_DATA_RULE ='))

  it('is declared, exported, and imported by the prompts that use it', () => {
    expect(rulesSrc).toContain('export const GROUNDING_RULE =')
    expect(rulesSrc).toContain('export const SHEET_DATA_RULE =')
    expect(src).toContain("from './groundingRules'")
  })

  it('exists in exactly one place', () => {
    // Prompt text that exists twice drifts, and a local path running an older
    // rule than the cloud path is the failure this split exists to prevent.
    expect(src).not.toContain('const GROUNDING_RULE =')
    expect(src).not.toContain('const SHEET_DATA_RULE =')
  })

  // The three things the rule has to say. Soften any one of them and the
  // confabulation the eval caught comes back.
  it('forbids unsourceable external claims', () => {
    expect(grounding).toMatch(/statistic/i)
    expect(grounding).toMatch(/quotation|quote/i)
    expect(grounding).toMatch(/cannot source/i)
  })

  it("forbids inventing details of the reader's own world", () => {
    expect(grounding).toMatch(/did not supply/i)
    expect(grounding).toMatch(/customers|revenue|deadlines/i)
  })

  it('does not carry the unmeasured placeholder-restraint clause', () => {
    // Removed after measurement: cloud scored 26/34 without it and 21/34 with
    // it, and the regression it was meant to prevent was already disproved
    // (drafts got longer under the rule, not thinner). Pinned so it is not
    // re-added on the same plausible-sounding reasoning as last time.
    expect(grounding).not.toMatch(/sparingly/i)
    expect(grounding).not.toMatch(/most good writing needs none/i)
  })

  it('still permits writing, and names the placeholder as the alternative', () => {
    // Without this the rule produces an empty skeleton, which is the failure
    // the original "not an outline of placeholders" clause guarded against.
    expect(grounding).toMatch(/freely/i)
    expect(grounding).toMatch(/placeholder/i)
    expect(grounding).toMatch(/\[launch date\]|\[owner name\]/)
  })

  it('lets sheet data look real without asserting real figures', () => {
    expect(sheet).toMatch(/realistic/i)
    expect(sheet).toMatch(/never give figures for/i)
    expect(sheet).toMatch(/named company|named person/i)
  })
})

describe('retired phrasings', () => {
  // These are the exact strings that caused the invention. They must not come
  // back, in this file or any sibling prompt file.
  it('no longer tells the model to avoid placeholders', () => {
    expect(code).not.toContain('not an outline of placeholders')
  })

  it('no longer demands realistic values with "example 1" as the only counter-example', () => {
    expect(code).not.toContain('realistic, useful example data')
    expect(code).not.toContain('Produce realistic, useful values')
  })
})

describe('every content writer is grounded', () => {
  const found = writers()

  it('finds the writers at all (guards this test against going vacuously green)', () => {
    // If a refactor renames resolveModel or the route keys, this test would
    // otherwise pass by checking nothing.
    expect(found.length).toBeGreaterThanOrEqual(8)
    expect(found.map((f) => f.name)).toContain('generateDocument')
  })

  it('finds every prompt each multi-prompt writer builds', () => {
    const byFn = prompts().filter((p) => p.fn === 'generateDocument')
    // doc, sheet, map, slides — if this drops, the per-branch check below has
    // silently stopped covering a branch.
    expect(byFn).toHaveLength(4)
    expect(prompts().filter((p) => p.fn === 'fillSheetRange')).toHaveLength(2)
  })

  it.each(prompts().map((p) => [p.id, p] as const))('%s', (_id, p) => {
    const grounded = GROUNDING_TOKENS.some((t) => p.text.includes(t))
    const exempt = p.fn in SELF_GROUNDED || PROMPT_EXEMPT[p.id] !== undefined
    expect(
      grounded || exempt,
      `${p.id} is a system prompt in a content writer but references no grounding rule. ` +
        `Append GROUNDING_RULE (prose and copy) or SHEET_DATA_RULE (tabular data) to it, or add ` +
        `its id to PROMPT_EXEMPT with the reason it asserts no facts.`
    ).toBe(true)
  })

  it('every exemption names a function that still exists', () => {
    const names = new Set(functions().map((f) => f.name))
    for (const n of Object.keys(SELF_GROUNDED)) expect(names, `${n} is exempt but gone`).toContain(n)
  })

  it('every self-grounded writer really does carry its own rule', () => {
    for (const [name, why] of Object.entries(SELF_GROUNDED)) {
      if (why.startsWith('Carries its own')) {
        const fn = functions().find((f) => f.name === name)!
        expect(fn.body, `${name} is exempt as self-grounded but says nothing about inventing`).toMatch(
          /invent|plausible guess|licence to add/i
        )
      }
    }
  })
})
