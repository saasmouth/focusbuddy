// A diagram body must be a TREE: no object (a node's style, an edge's
// waypoints, a binding) may be reachable by two paths. A shared reference means
// an in-place edit to one shape silently changes another, and the IPC payload
// check (4.3.39-local.6) refused such bodies as "cyclic data", so they did not
// save. Every editor operation that copies (duplicate, paste, quick-add,
// templates, generators, imports) must produce fresh objects; this finds the
// ones that do not.

/**
 * Paths at which an object already seen elsewhere in `value` appears again,
 * each as "second path (first seen at first path)". Empty means a clean tree.
 */
export function sharedObjectPaths(value: unknown): string[] {
  const seen = new Map<object, string>()
  const out: string[] = []
  const walk = (v: unknown, path: string): void => {
    if (!v || typeof v !== 'object') return
    const first = seen.get(v)
    if (first !== undefined) {
      out.push(`${path} (first seen at ${first})`)
      return
    }
    seen.set(v, path)
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`))
    else for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`)
  }
  walk(value, '$')
  return out
}

/**
 * A deep copy of a plain-JSON diagram value. Anything an operation takes from
 * one place in a body and puts in another (a pasted node's style, a patch
 * applied to several shapes) goes through this, so the body stays a tree.
 */
export function fresh<T>(v: T): T {
  return v === undefined || v === null || typeof v !== 'object' ? v : (JSON.parse(JSON.stringify(v)) as T)
}
