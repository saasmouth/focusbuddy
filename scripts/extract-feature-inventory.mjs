// Derive the feature inventory from the code, not from memory.
//
// A hand-written feature list on a 300k-line codebase lists things that were
// removed, misses things nobody remembers, and invents importance. Everything
// factual here is read out of source: the widget catalogue, the view union, the
// segment registry, the IPC surface, the store layer. The only authored fields
// are the marketing lines, and they are marked as such.
//
// IMPORTANCE IS NOT INVENTED. Assigning 1-10 by feel would poison the database
// it is meant to seed. What is emitted instead are measurable signals — how
// many modules import a thing, how big its IPC surface is, how many tests name
// it — and an empty `weight` column for a human to fill.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs'
import { resolve, dirname, relative, basename } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8')

// ── every source file once, so counting is cheap ────────────────────────────
function walk(dir, out = []) {
  for (const e of readdirSync(resolve(ROOT, dir))) {
    const p = `${dir}/${e}`
    const st = statSync(resolve(ROOT, p))
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e)) out.push(p)
  }
  return out
}
const SRC = walk('src')
const TESTS = existsSync(resolve(ROOT, 'tests')) ? walk('tests') : []
const SRC_TEXT = new Map(SRC.map((f) => [f, read(f)]))
const TEST_TEXT = new Map(TESTS.map((f) => [f, read(f)]))

/** How many source files import this module — the blast radius of changing it. */
function importedBy(file) {
  const stem = basename(file).replace(/\.tsx?$/, '')
  let n = 0
  for (const [f, t] of SRC_TEXT) {
    if (f === file) continue
    if (new RegExp(`from '[^']*/${stem}'|from '\\./${stem}'`).test(t)) n++
  }
  return n
}

/** How many test files name this thing — a coverage signal, not a percentage. */
function testsNaming(term) {
  let n = 0
  for (const t of TEST_TEXT.values()) if (t.includes(term)) n++
  return n
}


/**
 * Whether anything in the product actually CALLS this module.
 *
 * `dependents` counts static `from '.../name'` imports, and that is blind to a
 * module reached through a barrel, a dynamic import or an IPC handler. Worse,
 * the review built on it called three modules "possibly dead" that were in fact
 * spec-conformance contracts — and called a fourth unused that was simply named
 * differently. This asks the more useful question: does any other source file
 * mention any of this module's exported functions by name? Zero means the code
 * is implemented, and perhaps tested, but governs nothing that ships.
 */
function callers(file) {
  const src = SRC_TEXT.get(file) || ''
  const exported = [...src.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1])
  if (exported.length === 0) return null // types/constants only — not applicable
  let n = 0
  for (const [f, t] of SRC_TEXT) {
    if (f === file) continue
    if (exported.some((fn) => new RegExp(`\\b${fn}\\b`).test(t))) n++
  }
  return n
}


/**
 * A module's own description: its leading comment block, as prose.
 *
 * The first version took only the first comment line, and module headers wrap
 * at 80 columns — so descriptions stopped mid-sentence ("Agents act on behalf
 * of a human and"). This joins the leading block and ends on a sentence
 * boundary, so a row in the database reads as a complete statement.
 */
function headerOf(file, max = 260) {
  // Imports first, comment second, is how 64 of the 71 stores are written, so
  // the imports are removed — multi-line ones included — before looking. The
  // first version stopped at the first import and discarded all of those
  // descriptions, filling the rows with "Zustand store".
  const body = (SRC_TEXT.get(file) || '')
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm, '')
    .replace(/^import\s+['"][^'"]+['"];?[ \t]*$/gm, '')
  const lines = body.split('\n')
  const block = []
  for (const l of lines) {
    const m = l.match(/^\s*\/\/\s?(.*)$/)
    if (m) { block.push(m[1].trim()); continue }
    if (block.length) break // the first block has ended
    if (l.trim() === '') continue
    break // code before any comment: this module has no header
  }
  const text = block.join(' ').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  // Prefer ending on a sentence; fall back to a word boundary with an ellipsis.
  const cut = text.slice(0, max)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.) '))
  if (stop > 80) return cut.slice(0, stop + 1).trim()
  return cut.slice(0, cut.lastIndexOf(' ')).trim() + '…'
}

