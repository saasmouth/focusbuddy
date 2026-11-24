// Egress rules for connections (SPEC-CONNECTIONS.md §3, §5): validate custom and
// discovered endpoints and redirects; reject private network destinations by
// default; bind credentials to approved origins.
//
// Pure. The main process adds the DNS check (a hostname that RESOLVES to a
// private address is refused too) in src/main/aispace/net.ts.

export interface EndpointCheck {
  ok: boolean
  reason: string
  origin: string | null
  url: URL | null
}

export interface EndpointOptions {
  // Loopback (127.0.0.1 / ::1 / localhost) is refused unless this is set. Only
  // tests and local reference servers set it; there is no UI for it.
  allowLoopback?: boolean
}

export function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null
}

export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true
  const v4 = parseIPv4(h)
  return Boolean(v4 && v4[0] === 127)
}

// Private, link-local, CGNAT, unspecified, multicast and reserved ranges.
export function isPrivateAddress(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (isLoopback(h)) return true
  const v4 = parseIPv4(h)
  if (v4) {
    const [a, b] = v4
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a === 169 && b === 254) return true // link-local, cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 192 && b === 0 && v4[2] === 0) return true
    if (a === 198 && (b === 18 || b === 19)) return true
    if (a >= 224) return true // multicast + reserved
    return false
  }
  if (h.includes(':')) {
    if (h === '::' || h === '::1') return true
    // IPv4-mapped (::ffff:10.0.0.1)
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h)
    if (mapped) return isPrivateAddress(mapped[1])
    const first = parseInt(h.split(':')[0] || '0', 16)
    if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return true // multicast
    return false
  }
  return false
}

export function validateEndpoint(raw: string, opts: EndpointOptions = {}): EndpointCheck {
  const bad = (reason: string): EndpointCheck => ({ ok: false, reason, origin: null, url: null })
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return bad('That isn’t a valid web address.')
  }
  if (url.username || url.password) return bad('Addresses with a user name or password in them are refused.')
  const host = url.hostname
  const loop = isLoopback(host)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loop && opts.allowLoopback)) {
    return bad('Only https addresses are allowed.')
  }
  if (loop && !opts.allowLoopback) return bad('Addresses on this computer are refused for remote connections.')
  if (!loop && isPrivateAddress(host)) return bad('Private network addresses are refused.')
  if (!host.includes('.') && !loop) return bad('Use the server’s full address.')
  url.hash = ''
  return { ok: true, reason: 'OK', origin: url.origin, url }
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}
