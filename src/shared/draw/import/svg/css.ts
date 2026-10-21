// The CSS that SVG exporters write: `style="..."` attributes (Inkscape puts
// everything there) and `<style>` sheets of class rules (Illustrator's .st0,
// .st1 ... and Figma's occasional classes), applied with the real cascade:
//
//   presentation attribute  <  sheet rule (by specificity, then order)
//                           <  style attribute  <  sheet !important  <  style !important
//
// Selectors: type, *, #id, .class, [attr], [attr=v] (and ~= |= ^= $= *=),
// compounds of those, and the descendant and child combinators. A rule using
// anything else (pseudo-classes, sibling combinators) is skipped and counted,
// never guessed at. At-rules are skipped; `@import` is never followed.

export interface Declaration {
  prop: string
  value: string
  important: boolean
}

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Split on `sep` outside quotes and parentheses. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (c === sep && depth === 0) {
      out.push(s.slice(start, i))
      start = i + 1
    }
  }
  out.push(s.slice(start))
  return out
}

/** A declaration block ("fill:red; stroke : #000 !important") as declarations, in order. */
export function parseDeclarations(text: string | null | undefined): Declaration[] {
  if (!text) return []
  const out: Declaration[] = []
  for (const part of splitTop(stripComments(text), ';')) {
    const colon = part.indexOf(':')
    if (colon < 0) continue
    const prop = part.slice(0, colon).trim().toLowerCase()
    let value = part.slice(colon + 1).trim()
    if (!/^-?[a-z][a-z0-9-]*$/.test(prop) || !value) continue
    let important = false
    const imp = /\s*!\s*important\s*$/i.exec(value)
    if (imp) {
      important = true
      value = value.slice(0, imp.index).trim()
    }
    out.push({ prop, value, important })
  }
  return out
}

// ── Selectors ────────────────────────────────────────────────────────────────

/** The element interface selector matching needs (a DOM Element satisfies it). */
export interface StyleElement {
  localName: string
  nodeType: number
  getAttribute(name: string): string | null
  hasAttribute?(name: string): boolean
  /** parentNode, not parentElement: every XML DOM has the former. */
  parentNode: unknown
}

/** The parent element, or null at the top (a Document is not an element). */
export function parentEl<T extends StyleElement>(el: T): T | null {
  const p = el.parentNode as T | null
  return p && p.nodeType === 1 ? p : null
}

interface AttrTest {
  name: string
  op: '' | '=' | '~=' | '|=' | '^=' | '$=' | '*='
  value: string
}

interface Compound {
  type: string | null
  id: string | null
  classes: string[]
  attrs: AttrTest[]
}

interface Selector {
  /** Right to left: parts[0] is the subject; each later part is an ancestor (combinators[i] links parts[i] to parts[i+1]). */
  parts: Compound[]
  combinators: Array<' ' | '>'>
  specificity: number
}

const IDENT = '-?[_a-zA-Z\\u00a0-\\uffff][-_a-zA-Z0-9\\u00a0-\\uffff]*'

function parseCompound(s: string): Compound | null {
  const c: Compound = { type: null, id: null, classes: [], attrs: [] }
  let i = 0
  const typeM = new RegExp(`^(${IDENT}|\\*)`).exec(s)
  if (typeM) {
    if (typeM[1] !== '*') c.type = typeM[1].replace(/^.*\|/, '')
    i = typeM[0].length
  }
  while (i < s.length) {
    const rest = s.slice(i)
    let m: RegExpExecArray | null
    if ((m = new RegExp(`^#(${IDENT})`).exec(rest))) c.id = m[1]
    else if ((m = new RegExp(`^\\.(${IDENT})`).exec(rest))) c.classes.push(m[1])
    else if ((m = new RegExp(`^\\[\\s*(${IDENT})\\s*(?:([~|^$*]?=)\\s*(?:"([^"]*)"|'([^']*)'|(${IDENT}))\\s*)?\\]`).exec(rest))) {
      c.attrs.push({ name: m[1], op: (m[2] ?? '') as AttrTest['op'], value: m[3] ?? m[4] ?? m[5] ?? '' })
    } else return null
    i += m[0].length
  }
  return c
}

function parseSelector(text: string): Selector | null {
  const tokens = text
    .trim()
    .replace(/\s*>\s*/g, ' > ')
    .split(/\s+/)
    .filter(Boolean)
  if (!tokens.length) return null
  const parts: Compound[] = []
  const combinators: Array<' ' | '>'> = []
  let pending: ' ' | '>' = ' '
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]
    if (t === '>') {
      pending = '>'
      continue
    }
    if (/[+~:]/.test(t.replace(/\[[^\]]*\]/g, ''))) return null
    const c = parseCompound(t)
    if (!c) return null
    if (parts.length) combinators.push(pending)
    pending = ' '
    parts.push(c)
  }
  if (!parts.length) return null
  let a = 0
  let b = 0
  let cc = 0
  for (const p of parts) {
    if (p.id) a++
    b += p.classes.length + p.attrs.length
    if (p.type) cc++
  }
  return { parts, combinators, specificity: a * 1_000_000 + b * 1_000 + cc }
}

