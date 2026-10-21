// Lazy loading of the geometry engines, kept apart from engine.ts so code
// that needs only one engine (the main process, for Clipper2) never pulls the
// others into its bundle: import createClipperEngine from clipperEngine.ts
// there, not this file.

import type { EngineId, GeometryEngine } from './engine'

const cache = new Map<EngineId, Promise<GeometryEngine>>()

/**
 * Load an engine once, lazily: paper.js (about 214 KB minified, 74 KB gzip)
 * and Clipper2 (214 KB of wasm plus 54 KB of glue) are paid for only when a
 * feature first needs them.
 */
export function loadGeometryEngine(id: EngineId): Promise<GeometryEngine> {
  let p = cache.get(id)
  if (!p) {
    p =
      id === 'inhouse'
        ? import('./inhouse').then((m) => m.inhouseEngine)
        : id === 'paper'
          ? import('./paperEngine').then((m) => m.createPaperEngine())
          : import('./clipperEngine').then((m) => m.createClipperEngine())
    // A failed load is not cached: the next call retries.
    p.catch(() => cache.delete(id))
    cache.set(id, p)
  }
  return p
}
