// Reconcile the plexiidesk.com DNS records for our four public surfaces.
//
// Why this exists.
//
// Every subdomain was first created by hand as a PROXIED CNAME pointing at the
// apex. That is wrong for all four of them, and wrong in a way that looks
// plausible in the dashboard: the record resolves, the orange cloud is on, and
// every request returns HTTP 525 because Cloudflare is terminating TLS and then
// finding no origin behind it. Three origins each want a specific record:
//
//   api.    Fly.io      A + AAAA to the app's anycast addresses
//   view.   Vercel      A 76.76.21.21
//   admin.  Vercel      A 76.76.21.21
//   dl.     R2          NO record here — R2 writes its own when you attach the
//                       custom domain from inside the bucket. A leftover manual
//                       record blocks that, so this script deletes it.
//
// All three are created DNS-only (grey cloud). Fly and Vercel both complete an
// ACME challenge against the hostname and issue their own certificate; behind
// Cloudflare's proxy that challenge cannot reach them, which is the other half
// of the 525. api. additionally stays grey because it carries the WebSocket
// signalling connection and gains nothing from being proxied.
//
// It is dry-run by default. These are production DNS records for a domain that
// is about to go live, so writing requires --apply, said out loud.
//
// Usage:
//   node scripts/cloudflare-dns-apply.mjs              # show the diff, change nothing
//   node scripts/cloudflare-dns-apply.mjs --apply      # write it
//   node scripts/cloudflare-dns-apply.mjs --mail       # include the Zoho records
//
// Env (read from the environment, else from ./.env):
//   CLOUDFLARE_API_TOKEN   required. Needs Zone:DNS:Edit on plexiidesk.com.
//                          Zone:Read as well, or else set CLOUDFLARE_ZONE_ID,
//                          because listing zones by name is itself a read.
//   CLOUDFLARE_ZONE_ID     optional. Dashboard -> plexiidesk.com -> Overview,
//                          right-hand sidebar. Skips zone lookup entirely.
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
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
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
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  })
  let json
  try {
    json = await res.json()
  } catch {
    throw new Error(`${method} ${path} -> HTTP ${res.status}, body was not JSON`)
  }
  return json
}

function explainPermissionFailure(json, what) {
  const codes = (json.errors || []).map((e) => e.code)
  console.error(`\nCould not ${what}.`)
  for (const e of json.errors || []) console.error(`  [${e.code}] ${e.message}`)
  if (codes.includes(9109) || codes.includes(10000) || codes.includes(7003)) {
    console.error(
      '\nThis token does not carry the permission that call needs. Edit it at\n' +
        '  Cloudflare -> My Profile -> API Tokens -> (token) -> Edit\n' +
        'and give it, at minimum:\n' +
        `  Zone  -> DNS             -> Edit   on ${ZONE_NAME}\n` +
        `  Zone  -> Zone            -> Read   on ${ZONE_NAME}\n` +
        'and, for the dl. bucket:\n' +
        '  Account -> Workers R2 Storage -> Edit\n' +
        '  Account -> Account Settings   -> Read\n'
    )
  }
}

// ------------------------------------------------------------- the record set

// Fly's anycast addresses for focusbuddy-signal, as reported by
// `flyctl certs add api.plexiidesk.com -a focusbuddy-signal`.
const FLY_A = '66.241.125.86'
const FLY_AAAA = '2a09:8280:1::11e:cda5:0'
// Vercel's shared ingress address, as reported by `vercel domains inspect`.
const VERCEL_A = '76.76.21.21'

const desired = [
  { name: `api.${ZONE_NAME}`, type: 'A', content: FLY_A, proxied: false,
    why: 'Fly.io origin for focusbuddy-signal; grey so the Fly cert can validate and the WebSocket stays direct' },
  { name: `api.${ZONE_NAME}`, type: 'AAAA', content: FLY_AAAA, proxied: false,
    why: 'Fly.io IPv6 for the same app' },
  { name: `view.${ZONE_NAME}`, type: 'A', content: VERCEL_A, proxied: false,
    why: 'Vercel origin for focusbuddy-viewer; grey so Vercel can issue its cert' },
  { name: `admin.${ZONE_NAME}`, type: 'A', content: VERCEL_A, proxied: false,
    why: 'Vercel origin for haptyx-admin; grey so Vercel can issue its cert' }
]

// dl. is owned by R2. Any record we find under that name is a leftover from the
// manual setup and must go, or R2 will refuse to attach the custom domain.
const ownedElsewhere = [`dl.${ZONE_NAME}`]

// ------------------------------------------------------------- the mail record set

