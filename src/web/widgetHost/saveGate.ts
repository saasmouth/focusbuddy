// When the widget host may write its file back (F2 item 2: no echo-saves).
//
// PlexiiLite owns the file and treats it as the only truth: it writes
// atomically, checks for changes made outside, and keeps Undo. A write that
// changes nothing is therefore not harmless -- it bumps the file's date, can
// trip another app's "changed on disk", and spends an Undo step on nothing.
// The spike posted a save on every store change, and card, shape and
// custom-block changed three times on load with no edit, so merely opening a
// file would have rewritten it.
//
// Two conditions, both required:
//   1. The text differs from the last text the embedder has (what it loaded,
//      then each save), ignoring exportedAt, which every export restamps, and
//      ignoring key order and indentation.
//   2. The person has done something in the page since it loaded (a key, a
//      pointer, a paste, a drop). A widget that tidies its own content on
//      mount is not the person's change; it goes out with their first real
//      edit, never on its own. So opening and closing a file never writes it.
// Read-only never posts at all.

/** Recursively sorted keys, so two exports of the same file compare equal. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

/** The file's text with exportedAt removed and keys sorted; null if it is not JSON. */
export function canonicalFileText(text: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) delete (parsed as Record<string, unknown>).exportedAt
  return JSON.stringify(sortKeys(parsed))
}

export interface SaveGate {
  /** The person did something in the page (a key, a pointer, a paste, a drop). */
  touched(): void
  /** Should this export be posted? True means: post it now; it becomes the new baseline. */
  offer(text: string): boolean
  /** Whether an export was held back for want of a touch (diagnostics). */
  pending(): boolean
}

export function createSaveGate(loadedText: string, opts: { readOnly?: boolean } = {}): SaveGate {
  let baseline = canonicalFileText(loadedText)
  let touched = false
  let held = false
  return {
    touched() {
      touched = true
    },
    offer(text) {
      if (opts.readOnly) return false
      const canon = canonicalFileText(text)
      if (canon === null) return false
      if (canon === baseline) {
        held = false
        return false
      }
      if (!touched) {
        held = true
        // Not reported as pending: nothing the PERSON did is waiting.
        return false
      }
      baseline = canon
      held = false
      return true
    },
    pending() {
      return touched && held
    }
  }
}
