// WWW-Authenticate parsing (RFC 9110 §11.6.1, RFC 6750 §3, RFC 9728 §5.1).
//
// A header may carry several challenges ("Basic realm=x, Bearer scope=...") and
// quoted values may contain commas, so a split on ',' is wrong. This walks the
// grammar once and keeps only the Bearer challenge, which is the one MCP uses.

export interface BearerChallenge {
  // RFC 9728: where the protected resource metadata lives.
  resourceMetadata: string | null
  // Space-separated scopes the server says this request needs.
  scope: string | null
  // RFC 6750 error code: invalid_token, insufficient_scope, invalid_request.
  error: string | null
  errorDescription: string | null
}

const TCHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z]/

interface RawChallenge {
  scheme: string
  params: Record<string, string>
}

function parseChallenges(header: string): RawChallenge[] {
  const out: RawChallenge[] = []
  const s = header
  let i = 0
  let current: RawChallenge | null = null
  const skip = (re: RegExp): void => {
    while (i < s.length && re.test(s[i])) i++
  }
  const token = (): string => {
    const start = i
    while (i < s.length && TCHAR.test(s[i])) i++
    return s.slice(start, i)
  }
  while (i < s.length) {
    skip(/[\s,]/)
    if (i >= s.length) break
    const name = token()
    if (!name) {
      // Something outside the grammar (a token68 tail, stray '='): step over it.
      i++
      continue
    }
    skip(/[ \t]/)
    if (s[i] === '=' && current) {
      i++
      skip(/[ \t]/)
      let value = ''
      if (s[i] === '"') {
        i++
        while (i < s.length && s[i] !== '"') {
          if (s[i] === '\\' && i + 1 < s.length) i++
          value += s[i]
          i++
        }
        i++ // closing quote
      } else {
        value = token()
      }
      const key = name.toLowerCase()
      if (!(key in current.params)) current.params[key] = value
    } else {
      current = { scheme: name.toLowerCase(), params: {} }
      out.push(current)
    }
  }
  return out
}

export function parseWwwAuthenticate(header: string | null | undefined): BearerChallenge | null {
  if (!header) return null
  const bearer = parseChallenges(header).find((c) => c.scheme === 'bearer')
  if (!bearer) return null
  const p = bearer.params
  const val = (k: string): string | null => (typeof p[k] === 'string' && p[k] !== '' ? p[k] : null)
  return {
    resourceMetadata: val('resource_metadata'),
    scope: val('scope'),
    error: val('error'),
    errorDescription: val('error_description')
  }
}
