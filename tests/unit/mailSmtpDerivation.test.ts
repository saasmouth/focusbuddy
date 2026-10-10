import { describe, it, expect } from 'vitest'
import { deriveSmtp, type SmtpTarget } from '../../src/main/mail/smtp'

// The send server is never asked for: it is derived from the IMAP host the user
// connected. A wrong derivation does not fail at setup, it fails on the first
// reply, so every provider the setup screen offers is pinned here, plus the
// generic convention that covers everything else.
//
// Zoho's help pages document only the US pair (imap/imappro.zoho.com,
// smtp/smtppro.zoho.com) and say each account's exact hosts, by account type
// and datacentre, are under Settings → Mail Accounts → Server Configuration
// Details. The other datacentres follow the same naming; each host below was checked on 2026-10-10
// to resolve in DNS and to present a certificate valid for its own name on 993
// (IMAP) and 465 (SMTP). The bug this guards: imappro.zoho.com.au used to derive
// smtp.imappro.zoho.com.au, which is NXDOMAIN, so every send failed.

function acct(host: string): Parameters<typeof deriveSmtp>[0] {
  return { host, port: 993, secure: true, user: 'me@example.com', password: 'x' }
}

const ssl465 = (host: string): SmtpTarget => ({ host, port: 465, secure: true })
const starttls587 = (host: string): SmtpTarget => ({ host, port: 587, secure: false })

const ZOHO_DATACENTRES = [
  'zoho.com',
  'zoho.eu',
  'zoho.uk',
  'zoho.in',
  'zoho.com.au',
  'zoho.jp',
  'zohocloud.ca',
  'zoho.sa',
  'zoho.ae',
  'zoho.com.cn'
]

describe('deriveSmtp — Zoho, every datacentre and both account kinds', () => {
  it('sends a paid organisation account in Australia through smtppro.zoho.com.au', () => {
    expect(deriveSmtp(acct('imappro.zoho.com.au'))).toEqual(ssl465('smtppro.zoho.com.au'))
  })

  it.each(ZOHO_DATACENTRES)('maps the organisation host imappro.%s to smtppro on 465 SSL', (dc) => {
    expect(deriveSmtp(acct(`imappro.${dc}`))).toEqual(ssl465(`smtppro.${dc}`))
  })

  it.each(ZOHO_DATACENTRES)('maps the personal / free-plan host imap.%s to smtp on 465 SSL', (dc) => {
    expect(deriveSmtp(acct(`imap.${dc}`))).toEqual(ssl465(`smtp.${dc}`))
  })

  it('never produces the nested smtp.imappro.* host the plain swap used to', () => {
    for (const dc of ZOHO_DATACENTRES) {
      expect(deriveSmtp(acct(`imappro.${dc}`)).host).not.toMatch(/imappro/)
    }
  })

  it('tolerates the case and stray whitespace of a hand-typed host', () => {
    expect(deriveSmtp(acct('  IMAPPRO.Zoho.COM.AU '))).toEqual(ssl465('smtppro.zoho.com.au'))
  })
})

describe('deriveSmtp — the existing provider presets still map as before', () => {
  it.each([
    ['imap.gmail.com', ssl465('smtp.gmail.com')],
    ['imap.googlemail.com', ssl465('smtp.gmail.com')],
    ['imap.mail.me.com', starttls587('smtp.mail.me.com')],
    ['imap.mail.icloud.com', starttls587('smtp.mail.me.com')],
    ['outlook.office365.com', starttls587('smtp.office365.com')],
    ['imap-mail.outlook.com', starttls587('smtp.office365.com')],
    ['imap.hotmail.com', starttls587('smtp.office365.com')],
    ['imap.live.com', starttls587('smtp.office365.com')],
    ['imap.fastmail.com', ssl465('smtp.fastmail.com')],
    ['imap.mail.yahoo.com', ssl465('smtp.mail.yahoo.com')]
  ])('%s -> %o', (imapHost, target) => {
    expect(deriveSmtp(acct(imapHost))).toEqual(target)
  })
})

describe('deriveSmtp — the generic convention for every other host', () => {
  it('swaps a leading imap. label for smtp. and defaults to 465 SSL', () => {
    expect(deriveSmtp(acct('imap.example.com'))).toEqual(ssl465('smtp.example.com'))
  })

  it('swaps a leading imap- label too, keeping the hyphen', () => {
    expect(deriveSmtp(acct('imap-mail.example.com'))).toEqual(ssl465('smtp-mail.example.com'))
  })

  it('carries a pro suffix across on any domain, not only Zoho', () => {
    expect(deriveSmtp(acct('imappro.example.com'))).toEqual(ssl465('smtppro.example.com'))
  })

  it('prefixes smtp. when the host has no imap label', () => {
    expect(deriveSmtp(acct('mail.example.com'))).toEqual(ssl465('smtp.mail.example.com'))
  })

  it('only swaps a whole label: a word that merely starts with imap is left alone', () => {
    expect(deriveSmtp(acct('imapserver.example.com'))).toEqual(ssl465('smtp.imapserver.example.com'))
    expect(deriveSmtp(acct('imappromo.example.com'))).toEqual(ssl465('smtp.imappromo.example.com'))
  })

  it('does not touch an imap label that is not the first one', () => {
    expect(deriveSmtp(acct('mx.imap.example.com'))).toEqual(ssl465('smtp.mx.imap.example.com'))
  })
})
