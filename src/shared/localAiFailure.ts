// What a person reads when an on-device answer failed — kept in plain words,
// including for failures that were SAVED by an older version.
//
// 4.3.40 wrote the parser's technical reason into the failure line:
// "The on-device model could not produce a reply for this request (no JSON
// object was found). Nothing was sent anywhere. …". PlexiiAssist saves each
// finished turn with its trace, error included, so that sentence lives on in
// the conversation history and is shown again — beside the answer it was
// saved with — every time the conversation is reopened, on any later version.
// The owner's 4.3.41 check of "PlexiiBrain ranks by passage" saw exactly that:
// both stored copies on the machine were written on 2026-10-22, before 4.3.41
// was built, and 4.3.41 cannot produce the sentence at all.
//
// So a failure line is put into plain words where it is shown: the saved
// 4.3.40 template becomes the current wording (providerRouter.unusableMessage),
// and any parenthesised parser detail is dropped. Pure; shared by main and the
// renderer.

/** Parser and contract details that are never for the person to read. */
const TECHNICAL =
  /no JSON (?:object|array)|JSON was cut off|did not parse|must be a JSON|the object must have|must have a string|reply with a JSON|is empty: |Unexpected token|Unexpected end of JSON/i

const LEGACY_4340 =
  /^The on-device model could not produce (.+?) for this request \((.*)\)\. Nothing was sent anywhere\. Try again, rephrase it, or use your own key for (.+?) in Settings → AI\.?\s*$/s

/**
 * The failure line in plain words. A message that carries no technical detail
 * is returned unchanged; null/undefined pass through.
 */
export function plainLocalFailure<T extends string | null | undefined>(message: T): T {
  if (typeof message !== 'string' || !message) return message
  const legacy = LEGACY_4340.exec(message)
  if (legacy) {
    const [, promised, , label] = legacy
    return `The on-device model could not write ${promised} this time. Nothing was sent anywhere. Try again or rephrase it, or use your own key for ${label} in Settings → AI.` as T
  }
  if (!TECHNICAL.test(message)) return message
  // Drop any parenthesised technical reason, then any sentence still carrying one.
  const noParens = message.replace(/\s*\(([^()]*)\)/g, (m, inner: string) => (TECHNICAL.test(inner) ? '' : m))
  const sentences = noParens.split(/(?<=[.!?])\s+/).filter((s) => !TECHNICAL.test(s))
  const out = sentences.join(' ').trim()
  return (out || 'The on-device model could not write an answer this time. Nothing was sent anywhere. Try again or rephrase it.') as T
}
