// Public marketing-site URLs, derived from the one place the product's domains
// are named (shared/productDomains.ts). Every in-app link to help, pricing or
// the account pages follows ACTIVE.site, so the cutover to www.plexiidesk.com
// is one edit there rather than one here and several elsewhere.
import { ACTIVE } from '@shared/productDomains'
export const SITE_BASE = ACTIVE.site

export const HELP_BASE = `${SITE_BASE}/help`
export const PRICING_URL = `${SITE_BASE}/pricing`

// Password reset happens on the web (the brochure's /account/forgot page emails
// a one-hour reset link). The desktop links out to it so the flow is the same
// everywhere. Pre-filling the email saves the user retyping it.
export function forgotPasswordUrl(email?: string): string {
  const base = `${SITE_BASE}/account/forgot`
  const e = email?.trim()
  return e ? `${base}?email=${encodeURIComponent(e)}` : base
}
