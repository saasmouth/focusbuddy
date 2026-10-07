// Reconcile the plexiidesk.com DNS zone: the four product surfaces, and the
// mail records, against what each origin actually requires.
//
// WHY THIS EXISTS
//
// Every subdomain was first created by hand as a PROXIED CNAME pointing at the
// apex. That is wrong for all four, and wrong in a way that looks plausible in
// the dashboard: the record resolves, the orange cloud is on, and every request
// returns HTTP 525 because Cloudflare terminates TLS and then finds no origin
// behind it. Three origins each want a specific record:
//
//   api.    Fly.io    A + AAAA to the app's anycast addresses
//   view.   Vercel    A 76.76.21.21
//   admin.  Vercel    A 76.76.21.21
//   dl.     R2        NO record here. R2 writes its own when the custom domain
//                     is attached from inside the bucket, and a leftover manual
//                     record blocks that. So this script deletes it.
//
// All three are created DNS-only (grey). Fly and Vercel each complete an ACME
// challenge against the hostname, which cannot reach them through the proxy —
// that is the other half of the 525. api. additionally stays grey because it
// carries the WebSocket signalling connection and gains nothing from proxying.
//
// HOW DELETION IS SCOPED, AND WHY IT MATTERS
//
// An earlier version of this script deleted "any record of a wrong type under a
// name we are claiming". That rule is fine for api/view/admin, which we own
// outright. Applied to the apex — which --mail claims for MX and SPF — it would
// have deleted the apex A records and taken the website offline. The apex is
// shared: it holds the live site, a Zoho ownership token, and our mail records.
//
// So deletion is strictly SLOT-scoped. A slot is (name, type, kind), where kind
// distinguishes TXT records by purpose: v=spf1 / v=DMARC1 / v=DKIM1 / other.
// We only ever touch slots we explicitly declare. A name may additionally be
// marked `exclusive`, which means we own every record under it — that, and only
// that, permits deleting a record of a type we did not declare.
//
// Consequence: the apex A records, the zoho-verification TXT, the zmail DKIM
// key and the whole email.plexiidesk.com Email Routing setup are invisible to
// this script. It cannot delete them.
//
// ORDER OF OPERATIONS
//
// Where a slot has an existing record and a desired one, we PATCH in place, so
// there is never a window with no MX and no SPF. Only a type change (the
// CNAME -> A swap) requires delete-then-create, and that is confined to the
// exclusive names. Hence: patch, then delete within exclusive names, then
// create, then any remaining deletes.
//
// It is dry-run by default. These are production records for a domain that is
// about to go live, and for live email, so writing requires --apply out loud.
//
// USAGE
//   node scripts/cloudflare-dns-apply.mjs                  # diff only
//   node scripts/cloudflare-dns-apply.mjs --apply          # write the surfaces
//   node scripts/cloudflare-dns-apply.mjs --mail           # diff incl. mail
//   node scripts/cloudflare-dns-apply.mjs --mail --apply   # write both
//
// ENV (environment first, then ./.env)
//   CLOUDFLARE_API_TOKEN  required. Zone:DNS:Edit + Zone:Read on plexiidesk.com.
//   CLOUDFLARE_ZONE_ID    optional. Skips the zone lookup (which needs Zone:Read).
//   ZOHO_REGION           mail datacentre: com | eu | in | com.au. Default com.au.
//   ZOHO_DKIM_SELECTOR    } only needed to CREATE a DKIM record. An existing
//   ZOHO_DKIM_VALUE       } DKIM record is never touched without both of these.
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const APPLY = process.argv.includes('--apply')
const WITH_MAIL = process.argv.includes('--mail')
const ZONE_NAME = 'plexiidesk.com'
const API = 'https://api.cloudflare.com/client/v4'

// ---------------------------------------------------------------- env loading

