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
//
// It also refuses the build that WOULD be signed, but with the app-specific
// password on notarytool's command line (readable by any process with ps): see
// scripts/notary-auth.cjs, which every signing gate shares. This script runs as
// its own step (`a && b` in package.json), so it cannot take anything out of
// the build's environment; electron-builder.cjs does that, inside the builder.
import { createRequire } from 'node:module'

const { resolveNotaryAuth } = createRequire(import.meta.url)('./notary-auth.cjs')

if (process.env.SKIP_SIGNING_CHECK === '1') {
  console.log('[signing] SKIP_SIGNING_CHECK=1 — building WITHOUT signing on purpose')
  process.exit(0)
}

const auth = resolveNotaryAuth(process.env)

if (auth.fatal) {
  console.error(`\nFATAL: ${auth.fatal}`)
  process.exit(1)
}

if (auth.mode === 'none') {
  console.error(`
FATAL: a signed build was requested but no notarisation credentials are in the
environment, so electron-builder would skip signing and produce an ad-hoc
signed app that Gatekeeper rejects.

They come from the login keychain (the notarytool profile "plexii-notary") and
from .env, which npm does NOT load. Run the build through the wrapper:

  node scripts/release-env.mjs npm run dist:mac:signed

Set SKIP_SIGNING_CHECK=1 to build unsigned on purpose (local testing).
`)
  process.exit(1)
}

for (const w of auth.warnings) console.warn(w)
console.log(`[signing] credentials present: ${auth.summary.replace(/^notarisation: /, '')}`)
