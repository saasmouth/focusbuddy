// Build config for the widget host: a second entry of the browser runtime
// (src/web/widgetHost), built on its own so its output is exactly what
// PlexiiLite vendors (haptyx-web scripts/build-widget-host.mjs, from a pinned
// commit). Everything else -- the module swaps that let the data layer run in
// a Worker, the aliases, the WASM handling -- is the web build's, unchanged.
import { resolve } from 'path'
import { defineConfig, mergeConfig } from 'vite'
import web from './vite.web.config'

export default mergeConfig(
  web,
  defineConfig({
    root: 'src/web/widgetHost',
    // Relative, so the page works from wherever it is copied (a file in
    // PlexiiLite's resources, a test server).
    base: './',
    // The share app's public files (its Service Worker, Vercel and Netlify
    // rules) have no place here: the host serves no Drive bytes and no routes.
    publicDir: false,
    build: {
      outDir: resolve(__dirname, 'out/widget-host'),
      emptyOutDir: true,
      rollupOptions: { input: resolve(__dirname, 'src/web/widgetHost/index.html') }
    },
    server: { port: 5190 }
  })
)
