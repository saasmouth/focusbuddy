// What the system clipboard holds, as conversion forms (src/shared/snippetForms.ts).
//
// ⌘V and right-click › Paste in every destination go through the SAME acceptors
// as inserting a saved snippet, so one conversion matrix serves both and the two
// can never drift apart. This module is the clipboard half: it reads every
// flavour our apps and the system put on the pasteboard and turns them into the
// best-first Form[] that formsOf() produces for a snippet.
//
// Order of preference, most faithful first:
//   1. a Plexii app's own format → its snippet body → formsOf(body), so a copy
//      from PlexiiDraw, PlexiiDeck/PlexiiDesign, PlexiiDiagrams or PlexiiCells
//      lands exactly as a saved snippet of the same selection would;
//   2. SVG (raw macOS flavour, never getType('image/svg+xml'), which blocks the
//      main process on macOS) → 'svg';
//   3. PNG / JPEG → 'image';
//   4. HTML → 'docNodes' (via htmlToDoc) and 'rows' when it is a table;
//   5. plain text → 'text' (and 'rows' when it is TSV).
//
// A flavour whose envelope carries a version this build does not understand is
// refused, never guessed at (PlexiiDraw's rule).

import type { Form } from '@shared/snippetForms'

export interface ClipboardForms {
  forms: Form[]
  /** Which Plexii app the copy came from, when it is one of ours. */
  source: string | null
}

/** Read the system clipboard as conversion forms, best first. Empty when it holds nothing usable. */
export async function readClipboardForms(): Promise<ClipboardForms> {
  // Implemented in the any-to-any office-apps phase; this stub keeps the
  // signature fixed so the widget phase can be built against it in parallel.
  return { forms: [], source: null }
}
