// Every channel the preload invokes must be a channel main registers.
//
// window.api is the ONLY way the renderer reaches main, and a name typed twice
// is a name that can be typed differently twice. When it is, nothing fails at
// build time and nothing fails at boot: the feature simply throws "No handler
// registered for ..." the first time a user reaches it, which for an AI action
// behind a button may be weeks after it shipped.
//
// That is not hypothetical. `metricBindings.build` invoked 'metrics:buildBinding'
// while main registered 'metricBinding:build', so AI autobuild for stat cards
// could never once have worked. Nothing caught it, because the existing channel
// test (webHandlerChannels) compares the preload against the BROWSER worker's
// table, not against the Electron handlers. This closes that gap.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const root = resolve(__dirname, '../..')
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8')

/** Channel literals, as they are written at the call site. */
function literals(source: string, call: string): string[] {
  const out: string[] = []
  // Only a single-quoted literal first argument. A computed channel would be
  // invisible here, which is itself a reason not to compute one.
  const re = new RegExp(`${call.replace('.', '\\.')}\\(\\s*'([^']+)'`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) out.push(m[1])
  return out
}

const HANDLER_FILES = [
  'src/main/ipc/index.ts',
  'src/main/index.ts',
  'src/main/mdExternal.ts',
  'src/main/activityTracker.ts'
]

const registered = new Set(
  HANDLER_FILES.flatMap((f) => [
    ...literals(read(f), 'ipcMain.handle'),
    // A channel served with .on is still served; the preload reaches those
    // through send rather than invoke, but listing them keeps the set honest.
    ...literals(read(f), 'ipcMain.on')
  ])
)

const preload = read('src/preload/index.ts')
const invoked = [...new Set(literals(preload, 'ipcRenderer.invoke'))]
const sent = [...new Set(literals(preload, 'ipcRenderer.send'))]

describe('preload → main channel agreement', () => {
  it('finds both sides, so a silent parse failure cannot pass as agreement', () => {
    expect(registered.size).toBeGreaterThan(100)
    expect(invoked.length).toBeGreaterThan(100)
  })

  it('registers a handler for every channel the preload invokes', () => {
    const missing = invoked.filter((c) => !registered.has(c))
    expect(missing, `preload invokes channels main never registers: ${missing.join(', ')}`).toEqual(
      []
    )
  })

  it('registers a listener for every channel the preload sends to', () => {
    const missing = sent.filter((c) => !registered.has(c))
    expect(missing, `preload sends on channels main never listens for: ${missing.join(', ')}`).toEqual(
      []
    )
  })

  it('agrees with the generated channel map', () => {
    // The map is derived from the preload, so a name that is in one and not the
    // other means the map is stale and the web runtime is serving the old name.
    const map = read('src/web/api/channelMap.generated.ts')
    for (const channel of invoked) {
      if (!map.includes(`'${channel}'`)) {
        throw new Error(`channelMap.generated.ts is stale: it does not mention ${channel}`)
      }
    }
  })
})
