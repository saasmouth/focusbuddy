// PlexiiDraw's clipboard FORMAT: the names and the envelope every reader and
// writer of a Draw copy agrees on. Moved here unchanged (byte for byte) from
// src/main/drawClipboard.ts and the Draw editor's clipboard.ts, so that a
// paste into another app (renderer/src/lib/clipboardForms.ts) reads the same
// definitions Draw writes with. Both original modules import from here and
// re-export, so nothing that imported them changes.

import type { Box } from '../drawGeometry'
import type { DrawAsset, DrawNode, DrawSwatch } from './model'

/** The native PlexiiDraw format: a web custom format, so the browser build can read it too. */
export const DRAW_CLIPBOARD_NATIVE = 'web application/vnd.plexii.draw+json'

/** A raw type in a read item's list that carries SVG, whatever the platform calls it. */
export function svgTypeIn(types: string[]): string | undefined {
  return types.find((t) => /^electron application\/osclipboard;format="(public\.svg-image|image\/svg\+xml|CorePasteboardFlavorType 0x73766720)"$/i.test(t))
}

/** A raw type carrying JPEG bytes, so a pasted photo keeps its own (smaller) encoding. */
export function jpegTypeIn(types: string[]): string | undefined {
  return types.find((t) => /^electron application\/osclipboard;format="(public\.jpeg|image\/jpeg|JFIF|CorePasteboardFlavorType 0x4A504547)"$/i.test(t))
}

// ── The payload ──────────────────────────────────────────────────────────────

export const DRAW_CLIPBOARD_KIND = 'plexiidraw/clipboard'
export const DRAW_CLIPBOARD_VERSION = 1

/** The native clipboard format: what a PlexiiDraw copy writes as JSON. */
export interface DrawClipboardPayload {
  kind: typeof DRAW_CLIPBOARD_KIND
  version: number
  /** Visible bounds of the copied art, document space. */
  bounds: Box
  /** The artboard the art was copied from (Paste in Place keeps the art where it sat on it). */
  artboard: { x: number; y: number; w: number; h: number }
  /** Top-level copied nodes, bottom first. Ids are the source's; a paste mints new ones. */
  nodes: DrawNode[]
  /** Exactly the assets the nodes use. */
  assets: Record<string, DrawAsset>
  /** Exactly the swatches the nodes reference. */
  swatches: DrawSwatch[]
}
