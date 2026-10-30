import { describe, it, expect } from 'vitest'

// "Make ALL ai functionality have access to browsing" (the owner, 2026-10-30).
//
// Wiring eight surfaces is a one-off; keeping the ninth wired is the hard
// part. A surface added later that quietly skips research is invisible —
// it just answers from the model's memory, confidently, like the old ones
// did. So the list is asserted against the source.
//
// Adding a surface here is the point of the test, not a chore to work around:
// if a new AI entry point genuinely should not browse, say so in the skip
// list below with the reason, and the next reader inherits the decision
// rather than guessing at it.

const { readFileSync } = require('node:fs') as typeof import('node:fs')
const { join } = require('node:path') as typeof import('node:path')

const SRC = readFileSync(join(__dirname, '../..', 'src/main/ai/anthropic.ts'), 'utf-8')

/** Every AI surface that takes a user's intent and must be able to research it. */
const RESEARCHING_SURFACES = [
  'buildFromPrompt', // the desk builder — the owner's own example
  'suggestSetupWidgets', // "set this desk up for me"
  'suggestTableRows', // populate a table
  'suggestWidgetSetup', // fill a widget
  'suggestPageContent', // draft into a page
  'generateDocument', // doc / sheet / slides / map
  'generateDesignContent', // marketing copy
  'askWorkspace', // ask across the workspace
  'askWorkspaceStream'
]

function bodyOf(name: string): string {
  const at = SRC.indexOf(`export async function ${name}(`)
  expect(at, `${name} not found in anthropic.ts`).toBeGreaterThan(-1)
  const next = SRC.indexOf('\nexport ', at + 1)
  return SRC.slice(at, next === -1 ? SRC.length : next)
}

describe('every AI surface can research', () => {
  it.each(RESEARCHING_SURFACES)('%s reaches the research pass', (name) => {
    const body = bodyOf(name)
    // Either it calls the shared pass itself, or (suggestSetupWidgets) it
    // delegates to a surface that does and names the subject to research.
    const wired = body.includes('researchAndContext(') || body.includes('researchSubject')
    expect(wired, `${name} does not run the research pass`).toBe(true)
  })

  it.each(RESEARCHING_SURFACES)('%s takes the opt-in rather than deciding for the user', (name) => {
    const body = bodyOf(name)
    expect(body.includes('AiResearchOpts') || body.includes('opts')).toBe(true)
  })

  it('chat reads the pages it searched, not only their snippets', () => {
    // The chat pool is assembled inline in prepareChatCall rather than
    // through researchAndContext, because it has its own [n] numbering.
    expect(SRC).toContain('CHAT_PAGES_READ')
    expect(SRC).toContain('fetchPageText(r.url, CHAT_PAGE_CHARS)')
  })

  it('research is never on by default in the model layer', () => {
    // The default lives in researchFor(enabled, …): a surface that passes
    // nothing researches nothing. Asserted at the source of the rule.
    const research = readFileSync(join(__dirname, '../..', 'src/main/ai/research.ts'), 'utf-8')
    expect(research).toContain("if (!enabled) return { block: '', result: { queries: [], findings: [], skipped: 'off' } }")
  })

  it('on-device AI never reaches a search engine', () => {
    const research = readFileSync(join(__dirname, '../..', 'src/main/ai/research.ts'), 'utf-8')
    const at = research.indexOf('export async function research(')
    const body = research.slice(at)
    expect(body).toContain('localOnlyActive()')
    // And it must be checked BEFORE the search is made, not after.
    expect(body.indexOf('localOnlyActive()')).toBeLessThan(body.indexOf('searchWeb('))
  })
})