const loc = (file) => (SRC_TEXT.get(file) || '').split('\n').length

// ── 1. Widgets: the desk's building blocks ──────────────────────────────────
function widgets() {
  const src = read('src/renderer/src/lib/widgetCatalog.ts')
  const body = src.slice(src.indexOf('WIDGET_CATALOG: WidgetCatalogEntry[] = ['))
  // Split into entries by brace depth rather than matching a field ORDER. The
  // first attempt assumed kind/category/label/icon/hint always appear in that
  // sequence and silently dropped six widgets that do not — a feature list
  // missing six features, with nothing to signal it.
  const entries = []
  let depth = 0
  let cur = ''
  // Only braces are counted, so a top-level entry sits at depth 1 — the array
  // bracket contributes nothing. Nested braces (defaultContent holds a
  // JSON.stringify call) push deeper and must stay inside the same entry.
  for (const ch of body) {
    if (ch === '{') { if (depth === 0) cur = ''; depth++ }
    if (depth >= 1) cur += ch
    if (ch === '}') { depth--; if (depth === 0 && cur) { entries.push(cur); cur = '' } }
  }
  const field = (e, name) => {
    for (const q of ["'", '"', '`']) {
      const i = e.indexOf(`${name}: ${q}`)
      if (i === -1) continue
      const from = i + name.length + 3
      let outStr = ''
      for (let j = from; j < e.length; j++) {
        if (e[j] === '\\') { outStr += e[j + 1]; j++; continue }
        if (e[j] === q) break
        outStr += e[j]
      }
      return outStr.replace(/\s+/g, ' ').trim()
    }
    return ''
  }
  const out = []
  for (const e of entries) {
    const kind = field(e, 'kind')
    if (!kind) continue
    out.push({
      domain: 'Widget',
      id: `widget.${kind}`,
      name: field(e, 'label') || kind,
      module: `Desk canvas / ${field(e, 'category') || 'Uncategorised'}`,
      description: field(e, 'hint'),
      status: /hideFromPicker:\s*true/.test(e) ? 'legacy (folded into File)' : 'active',
      tests: testsNaming(`'${kind}'`)
    })
  }
  return out
}

// ── 2. Screens: every destination the app can navigate to ───────────────────
function views() {
  const src = read('src/renderer/src/stores/view.ts')
  const body = src.slice(src.indexOf('export type View'), src.indexOf('interface ViewStore'))
  const seen = new Set()
  const out = []
  for (const m of body.matchAll(/kind:\s*'([a-z-]+)'([^}]*)\}/g)) {
    const kind = m[1]
    if (seen.has(kind)) continue
    seen.add(kind)
    const params = [...m[2].matchAll(/(\w+)\??:\s*string/g)].map((p) => p[1])
    out.push({
      domain: 'Screen',
      id: `view.${kind}`,
      name: kind,
      module: 'Navigation',
      description: params.length ? `Carries: ${params.join(', ')}` : 'No parameters — a place, not a thing',
      status: 'active',
      tests: testsNaming(`'${kind}'`)
    })
  }
  return out
}

