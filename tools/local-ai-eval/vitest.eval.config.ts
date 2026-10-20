import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// The local-AI eval is NOT part of the unit suite: it loads a multi-gigabyte
// model or calls a paid API, and one run takes tens of minutes. Run it with
//   npx vitest run --config tools/local-ai-eval/vitest.eval.config.ts
// (see run.eval.ts for the environment variables that pick the target).
const root = resolve(__dirname, '..', '..')
export default defineConfig({
  root,
  test: {
    environment: 'node',
    include: ['tools/local-ai-eval/run.eval.ts'],
    testTimeout: 6 * 60 * 60 * 1000,
    hookTimeout: 10 * 60 * 1000,
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false
  },
  resolve: {
    alias: {
      '@shared': resolve(root, 'src/shared'),
      '@renderer': resolve(root, 'src/renderer/src')
    }
  }
})
