// What the main process reads off the system clipboard for a cross-app paste
// (src/main/appClipboard.ts), as plain data the renderer turns into conversion
// forms (renderer/src/lib/clipboardForms.ts). Shared so the IPC contract, the
// preload and both ends agree on one shape.

/** What the renderer gets: every flavour a cross-app paste can use, as plain data. */
export interface AppClipboardRead {
  /** PlexiiDraw's native JSON (its versioned envelope, unparsed). */
  drawNative?: string
  /** Our private DataTransfer types (application/x-plexii-*), by type. */
  custom?: Record<string, string>
  /** SVG markup, from an SVG flavour or an .svg file copied in Finder. */
  svg?: string
  /** A picture (PNG or JPEG bytes, or a copied image file) with its pixel size when known. */
  image?: { dataUrl: string; w: number; h: number }
  html?: string
  text?: string
  error?: string
}
