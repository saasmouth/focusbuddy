// SMTP send — the outbound half of the user's own mailbox. PlexiDesk reads
// over IMAP and sends over SMTP using the SAME account: same login, same
// app-specific password, just the sending server instead of the reading one.
// We never ask the user for separate send settings; the SMTP host is derived
// from the IMAP host they already connected, which is correct for every major
// provider (Gmail, iCloud, Outlook, Fastmail, Yahoo, Zoho in every datacentre)
// and a safe convention for the rest.

import nodemailer from 'nodemailer'
import type { MailAccountConfig } from './mailAccount'

export interface SmtpTarget {
  host: string
  port: number
  // true = implicit TLS (port 465). false = STARTTLS upgrade (port 587).
  secure: boolean
}

export interface SendMessage {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  text: string
  inReplyTo?: string | null
  references?: string[]
}

// Known providers whose SMTP endpoint is not a simple imap->smtp host swap, or
// whose port/TLS differs from the 465-implicit default. Matched on the IMAP
// host the user connected with.
const PROVIDERS: { match: RegExp; target: SmtpTarget }[] = [
  { match: /(^|\.)gmail\.com$/i, target: { host: 'smtp.gmail.com', port: 465, secure: true } },
  { match: /(^|\.)googlemail\.com$/i, target: { host: 'smtp.gmail.com', port: 465, secure: true } },
  // iCloud uses STARTTLS on 587.
  { match: /(^|\.)me\.com$/i, target: { host: 'smtp.mail.me.com', port: 587, secure: false } },
  { match: /(^|\.)icloud\.com$/i, target: { host: 'smtp.mail.me.com', port: 587, secure: false } },
  // Outlook / Microsoft 365 use STARTTLS on 587.
  {
    match: /(office365|outlook|hotmail|live)\.com$/i,
    target: { host: 'smtp.office365.com', port: 587, secure: false }
  },
  { match: /(^|\.)fastmail\.com$/i, target: { host: 'smtp.fastmail.com', port: 465, secure: true } },
  { match: /(^|\.)yahoo\.com$/i, target: { host: 'smtp.mail.yahoo.com', port: 465, secure: true } }
]

/**
 * Work out which SMTP server to send through for a given IMAP account. Known
 * providers are mapped explicitly; anything else swaps a leading "imap" label
 * for "smtp" and sends over implicit TLS on 465, the near-universal default.
 */
export function deriveSmtp(config: MailAccountConfig): SmtpTarget {
  const host = config.host.trim().toLowerCase()
  for (const p of PROVIDERS) {
    if (p.match.test(host)) return p.target
  }
  // Generic convention: imap.example.com -> smtp.example.com, else prefix smtp.
  // A "pro" suffix on the label carries across, because Zoho names its paid
  // organisation (custom-domain) servers that way in every datacentre:
  // imappro.zoho.com.au sends through smtppro.zoho.com.au, where the plain swap
  // used to produce smtp.imappro.zoho.com.au, which does not exist. Zoho's
  // personal and free-plan pair (imap.zoho.eu -> smtp.zoho.eu) is the plain swap.
  const smtpHost = /^imap(pro)?[.-]/i.test(host)
    ? host.replace(/^imap(pro)?([.-])/i, 'smtp$1$2')
    : `smtp.${host}`
  return { host: smtpHost, port: 465, secure: true }
}

// Minimal text-to-HTML so the outgoing message carries both a plain and an HTML
// part. We escape the body and turn newlines into <br> rather than authoring
// rich HTML — the composer is plain-text only by design.
function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return `<div style="white-space:pre-wrap;font-family:sans-serif;font-size:14px">${escaped.replace(
    /\n/g,
    '<br>'
  )}</div>`
}

/**
 * Send one message through the account's SMTP server. Verifies the transport
 * first so an auth/connection failure surfaces as a clear thrown error instead
 * of a silently dropped message.
 */
export async function sendMail(config: MailAccountConfig, msg: SendMessage): Promise<void> {
  const smtp = deriveSmtp(config)
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    // On STARTTLS ports, insist the upgrade actually happens rather than
    // falling back to an unencrypted session.
    requireTLS: !smtp.secure,
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 15_000,
    greetingTimeout: 12_000,
    socketTimeout: 30_000
  })

  const from = config.email?.trim() || config.user
  await transport.sendMail({
    from,
    to: msg.to,
    cc: msg.cc && msg.cc.length ? msg.cc : undefined,
    bcc: msg.bcc && msg.bcc.length ? msg.bcc : undefined,
    subject: msg.subject,
    text: msg.text,
    html: textToHtml(msg.text),
    inReplyTo: msg.inReplyTo || undefined,
    references: msg.references && msg.references.length ? msg.references : undefined
  })
  transport.close()
}