// ── 3. Apps inside the four segments ────────────────────────────────────────
function apps() {
  const all = read('src/renderer/src/lib/segmentApps.ts')
  // Only the registry literal. Reading the whole file also matched example
  // keys in the doc comments above it.
  const src = all.slice(all.indexOf('export const SEGMENT_APPS'), all.indexOf('} as const satisfies'))
  const out = []
  let segment = null
  for (const line of src.split('\n')) {
    const seg = line.match(/^\s{2}(plexidesk|plexipeople|plexibrain|office):\s*\[/)
    if (seg) segment = seg[1]
    const app = line.match(/\{\s*key:\s*'([^']+)',\s*label:\s*'([^']+)'/)
    if (app && segment) {
      out.push({
        domain: 'App',
        id: `app.${segment}.${app[1]}`,
        name: app[2],
        module: segment,
        description: /hub:\s*true/.test(line) ? 'The segment landing page' : 'An app inside the segment',
        status: 'active',
        tests: testsNaming(`${segment}:${app[1]}`)
      })
    }
  }
  return out
}

// ── 4. Capabilities: the IPC surface, grouped by namespace ──────────────────
function capabilities() {
  let text = ''
  for (const f of ['src/main/ipc/index.ts', 'src/main/mdExternal.ts', 'src/main/activityTracker.ts']) {
    if (existsSync(resolve(ROOT, f))) text += read(f)
  }
  const byNs = new Map()
  for (const m of text.matchAll(/ipcMain\.handle\(\s*'([a-zA-Z]+):([a-zA-Z0-9]+)'/g)) {
    if (!byNs.has(m[1])) byNs.set(m[1], [])
    byNs.get(m[1]).push(m[2])
  }
  return [...byNs.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([ns, ops]) => ({
      domain: 'Capability',
      id: `ipc.${ns}`,
      name: ns,
      module: 'Main process',
      description: `${ops.length} operation${ops.length === 1 ? '' : 's'}: ${ops.slice(0, 8).join(', ')}${ops.length > 8 ? '…' : ''}`,
      status: 'active',
      surface: ops.length,
      tests: testsNaming(`${ns}:`)
    }))
}

// ── 5. State modules: the renderer's stores ─────────────────────────────────
function stores() {
  return SRC.filter((f) => /^src\/renderer\/src\/stores\/[^/]+\.ts$/.test(f)).map((f) => {
    const name = basename(f, '.ts')
    return {
      domain: 'State',
      id: `store.${name}`,
      name,
      module: 'Renderer state',
      description: headerOf(f),
      status: 'active',
      dependents: importedBy(f),
      loc: loc(f),
      tests: testsNaming(name)
    }
  }).sort((a, b) => b.dependents - a.dependents)
}

// ── 6. Engines: the substantial main-process modules ────────────────────────
function engines() {
  return SRC.filter((f) => /^src\/main\/(ai|db|mail)\/[^/]+\.ts$/.test(f))
    .map((f) => {
      const name = basename(f, '.ts')
      const c = callers(f)
      return {
        domain: 'Engine',
        id: `engine.${name}`,
        name,
        module: `Main / ${f.split('/')[2]}`,
        description: headerOf(f),
        // Unwired: implemented, maybe tested, called by nothing in the product.
        status: c === 0 ? 'unwired' : 'active',
        callers: c,
        dependents: importedBy(f),
        loc: loc(f),
        tests: testsNaming(name)
      }
    })
    .filter((e) => e.loc > 80)
    .sort((a, b) => b.loc - a.loc)
}

const rows = [...apps(), ...views(), ...widgets(), ...capabilities(), ...stores(), ...engines()]

const meta = {
  generated: new Date().toISOString(),
  commit: execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(),
  sourceFiles: SRC.length,
  testFiles: TESTS.length,
  totalLoc: SRC.reduce((n, f) => n + loc(f), 0)
}

writeFileSync(resolve(ROOT, 'docs/plexii-feature-inventory.json'), JSON.stringify({ meta, rows }, null, 1))

// CSV is the point: a PDF cannot be loaded into a database.
const COLS = ['id', 'domain', 'name', 'module', 'description', 'status', 'surface', 'callers', 'dependents', 'loc', 'tests']
const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
writeFileSync(
  resolve(ROOT, 'docs/plexii-feature-inventory.csv'),
  [
    [...COLS, 'weight', 'owner', 'marketing_description', 'notes'].join(','),
    ...rows.map((r) => [...COLS.map((c) => esc(r[c])), '', '', '', ''].join(','))
  ].join('\n')
)

console.log(JSON.stringify({ ...meta, rows: rows.length, byDomain: rows.reduce((a, r) => ({ ...a, [r.domain]: (a[r.domain] || 0) + 1 }), {}) }, null, 1))
