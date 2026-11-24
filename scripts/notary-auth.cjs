// How notarytool authenticates, and keeping the app-specific password OFF its
// command line.
//
// @electron/notarize runs notarytool with its credentials as ARGUMENTS. On the
// Apple ID path that is `--apple-id <id> --password <app-specific password>`,
// and a process's arguments are readable by every other process running on the
// Mac (`ps`, `pgrep -fl`) for as long as the upload takes — minutes. On
// 2026-11-25 it had been read that way into two agent sessions' tool output.
//
// The fix is a notarytool keychain profile: stored ONCE, by notarytool itself,
// with the password typed at its own secure prompt —
//
//   xcrun notarytool store-credentials plexii-notary \
//     --apple-id <id> --team-id <team> --keychain ~/Library/Keychains/login.keychain-db
//
// — after which the command line carries only `--keychain-profile plexii-notary`.
//
// THE TRAP this module exists for: electron-builder 26
// (app-builder-lib MacTargetHelper.getNotarizeOptions) takes the Apple ID +
// password path whenever EITHER APPLE_ID or APPLE_APP_SPECIFIC_PASSWORD is in
// the environment, BEFORE it looks at an API key or a keychain profile. So
// adding a profile changes nothing while the password is still exported: it has
// to be REMOVED from the environment the builder runs with. That is what
// `resolveNotaryAuth` returns, and what `applyNotaryAuth` does to process.env.
//
// The three gates all use this one module, so they cannot disagree:
//   - scripts/release-env.mjs        what the build is handed;
//   - scripts/require-signing-env.mjs refuses a signed build that would put the
//                                     password on the command line;
//   - electron-builder.cjs           strips it inside the builder's own process,
//                                     where notarize reads the environment — the
//                                     last line, whatever launched the build.
//
// Order: an App Store Connect API key (a FILE path on the command line), then a
// keychain profile, then — only with NOTARY_PASSWORD_IN_ARGV=1, and loudly — the
// old password path. A password with neither a key nor a profile is refused.
//
// Nothing here ever reads or prints a secret. Whether a profile is stored is
// asked of `security find-generic-password` by ACCOUNT NAME only, without -g or
// -w, which returns the item's attributes and never its password.
'use strict'

const { spawnSync } = require('node:child_process')
const { homedir } = require('node:os')
const { join } = require('node:path')

/** The profile this Mac's releases use; stored once in the login keychain. */
const DEFAULT_PROFILE = 'plexii-notary'
/** Explicit opt-in to the old path. Set at the shell, on purpose, never in .env. */
const ARGV_OPT_IN = 'NOTARY_PASSWORD_IN_ARGV'
const PASSWORD_KEYS = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD']
const API_KEY_KEYS = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']

function loginKeychain() {
  return join(homedir(), 'Library', 'Keychains', 'login.keychain-db')
}

/** notarytool names each saved profile's keychain item by this account. */
function profileAccount(profile) {
  return `com.apple.gke.notary.tool.saved-creds.${profile}`
}

/**
 * Is a notarytool profile stored? Attributes only (no -g, no -w): the password
 * is never read. `security` is looked up on PATH; a missing tool means "no".
 */
function profileStored(profile, keychain) {
  const args = ['find-generic-password', '-a', profileAccount(profile)]
  if (keychain) args.push(keychain)
  try {
    const r = spawnSync('security', args, { stdio: 'ignore' })
    return r.status === 0
  } catch {
    return false
  }
}

function storeCommand(profile) {
  return (
    `xcrun notarytool store-credentials ${profile} --apple-id <APPLE_ID> --team-id <APPLE_TEAM_ID> ` +
    `--keychain ~/Library/Keychains/login.keychain-db`
  )
}

/**
 * Decide how this build notarises. Pure apart from the injected lookup.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ profileExists?: (profile: string, keychain?: string) => boolean }} [deps]
 * @returns {{
 *   mode: 'api-key' | 'keychain-profile' | 'password-argv' | 'none',
 *   env: Record<string, string | undefined>,
 *   removed: string[],
 *   profile: string | null,
 *   summary: string,
 *   warnings: string[],
 *   fatal: string | null
 * }}
 */
