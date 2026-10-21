// @vitest-environment node
// Nothing Node-only may reach the browser runtime's bundle.
//
// The browser runtime (`npm run web:build`, which plexiidesk.com's /share/ app is
// built from) compiles the renderer and the data layer for a tab: the page, and
// a Worker that runs src/main/db on WebAssembly. Shared code under src/main is
// welcome there; code that needs Electron or Node is not, and
// vite.web.config.ts swaps each such module for a browser variant
// (MODULE_SWAPS) or shims the builtin (WEB_ALIASES).
//
// Twice that list fell behind and nothing noticed until the site's compose
// step ran. The local-AI work made liveResume.ts route through
// ai/local/providerRouter.ts, whose `import { AsyncLocalStorage } from
// 'node:async_hooks'` failed the build outright:
//
//   worker/index.ts -> worker/handlers.ts -> db/workspaceSync.ts
//     -> context/engine.ts -> ai/liveResume.ts -> ai/local/providerRouter.ts
//     -> node:async_hooks
//
// and the privacy work's privacyPrefs.ts (reached through
// db/widgetFiles.ts -> documentRetrieval.ts -> backgroundAiGate.ts) brought in
// electron, node:fs and node:path -- which did NOT fail the build: Vite stubs
// them with a warning, and Electron's npm package, whose index.js runs
// child_process and fs at load, was bundled into the Worker.
//
// So this walks both entries' import graphs the way the web build does, with
// the same swaps and aliases (imported from the config, not copied), and fails
// naming the import chain the moment a builtin or Electron is reached. It is a
// graph walk rather than a full `vite build` so it stays a couple of seconds;
// CI also runs the real build (.github/workflows/ci.yml, "Web build").
import { describe, it, expect, vi } from 'vitest'
import { builtinModules } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import * as esbuild from 'esbuild'
import { MODULE_SWAPS, WEB_ALIASES } from '../../vite.web.config'

// Only for the parity checks at the bottom, which import the desktop modules to
// compare defaults; the graph walk never executes anything.
vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent-userdata' } }))

const ROOT = resolve(__dirname, '../..')

/** The page's entry, and the Worker dbClient.ts starts with `new Worker(new URL(...))`. */
const ENTRIES = {
  page: 'src/web/boot.tsx',
  worker: 'src/web/worker/index.ts'
} as const

