// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { splitQuoted } from '../../src/renderer/src/lib/mailBodyText'
import { widgetToText } from '../../src/shared/widgetText'
import type { Widget } from '../../src/shared/types'

// An email on a desk, read as a document.
//
// The distinction that matters: the 'inbox' widget is a live QUERY, showing whatever
// currently matches a rule. This is one piece of correspondence that belongs to this
// work — the lease, the quote, the levy notice — and it stays on the desk whether or
// not it still matches any filter, and whether or not it is still in the inbox.

const ROOT = join(__dirname, '..', '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8')

describe('quoted history is folded away', () => {
  // A reply chain repeats every previous message, so the fifth reply is mostly text
  // the reader has already seen and the new sentence is buried at the top.
  it('cuts at the standard attribution line', () => {
    const { main, quoted } = splitQuoted(
      'Yes, Friday works.\n\nOn Tue, 3 Mar 2026 at 09:14, Dana Reed wrote:\n> Are you free Friday?'
    )
    expect(main).toBe('Yes, Friday works.')
    expect(quoted).toContain('Are you free Friday?')
  })

  it('cuts at a bare quote marker', () => {
    const { main, quoted } = splitQuoted('Agreed.\n> the original text')
    expect(main).toBe('Agreed.')
    expect(quoted).toBe('> the original text')
  })

  it('cuts at a forwarded-message separator', () => {
    const { main } = splitQuoted('See below.\n---------- Forwarded message ----------\nFrom: someone')
    expect(main).toBe('See below.')
  })

  it('leaves a message with no quoted history entirely alone', () => {
    const { main, quoted } = splitQuoted('Just the one paragraph.')
    expect(main).toBe('Just the one paragraph.')
    expect(quoted).toBe('')
  })

  it('does not swallow a message that OPENS with a quote', () => {
    // If the cut were at index 0 there would be no main text left, and the card
    // would look empty. Better to show everything than to show nothing.
    const { main } = splitQuoted('> quoted first\nthen my reply')
    expect(main).toContain('quoted first')
  })
})

describe('Plexii can read a pinned email', () => {
  const mk = (content: string): Widget =>
    ({ id: 'w1', taskId: 'desk1', kind: 'mail-thread', content, title: 'Email' }) as unknown as Widget

  const pinned = mk(
    JSON.stringify({ mode: 'one', uids: [42], subject: 'Lease renewal', fromName: 'Dana Reed' })
  )

  it('names the email even with no mail resolver at hand', () => {
    // A caller that cannot read mail must still get something truthful, not a blank.
    const t = widgetToText(pinned).text
    expect(t).toContain('Lease renewal')
    expect(t).toContain('Dana Reed')
  })

  it('reads the message when the resolver can supply it', () => {
    const t = widgetToText(pinned, {
      mailItems: () => [
        { uid: 42, fromName: 'Dana Reed', subject: 'Lease renewal', date: Date.UTC(2026, 2, 14), seen: true },
        { uid: 99, fromName: 'Someone else', subject: 'Unrelated', date: 0, seen: true }
      ]
    }).text
    expect(t).toContain('uid 42')
    expect(t).toContain('Lease renewal')
    // Only what this widget pinned — not the whole mailbox the resolver returned.
    expect(t).not.toContain('Unrelated')
  })

  it('says so when the pinned message is not in the local copy', () => {
    const t = widgetToText(pinned, { mailItems: () => [] }).text
    expect(t).toMatch(/not in the local mail copy/i)
    // And still names it, so the desk is not full of anonymous cards.
    expect(t).toContain('Lease renewal')
  })

  it('distinguishes a thread from a single message', () => {
    const thread = mk(JSON.stringify({ mode: 'thread', uids: [42], subject: 'Lease renewal' }))
    expect(widgetToText(thread).text).toContain('whole thread')
    expect(widgetToText(pinned).text).not.toContain('whole thread')
  })

  it('survives unparseable content rather than throwing', () => {
    expect(() => widgetToText(mk('not json'))).not.toThrow()
    expect(widgetToText(mk('not json')).text).toContain('pinned email')
  })
})

describe('the kind is registered everywhere the analogue is', () => {
  // A new widget kind fails SILENTLY: renderWidget ends in `default: return null`,
  // so a missed registration is a blank card rather than a build error. chat-thread
  // is the template, so this checks the same files mention mail-thread.
  const FILES = [
    'src/shared/types.ts',
    'src/renderer/src/lib/widgetCatalog.ts',
    'src/renderer/src/components/widgets/renderWidget.tsx',
    'src/renderer/src/lib/renderWidgetInline.tsx',
    'src/renderer/src/lib/deskColumns.ts',
    'src/shared/publicDesk.ts',
    'src/shared/widgetText.ts'
  ]
  for (const f of FILES) {
    it(`registered in ${f}`, () => expect(read(f)).toContain('mail-thread'))
  }

  it('is never shared on a public desk', () => {
    // Somebody else's correspondence. The share path must refuse it by name.
    expect(read('src/shared/publicDesk.ts')).toMatch(/'mail-thread':\s*'Email — not available publicly'/)
  })

  it('is not offerable from the widget picker, since an empty one holds no message', () => {
    const cat = read('src/renderer/src/lib/widgetCatalog.ts')
    const block = cat.slice(cat.indexOf("kind: 'mail-thread'"), cat.indexOf("kind: 'chat-thread'"))
    expect(block).toContain('hideFromPicker: true')
  })
})
