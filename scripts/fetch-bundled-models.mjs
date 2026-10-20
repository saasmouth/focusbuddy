// Stage the on-device AI models that ship INSIDE the app.
//
//   node scripts/fetch-bundled-models.mjs                 # download from each model's pinned source
//   node scripts/fetch-bundled-models.mjs --from <dir>    # copy (APFS clone) files already on disk
//   node scripts/fetch-bundled-models.mjs --check         # verify what is staged; change nothing
//
// Writes resources/models/<bundleId>/<file> and resources/models/<bundleId>/LICENSE.txt
// for every entry in resources/local-models.json (models[] and embedding). That
// folder is gitignored build input: electron-builder.cjs (extraResourcesFor)
// copies it to Contents/Resources/models/ when it exists, and
// scripts/verify-model-split.mjs checks the DMG carries it and the update zip
// does not. Every file is verified against the manifest's size and sha256 before
// it is left in place; a mismatch is deleted and the script exits non-zero, so a
// wrong file can never be packaged under a checksum the app trusts.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const from = args.includes('--from') ? args[args.indexOf('--from') + 1] : null
const checkOnly = args.includes('--check')

const manifest = JSON.parse(readFileSync(join(root, 'resources', 'local-models.json'), 'utf8'))
const entries = [...manifest.models, manifest.embedding]

const sha256 = (p) =>
  new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject)
  })

async function verified(p, e) {
  if (!existsSync(p) || statSync(p).size !== e.sizeBytes) return false
  return (await sha256(p)) === e.sha256
}

let failed = false
for (const e of entries) {
  const dir = join(root, 'resources', 'models', e.bundleId)
  const dest = join(dir, e.file)
  if (await verified(dest, e)) {
    console.log(`  OK       ${e.bundleId}/${e.file}`)
  } else if (checkOnly) {
    console.log(`  MISSING  ${e.bundleId}/${e.file}`)
    failed = true
    continue
  } else {
    mkdirSync(dir, { recursive: true })
    const part = `${dest}.part`
    if (from) {
      const src = join(from, e.file)
      if (!existsSync(src)) {
        console.log(`  MISSING  ${src}`)
        failed = true
        continue
      }
      try {
        execFileSync('cp', ['-c', src, part]) // APFS clone: no extra disk until modified
      } catch {
        copyFileSync(src, part)
      }
    } else {
      // The pinned source commit, as a raw download.
      const url = e.sourceUrl.replace('/blob/', '/resolve/')
      console.log(`  fetching ${url}`)
      const res = await fetch(url)
      if (!res.ok || !res.body) {
        console.log(`  FAIL     ${e.file}: HTTP ${res.status}`)
        failed = true
        continue
      }
      await pipeline(Readable.fromWeb(res.body), createWriteStream(part))
    }
    if (!(await verified(part, e))) {
      unlinkSync(part)
      console.log(`  CHECKSUM ${e.bundleId}/${e.file} did not match the manifest; deleted`)
      failed = true
      continue
    }
    renameSync(part, dest)
    console.log(`  STAGED   ${e.bundleId}/${e.file}  ${e.sizeBytes} bytes  sha256 ${e.sha256}`)
  }
  const lic = join(root, 'resources', 'local-model-licenses', e.licenseFile)
  if (!checkOnly) copyFileSync(lic, join(dir, 'LICENSE.txt'))
  else if (!existsSync(join(dir, 'LICENSE.txt'))) {
    console.log(`  MISSING  ${e.bundleId}/LICENSE.txt`)
    failed = true
  }
}
if (failed) process.exit(1)
console.log('bundled models: OK')