// Zoho's inbound hosts differ per datacentre, and sending mail to the wrong one
// silently loses it. Nothing here is guessed: the region must be stated, and
// the two values only Zoho can give us must be supplied or the record is skipped.
const ZOHO_REGION = env('ZOHO_REGION') || 'com'
const ZOHO_MX = {
  com: ['mx.zoho.com', 'mx2.zoho.com', 'mx3.zoho.com'],
  eu: ['mx.zoho.eu', 'mx2.zoho.eu', 'mx3.zoho.eu'],
  'com.au': ['mx.zoho.com.au', 'mx2.zoho.com.au', 'mx3.zoho.com.au'],
  in: ['mx.zoho.in', 'mx2.zoho.in', 'mx3.zoho.in']
}

function mailRecords() {
  const hosts = ZOHO_MX[ZOHO_REGION]
  if (!hosts) {
    console.error(`ZOHO_REGION="${ZOHO_REGION}" is not one of: ${Object.keys(ZOHO_MX).join(', ')}`)
    process.exit(2)
  }
  const out = [
    { name: ZONE_NAME, type: 'MX', content: hosts[0], priority: 10, proxied: false, why: `Zoho inbound (${ZOHO_REGION})` },
    { name: ZONE_NAME, type: 'MX', content: hosts[1], priority: 20, proxied: false, why: `Zoho inbound (${ZOHO_REGION})` },
    { name: ZONE_NAME, type: 'MX', content: hosts[2], priority: 50, proxied: false, why: `Zoho inbound (${ZOHO_REGION})` },
    { name: ZONE_NAME, type: 'TXT', content: `"v=spf1 include:zoho.${ZOHO_REGION} ~all"`, proxied: false, why: 'SPF, authorising Zoho to send as us' },
    { name: `_dmarc.${ZONE_NAME}`, type: 'TXT', content: `"v=DMARC1; p=none; rua=mailto:postmaster@${ZONE_NAME}"`, proxied: false, why: 'DMARC in report-only; tighten to p=quarantine once the reports are clean' }
  ]
  const sel = env('ZOHO_DKIM_SELECTOR')
  const key = env('ZOHO_DKIM_VALUE')
  if (sel && key) {
    out.push({ name: `${sel}._domainkey.${ZONE_NAME}`, type: 'TXT', content: `"${key}"`, proxied: false, why: 'DKIM public key issued by Zoho' })
  } else {
    console.warn(
      'SKIPPING DKIM: set ZOHO_DKIM_SELECTOR and ZOHO_DKIM_VALUE from\n' +
        '  Zoho Mail Admin -> Domains -> plexiidesk.com -> Email Configuration -> DKIM.\n' +
        '  These are generated per account and cannot be derived. Mail will send\n' +
        '  without DKIM but is far more likely to be filtered.'
    )
  }
  const verify = env('ZOHO_VERIFY_VALUE')
  if (verify) {
    out.push({ name: ZONE_NAME, type: 'TXT', content: `"${verify}"`, proxied: false, why: 'Zoho domain-ownership verification' })
  } else {
    console.warn(
      'SKIPPING Zoho domain verification: set ZOHO_VERIFY_VALUE to the TXT value\n' +
        '  Zoho shows under Domains -> Verify (it looks like zoho-verification=zb……).'
    )
  }
  return out
}

// --------------------------------------------------------------------- reconcile

function sameRecord(existing, want) {
  if (existing.type !== want.type) return false
  let content = want.content
  if (want.type === 'TXT') content = content.replace(/^"|"$/g, '')
  if (existing.content !== content) return false
  if (want.priority !== undefined && existing.priority !== want.priority) return false
  return (existing.proxied ?? false) === (want.proxied ?? false)
}

function describe(r) {
  const prio = r.priority !== undefined ? ` prio=${r.priority}` : ''
  const cloud = r.proxied ? 'orange' : 'grey'
  return `${r.type.padEnd(5)} ${r.name.padEnd(28)} ${String(r.content).slice(0, 60).padEnd(62)}${prio} ${cloud}`
}

