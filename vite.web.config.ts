// Build config for the browser runtime.
//
// It compiles the same renderer the desktop ships, with three substitutions
// that let the data layer come along: the Electron-bound database module is
// swapped for the WebAssembly one, Node's crypto is swapped for the Web Crypto
// call of the same name, and better-sqlite3 is stubbed because nothing in the
// browser graph should reach it -- if something does, the stub throws by name
// instead of failing somewhere less obvious inside a bundler.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import type { Plugin } from 'vite'
import { keepPlexiiIconsAsFiles } from './electron.vite.config'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as { version: string }

/**
 * Redirect a module by absolute path. Aliases cannot do this on their own: the
 * data layer imports './database' relatively from 50 files, so the swap has to
 * happen after resolution, on the file that resolution arrived at.
 */
function swapModules(map: Record<string, string>): Plugin {
  const resolved = Object.entries(map).map(([from, to]) => [resolve(__dirname, from), resolve(__dirname, to)] as const)
  return {
    name: 'plexii-swap-modules',
    enforce: 'pre',
    async resolveId(source, importer) {
      const target = await this.resolve(source, importer, { skipSelf: true })
      if (!target) return null
      const hit = resolved.find(([from]) => from === target.id)
      return hit ? hit[1] : null
    }
  }
}

// The Worker is bundled by a pipeline of its own, so the swaps have to be
// registered twice -- and the Worker is the side that actually runs the data
// layer, which is why leaving it off the second list failed there and nowhere
// else.
//
// Exported because tests/unit/webBundleGraph.test.ts walks the same graph with
// the same swaps, to fail in the unit suite when anything Node-only gets in.
export const MODULE_SWAPS: Record<string, string> = {
  // The database, on WebAssembly instead of a file in userData.
  'src/main/db/database.ts': 'src/web/worker/database.ts',
  // Session state: owned by the page in the browser, not by the Worker.
  'src/main/db/account.ts': 'src/web/worker/main/account.ts',
  // Provider keys: deliberately absent in the browser (see the variant).
  'src/main/settingsStore.ts': 'src/web/worker/main/settingsStore.ts',
  // Row-change fan-out: postMessage rather than webContents.send.
  'src/main/tableEvents.ts': 'src/web/worker/main/tableEvents.ts',
  // Document-change fan-out, for the same reason: one document can be open in
  // two editors at once, and a copy that never hears about the other's save
  // ages silently until its own save is refused.
  'src/main/documentEvents.ts': 'src/web/worker/main/documentEvents.ts',
  // Drive file bytes live on OPFS rather than on a disk. Only the byte store is
  // swapped -- db/files.ts itself, all 900 lines of folders, tags, smart
  // folders, trash and search, is the same code on both runtimes.
  'src/main/db/fileBlobs.ts': 'src/web/worker/main/fileBlobs.ts',
  // OCR rasterises pages through native tooling; a tab has none. Only the
  // scanned-PDF fallback goes through here, so extraction still works for
  // everything whose text is already text.
  'src/main/ocr.ts': 'src/web/worker/main/ocr.ts',
  // pdf.js's shared globals: a native-canvas clash that only the desktop has
  // (pdf-parse vs the page renderer). fileText.ts reaches it; in a tab text
  // extraction runs as it is, and there is no page renderer.
  'src/main/pdfCanvasGlobals.ts': 'src/web/worker/main/pdfCanvasGlobals.ts',
  // Image downsampling: same rules, different encoder. The desktop has
  // Electron's nativeImage; a Worker has OffscreenCanvas.
  'src/main/db/imageDownsample.ts': 'src/web/worker/main/imageDownsample.ts',
  // The Vault: metadata is real, the crypto refuses. Its PBKDF2 and AES-GCM are
  // synchronous and the browser offers them only asynchronously, and a
  // hand-written cipher is not an acceptable way around that.
  'src/main/db/vault.ts': 'src/web/worker/main/vault.ts',
  // AI routing between the on-device model and the cloud. The browser has no
  // device model, and the desktop router holds its per-request cloud grant in
  // Node's AsyncLocalStorage -- reached through the live Resume summary, it
  // broke this build outright.
  'src/main/ai/local/providerRouter.ts': 'src/web/worker/main/providerRouter.ts',
  // Privacy switches live in a JSON file in Electron's userData. Reached through
  // the Background AI gate; it pulled Electron's npm stub (which calls
  // child_process and fs at load) into the Worker.
  'src/main/privacyPrefs.ts': 'src/web/worker/main/privacyPrefs.ts'
}

// Path aliases plus the Node-module shims. Exported for the same test.
export const WEB_ALIASES: Record<string, string> = {
  '@renderer': resolve('src/renderer/src'),
  '@shared': resolve('src/shared'),
  '@office': resolve('src/renderer/src/office'),
  '@runtime': resolve('src/renderer/src/runtime'),
  crypto: resolve('src/web/shims/crypto.ts'),
  path: resolve('src/web/shims/path.ts'),
  'node:crypto': resolve('src/web/shims/crypto.ts'),
  'better-sqlite3': resolve('src/web/shims/betterSqlite3.ts')
}

export default defineConfig({
  root: 'src/web',
  // Where this build will be served from. '/' for a root of its own; a path when
  // it is mounted inside another site, which is how it ships today: under
  // /share/ on the marketing site. Everything base-sensitive reads it back at
  // runtime through import.meta.env.BASE_URL -- the asset URLs, the Service
  // Worker's scope, and the /fb-file/ prefix that worker answers.
  base: process.env.VITE_WEB_BASE ?? '/',
  plugins: [react(), swapModules(MODULE_SWAPS)],
  resolve: {
    alias: WEB_ALIASES
  },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  optimizeDeps: {
    // The WASM build ships as an ES module with a sibling .wasm; pre-bundling
    // rewrites the URL it uses to find that file.
    exclude: ['@sqlite.org/sqlite-wasm']
  },
  worker: { format: 'es', plugins: () => [swapModules(MODULE_SWAPS)] },
  // Same rule as the desktop renderer (electron.vite.config.ts): icon files stay files.
  build: { outDir: '../../out/web', emptyOutDir: true, target: 'es2022', assetsInlineLimit: keepPlexiiIconsAsFiles },
  server: { port: 5180 }
})
