import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { mentionHref, parseMentionHref, type TextMention } from '@shared/mentionText'
import { openMention } from '../../MentionText'

// `@` inside a rich-text document.
//
// The plain-text fields store a markdown-shaped token, because a string is all
// they have. A Tiptap document has marks, so a mention here is a real LINK --
// the title as text, plexii:// as the href. That means it renders, copies,
// exports and round-trips through the document's own HTML with no special
// handling anywhere, and the editor's existing link machinery draws it.
//
// The query detection is deliberately the same rule as the plain-text one: an
// `@` must start a word, so an email address never opens a picker.

export interface DocMentionQuery {
  query: string
  /** Document positions of the `@…` being typed. */
  from: number
  to: number
  /** Where to put the picker, in viewport coordinates. */
  rect: { top: number; left: number; bottom: number } | null
}

export interface DocMentionHooks {
  onQuery: (q: DocMentionQuery | null) => void
  /** Return true if the key was consumed (the picker is open and handled it). */
  onKeyDown: (event: KeyboardEvent) => boolean
}

export const docMentionKey = new PluginKey('docMentions')

/** Detect the `@…` immediately before the caret, if any. */
export function queryBeforeCaret(textBefore: string): { query: string; length: number } | null {
  // Walk back to the nearest '@' without crossing whitespace.
  let i = textBefore.length - 1
  while (i >= 0) {
    const ch = textBefore[i]
    if (ch === '@') break
    if (ch === '\n' || ch === ' ' || ch === '\t') return null
    i--
  }
  if (i < 0 || textBefore[i] !== '@') return null
  const before = i > 0 ? textBefore[i - 1] : ''
  // Must start a word: an @ mid-word is an address somebody is writing out.
  if (before && !/[\s(["'<>,;:]/.test(before)) return null
  return { query: textBefore.slice(i + 1), length: textBefore.length - i }
}

export const DocMentions = Extension.create<{ hooks: DocMentionHooks | null }>({
  name: 'docMentions',
  addOptions() {
    return { hooks: null }
  },
  addProseMirrorPlugins() {
    const hooks = (): DocMentionHooks | null => this.options.hooks
    return [
      new Plugin({
        key: docMentionKey,
        view: () => ({
          update: (view) => {
            const h = hooks()
            if (!h) return
            const { selection } = view.state
            if (!selection.empty) {
              h.onQuery(null)
              return
            }
            const $from = selection.$from
            const textBefore = $from.parent.textBetween(
              Math.max(0, $from.parentOffset - 80),
              $from.parentOffset,
              undefined,
              '￼'
            )
            const found = queryBeforeCaret(textBefore)
            if (!found) {
              h.onQuery(null)
              return
            }
            const from = selection.from - found.length
            let rect: DocMentionQuery['rect'] = null
            try {
              const c = view.coordsAtPos(from)
              rect = { top: c.top, left: c.left, bottom: c.bottom }
            } catch {
              rect = null
            }
            h.onQuery({ query: found.query, from, to: selection.from, rect })
          },
          destroy: () => hooks()?.onQuery(null)
        }),
        props: {
          handleKeyDown: (_view, event) => hooks()?.onKeyDown(event) ?? false,
          // Ordinary links in a document deliberately do NOT open on click --
          // the editor shows an edit popover instead. A mention is the
          // exception: it is a link whose entire purpose is to be followed, so
          // a plain click navigates and everything else behaves as before.
          handleClick: (_view, _pos, event) => {
            const target = event.target as HTMLElement | null
            const anchor = target?.closest?.('a') as HTMLAnchorElement | null
            const href = anchor?.getAttribute('href') ?? ''
            if (!href.startsWith('plexii://')) return false
            const parsed = parseMentionHref(href)
            if (!parsed) return false
            event.preventDefault()
            openMention(parsed)
            return true
          }
        }
      })
    ]
  }
})

/**
 * Replace the `@…` with a linked mention.
 *
 * The trailing space matters: without it the caret sits inside the link mark
 * and the next word typed silently becomes part of the link.
 */
export function insertDocMention(
  editor: { chain: () => any },
  range: { from: number; to: number },
  mention: TextMention
): void {
  editor
    .chain()
    .focus()
    .deleteRange(range)
    .insertContent([
      {
        type: 'text',
        text: mention.title || 'Untitled',
        marks: [{ type: 'link', attrs: { href: mentionHref(mention) } }]
      },
      { type: 'text', text: ' ' }
    ])
    .run()
}
