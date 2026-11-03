// Do two document bodies hold the same content?
//
// Used where a conditional save was refused as stale (documents.body_rev): if
// what this editor tried to save is already what is stored — another editor on
// the same document made the very same change first, typically the tidy-up an
// editor applies to a body on load — there is nothing to resolve, and showing
// "Changed elsewhere" would ask the person to choose between two identical
// texts (owner, 2026-11-03).
//
// Compared as stored JSON: key order is not content (two serialisers may order
// keys differently), and a field that is undefined is the same as an absent one,
// as it is once written. Array order, text and structure are content.

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : canonical(x)))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k]
      if (x !== undefined) out[k] = canonical(x)
    }
    return out
  }
  return v
}

export function sameDocBody(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}
