// Text extraction from Drive files: nothing to extract in the browser yet.
//
// The desktop reads bytes from disk and runs format-specific extractors over
// them, several of which shell out to native tooling. The browser has no file
// bytes (see ./files.ts), so this returns nothing rather than pretending an
// extraction happened. Its one caller, the chunk index, treats an empty result
// as "no text for this file" and moves on.
export function extractFileText(_id: string): string | null {
  return null
}