function getAttr(el: StyleElement, name: string): string | null {
  const v = el.getAttribute(name)
  return v === '' && el.hasAttribute && !el.hasAttribute(name) ? null : v
}

function attrMatches(el: StyleElement, t: AttrTest): boolean {
  const v = getAttr(el, t.name)
  if (v === null) return false
  switch (t.op) {
    case '':
      return true
    case '=':
      return v === t.value
    case '~=':
      return v.split(/\s+/).includes(t.value)
    case '|=':
      return v === t.value || v.startsWith(`${t.value}-`)
    case '^=':
      return t.value !== '' && v.startsWith(t.value)
    case '$=':
      return t.value !== '' && v.endsWith(t.value)
    default:
      return t.value !== '' && v.includes(t.value)
  }
}

function compoundMatches(el: StyleElement, c: Compound): boolean {
  if (c.type && el.localName !== c.type) return false
  if (c.id && getAttr(el, 'id') !== c.id) return false
  if (c.classes.length) {
    const cls = (getAttr(el, 'class') ?? '').split(/\s+/)
    for (const k of c.classes) if (!cls.includes(k)) return false
  }
  for (const a of c.attrs) if (!attrMatches(el, a)) return false
  return true
}

function selectorMatches(el: StyleElement, sel: Selector, i = 0): boolean {
  if (!compoundMatches(el, sel.parts[i])) return false
  if (i === sel.parts.length - 1) return true
  const comb = sel.combinators[i]
  let p = parentEl(el)
  if (comb === '>') return p !== null && selectorMatches(p, sel, i + 1)
  while (p) {
    if (selectorMatches(p, sel, i + 1)) return true
    p = parentEl(p)
  }
  return false
}

// ── Sheets ───────────────────────────────────────────────────────────────────

interface Rule {
  selector: Selector
  decls: Declaration[]
  order: number
}

export interface StyleSheetSet {
  rules: Rule[]
  /** Rules skipped because they use selectors this importer does not evaluate. */
  skippedSelectors: number
  /** `@import` rules, which are never fetched. */
  imports: number
  /** Other at-rules (@media, @font-face, ...) that were skipped. */
  atRules: number
}

export function emptySheets(): StyleSheetSet {
  return { rules: [], skippedSelectors: 0, imports: 0, atRules: 0 }
}

/** Skip a balanced { ... } block starting at `i` (which is at the '{'); returns the index after it. */
function skipBlock(s: string, i: number): number {
  let depth = 0
  for (; i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return s.length
}

/** Add one `<style>` sheet's rules to `set`. */
export function addStyleSheet(set: StyleSheetSet, text: string): void {
  const s = stripComments(text.replace(/<!\[CDATA\[|\]\]>/g, ''))
  let i = 0
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++
    if (i >= s.length) break
    if (s[i] === '@') {
      const m = /^@([a-z-]+)/i.exec(s.slice(i))
      const name = (m?.[1] ?? '').toLowerCase()
      const semi = s.indexOf(';', i)
      const brace = s.indexOf('{', i)
      if (name === 'import') set.imports++
      else set.atRules++
      if (brace >= 0 && (semi < 0 || brace < semi)) i = skipBlock(s, brace)
      else i = semi < 0 ? s.length : semi + 1
      continue
    }
    const open = s.indexOf('{', i)
    if (open < 0) break
    const close = s.indexOf('}', open)
    if (close < 0) break
    const selText = s.slice(i, open)
    const decls = parseDeclarations(s.slice(open + 1, close))
    for (const one of splitTop(selText, ',')) {
      const sel = parseSelector(one)
      if (!sel) {
        if (one.trim()) set.skippedSelectors++
        continue
      }
      set.rules.push({ selector: sel, decls, order: set.rules.length })
    }
    i = close + 1
  }
}

/**
 * The cascaded CSS declarations for an element, from sheets and its style
 * attribute, as prop -> value. Presentation attributes are the caller's lower
 * layer (they lose to everything here).
 */
export function cascadedStyle(el: StyleElement, sheets: StyleSheetSet): Map<string, string> {
  const matched: Array<{ d: Declaration; spec: number; order: number; inline: boolean }> = []
  for (const r of sheets.rules) {
    if (!selectorMatches(el, r.selector)) continue
    for (const d of r.decls) matched.push({ d, spec: r.selector.specificity, order: r.order, inline: false })
  }
  parseDeclarations(getAttr(el, 'style')).forEach((d, i) => matched.push({ d, spec: Number.MAX_SAFE_INTEGER, order: i, inline: true }))
  // Lowest priority first, so later writes win.
  const rank = (m: (typeof matched)[number]): number => (m.d.important ? 2 : 0) + (m.inline ? 1 : 0)
  matched.sort((a, b) => rank(a) - rank(b) || a.spec - b.spec || a.order - b.order)
  const out = new Map<string, string>()
  for (const m of matched) out.set(m.d.prop, m.d.value)
  return out
}
