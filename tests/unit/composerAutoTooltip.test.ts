// The Auto pill's tooltip says what Auto actually does.
//
// It said "Smart: URLs open, take-me-to navigates, everything else asks" for
// two months after 961e3436 made a short phrase in a new chat search the web.
// The tooltip is now built from the same constants composerOmniIntents uses
// (lib/omniIntent.ts). This test closes the loop the other way: every line of
// the tooltip has examples run through the real router, the limits it quotes
// are probed at their edges, and a rule with no examples fails here.

import { describe, it, expect } from 'vitest'
import {
  composerOmniIntents,
  COMPOSER_AUTO_RULES,
  COMPOSER_AUTO_TOOLTIP,
  COMPOSER_COMMAND_MAX_CHARS,
  COMPOSER_SHORT_PHRASE_MAX_WORDS,
  NAV_VERBS_FIRM,
  NAV_VERBS_SOFT,
  type ComposerAutoRuleId,
  type OmniIntentKind,
  type OmniTarget
} from '../../src/renderer/src/lib/omniIntent'

const TARGETS: OmniTarget[] = [
  { kind: 'page', id: 'calendar', title: 'Calendar' },
  { kind: 'desk', id: 'desk-1', title: 'Wedding' },
  { kind: 'document', id: 'doc-1', title: 'Launch budget' }
]

/** What Enter does: the first intent, or asking Plexii when the router offers nothing (pure chat). */
function enterDoes(input: string, midConversation = false): OmniIntentKind {
  return composerOmniIntents(input, TARGETS, { chatFirst: midConversation })[0]?.kind ?? 'ask'
}

type Example = { input: string; mid?: boolean }
// Every rule, with inputs that reach it and NOT an earlier one, both in a new
// chat and mid-conversation unless the rule is about one of them.
const EXAMPLES: Record<ComposerAutoRuleId, { does: OmniIntentKind; examples: Example[] }> = {
  composed: {
    does: 'ask',
    examples: [
      { input: 'take me to\nthe wedding desk' },
      { input: 'plexi.so\nis this right' },
      { input: 'x'.repeat(COMPOSER_COMMAND_MAX_CHARS + 1) },
      { input: `go to ${'y'.repeat(COMPOSER_COMMAND_MAX_CHARS)}`, mid: true }
    ]
  },
  address: {
    does: 'url',
    examples: [{ input: 'plexi.so' }, { input: 'https://www.figma.com/files', mid: true }]
  },
  'goto-here': {
    does: 'goto',
    examples: [
      { input: 'take me to my wedding desk' },
      { input: 'go to calendar', mid: true },
      { input: 'open launch budget' },
      { input: 'show wedding', mid: true }
    ]
  },
  'goto-web': {
    does: 'search',
    examples: [
      { input: 'take me to buffalo wild wings menu' },
      { input: 'go to the nearest post office', mid: true },
      { input: 'goto hacker news' }
    ]
  },
  question: {
    does: 'ask',
    examples: [
      { input: 'how do I become a great SDR?' },
      { input: 'standing desks any good?' },
      { input: 'write a toast for the wedding' },
      { input: 'summarize this week', mid: true }
    ]
  },
  'short-new': {
    does: 'search',
    examples: [
      { input: 'standing desk setups' },
      { input: 'open a savings account' },
      { input: Array.from({ length: COMPOSER_SHORT_PHRASE_MAX_WORDS }, (_, i) => `word${i}`).join(' ') }
    ]
  },
  'short-mid': {
    does: 'ask',
    examples: [
      { input: 'sounds good', mid: true },
      { input: 'open a savings account', mid: true },
      { input: Array.from({ length: COMPOSER_SHORT_PHRASE_MAX_WORDS }, (_, i) => `word${i}`).join(' '), mid: true }
    ]
  },
  longer: {
    does: 'ask',
    examples: [
      { input: Array.from({ length: COMPOSER_SHORT_PHRASE_MAX_WORDS + 1 }, (_, i) => `word${i}`).join(' ') },
      { input: 'the venue confirmed the date for the second weekend of May' },
      { input: 'the venue confirmed the date for the second weekend of May', mid: true }
    ]
  }
}