async function main() {
  // Zone id: from env if given, else look it up, which needs Zone:Read.
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
          'That is what Cloudflare returns when the token is valid but carries no\n' +
          'Zone:Read permission — the list is filtered to what the token may see,\n' +
          'and an empty list is indistinguishable from "no such zone".\n\n' +
          'Either add Zone -> Zone -> Read to the token, or set CLOUDFLARE_ZONE_ID\n' +
          `from Cloudflare -> ${ZONE_NAME} -> Overview -> Zone ID (right sidebar).`
      )
      process.exit(1)
    }
    zoneId = z.result[0].id
    console.log(`zone:   ${ZONE_NAME} (${zoneId})`)
  }

  const list = await cf('GET', `/zones/${zoneId}/dns_records?per_page=200`)
  if (!list.success) {
    explainPermissionFailure(list, 'list the zone DNS records')
    process.exit(1)
  }
  const existing = list.result
  console.log(`mode:   ${APPLY ? 'APPLY (writing)' : 'dry run (pass --apply to write)'}`)
  console.log(`found:  ${existing.length} existing records\n`)

  const want = WITH_MAIL ? [...desired, ...mailRecords()] : desired
  const plan = { create: [], replace: [], keep: [], remove: [] }

  // Group the wanted records by name+type so a name holding several records
  // (the three Zoho MX, say) reconciles as a set rather than fighting itself.
  const byKey = new Map()
  for (const w of want) {
    const k = `${w.name}|${w.type}`
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(w)
  }

  for (const [k, group] of byKey) {
    const [name, type] = k.split('|')
    const have = existing.filter((e) => e.name === name && e.type === type)
    const matched = new Set()
    for (const w of group) {
      const hit = have.find((e) => !matched.has(e.id) && sameRecord(e, w))
      if (hit) {
        matched.add(hit.id)
        plan.keep.push(w)
      } else {
        plan.create.push(w)
      }
    }
    // Any record of this name+type we did not want is stale.
    for (const e of have) if (!matched.has(e.id)) plan.remove.push(e)
  }

  // Wrong-type records under a name we are claiming (the proxied CNAMEs).
  const claimed = new Set(want.map((w) => w.name))
  for (const e of existing) {
    if (!claimed.has(e.name)) continue
    const wantedTypes = new Set(want.filter((w) => w.name === e.name).map((w) => w.type))
    if (!wantedTypes.has(e.type) && !plan.remove.find((r) => r.id === e.id)) {
      plan.remove.push(e)
    }
  }

  // And anything sitting on a name another service owns.
  for (const e of existing) {
    if (ownedElsewhere.includes(e.name) && !plan.remove.find((r) => r.id === e.id)) {
      plan.remove.push(e)
    }
  }

  if (plan.keep.length) {
    console.log('ALREADY CORRECT')
    for (const r of plan.keep) console.log(`  = ${describe(r)}`)
    console.log()
  }
  if (plan.remove.length) {
    console.log('DELETE')
    for (const r of plan.remove) {
      const note = ownedElsewhere.includes(r.name) ? '  <- R2 attaches its own record here' : ''
      console.log(`  - ${describe(r)}${note}`)
    }
    console.log()
  }
  if (plan.create.length) {
    console.log('CREATE')
    for (const r of plan.create) console.log(`  + ${describe(r)}\n      ${r.why}`)
    console.log()
  }
  if (!plan.remove.length && !plan.create.length) {
    console.log('Nothing to change.')
    return
  }
  if (!APPLY) {
    console.log('Dry run — nothing was written. Re-run with --apply to make these changes.')
    return
  }

  let failed = 0
  for (const r of plan.remove) {
    const res = await cf('DELETE', `/zones/${zoneId}/dns_records/${r.id}`)
    if (res.success) {
      console.log(`deleted ${r.type} ${r.name}`)
    } else {
      failed++
      console.error(`FAILED to delete ${r.type} ${r.name}:`, JSON.stringify(res.errors))
    }
  }
  for (const r of plan.create) {
    const body = {
      type: r.type,
      name: r.name,
      content: r.type === 'TXT' ? r.content.replace(/^"|"$/g, '') : r.content,
      ttl: 1,
      proxied: r.proxied ?? false
    }
    if (r.priority !== undefined) body.priority = r.priority
    const res = await cf('POST', `/zones/${zoneId}/dns_records`, body)
    if (res.success) {
      console.log(`created ${r.type} ${r.name} -> ${r.content}`)
    } else {
      failed++
      console.error(`FAILED to create ${r.type} ${r.name}:`, JSON.stringify(res.errors))
    }
  }

  // Read the zone back. The plan is not the outcome.
  const after = await cf('GET', `/zones/${zoneId}/dns_records?per_page=200`)
  if (after.success) {
    console.log('\nZone now holds, for the names we touched:')
    const names = new Set([...want.map((w) => w.name), ...ownedElsewhere])
    const rows = after.result.filter((e) => names.has(e.name))
    if (!rows.length) console.log('  (none)')
    for (const e of rows) console.log(`  ${describe({ ...e, proxied: e.proxied })}`)
  }

  if (failed) {
    console.error(`\n${failed} operation(s) failed.`)
    process.exit(1)
  }
  console.log('\nDone. Fly and Vercel verify asynchronously; check with:')
  console.log('  flyctl certs check api.plexiidesk.com -a focusbuddy-signal')
  console.log('  npx vercel domains inspect view.plexiidesk.com')
  console.log('  npx vercel domains inspect admin.plexiidesk.com')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
