// Font catalogue + loader, shared by the document, spreadsheet, slide and
// design editors. Every family offered here ships with the app, so choosing one
// never contacts a font CDN:
//
//   - the core type stack (Inter, JetBrains Mono, Lexend, Atkinson Hyperlegible,
//     Patrick Hand) and Material Symbols come from the @fontsource /
//     material-symbols packages, imported by main.tsx;
//   - the rest are vendored in assets/fonts (latin subset, regular and bold plus
//     italics; SIL OFL 1.1, Permanent Marker Apache 2.0; licences in
//     assets/fonts/FONT-LICENSES.txt) and declared by bundled-fonts.css below.
//
// Until 4.3.34 the picker offered ~100 Google Fonts fetched from
// fonts.googleapis.com on demand, which told Google about every launch of
// PlexiiOffice and every font chosen, and in the PlexiiDesk window never worked
// at all (its CSP blocks the CDN). A document that still names a family no
// longer offered falls back to the generic stack; its stored value is untouched.
//
// The exported names keep "Google" for the call sites' sake; the fonts are
// Google Fonts families, served from the app itself.

import '../assets/fonts/bundled-fonts.css'
// Emitted with the bundle so the licences travel with the fonts.
import '../assets/fonts/FONT-LICENSES.txt?url'

export const GENERIC_FONTS = [
  { label: 'Default', value: '' },
  { label: 'Sans', value: 'Inter, system-ui, sans-serif' },
  { label: 'Serif', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Mono', value: '"JetBrains Mono", ui-monospace, monospace' }
]

// Every family the pickers offer, all bundled. Keep in step with
// assets/fonts/bundled-fonts.css and the type-stack imports; a unit test
// (bundledFonts.test.ts) fails if one is offered without being bundled.
export const GOOGLE_FONTS: string[] = [
  // Sans
  'Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Source Sans 3', 'Nunito',
  'Work Sans', 'DM Sans', 'Raleway', 'Lexend', 'Atkinson Hyperlegible', 'Oswald',
  // Serif
  'Merriweather', 'Playfair Display', 'Lora', 'PT Serif', 'EB Garamond', 'Source Serif 4',
  'Libre Baskerville',
  // Mono
  'JetBrains Mono', 'Fira Code', 'IBM Plex Mono', 'Source Code Pro', 'Roboto Mono',
  // Display and handwriting
  'Bebas Neue', 'Caveat', 'Dancing Script', 'Pacifico', 'Permanent Marker', 'Indie Flower',
  'Patrick Hand'
]

// Kept as a call-site hook: fonts are bundled, so there is nothing to fetch.
// Never inject a remote stylesheet here; tests/unit/bundledFonts.test.ts holds
// that line for the whole renderer.
export function loadGoogleFont(_family: string): void {
  /* every offered family is already declared by bundled-fonts.css */
}

// The CSS font-family value to store for a chosen Google family (with a fallback).
export function fontFamilyValue(family: string): string {
  if (!family) return ''
  if (family.includes(',')) return family // already a stack
  return `"${family}", sans-serif`
}

// Extract the primary family name from a stored CSS font-family value, for
// showing the current selection and matching the list.
export function familyLabel(value: string | undefined): string {
  if (!value) return 'Default'
  const first = value.split(',')[0].trim().replace(/^["']|["']$/g, '')
  return first || 'Default'
}