describe('the Auto pill tooltip and the composer router agree', () => {
  it('every line of the tooltip has examples, and every example does what its line says', () => {
    expect(Object.keys(EXAMPLES).sort()).toEqual(COMPOSER_AUTO_RULES.map((r) => r.id).sort())
    for (const rule of COMPOSER_AUTO_RULES) {
      const { does, examples } = EXAMPLES[rule.id]
      expect(examples.length, rule.id).toBeGreaterThan(0)
      for (const ex of examples) {
        expect(enterDoes(ex.input, ex.mid), `"${rule.says}" — ${JSON.stringify(ex.input)}${ex.mid ? ' (mid-conversation)' : ''}`).toBe(does)
      }
    }
  })

  it('the line’s own verb matches what the router does', () => {
    const verb: Record<OmniIntentKind, RegExp> = { ask: /asks Plexii\.$/, search: /searches the web/, url: /opens/, goto: /goes there\.$/ }
    for (const rule of COMPOSER_AUTO_RULES) expect(rule.says, rule.id).toMatch(verb[EXAMPLES[rule.id].does])
  })

  it('the limits it quotes are the router’s limits, probed at the edge', () => {
    const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')
    expect(COMPOSER_AUTO_TOOLTIP).toContain(`up to ${COMPOSER_SHORT_PHRASE_MAX_WORDS} words searches the web`)
    expect(enterDoes(words(COMPOSER_SHORT_PHRASE_MAX_WORDS))).toBe('search')
    expect(enterDoes(words(COMPOSER_SHORT_PHRASE_MAX_WORDS + 1))).toBe('ask')

    expect(COMPOSER_AUTO_TOOLTIP).toContain(`over ${COMPOSER_COMMAND_MAX_CHARS} characters`)
    const atLimit = `go to ${'z'.repeat(COMPOSER_COMMAND_MAX_CHARS - 6)}`
    expect(atLimit).toHaveLength(COMPOSER_COMMAND_MAX_CHARS)
    expect(enterDoes(atLimit)).toBe('search')
    expect(enterDoes(`${atLimit}z`)).toBe('ask')
  })

  it('names every navigation verb the router acts on (the typo alias aside), and only those', () => {
    for (const v of [...NAV_VERBS_FIRM.filter((x) => x !== 'goto'), ...NAV_VERBS_SOFT]) {
      expect(COMPOSER_AUTO_TOOLTIP).toContain(`“${v}”`)
      expect(enterDoes(`${v} wedding`), v).toBe('goto')
    }
    const firmLine = COMPOSER_AUTO_RULES.find((r) => r.id === 'goto-web')!.says
    for (const v of NAV_VERBS_SOFT) {
      expect(firmLine).not.toContain(`“${v}”`)
      // A soft verb naming nothing is not navigation: it falls to the phrase rules.
      expect(enterDoes(`${v} the nearest post office`, true), v).toBe('ask')
    }
  })

  it('reads as the app speaks: the rule in order, where Plexii answers, no stale claim', () => {
    expect(COMPOSER_AUTO_TOOLTIP).toBe(
      [
        'Auto: Enter does the first of these that fits.',
        '• A message on several lines, or over 160 characters, asks Plexii.',
        '• A web address opens the site.',
        '• “take me to”, “go to”, “open” or “show” with the name of one of your desks, pages or documents goes there.',
        '• “take me to” or “go to” anything else searches the web for it.',
        '• A question, or a request like “write…” or “summarize…”, asks Plexii.',
        '• In a new chat, a phrase of up to 6 words searches the web.',
        '• Once the chat has started, a phrase that short asks Plexii.',
        '• Anything longer asks Plexii.',
        'Plexii answers on this device or in the cloud, as set in Settings › AI.',
        'When there is a choice, the chips above the box show what Enter will do, and Tab switches between them.'
      ].join('\n')
    )
    expect(COMPOSER_AUTO_TOOLTIP).not.toMatch(/everything else asks/i)
    expect(COMPOSER_AUTO_TOOLTIP).not.toMatch(/Plexi(?!i)|PlexiDesk/)
  })
})
