// Every channel the browser runtime serves must be a channel that exists.
//
// The handler table is written by hand, mirroring src/main/ipc/index.ts, and
// hand-written mirrors drift. Two ways in particular: serving a channel under a
// name nothing calls (ai:status, where the real one is ai:getStatus) which is
// dead code that looks like coverage; and serving a real channel with the wrong
// argument shape, which fails only when a user reaches that feature.
//
// The first is caught here, against the map generated from the preload -- the
// same source the browser's window.api is built from, so agreement with it is
// exactly agreement with what the renderer can call. Both were real mistakes in
// the commit that added these; this is why the test exists.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { HANDLERS } from '../../src/web/worker/handlers'
import { INVOKE_CHANNELS, HANDLER_PARAMS } from '../../src/web/api/channelMap.generated'

const realChannels = new Set(Object.values(INVOKE_CHANNELS))

/**
 * The parameter list each browser handler declares, read out of the table.
 *
 * Read textually rather than through Function.length, which counts only
 * parameters before the first optional one and so cannot tell `(a, b?)` from
 * `(a)` -- precisely the confusion this is meant to catch.
 */
/** Split a parameter list on commas that are not inside <>, (), [] or {}. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const c of text) {
    if ('<([{'.includes(c)) depth++
    else if ('>)]}'.includes(c)) depth--
    if (c === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += c
  }
  if (current.trim()) parts.push(current.trim())
  return parts.filter(Boolean)
}

function browserHandlerParams(): Record<string, string[]> {
  const src = readFileSync(resolve(__dirname, '../../src/web/worker/handlers.ts'), 'utf-8')
  const out: Record<string, string[]> = {}
  const re = /'([a-zA-Z]+:[a-zA-Z0-9_-]+)':\s*h\(\s*(?:async\s*)?\(([^)]*)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    // Split at paren depth, not on every comma: a parameter typed
    // Record<string, string> contains one, and splitting there invents an
    // argument that does not exist. The generator learned this the same way.
    //
    // Then the same identifier extraction it uses, so `label?: string` and
    // `label: string` compare equal -- optionality is not the contract being
    // checked here, position and count are.
    out[m[1]] = splitTopLevel(m[2]).map((p) => /^([A-Za-z_$][\w$]*)/.exec(p)?.[1] ?? p)
  }
  return out
}

describe('the browser runtime handler table', () => {
  it('serves only channels the preload actually exposes', () => {
    const invented = Object.keys(HANDLERS).filter((c) => !realChannels.has(c))
    expect(invented, `not real channels: ${invented.join(', ')}`).toEqual([])
  })

  it('serves a meaningful share of what the desktop does', () => {
    // Not a target to game -- a floor, so a refactor that quietly unhooks half
    // the table is noticed. It rises as namespaces are ported.
    expect(Object.keys(HANDLERS).length).toBeGreaterThanOrEqual(100)
  })

  it('takes the same arguments the desktop handler takes', () => {
    // Channel names agreeing proves nothing about the call itself. Four
    // handlers in the Drive namespace were wired with their arguments in the
    // wrong order -- createFolder(name, parentId) where the desktop passes
    // (parentId, name) -- which type-checks, builds, and fails only when a user
    // creates a folder. This compares against the desktop signatures the
    // generator reads out of ipc/index.ts.
    const mine = browserHandlerParams()
    const mismatched: string[] = []
    for (const [channel, params] of Object.entries(mine)) {
      const theirs = HANDLER_PARAMS[channel]
      if (!theirs) continue // covered by the previous test
      if (theirs.length !== params.length) {
        mismatched.push(`${channel}: browser takes (${params.join(', ')}), desktop takes (${theirs.join(', ')})`)
      }
    }
    expect(mismatched, mismatched.join('\n')).toEqual([])
  })

  it('names its arguments as the desktop does, so order is comparable', () => {
    // Counts agreeing still permits (a, b) against (b, a). Names are the only
    // signal available without running both, and they are copied from the same
    // handlers, so a disagreement is worth a look even when it is deliberate.
    const mine = browserHandlerParams()
    const renamed: string[] = []
    for (const [channel, params] of Object.entries(mine)) {
      const theirs = HANDLER_PARAMS[channel]
      if (!theirs || theirs.length !== params.length) continue
      // A leading underscore is the "declared but deliberately unused"
      // convention and is not a difference in the contract.
      const norm = (names: readonly string[]): string => names.map((n) => n.replace(/^_/, '')).join(',')
      if (norm(params) !== norm(theirs)) {
        renamed.push(`${channel}: (${params.join(', ')}) vs desktop (${theirs.join(', ')})`)
      }
    }
    expect(renamed, renamed.join('\n')).toEqual([])
  })

  it('covers the workspace sync loop completely, since partial sync loses data', () => {
    const syncChannels = [...realChannels].filter((c) => c.startsWith('workspace:'))
    const missing = syncChannels.filter((c) => !(c in HANDLERS))
    // The exceptions: export/import read and write a file on disk, and
    // workspace:ask and workspace:related are retrieval over the workspace
    // rather than part of the sync loop.
    //
    // The file-bytes channels used to be here too. They are served now that the
    // browser has a byte store of its own (OPFS), which is what makes
    // cross-member file sync work in a tab rather than silently moving metadata
    // for files whose contents never arrive.
    expect(missing.sort()).toEqual([
      'workspace:ask',
      'workspace:exportJson',
      'workspace:importJson',
      'workspace:related'
    ])
  })
})