const NODE_ONLY = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`), 'electron'])
function isNodeOnly(spec: string): boolean {
  return NODE_ONLY.has(spec) || NODE_ONLY.has(spec.split('/')[0]) || spec.startsWith('node:') || spec.startsWith('electron/')
}

interface Walk {
  /** Every input file, repo-relative. */
  inputs: string[]
  /** Node-only specifiers reached, each with the import chain from the entry. */
  leaks: { spec: string; chain: string[] }[]
  errors: string[]
}

async function walk(entry: string): Promise<Walk> {
  const swaps = new Map(Object.entries(MODULE_SWAPS).map(([from, to]) => [resolve(ROOT, from), resolve(ROOT, to)]))
  const aliases = Object.entries(WEB_ALIASES).sort((a, b) => b[0].length - a[0].length)
  const leakedFrom = new Map<string, Set<string>>() // spec -> importers
  const plugin: esbuild.Plugin = {
    name: 'web-config-mirror',
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData === 'inner') return undefined
        let spec = args.path
        for (const [key, target] of aliases) {
          if (spec === key || spec.startsWith(key + '/')) {
            spec = target + spec.slice(key.length)
            break
          }
        }
        if (isNodeOnly(spec)) {
          const set = leakedFrom.get(spec) ?? new Set<string>()
          set.add(relative(ROOT, args.importer))
          leakedFrom.set(spec, set)
          return { path: spec, external: true }
        }
        const r = await build.resolve(spec, { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, pluginData: 'inner' })
        if (r.errors.length) {
          // A guarded optional require inside a dependency (framer-motion's
          // @emotion/is-prop-valid): Rollup leaves those alone, and so do we.
          if (args.kind === 'require-call' && args.importer.includes('/node_modules/')) return { path: spec, external: true }
          return { errors: r.errors }
        }
        return swaps.has(r.path) ? { path: swaps.get(r.path)! } : r
      })
    }
  }
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    logLevel: 'silent',
    plugins: [plugin],
    define: { __APP_VERSION__: '"0.0.0-test"' },
    loader: {
      '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.jpg': 'empty', '.jpeg': 'empty', '.gif': 'empty',
      '.webp': 'empty', '.wasm': 'empty', '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty', '.otf': 'empty',
      '.mp3': 'empty', '.mp4': 'empty', '.txt': 'empty', '.md': 'empty', '.html': 'empty'
    }
  }).catch((err: { errors?: esbuild.Message[] }) => ({ errors: err.errors ?? [], metafile: undefined }))

  const errors = (result.errors ?? []).map((e) => `${e.location?.file ?? '?'}:${e.location?.line ?? '?'}: ${e.text}`)
  const inputs = Object.keys(result.metafile?.inputs ?? {})
  // Breadth-first from the entry, so each chain shown is a shortest one.
  const parent = new Map<string, string | null>([[entry, null]])
  const queue = [entry]
  const metaInputs = result.metafile?.inputs ?? {}
  while (queue.length) {
    const file = queue.shift()!
    for (const imp of metaInputs[file]?.imports ?? []) {
      if (!parent.has(imp.path)) {
        parent.set(imp.path, file)
        queue.push(imp.path)
      }
    }
  }
  const chainTo = (file: string): string[] => {
    const chain: string[] = []
    for (let f: string | null | undefined = file; f; f = parent.get(f)) chain.unshift(f)
    return chain
  }
  const leaks = [...leakedFrom].map(([spec, importers]) => {
    const first = [...importers].sort((a, b) => chainTo(a).length - chainTo(b).length)[0]
    return { spec, chain: [...chainTo(first), spec] }
  })
  return { inputs, leaks, errors }
}

// Each graph is walked once and shared by the tests that read it.
const walks = new Map<string, Promise<Walk>>()
const walked = (entry: string): Promise<Walk> => {
  if (!walks.has(entry)) walks.set(entry, walk(entry))
  return walks.get(entry)!
}

const describeLeaks = (w: Walk): string =>
  w.leaks.map((l) => `${l.spec} reached via\n    ${l.chain.join('\n -> ')}`).join('\n\n')

describe('web bundle import graph', () => {
  it('the Worker entry is the one dbClient.ts starts', () => {
    const client = readFileSync(resolve(ROOT, 'src/web/api/dbClient.ts'), 'utf-8')
    expect(client).toContain(`new Worker(new URL('../worker/index.ts', import.meta.url)`)
  })

  it('every swap points at a file that exists', () => {
    for (const [from, to] of Object.entries(MODULE_SWAPS)) {
      expect(existsSync(resolve(ROOT, from)), from).toBe(true)
      expect(existsSync(resolve(ROOT, to)), to).toBe(true)
    }
  })

  for (const [name, entry] of Object.entries(ENTRIES)) {
    it(`the ${name} graph resolves and reaches no Node builtin or Electron`, async () => {
      const w = await walked(entry)
      expect(w.errors, w.errors.join('\n')).toEqual([])
      expect(w.inputs.length).toBeGreaterThan(50) // the walk really ran
      expect(w.leaks, `Node-only modules in the ${name} bundle. Swap the module in vite.web.config.ts (MODULE_SWAPS) or cut the import:\n\n${describeLeaks(w)}`).toEqual([])
    }, 60_000)
  }

  it('the Worker graph runs the browser variants, never the desktop modules they replace', async () => {
    const w = await walked(ENTRIES.worker)
    for (const [from, to] of Object.entries(MODULE_SWAPS)) {
      expect(w.inputs, from).not.toContain(from)
      if (from.includes('providerRouter') || from.includes('privacyPrefs')) expect(w.inputs, to).toContain(to)
    }
  }, 60_000)
})

describe('browser variants answer as the desktop does by default', () => {
  it('privacy switches: the shipped defaults', async () => {
    const web = await import('../../src/web/worker/main/privacyPrefs')
    const desktop = await import('../../src/main/privacyPrefs')
    expect(web.PRIVACY_DEFAULTS).toEqual(desktop.PRIVACY_DEFAULTS)
    expect(web.backgroundAiEnabled()).toBe(false)
    expect(web.getPrivacyPrefs()).toEqual(desktop.PRIVACY_DEFAULTS)
    expect(() => web.setPrivacyPrefs({ backgroundAi: true })).toThrow(/desktop app/)
  })

  it('AI routing: no device model, a key makes a cloud client, no key makes none', async () => {
    const web = await import('../../src/web/worker/main/providerRouter')
    expect(web.localOnlyActive()).toBe(false)
    const cloud = { messages: {} } as never
    expect(web.clientForKey('sk-test', () => cloud)).toBe(cloud)
    expect(web.clientForKey(null, () => cloud)).toBeNull()
    const rt = web.getLocalRuntime()
    expect(rt.installed()).toBe(false)
    await expect(rt.engine()).rejects.toMatchObject({ name: 'LocalModelMissingError' })

    // The desktop router, unwired (which is what the Worker would have had):
    // same answers for the same inputs.
    const desktop = await import('../../src/main/ai/local/providerRouter')
    expect(desktop.localOnlyActive()).toBe(false)
    expect(desktop.clientForKey(null, () => cloud)).toBeNull()
    expect(desktop.getLocalRuntime().installed()).toBe(false)
  })
})