function resolveNotaryAuth(env, deps = {}) {
  const exists = deps.profileExists || profileStored
  const out = { ...env }
  const removed = []
  const strip = (keys) => {
    for (const k of keys) {
      if (k in out) {
        delete out[k]
        removed.push(k)
      }
    }
  }
  const hasPassword = PASSWORD_KEYS.some((k) => !!env[k])
  const passwordComplete = PASSWORD_KEYS.every((k) => !!env[k]) && !!env.APPLE_TEAM_ID
  const hasApiKey = API_KEY_KEYS.every((k) => !!env[k])
  const base = { env: out, removed, profile: null, warnings: [], fatal: null }

  // 1. App Store Connect API key: notarytool gets a FILE PATH, no secret. But
  // electron-builder would still pick the password first if one is exported.
  if (hasApiKey && env.APPLE_TEAM_ID) {
    strip(PASSWORD_KEYS)
    return { ...base, mode: 'api-key', summary: 'notarisation: App Store Connect API key (no secret on any command line)' }
  }

  // 2. A keychain profile: named explicitly, or the default when it is stored.
  const keychain = env.APPLE_KEYCHAIN || undefined
  const named = env.APPLE_KEYCHAIN_PROFILE || ''
  if (named) {
    if (!exists(named, keychain)) {
      return {
        ...base,
        mode: 'none',
        summary: 'notarisation: refused',
        fatal:
          `APPLE_KEYCHAIN_PROFILE=${named}, but no notarytool profile of that name is in the keychain.\n` +
          `Store it once (notarytool asks for the app-specific password at its own prompt):\n\n  ${storeCommand(named)}\n`
      }
    }
  }
  const profile = named || (exists(DEFAULT_PROFILE, keychain) ? DEFAULT_PROFILE : '')
  if (profile) {
    strip(PASSWORD_KEYS)
    strip(API_KEY_KEYS.filter((k) => k in out && !hasApiKey))
    out.APPLE_KEYCHAIN_PROFILE = profile
    return {
      ...base,
      profile,
      mode: 'keychain-profile',
      summary:
        `notarisation: keychain profile ${profile} (no secret on any command line)` +
        (removed.length ? `; not passed to the build: ${removed.join(' ')}` : '')
    }
  }

  // 3. Only a password. notarytool would receive it as an argument.
  if (hasPassword) {
    if (env[ARGV_OPT_IN] === '1' && passwordComplete) {
      return {
        ...base,
        mode: 'password-argv',
        summary: 'notarisation: app-specific password ON THE COMMAND LINE (NOTARY_PASSWORD_IN_ARGV=1)',
        warnings: [
          '##############################################################################',
          'WARNING: notarytool will receive the app-specific password as a command-line',
          'argument. Any process on this Mac can read it with ps while notarisation runs.',
          `This is the explicit fallback (${ARGV_OPT_IN}=1). Store the profile instead:`,
          `  ${storeCommand(DEFAULT_PROFILE)}`,
          '##############################################################################'
        ]
      }
    }
    return {
      ...base,
      mode: 'none',
      summary: 'notarisation: refused',
      fatal:
        'The only notarisation credentials are an Apple ID app-specific password, and\n' +
        'notarytool would receive it on its command line, where any process on this Mac\n' +
        `can read it with ps. No keychain profile "${DEFAULT_PROFILE}" is stored.\n\n` +
        `Store it once (notarytool asks for the password at its own prompt):\n\n  ${storeCommand(DEFAULT_PROFILE)}\n\n` +
        `Or set ${ARGV_OPT_IN}=1 to use the password on the command line, on purpose.\n`
    }
  }

  return { ...base, mode: 'none', summary: 'notarisation: none (ad-hoc signed, not notarised)' }
}

/**
 * Apply the decision to process.env in place (for electron-builder.cjs, which
 * runs inside the builder). Throws on a refusal, so the build stops before
 * anything is packaged.
 */
function applyNotaryAuth(env = process.env, deps) {
  const r = resolveNotaryAuth(env, deps)
  if (r.fatal) throw new Error(`[notary-auth] ${r.fatal}`)
  for (const k of r.removed) delete env[k]
  if (r.profile) env.APPLE_KEYCHAIN_PROFILE = r.profile
  return r
}

module.exports = {
  DEFAULT_PROFILE,
  ARGV_OPT_IN,
  loginKeychain,
  profileAccount,
  profileStored,
  resolveNotaryAuth,
  applyNotaryAuth
}
