import { describe, it, expect } from 'vitest'
import {
  parseAttentionCommand,
  hasAttentionCommand,
  isLeadingAttention,
  isCapturePrefix,
  CAPTURE_WORDS,
  LEADING_CAPTURE_WORD
} from '../../src/renderer/src/lib/attentionCommand'

// DEC-031 — @attention ANYWHERE is a deterministic capture. Leading is the
// pure capture gesture (nothing reaches the model); inline captures AND still
// sends the message with the token stripped.

describe('detection', () => {
  it('finds the token leading, trailing and mid-sentence — never inside a word', () => {
    expect(hasAttentionCommand('@attention call Bob')).toBe(true)
    expect(hasAttentionCommand('draft the deck @attention')).toBe(true)
    expect(hasAttentionCommand('remind me @attention to call Bob')).toBe(true)
    expect(hasAttentionCommand('@Attention: ship it')).toBe(true)
    // Not a command: part of an address or another word.
    expect(hasAttentionCommand('mail me at bob@attention.example')).toBe(false)
    expect(hasAttentionCommand('pay attention to this')).toBe(false)
    expect(hasAttentionCommand('@attentional bias')).toBe(false)
  })

  it('separates the leading gesture from an inline one', () => {
    expect(isLeadingAttention('@attention call Bob')).toBe(true)
    expect(isLeadingAttention('  @attention: call Bob')).toBe(true)
    expect(isLeadingAttention('call Bob @attention')).toBe(false)
  })
})

describe('parseAttentionCommand', () => {
  it('plain text is untouched and still sendable', () => {
    expect(parseAttentionCommand('what is the wifi password?')).toEqual({
      mode: 'none',
      captureText: '',
      messageText: 'what is the wifi password?'
    })
  })

  it('LEADING: the remainder is the capture and nothing is sent', () => {
    expect(parseAttentionCommand('@attention call Bob Thursday')).toEqual({
      mode: 'leading',
      captureText: 'call Bob Thursday',
      messageText: null
    })
    // Punctuated form, same result.
    expect(parseAttentionCommand('@attention: call Bob Thursday').captureText).toBe('call Bob Thursday')
  })

  it('INLINE: captures the message AND still sends it, token stripped', () => {
    // The operator's live case — this produced ONLY a page before DEC-031.
    const c = parseAttentionCommand('draft the Cetra pitch deck by friday @attention')
    expect(c.mode).toBe('inline')
    expect(c.captureText).toBe('draft the Cetra pitch deck by friday')
    expect(c.messageText).toBe('draft the Cetra pitch deck by friday')
  })

  it('INLINE mid-sentence closes the gap left by the strip', () => {
    const c = parseAttentionCommand('remind me @attention to call Bob')
    expect(c.captureText).toBe('remind me to call Bob')
    expect(c.messageText).toBe('remind me to call Bob')
  })

  it('a bare token captures nothing and sends nothing', () => {
    expect(parseAttentionCommand('@attention')).toEqual({
      mode: 'leading',
      captureText: '',
      messageText: null
    })
  })

  it('repeated tokens collapse without leaving double spaces', () => {
    const c = parseAttentionCommand('ship the deck @attention and call Bob @attention')
    expect(c.captureText).toBe('ship the deck and call Bob')
    expect(c.mode).toBe('inline')
  })

  it('the global regex is not stateful across calls (lastIndex reset)', () => {
    // A /g regex reused via .test() advances lastIndex — the classic bug that
    // makes every SECOND identical call return false.
    for (let i = 0; i < 4; i++) {
      expect(hasAttentionCommand('draft the deck @attention')).toBe(true)
      expect(parseAttentionCommand('draft the deck @attention').mode).toBe('inline')
    }
  })
})

describe('DEC-144 — @focus is the token, @attention stays an alias', () => {
  it('both words capture, leading and inline', () => {
    expect(parseAttentionCommand('@focus call Bob Thursday')).toEqual({
      mode: 'leading',
      captureText: 'call Bob Thursday',
      messageText: null
    })
    expect(parseAttentionCommand('@attention call Bob Thursday').mode).toBe('leading')
    expect(parseAttentionCommand('draft the deck by friday @focus').mode).toBe('inline')
    expect(hasAttentionCommand('mail me at me@focus.example')).toBe(false)
  })

  it('one prefix rule for every picker', () => {
    for (const p of ['', 'f', 'FO', 'focus', 'a', 'att', 'attention']) expect(isCapturePrefix(p)).toBe(true)
    for (const p of ['x', 'fox', 'attend', 'focused']) expect(isCapturePrefix(p)).toBe(false)
    expect(CAPTURE_WORDS[0]).toBe('focus')
    expect(LEADING_CAPTURE_WORD.exec('focus: call Bob')?.[1]).toBe('call Bob')
    expect(LEADING_CAPTURE_WORD.exec('@attention call Bob')?.[1]).toBe('call Bob')
  })
})