function fromDotEnv(key) {
  const f = join(root, '.env')
  if (!existsSync(f)) return undefined
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (m && m[1] === key) return m[2].trim().replace(/^['"]|['"]$/g, '')
  }
  return undefined
}
const env = (key) => process.env[key] || fromDotEnv(key)

const TOKEN = env('CLOUDFLARE_API_TOKEN')
if (!TOKEN) {
  console.error('CLOUDFLARE_API_TOKEN is not set, in the environment or in .env.')
  process.exit(2)
}

// ------------------------------------------------------------------ api layer

async function cf(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  try {
    return await res.json()
  } catch {
    throw new Error(`${method} ${path} -> HTTP ${res.status}, body was not JSON`)
  }
}

function explainPermissionFailure(json, what) {
  console.error(`\nCould not ${what}.`)
  for (const e of json.errors || []) console.error(`  [${e.code}] ${e.message}`)
  const codes = (json.errors || []).map((e) => e.code)
  if (codes.some((c) => [9109, 10000, 7003].includes(c))) {
    console.error(
      '\nThe token lacks the permission that call needs. Cloudflare ->\n' +
        'My Profile -> API Tokens -> (token) -> Edit, and grant at least:\n' +
        `  Zone -> DNS  -> Edit  on ${ZONE_NAME}\n` +
        `  Zone -> Zone -> Read  on ${ZONE_NAME}\n`
    )
  }
}

// ------------------------------------------------------------ TXT record kinds

// TXT records are a shared namespace: one name can hold SPF, DMARC, DKIM, and
// any number of third-party ownership tokens. Reconciling them by name alone
// would delete whichever ones we did not happen to declare. So every TXT is
// classified, and only declared kinds are ever touched.
function txtKind(content) {
  const c = String(content).replace(/^"|"$/g, '').trim().toLowerCase()
  if (c.startsWith('v=spf1')) return 'spf'
  if (c.startsWith('v=dmarc1')) return 'dmarc'
  if (c.startsWith('v=dkim1')) return 'dkim'
  return 'other'
}
const slotOf = (r) => `${r.name}|${r.type}|${r.type === 'TXT' ? txtKind(r.content) : '-'}`

// ------------------------------------------------------------- the record sets

// Fly's anycast addresses for focusbuddy-signal, as reported by
// `flyctl certs add api.plexiidesk.com -a focusbuddy-signal`.
const FLY_A = '66.241.125.86'
const FLY_AAAA = '2a09:8280:1::11e:cda5:0'
// Vercel's shared ingress, as reported by `vercel domains inspect`.
const VERCEL_A = '76.76.21.21'

const surfaces = [
  { name: `api.${ZONE_NAME}`, type: 'A', content: FLY_A, proxied: false,
    why: 'Fly.io origin for focusbuddy-signal; grey so the cert can validate and the WebSocket stays direct' },
  { name: `api.${ZONE_NAME}`, type: 'AAAA', content: FLY_AAAA, proxied: false,
    why: 'Fly.io IPv6 for the same app' },
  { name: `view.${ZONE_NAME}`, type: 'A', content: VERCEL_A, proxied: false,
    why: 'Vercel origin for focusbuddy-viewer; grey so Vercel can issue its cert' },
  { name: `admin.${ZONE_NAME}`, type: 'A', content: VERCEL_A, proxied: false,
    why: 'Vercel origin for haptyx-admin; grey so Vercel can issue its cert' }
]

// Names we own outright. Anything else found under one of these is stale.
const exclusive = new Set([
  `api.${ZONE_NAME}`,
  `view.${ZONE_NAME}`,
  `admin.${ZONE_NAME}`,
  `dl.${ZONE_NAME}` // declared with no desired records, so everything here goes
])

// Records that exist and are correct except for the proxy flag. Patching the
// flag is safer than delete-and-recreate, and it is all these need.
const proxyFixes = [
  { match: (r) => r.type === 'CNAME' && /(^|\.)zmverify\.zoho\./i.test(r.content), proxied: false,
    why: 'a Zoho ownership CNAME must resolve to Zoho; proxied it returns Cloudflare addresses' }
]

// Zoho's inbound hosts differ per datacentre and mail to the wrong one is lost,
// so the region is explicit and the host list is not guessed.
const ZOHO_REGION = env('ZOHO_REGION') || 'com.au'
const ZOHO_HOSTS = {
  com: { mx: ['mx.zoho.com', 'mx2.zoho.com', 'mx3.zoho.com'], spf: 'zoho.com' },
  eu: { mx: ['mx.zoho.eu', 'mx2.zoho.eu', 'mx3.zoho.eu'], spf: 'zoho.eu' },
  in: { mx: ['mx.zoho.in', 'mx2.zoho.in', 'mx3.zoho.in'], spf: 'zoho.in' },
  'com.au': { mx: ['mx.zoho.com.au', 'mx2.zoho.com.au', 'mx3.zoho.com.au'], spf: 'zohomail.com.au' }
}

function mailRecords(existing) {
  const z = ZOHO_HOSTS[ZOHO_REGION]
  if (!z) {
    console.error(`ZOHO_REGION="${ZOHO_REGION}" is not one of: ${Object.keys(ZOHO_HOSTS).join(', ')}`)
    process.exit(2)
  }
  const out = [
    { name: ZONE_NAME, type: 'MX', content: z.mx[0], priority: 10, proxied: false, why: `Zoho inbound, primary (${ZOHO_REGION})` },
    { name: ZONE_NAME, type: 'MX', content: z.mx[1], priority: 20, proxied: false, why: 'Zoho inbound, secondary' },
    { name: ZONE_NAME, type: 'MX', content: z.mx[2], priority: 50, proxied: false, why: 'Zoho inbound, tertiary' }
  ]

  // SPF. Rebuild from the existing record rather than replacing it wholesale:
  // it may carry senders this script knows nothing about. Drop only what is
  // provably broken — a self-include, and Cloudflare proxy addresses, which
  // never originate SMTP.
  const current = existing.find((r) => slotOf(r) === `${ZONE_NAME}|TXT|spf`)
  const keptTerms = []
  const dropped = []
  if (current) {
    for (const term of String(current.content).replace(/^"|"$/g, '').split(/\s+/)) {
      const t = term.trim()
      if (!t || /^v=spf1$/i.test(t) || /^[~\-+?]all$/i.test(t)) continue
      if (new RegExp(`^include:${ZONE_NAME.replace('.', '\\.')}$`, 'i').test(t)) {
        dropped.push(`${t}  (recursive self-include: SPF evaluates to permerror)`)
      } else if (/^ip4:(104\.(1[6-9]|2[0-9]|3[01])\.|172\.6[4-9]\.|172\.7[01]\.)/.test(t)) {
        dropped.push(`${t}  (Cloudflare proxy address; never originates SMTP)`)
      } else {
        keptTerms.push(t)
      }
    }
  }
  if (!keptTerms.some((t) => new RegExp(`^include:${z.spf.replace(/\./g, '\\.')}$`, 'i').test(t))) {
    keptTerms.push(`include:${z.spf}`)
  }
  if (dropped.length) {
    console.log('SPF terms being dropped:')
    for (const d of dropped) console.log(`  - ${d}`)
    console.log()
  }
  out.push({
    name: ZONE_NAME, type: 'TXT', content: `v=spf1 ${keptTerms.join(' ')} ~all`, proxied: false,
    why: 'SPF, rebuilt from the existing record with the broken terms removed'
  })

  // DMARC. Two records at one name means receivers must ignore both (RFC 7489
  // 6.6.3), so the domain currently has no DMARC at all. Collapse to one,
  // preferring the record that reports to an address we control.
  const dmarcs = existing.filter((r) => slotOf(r) === `_dmarc.${ZONE_NAME}|TXT|dmarc`)
  let dmarc = 'v=DMARC1; p=quarantine; rua=mailto:postmaster@' + ZONE_NAME
  if (dmarcs.length) {
    const ours = dmarcs.find((r) => /saasmouth|plexiidesk/i.test(r.content)) || dmarcs[0]
    dmarc = String(ours.content).replace(/^"|"$/g, '')
    if (dmarcs.length > 1) {
      console.log(`DMARC: ${dmarcs.length} records at _dmarc.${ZONE_NAME}, so DMARC is currently INACTIVE.`)
      console.log(`  keeping:  ${dmarc}`)
      for (const d of dmarcs) {
        if (d !== ours) console.log(`  removing: ${String(d.content).replace(/^"|"$/g, '')}`)
      }
      console.log()
    }
  }
  out.push({ name: `_dmarc.${ZONE_NAME}`, type: 'TXT', content: dmarc, proxied: false,
    why: 'DMARC, collapsed to a single record so it is honoured at all' })

  // DKIM is only declared when both halves are supplied. Otherwise the slot is
  // left undeclared, which means an existing key is never touched.
  const sel = env('ZOHO_DKIM_SELECTOR')
  const key = env('ZOHO_DKIM_VALUE')
  if (sel && key) {
    out.push({ name: `${sel}._domainkey.${ZONE_NAME}`, type: 'TXT', content: key, proxied: false,
      why: 'DKIM public key issued by Zoho' })
  }
  return out
}

// --------------------------------------------------------------------- compare

const norm = (type, content) =>
  type === 'TXT' ? String(content).replace(/^"|"$/g, '').trim() : String(content).trim()

function identical(existing, want) {
  if (norm(existing.type, existing.content) !== norm(want.type, want.content)) return false
  if (want.priority !== undefined && existing.priority !== want.priority) return false
  return (existing.proxied ?? false) === (want.proxied ?? false)
}

function describe(r) {
  const prio = r.priority !== undefined && r.priority !== null ? ` prio=${r.priority}` : ''
  const cloud = r.proxied ? 'orange' : 'grey'
  return `${r.type.padEnd(5)} ${r.name.padEnd(30)} ${norm(r.type, r.content).slice(0, 64).padEnd(66)}${cloud}${prio}`
}

// ------------------------------------------------------------------------ main

async function main() {
  let zoneId = env('CLOUDFLARE_ZONE_ID')
  if (zoneId) {
    console.log(`zone:   ${ZONE_NAME} (${zoneId}, from CLOUDFLARE_ZONE_ID)`)
  } else {
    const z = await cf('GET', `/zones?name=${ZONE_NAME}`)
    if (!z.success) {
      explainPermissionFailure(z, `list zones to find ${ZONE_NAME}`)
      process.exit(1)
    }
    if (!z.result?.length) {
      console.error(
        `\nThe API returned no zone named ${ZONE_NAME}, and no error.\n\n` +
          'That is what Cloudflare returns when the token is valid but holds no\n' +
          'Zone:Read permission: the list is filtered to what the token may see,\n' +
          'and an empty list is indistinguishable from "no such zone".\n\n' +
          'Add Zone -> Zone -> Read to the token, or set CLOUDFLARE_ZONE_ID from\n' +
          `Cloudflare -> ${ZONE_NAME} -> Overview -> Zone ID.`
      )
      process.exit(1)
    }
    zoneId = z.result[0].id
    console.log(`zone:   ${ZONE_NAME} (${zoneId})`)
  }

  const list = await cf('GET', `/zones/${zoneId}/dns_records?per_page=500`)
  if (!list.success) {
    explainPermissionFailure(list, 'list the zone DNS records')
    process.exit(1)
  }
  const existing = list.result
  console.log(`mode:   ${APPLY ? 'APPLY (writing)' : 'dry run — pass --apply to write'}`)
  console.log(`scope:  product surfaces${WITH_MAIL ? ' + mail (--mail)' : ' only'}`)
  console.log(`found:  ${existing.length} existing records\n`)

  const want = WITH_MAIL ? [...surfaces, ...mailRecords(existing)] : [...surfaces]

  // Declared slots: the only places we may delete. Exclusive names add every
  // slot currently present under them.
  const declared = new Set(want.map(slotOf))
  for (const r of existing) if (exclusive.has(r.name)) declared.add(slotOf(r))

  const plan = { patch: [], create: [], keep: [], delete: [] }

  // Pair desired against existing, slot by slot.
  const usedIds = new Set()
  for (const w of want) {
    const slot = slotOf(w)
    const pool = existing.filter((e) => slotOf(e) === slot && !usedIds.has(e.id))
    const exact = pool.find((e) => identical(e, w))
    if (exact) {
      usedIds.add(exact.id)
      plan.keep.push(w)
      continue
    }
    // Prefer an existing record holding the same content, so a change of
    // priority or proxy flag reads as exactly that, rather than appearing to
    // shuffle content between records.
    const reusable =
      pool.find((e) => norm(e.type, e.content) === norm(w.type, w.content)) || pool[0]
    if (reusable) {
      usedIds.add(reusable.id)
      plan.patch.push({ from: reusable, to: w })
    } else {
      plan.create.push(w)
    }
  }

  // Leftovers inside declared slots are stale.
  for (const e of existing) {
    if (usedIds.has(e.id)) continue
    if (!declared.has(slotOf(e))) continue
    plan.delete.push(e)
  }

  // Proxy-flag-only corrections, outside the slot machinery.
  for (const fix of proxyFixes) {
    for (const e of existing) {
      if (usedIds.has(e.id) || plan.delete.find((d) => d.id === e.id)) continue
      if (!fix.match(e)) continue
      if ((e.proxied ?? false) === fix.proxied) continue
      plan.patch.push({ from: e, to: { ...e, proxied: fix.proxied, why: fix.why }, flagOnly: true })
      usedIds.add(e.id)
    }
  }

  // ------------------------------------------------------------------ report

  if (plan.keep.length) {
    console.log('ALREADY CORRECT')
    for (const r of plan.keep) console.log(`  = ${describe(r)}`)
    console.log()
  }
  if (plan.patch.length) {
    console.log('CHANGE IN PLACE')
    for (const p of plan.patch) {
      console.log(`  ~ ${describe(p.from)}`)
      console.log(`    ${describe(p.to)}`)
      console.log(`      ${p.to.why}`)
    }
    console.log()
  }
  if (plan.delete.length) {
    console.log('DELETE')
    for (const r of plan.delete) {
      const note = r.name === `dl.${ZONE_NAME}` ? '   <- R2 attaches its own record here' : ''
      console.log(`  - ${describe(r)}${note}`)
    }
    console.log()
  }
  if (plan.create.length) {
    console.log('CREATE')
    for (const r of plan.create) console.log(`  + ${describe(r)}\n      ${r.why}`)
    console.log()
  }

  const untouched = existing.filter(
    (e) => !usedIds.has(e.id) && !plan.delete.find((d) => d.id === e.id)
  )
  console.log(`UNTOUCHED (${untouched.length} records this script cannot affect)`)
  for (const r of untouched) console.log(`  . ${describe(r)}`)
  console.log()

  if (!plan.patch.length && !plan.delete.length && !plan.create.length) {
    console.log('Nothing to change.')
    return
  }
  if (!APPLY) {
    console.log('Dry run — nothing was written. Re-run with --apply to make these changes.')
    return
  }

  // ------------------------------------------------------------------- apply

  let failed = 0
  const say = (ok, what, res) => {
    if (ok) console.log(`  ok      ${what}`)
    else {
      failed++
      console.error(`  FAILED  ${what}: ${JSON.stringify(res.errors)}`)
    }
  }

  const bodyFor = (r) => {
    const b = {
      type: r.type,
      name: r.name,
      content: norm(r.type, r.content),
      ttl: 1,
      proxied: r.proxied ?? false
    }
    if (r.priority !== undefined && r.priority !== null) b.priority = r.priority
    return b
  }

  // 1. Patches first: gapless, so MX and SPF are never absent.
  for (const p of plan.patch) {
    const res = await cf('PUT', `/zones/${zoneId}/dns_records/${p.from.id}`, bodyFor(p.to))
    say(res.success, `patch ${p.to.type} ${p.to.name}`, res)
  }
  // 2. Deletes within exclusive names, to clear the CNAME before the A lands.
  for (const r of plan.delete.filter((r) => exclusive.has(r.name))) {
    const res = await cf('DELETE', `/zones/${zoneId}/dns_records/${r.id}`)
    say(res.success, `delete ${r.type} ${r.name}`, res)
  }
  // 3. Creates.
  for (const r of plan.create) {
    const res = await cf('POST', `/zones/${zoneId}/dns_records`, bodyFor(r))
    say(res.success, `create ${r.type} ${r.name} -> ${norm(r.type, r.content).slice(0, 40)}`, res)
  }
  // 4. Remaining deletes, after their replacements exist.
  for (const r of plan.delete.filter((r) => !exclusive.has(r.name))) {
    const res = await cf('DELETE', `/zones/${zoneId}/dns_records/${r.id}`)
    say(res.success, `delete ${r.type} ${r.name}`, res)
  }

  // Read the zone back. The plan is not the outcome.
  const after = await cf('GET', `/zones/${zoneId}/dns_records?per_page=500`)
  if (after.success) {
    const names = new Set([...want.map((w) => w.name), ...exclusive])
    console.log('\nZone now holds, for the names touched:')
    const rows = after.result.filter((e) => names.has(e.name)).sort((a, b) => a.name.localeCompare(b.name))
    if (!rows.length) console.log('  (none)')
    for (const e of rows) console.log(`  ${describe(e)}`)
  } else {
    console.error('\nCould not read the zone back to verify.')
    failed++
  }

  if (failed) {
    console.error(`\n${failed} operation(s) failed.`)
    process.exit(1)
  }
  console.log('\nDone. Fly and Vercel verify asynchronously:')
  console.log('  flyctl certs check api.plexiidesk.com -a focusbuddy-signal')
  console.log('  npx vercel domains inspect view.plexiidesk.com')
  console.log('  npx vercel domains inspect admin.plexiidesk.com')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
