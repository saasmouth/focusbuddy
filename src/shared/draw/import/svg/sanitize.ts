// The text-level guard every SVG passes before an XML parser sees it.
//
// An SVG file is untrusted: it may come from anyone, by drag and drop or a
// shared folder. The parser that reads it must never be asked to fetch
// anything, run anything, or grow the input without bound. Doing that HERE,
// on the text, means the guarantees hold whatever XML parser runs next
// (Chromium's in the app, happy-dom's in the tests):
//
//   - DOCTYPE internal subsets are read by this code, not the parser. Simple
//     internal entities (Illustrator's `<!ENTITY ns_svg "http://...">`) are
//     expanded here, with limits on their number and size, and only when their
//     replacement text is plain text: no markup, no reference to another
//     custom entity (so "billion laughs" cannot nest). External entities
//     (SYSTEM / PUBLIC -- XXE) and parameter entities are refused outright.
//     The DOCTYPE itself is then removed, so the parser never sees a DTD.
//   - Processing instructions other than the XML declaration are removed
//     (`<?xml-stylesheet href=...?>` would name an external sheet).
//   - Size is capped before and after expansion.
// Scripts, event handlers and external references are removed later, on the
// parsed tree (see importer.ts); nothing from the file is ever executed.

import { MAX_SVG_BYTES } from '../imageInfo'

export interface SanitizeResult {
  text: string
  notes: string[]
}

export class SvgRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SvgRefused'
  }
}

const MAX_ENTITIES = 128
const MAX_ENTITY_VALUE = 4096
const PREDEFINED = new Set(['amp', 'lt', 'gt', 'quot', 'apos'])

/** Find the end of a DOCTYPE that starts at `start` (respecting a [ ... ] subset and quotes). */
function doctypeEnd(s: string, start: number): { end: number; subset: string | null } {
  let i = start + '<!DOCTYPE'.length
  let quote = ''
  let subsetStart = -1
  let subsetEnd = -1
  for (; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '[' && subsetStart < 0) subsetStart = i + 1
    else if (c === ']' && subsetStart >= 0 && subsetEnd < 0) {
      // Find the real end of the subset: the ']' followed by optional space and '>'.
      if (/^\]\s*>/.test(s.slice(i))) subsetEnd = i
    } else if (c === '>' && (subsetStart < 0 || subsetEnd >= 0)) {
      return { end: i + 1, subset: subsetStart >= 0 ? s.slice(subsetStart, subsetEnd) : null }
    }
  }
  throw new SvgRefused('the file has an unterminated DOCTYPE')
}

function readEntities(subset: string, notes: string[]): Map<string, string> {
  const ents = new Map<string, string>()
  // Comments inside the subset are not declarations.
  const body = subset.replace(/<!--[\s\S]*?-->/g, '')
  if (/<!ENTITY\s+%/i.test(body)) throw new SvgRefused('the file declares a parameter entity, which is not allowed')
  // A declaration ends at the first '>' OUTSIDE its quoted value.
  const re = /<!ENTITY\s+([A-Za-z_:][-A-Za-z0-9._:]*)\s+((?:"[^"]*"|'[^']*'|[^"'>])*)>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const name = m[1]
    const def = m[2].trim()
    if (/^(SYSTEM|PUBLIC)\b/i.test(def)) throw new SvgRefused(`the file declares an external entity ("${name}"), which is never loaded`)
    const q = /^(["'])([\s\S]*)\1$/.exec(def)
    if (!q) throw new SvgRefused(`the entity "${name}" is malformed`)
    const value = q[2]
    if (value.length > MAX_ENTITY_VALUE) throw new SvgRefused(`the entity "${name}" is too large`)
    if (value.includes('<')) throw new SvgRefused(`the entity "${name}" contains markup, which is not allowed`)
    // Only character references and the predefined five may appear inside.
    const refs = value.match(/&([^;\s]*);/g) ?? []
    for (const r of refs) {
      const inner = r.slice(1, -1)
      if (!(PREDEFINED.has(inner) || /^#(\d+|x[0-9a-fA-F]+)$/.test(inner))) throw new SvgRefused(`the entity "${name}" refers to another entity, which is not allowed`)
    }
    if (ents.has(name)) continue
    ents.set(name, value)
    if (ents.size > MAX_ENTITIES) throw new SvgRefused('the file declares too many entities')
  }
  if (ents.size) notes.push(`${ents.size} XML entit${ents.size === 1 ? 'y was' : 'ies were'} expanded`)
  return ents
}

/** The text with entities expanded and the DOCTYPE and processing instructions removed. */
export function sanitizeSvgText(input: string, maxBytes = MAX_SVG_BYTES): SanitizeResult {
  if (input.length > maxBytes) throw new SvgRefused(`the file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`)
  const notes: string[] = []
  let s = input.replace(/^﻿/, '')
  const dt = /<!DOCTYPE/i.exec(s)
  if (dt) {
    const { end, subset } = doctypeEnd(s, dt.index)
    const ents = subset ? readEntities(subset, notes) : new Map<string, string>()
    s = s.slice(0, dt.index) + s.slice(end)
    if (/<!DOCTYPE/i.test(s)) throw new SvgRefused('the file has more than one DOCTYPE')
    if (ents.size) {
      let grown = 0
      s = s.replace(/&([A-Za-z_:][-A-Za-z0-9._:]*);/g, (whole, name: string) => {
        const v = ents.get(name)
        if (v === undefined) return whole
        grown += v.length
        if (grown > maxBytes) throw new SvgRefused('entity expansion makes the file too large')
        // Substituted text may land inside a quoted attribute: keep its quotes literal.
        return v.replace(/"/g, '&quot;').replace(/'/g, '&apos;')
      })
    }
  }
  if (/<!ENTITY/i.test(s)) throw new SvgRefused('the file declares entities outside a DOCTYPE')
  // Processing instructions: keep only a leading XML declaration.
  let pis = 0
  s = s.replace(/<\?([\s\S]*?)\?>/g, (whole, inner: string, offset: number) => {
    if (/^xml\s/i.test(inner) && s.slice(0, offset).trim() === '') return whole
    pis++
    return ''
  })
  if (pis) notes.push(`${pis} processing instruction${pis === 1 ? ' was' : 's were'} ignored`)
  if (s.length > maxBytes) throw new SvgRefused(`the file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`)
  return { text: s, notes }
}

/**
 * SVG bytes as text: UTF-8 unless a byte-order mark or the XML declaration
 * says otherwise. An unknown encoding label falls back to UTF-8.
 */
export function decodeSvgBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes)
  let head = ''
  for (let i = 0; i < Math.min(bytes.length, 200); i++) head += String.fromCharCode(bytes[i])
  const m = /^\s*<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head.replace(/^\xEF\xBB\xBF/, ''))
  if (m && !/^utf-?8$/i.test(m[1])) {
    try {
      return new TextDecoder(m[1].toLowerCase()).decode(bytes)
    } catch {
      // An encoding this runtime does not know: read it as UTF-8.
    }
  }
  return new TextDecoder('utf-8').decode(bytes)
}
