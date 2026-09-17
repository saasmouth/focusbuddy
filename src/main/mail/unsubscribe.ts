// Read the sender's own unsubscribe offer out of the raw header block.
//
// List-Unsubscribe (RFC 2369) is what a legitimate sender publishes to say
// "here is how to stop"; List-Unsubscribe-Post (RFC 8058) says they accept a
// one-click POST. Both come from the SENDER, which is the whole point.
//
// Nothing here looks at the message body. An "unsubscribe" link scraped out of
// marketing HTML is as likely to be a tracking pixel, or a confirm-this-address
// -is-real trap, as a working opt-out — and presenting one as though the sender
// had sanctioned it would be a lie with consequences for the person who clicks.
// A sender who published no header gets `null`, which is a fact worth showing
// rather than a gap to fill in.
//
// Pure and dependency-free, like threadingHeaders.ts, so it unit-tests without
// a live mailbox.

export interface UnsubscribeOffer {
  kind: 'http' | 'mailto'
  target: string
}

export interface UnsubscribeHeaders {
  unsubscribe: UnsubscribeOffer | null
  /** RFC 8058: the sender accepts a one-click POST to the https target. */
  oneClickUnsubscribe: boolean
}

/** Value of one header, including folded continuation lines. */
function field(text: string, name: string): string | undefined {
  const re = new RegExp(`^${name}:(.*(?:\\r?\\n[ \\t].*)*)`, 'im')
  return re.exec(text)?.[1]?.replace(/\r?\n/g, ' ').trim()
}

export function parseUnsubscribe(headers: Buffer | string | undefined): UnsubscribeHeaders {
  if (!headers) return { unsubscribe: null, oneClickUnsubscribe: false }
  const text = typeof headers === 'string' ? headers : headers.toString('utf8')
  const raw = field(text, 'list-unsubscribe') ?? ''
  const targets = [...raw.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim())

  // https is preferred over mailto: a mailto opt-out means SENDING mail on the
  // person's behalf, which this app does not do — so it is surfaced as an
  // address to write to, never as a button that fires.
  const http = targets.find((t) => /^https:\/\//i.test(t))
  const mailto = targets.find((t) => /^mailto:/i.test(t))

  // Deliberately not http:// — an opt-out is a request carrying an identifier
  // for a real person, and sending it in the clear is not an improvement on
  // leaving it alone.
  const chosen: UnsubscribeOffer | null = http
    ? { kind: 'http', target: http }
    : mailto
      ? { kind: 'mailto', target: mailto }
      : null

  const post = field(text, 'list-unsubscribe-post') ?? ''
  return { unsubscribe: chosen, oneClickUnsubscribe: Boolean(http) && /one-click/i.test(post) }
}
