// printToPDF page size for a canvas measured in CSS pixels. Electron 44 reads a
// custom `pageSize` object in INCHES (older Electron took microns); passing
// microns makes Chromium's print compositor fail with "Page reading failed", so
// every custom-sized PDF export goes through this one conversion.

/** CSS px (96 per inch) to inches, as printToPDF's custom pageSize expects. */
export function pxToInch(px: number): number {
  return Math.max(px, 1) / 96
}

/** printToPDF `pageSize` for a canvas of the given CSS-pixel size. */
export function pdfPageSize(widthPx: number, heightPx: number): { width: number; height: number } {
  return { width: pxToInch(widthPx), height: pxToInch(heightPx) }
}
