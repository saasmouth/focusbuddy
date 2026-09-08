// The public desk contract is owned by projects/haptyx-shared, one level above
// this repository. focusbuddy is cloned standalone (it is a submodule of the
// ecosystem repo), so it cannot import across that boundary any more than the
// signal server can. The contract is vendored into src/shared as committed
// files and tests/unit/contractSync.test.ts fails if they drift.
// Run `npm run sync:contract` after changing the canonical copy.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CANON = join(here, '..', '..', 'haptyx-shared', 'src')
const DEST = join(here, '..', 'src', 'shared')
export const FILES = ['publicDesk.ts', 'publicDeskValidate.ts', 'workspaceClient.ts']

export const HEADER = `// GENERATED FILE -- DO NOT EDIT.
// Vendored from projects/haptyx-shared/src by scripts/sync-contract.mjs.
// Edit the canonical copy there, then run: npm run sync:contract
`

export const canonicalAvailable = existsSync(CANON)
export const expected = (file) => HEADER + readFileSync(join(CANON, file), 'utf8')
export const vendored = (file) => {
  const p = join(DEST, file)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!canonicalAvailable) {
    console.error(`canonical contract not found at ${CANON}`)
    process.exit(1)
  }
  mkdirSync(DEST, { recursive: true })
  for (const f of FILES) {
    writeFileSync(join(DEST, f), expected(f))
    console.log(`  synced src/shared/${f}`)
  }
}
