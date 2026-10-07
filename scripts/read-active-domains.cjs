// Resolve the ACTIVE product domains out of src/shared/productDomains.ts.
//
// WHY THIS EXISTS
//
// The build needs those four hostnames, and neither consumer can import the
// module: electron-builder.cjs is CommonJS loaded by electron-builder, and
// scripts/release-env.mjs runs under plain node. Both used to carry their own
// regex, and ACTIVE changing shape broke them silently differently:
//
//   export const ACTIVE: ProductDomains = CURRENT                              (was)
//   export const ACTIVE: ProductDomains = { ...CURRENT, downloads: PRODUCTION.downloads }  (now)
//
// release-env.mjs matched `= ([A-Z]+)` and simply stopped matching, which would
// have aborted the release build at its first step. One parser, used by both,
// so a shape it cannot read fails loudly in one place instead of two.
//
// These hostnames are COMPILED INTO the installer. A wrong answer here is not a
// deploy to redo, it is a release to redo, after someone cannot sign in.
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const SURFACES = ['site', 'api', 'viewer', 'downloads']

function literalSet(src, name) {
  const block = new RegExp(`export const ${name}: ProductDomains = \\{([\\s\\S]*?)\\n\\}`).exec(src)
  if (!block) return null
  const out = {}
  for (const key of SURFACES) {
    const m = new RegExp(`${key}:\\s*'([^']+)'`).exec(block[1])
    if (m) out[key] = m[1]
  }
  return out
}

/**
 * Returns { domains: {site, api, viewer, downloads}, describe: string }.
 * Throws if ACTIVE cannot be resolved — never guesses, never partially fills.
 */
function readActiveDomains(root) {
  const path = join(root, 'src/shared/productDomains.ts')
  const src = readFileSync(path, 'utf8')

  // The ACTIVE initialiser: everything after `=` up to the end of the statement.
  const m = /export const ACTIVE: ProductDomains = ([\s\S]*?)\n\n/.exec(src + '\n\n')
  if (!m) throw new Error(`could not find ACTIVE in ${path}`)
  const expr = m[1].trim()

  // Form 1: a bare reference, e.g. `CURRENT`.
  const bare = /^([A-Z][A-Z_]*)$/.exec(expr)
  if (bare) {
    const set = literalSet(src, bare[1])
    if (!set) throw new Error(`ACTIVE references ${bare[1]}, which is not a literal set`)
    return { domains: set, describe: bare[1] }
  }

  // Form 2: a spread with overrides, e.g.
  //   { ...CURRENT, downloads: PRODUCTION.downloads }
  //   { ...CURRENT, site: 'https://example.com' }
  const spread = /^\{\s*\.\.\.([A-Z][A-Z_]*)\s*,?([\s\S]*)\}$/.exec(expr)
  if (spread) {
    const base = literalSet(src, spread[1])
    if (!base) throw new Error(`ACTIVE spreads ${spread[1]}, which is not a literal set`)
    const domains = { ...base }
    const overrides = []
    const body = spread[2]
    for (const key of SURFACES) {
      // `key: OTHER.key`
      const ref = new RegExp(`\\b${key}:\\s*([A-Z][A-Z_]*)\\.${key}\\b`).exec(body)
      if (ref) {
        const other = literalSet(src, ref[1])
        if (!other || !other[key]) throw new Error(`ACTIVE overrides ${key} from ${ref[1]}, which has no ${key}`)
        domains[key] = other[key]
        overrides.push(`${key}=${ref[1]}`)
        continue
      }
      // `key: 'https://…'`
      const lit = new RegExp(`\\b${key}:\\s*'([^']+)'`).exec(body)
      if (lit) {
        domains[key] = lit[1]
        overrides.push(`${key}=literal`)
      }
    }
    const describe = overrides.length ? `${spread[1]} + ${overrides.join(' ')}` : spread[1]
    return { domains, describe }
  }

  throw new Error(
    `ACTIVE is a shape this parser does not understand:\n  ${expr}\n` +
      'Supported: a bare set name, or { ...SET, key: OTHER.key } / { ...SET, key: \'literal\' }.'
  )
}

/** True when the origin must use electron-updater's `github` provider. */
function usesGithubReleases(origin) {
  return /github\.com/.test(origin)
}

module.exports = { readActiveDomains, usesGithubReleases, SURFACES }
