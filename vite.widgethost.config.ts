// Build config for the widget host: a second entry of the browser runtime
// (src/web/widgetHost), built on its own so its output is exactly what
// PlexiiLite vendors (haptyx-web scripts/build-widget-host.mjs, from a pinned
// commit). Everything else -- the module swaps that let the data layer run in
// a Worker, the aliases, the WASM handling -- is the web build's. That includes
// having no local-model client: the web build swaps src/main/ai/localModel.ts
// for src/web/worker/main/localModel.ts, which has no model and nowhere to ask,
// so the host needs no swap of its own (it had one, hostLocalModel.ts, until
// the share app got the same swap; 4.3.55).
import { resolve } from 'path'
import { defineConfig, mergeConfig, type Plugin } from 'vite'
import web from './vite.web.config'
import { hostManifest } from './src/web/widgetHost/capabilities'

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

export default config
