import { resolve } from 'path'
import { readFileSync } from 'node:fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Single source of truth for the app version — read from package.json
// at build time and inlined into both main and renderer bundles as
// __APP_VERSION__. Bump `version` in package.json on every release and
// every surface that displays it (Footer, brochure /download, app
// identity) will follow automatically.
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf-8')
) as { version: string }
const APP_VERSION_DEFINE = {
  __APP_VERSION__: JSON.stringify(pkg.version)
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    define: APP_VERSION_DEFINE,
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // The on-device model runs in its own utility process (see
          // src/main/ai/local/engineHost.ts); Electron forks this file by path.
          localAiWorker: resolve('src/main/ai/local/localWorker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    define: APP_VERSION_DEFINE
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
        // Lean-split package boundaries (see src/renderer/src/office|runtime).
        // When these become real packages, only these targets move.
        '@office': resolve('src/renderer/src/office'),
        '@runtime': resolve('src/renderer/src/runtime')
      }
    },
    plugins: [react()],
    define: APP_VERSION_DEFINE,
    build: {
      minify: 'esbuild',
      rollupOptions: {
        input: {
          // One entry. The standalone PlexiiOffice renderer (plexioffice.html)
          // was retired in 4.3.41; the in-suite Office area is part of index.
          index: resolve('src/renderer/index.html')
        },
        output: {
          // Split the heavy, feature-specific vendor libraries into their own
          // chunks instead of folding them into one ~5MB blob. This does not
          // shrink first-load bytes on its own (these still load), but it isolates
          // the weight so an app update that only touches our code no longer forces
          // clients to re-download the editor/flow/chart/office vendors, which the
          // differential updater then ships as a much smaller delta. It also lets
          // the runtime fetch chunks in parallel, and it draws the boundaries a
          // later lazy-load pass (the real cold-start fix) will defer.
          manualChunks(id: string): string | undefined {
            if (!id.includes('node_modules')) return undefined
            if (/node_modules\/(@tiptap|prosemirror|tiptap-markdown|y-prosemirror)\//.test(id)) {
              return 'vendor-editor'
            }
            if (id.includes('node_modules/@xyflow/')) return 'vendor-flow'
            if (/node_modules\/(recharts|d3-|internmap|victory-vendor)\//.test(id)) {
              return 'vendor-charts'
            }
            if (/node_modules\/(exceljs|xlsx|pptxgenjs|@turbodocx)\//.test(id)) {
              return 'vendor-office'
            }
            if (/node_modules\/yjs\//.test(id)) return 'vendor-yjs'
            return undefined
          }
        }
      }
    }
  }
})
