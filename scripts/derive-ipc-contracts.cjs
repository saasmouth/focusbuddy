// Derive an ArgSpec registry from the real handler signatures.
const fs = require('fs')
const FILES = ['src/main/ipc/index.ts', 'src/main/mdExternal.ts', 'src/main/activityTracker.ts']
function parse() {
  const sigs = {}
  for (const f of FILES) {
    if (!fs.existsSync(f)) continue
    const s = fs.readFileSync(f, 'utf8')
    const re = /ipcMain\.handle\(\s*'([^']+)'\s*,\s*(?:async\s*)?\(([^)]*)\)/g
    let m
    while ((m = re.exec(s))) sigs[m[1]] = m[2].replace(/\s+/g, ' ').trim()
  }
  return sigs
}
// Resolve a named type to its actual shape by finding its DECLARATION, rather
// than guessing from the name. `EnergyLevel` and `WriteOrigin` are string unions
// while `NodeDraft` and `DeskLayout` are interfaces, and a name-based heuristic
// that got either wrong would reject legitimate calls — which is worse than not
// validating at all.
let typeIndex = null
function buildTypeIndex() {
  if (typeIndex) return typeIndex
  typeIndex = {}
  const roots = ['src/shared', 'src/main']
  const walk = (dir) => {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = `${dir}/${e.name}`
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); continue }
      if (!/\.ts$/.test(e.name)) continue
      const src = fs.readFileSync(full, 'utf8')
      for (const m of src.matchAll(/export\s+interface\s+([A-Za-z_]\w*)/g)) typeIndex[m[1]] = 'object'
      for (const m of src.matchAll(/export\s+type\s+([A-Za-z_]\w*)\s*=\s*([^\n]+)/g)) {
        const body = m[2].trim()
        if (/^['"]/.test(body)) typeIndex[m[1]] = 'string'      // 'a' | 'b' | 'c'
        else if (/^\{/.test(body)) typeIndex[m[1]] = 'object'
        else if (/^(number)\b/.test(body)) typeIndex[m[1]] = 'number'
        else if (/^(boolean)\b/.test(body)) typeIndex[m[1]] = 'boolean'
        else if (!(m[1] in typeIndex)) typeIndex[m[1]] = 'any'
      }
    }
  }
  for (const r of roots) walk(r)
  return typeIndex
}

// Collapse every brace group to `{}` so the tests below can only ever see the
// parameter's OWN punctuation, never punctuation belonging to members inside an
// inline object type. Repeated until stable, so nested objects flatten too.
function stripBraceGroups(t) {
  let prev
  let out = t
  do {
    prev = out
    out = out.replace(/\{[^{}]*\}/g, '{}')
  } while (out !== prev)
  return out
}

function specOf(param) {
  // Optionality belongs to the PARAMETER, which is the part before the first
  // colon. Reading it from the whole string meant `input: { a?: string }` -- a
  // REQUIRED argument whose type merely has an optional member -- was recorded as
  // optional, and since a channel is only registered when it has at least one
  // enforceable non-optional argument, the channel was dropped from the registry
  // altogether. That silently un-validated 32 handlers, among them agents:invoke,
  // chat:sendStream and files:ingestBuffer: precisely the object-taking handlers
  // this registry exists to cover.
  const colon = param.indexOf(':')
  const namePart = (colon === -1 ? param : param.slice(0, colon)).trim()
  const rawType = colon === -1 ? '' : param.slice(colon + 1).trim()
  // `probe` is the type with inline object bodies blanked out. For any type
  // without braces it is identical to the type itself, so this changes nothing
  // for the primitives and named types that already derived correctly.
  const probe = stripBraceGroups(rawType)
  const optional = namePart.endsWith('?') || /=/.test(probe)
  const t = probe.replace(/=.*$/, '').trim()
  const nullable = /\|\s*null/.test(t) || /\|\s*undefined/.test(t)
  const base = t.replace(/\|\s*(null|undefined)/g, '').trim()
  let kind = 'any'
  if (base === 'string') kind = 'string'
  else if (base === 'number') kind = 'number'
  else if (base === 'boolean') kind = 'boolean'
  else if (/^\{/.test(base) || /^Record</.test(base)) kind = 'object'
  else if (/^[A-Z]\w*$/.test(base)) {
    // A named type — resolved from its declaration, never from its name.
    const resolved = buildTypeIndex()[base]
    if (resolved === 'object' || resolved === 'string' || resolved === 'number' || resolved === 'boolean') {
      kind = resolved
    }
  }
  return { kind, optional, nullable }
}
function derive() {
  const sigs = parse()
  const out = {}
  for (const [ch, sig] of Object.entries(sigs)) {
    const params = sig.split(',').map((p) => p.trim()).filter(Boolean).slice(1)
    if (params.length === 0) continue
    const specs = params.map(specOf)
    // Only register a channel where at least one argument is actually enforceable.
    if (specs.some((s) => s.kind !== 'any' && !s.optional)) out[ch] = specs
  }
  return out
}
module.exports = { derive, parse, specOf }
// `--write` regenerates the committed registry; with no flag it prints the JSON
// so a test or a human can diff it against what is on disk.
if (require.main === module) {
  const specs = derive()
  if (!process.argv.includes('--write')) {
    console.log(JSON.stringify(specs, null, 0))
  } else {
    const lines = Object.entries(specs)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ch, ss]) => {
        const body = ss
          .map((s) => `{ kind: '${s.kind}', optional: ${s.optional}, nullable: ${s.nullable} }`)
          .join(', ')
        return `  '${ch}': [${body}]`
      })
    const existing = fs.readFileSync('src/main/ipc/ipcContracts.generated.ts', 'utf8')
    const header = existing.slice(0, existing.indexOf('export const IPC_ARG_CONTRACTS'))
    fs.writeFileSync(
      'src/main/ipc/ipcContracts.generated.ts',
      header + 'export const IPC_ARG_CONTRACTS: Record<string, readonly ArgSpec[]> = {\n' + lines.join(',\n') + '\n}\n'
    )
    console.log(`regenerated ${lines.length} channel contracts`)
  }
}
