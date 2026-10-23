// May this account write a comment — the one decision both of a host's write
// paths have to make.
//
// Commenting needs an account, on a LOCAL document too (owner's ruling,
// 4.3.41): a comment is attributed to a person, and an unattributed one helps
// nobody once the document is shared, which a local document can be at any
// time, carrying its comments with it.
//
// IT LIVES HERE BECAUSE HAVING IT TWICE IS HOW IT WENT MISSING. The local host
// checked `account` in addComment and not in replyComment, where `author`
// falls back to 'You' — so the panel showed "Sign in to comment" while every
// existing thread still took a reply, and that reply went in unattributed.
// Replying is commenting. One function, called by both, is the shape that
// makes the next write path inherit the rule instead of forgetting it.
//
// Not a hook, and it takes the prompt as an argument, so the rule can be
// called in a test exactly as the handlers call it.

/**
 * True when the comment may be written. When it may not, the sign-in prompt is
 * raised and the caller must return without writing.
 */
export function requireCommentAuthor(
  account: { id: string } | null | undefined,
  requestSignIn: () => void
): boolean {
  if (account) return true
  requestSignIn()
  return false
}
