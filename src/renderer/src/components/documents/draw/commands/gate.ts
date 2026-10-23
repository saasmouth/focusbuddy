// A command's `enabled` and its `disabledReason` from ONE predicate (SPEC §9.5:
// a disabled item always says why). `why` returns the sentence the menu shows
// under a greyed item, or null when the command can act; `enabled` is only
// "why says nothing", so the grey state and the sentence cannot disagree.
//
// Not a `*.commands.ts` file, so the registry does not load it as commands.

import type { Command, EditorCtx } from '../editor/types'

/** Why a command is off now, as a short sentence; null when it can act. Must be pure. */
export type Why = (ctx: EditorCtx) => string | null

export const READ_ONLY_REASON = 'This artwork is read-only.'

/** Off on a read-only drawing (one from a newer PlexiiDraw, or a viewer's). */
export const notReadOnly: Why = (ctx) => (ctx.get().readOnly ? READ_ONLY_REASON : null)

/** The first reason that applies, checked in order. */
export function firstOf(...whys: Why[]): Why {
  return (ctx) => {
    for (const w of whys) {
      const r = w(ctx)
      if (r) return r
    }
    return null
  }
}

/** `reason` when `ok` is false. */
export function unless(ok: (ctx: EditorCtx) => boolean, reason: string): Why {
  return (ctx) => (ok(ctx) ? null : reason)
}

/** `enabled` and `disabledReason` for a command, both read from `why`. */
export function gate(why: Why): Required<Pick<Command, 'enabled' | 'disabledReason'>> {
  return { enabled: (ctx) => why(ctx) === null, disabledReason: why }
}

/** A command that can only be off on a read-only drawing. */
export const writableGate = gate(notReadOnly)
