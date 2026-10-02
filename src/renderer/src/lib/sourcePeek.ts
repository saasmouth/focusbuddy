import type { SourceTarget } from './sourceTarget'

/** A reference that resolved to something. `SourceTarget` includes null for ones that did not. */
export type ResolvedTarget = NonNullable<SourceTarget>

// Which references can be opened WITHOUT leaving where you are.
//
// Following a citation used to mean being taken to the thing: the document view,
// the desk, the inbox. That answers "where is it" and loses "what was I reading"
// -- and for a reference you are checking mid-decision, which is the whole point
// of a citation on a proposal you are about to accept, being moved is the wrong
// answer to the question you asked.
//
// So a reference that can be rendered in place is peeked, and one that cannot is
// navigated to exactly as before. Deliberately no middle option: a modal showing
// a title and an Open button is a second click that tells you nothing, and is
// worse than the navigation it replaced.
//
// The three here are the ones with a real inline renderer behind them already.
// Widgets and tables go through renderWidgetInline, which renders 44 widget
// kinds interactively for focus mode and the split panes. Email goes through the
// mail-thread widget, reading the local mail store. A document, a past
// conversation, a meeting or a Drive file each have a full editor or view rather
// than an embeddable one, and showing a stand-in would mean previewing something
// that is not the thing.
const PEEKABLE = new Set<ResolvedTarget['kind']>(['widget', 'table', 'email'])

/** Can this reference be shown in place? */
export function canPeek(target: SourceTarget): target is ResolvedTarget {
  return target !== null && PEEKABLE.has(target.kind)
}

/** The peekable kinds, exported so a test can hold the classification to account. */
export const PEEKABLE_KINDS: readonly ResolvedTarget['kind'][] = ['widget', 'table', 'email']
