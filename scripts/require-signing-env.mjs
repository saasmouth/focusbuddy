// Refuse to run a "signed" build unsigned.
//
// electron-builder.cjs has two modes by design: with Apple credentials in the
// environment it signs and notarises; without them it sets identity:null and
// produces an ad-hoc signed app, so an unprovisioned machine can still build.
//
// The trap is that `npm run dist:mac:signed` took the second path SILENTLY. It
// exited 0, wrote PlexiDesk-<v>-mac-universal.zip and .dmg, and the only sign
// anything was wrong was one line in the middle of the log:
//
//   skipped macOS code signing  reason=identity explicitly is set to null
//
// The artifacts are the right size and the right names. Gatekeeper rejects them
// on the user's machine, which is where you find out. So a script whose name
// says "signed" now checks that it can be.
const REQUIRED = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
const ALT = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']

if (process.env.SKIP_SIGNING_CHECK === '1') {
  console.log('[signing] SKIP_SIGNING_CHECK=1 — building WITHOUT signing on purpose')
  process.exit(0)
}

const havePassword = REQUIRED.every((k) => process.env[k])
const haveApiKey = ALT.every((k) => process.env[k])

if (!havePassword && !haveApiKey) {
  const missing = REQUIRED.filter((k) => !process.env[k])
  console.error(`
FATAL: a signed build was requested but the notarisation credentials are not in
the environment, so electron-builder would skip signing and produce an ad-hoc
signed app that Gatekeeper rejects.

  missing: ${missing.join(', ')}

These live in .env and are NOT loaded by npm. Run the build through the wrapper
that loads them:

  node scripts/release-env.mjs npm run dist:mac:signed

Set SKIP_SIGNING_CHECK=1 to build unsigned on purpose (local testing).
`)
  process.exit(1)
}
console.log(`[signing] credentials present (${havePassword ? 'apple-id + app password' : 'app store connect api key'})`)
