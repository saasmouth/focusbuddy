// The field-hook registry: how a feature package teaches the v2 normaliser a
// field it adds, from its own file in src/shared/draw/fields/, without editing
// the model or normalize.ts.
//
// Without a hook an unknown field is still KEPT verbatim (forward
// compatibility), but nothing vouches for its value; with one, every load
// passes the value through the hook first, exactly as the built-in fields are.
// A package that renders its field must register a hook for it. Built-in
// fields cannot be overridden (the normaliser only consults hooks for keys it
// does not know).
//
// This module imports nothing, so a fields/*.ts file can import it while
// normalize.ts is loading those files.

/** Where a hooked field lives. */
export type DrawFieldScope = 'doc' | 'layer' | 'artboard' | 'node'

/** Normalise one field's untrusted value; return undefined to drop it. */
export type DrawFieldHook = (value: unknown) => unknown

const hooks: Record<DrawFieldScope, Map<string, DrawFieldHook>> = {
  doc: new Map(),
  layer: new Map(),
  artboard: new Map(),
  node: new Map()
}

export function registerDrawField(scope: DrawFieldScope, key: string, normalize: DrawFieldHook): void {
  hooks[scope].set(key, normalize)
}

/** For tests: forget a hook. */
export function unregisterDrawField(scope: DrawFieldScope, key: string): void {
  hooks[scope].delete(key)
}

export function fieldHook(scope: DrawFieldScope, key: string): DrawFieldHook | undefined {
  return hooks[scope].get(key)
}
