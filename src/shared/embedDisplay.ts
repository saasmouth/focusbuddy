// How an embedded work widget presents itself, chosen per PLACEMENT by whoever
// placed it: 'data' is the content alone, the live and editable component with
// no frame or header; 'object' is the original object as the desk draws it.
//
// It lives in shared, not the renderer, because every host's normaliser has to
// keep it. Each one whitelists the fields it keeps, and a field missing from a
// whitelist is silently dropped on the next load (how Design once lost its
// swatches).
export type EmbedDisplay = 'data' | 'object'

export const EMBED_DISPLAY_DEFAULT: EmbedDisplay = 'data'

/** Anything unrecognised (older placements carry nothing) reads as the default. */
export function normaliseEmbedDisplay(v: unknown): EmbedDisplay {
  return v === 'object' || v === 'data' ? v : EMBED_DISPLAY_DEFAULT
}

/** The field to spread into a normalised placement: present only when it isn't the default. */
export function embedDisplayField(v: unknown): { embedDisplay?: EmbedDisplay } {
  return v === 'object' ? { embedDisplay: 'object' } : {}
}
