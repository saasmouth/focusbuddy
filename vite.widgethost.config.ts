// Build config for the widget host: a second entry of the browser runtime
// (src/web/widgetHost), built on its own so its output is exactly what
// PlexiiLite vendors (haptyx-web scripts/build-widget-host.mjs, from a pinned
// commit). Everything else -- the module swaps that let the data layer run in
// a Worker, the aliases, the WASM handling -- is the web build's, with one swap
// of the host's own (HOST_MODULE_SWAPS).
import { resolve } from 'path'
import { defineConfig, mergeConfig, type Plugin } from 'vite'
import web, { MODULE_SWAPS, swapModules } from './vite.web.config'
import { hostManifest } from './src/web/widgetHost/capabilities'

/**
 * What the host's Worker has instead of the share app's, on top of the web
 * build's swaps.
 *
 * - No local-model client. The share app may ask an Ollama server on
 *   localhost:11434 for search vectors; the host runs inside PlexiiLite, which
 *   shows no AI, and asked it on every page that showed a calculator, a chart
 *   or a task list (1a, 2026-11-20). See src/web/worker/main/hostLocalModel.ts.
 *
 * Only the Worker: it is where the data layer runs, and the page never reaches
 * these modules. tests/widget-host/network.spec.ts checks the built host, page
 * and Worker together.
 */
export const HOST_MODULE_SWAPS: Record<string, string> = {
  'src/main/ai/localModel.ts': 'src/web/worker/main/hostLocalModel.ts'
}

/**
 * manifest.json beside index.html: what this host can make and show, from the
 * same lists the page loads (capabilities.ts). PlexiiLite reads it; haptyx-web
 * build-widget-host.mjs adds the pinned commit and every file's hash.
 */
function writeManifest(): Plugin {
  return {
    name: 'plexii-widget-host-manifest',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: JSON.stringify(hostManifest(), null, 2) + '\n' })
    }
  }
}

const config = mergeConfig(
  web,
  defineConfig({
    root: 'src/web/widgetHost',
    // Relative, so the page works from wherever it is copied (a file in
    // PlexiiLite's resources, a test server).
    base: './',
    // The share app's public files (its Service Worker, Vercel and Netlify
    // rules) have no place here: the host serves no Drive bytes and no routes.
    publicDir: false,
    plugins: [writeManifest()],
    build: {
      outDir: resolve(__dirname, 'out/widget-host'),
      emptyOutDir: true,
      rollupOptions: { input: resolve(__dirname, 'src/web/widgetHost/index.html') }
    },
    server: { port: 5190 }
  })
)

// The Worker's swaps: the web build's and the host's, in one plugin. Set after
// the merge, so the Worker has exactly this list rather than whatever merging
// two plugin factories would make of them.
config.worker = { ...config.worker, plugins: () => [swapModules({ ...MODULE_SWAPS, ...HOST_MODULE_SWAPS })] }

export default config
