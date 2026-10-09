// Persona demo rooms — spec validation, record building and canvas layout.
//
// Pure functions only: nothing here touches a database or the filesystem, so the
// whole pipeline (spec → rows) is unit-tested in lib.test.cjs and the CLI in
// seed.cjs is a thin transaction around it.
//
// A spec is one JSON file per persona (personas/NN-slug.json). It describes a Room
// and its Desks in terms of what a person would put on them — a brief, a table, a
// chart over that table, a mind map, notes — and this module turns that into
// nodes / widgets / fb_tables / fb_rows with a layout, so no spec author has to
// think in pixels.
//
// Only widget kinds that survive a public share are used (see PUBLIC_RENDER_POLICY
// and PUBLIC_CAPTURE_ALLOWED in src/shared/publicDesk.ts). Metrics, stat cards,
// contacts and task lists publish as "not available publicly" placeholders, which
// would make a marketing desk look broken in the browser, so the schema simply has
// no way to ask for them. The same goes for anything that acts on its own (agents,
// living docs, webhooks) and for office documents (doc/sheet/slides): personal
// documents are not in workspace sync, so a seeded document would reach another
// device as a widget without its document, and the widget there would create a
// blank one and sync that pointer back over this one.
//
// Images are stored inline as JPEG data: URLs rather than as fb_files blobs. The
// public capture keeps only data: images (an fb-file:// picture publishes as an
// empty frame on the shared canvas), and personal file sync uploads the bytes of
// at most six files per cycle while marking the rest pushed, so a hundred seeded
// blobs would mostly never reach the server. Inline, the picture travels with
// its widget row everywhere. Each is kept small enough (MAX_IMAGE_DATA_URL) to sit
// inside the 512 KB capture cap.
//
// SAMPLE DATA, and labelled as such: every room description, desk description and
// desk brief carries the sample notice, added here rather than trusted to authors.
// Images are AI-generated illustrations and every image title says so.

const { createHash } = require('node:crypto')

const NAMESPACE = 'plexii-persona-demo/v1'
const ROOT_KEY = 'root'
const ROOT_TITLE = 'Plexii Showcase · Persona demos'
const ROOT_DESCRIPTION =
  'Sample demo rooms, one per target persona, for sharing with prospects. ' +
  'Every person, company and figure inside is illustrative demo data.'

const SAMPLE_BRIEF_NOTICE =
  '> **Sample desk.** The people, organisations and figures on this desk are illustrative demo data, not a real engagement.'
const SAMPLE_DESC_SUFFIX = ' · Sample demo desk.'
const SAMPLE_ROOM_SUFFIX = ' Sample demo room — illustrative data.'

const CATEGORIES = ['Primary early adopters', 'Professional use cases', 'Team and buying personas']
const COLUMN_TYPES = new Set(['text-short', 'text-long', 'number', 'single-select', 'checkbox'])
const CHART_TYPES = new Set(['bar', 'line', 'area', 'pie', 'kpi'])
const AGGS = new Set(['sum', 'avg', 'count', 'min', 'max'])
const MINDMAP_KINDS = new Set(['idea', 'task', 'question', 'tool'])
const FIELD_TYPES = new Set(['number', 'text-short', 'checkbox', 'single-select'])
const STICKY_COLORS = ['#fef08a', '#fbcfe8', '#bae6fd', '#bbf7d0', '#fed7aa']
const CARD_ACCENTS = new Set(['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#64748b'])
const SELECT_COLORS = ['#10b981', '#f59e0b', '#6366f1', '#94a3b8', '#ef4444', '#0ea5e9', '#ec4899']
const HEX = /^#[0-9a-f]{6}$/i
const DATE_TOKEN = /@(today|[+-]\d{1,3}d)/g
const DAY = 86_400_000

// Browsers, images and the advanced kinds.
const IMAGE_MODEL = 'gpt-image-2'
const IMAGE_ASPECTS = { landscape: { size: '1536x1024', w: 720, h: 480 }, portrait: { size: '1024x1536', w: 480, h: 720 }, square: { size: '1024x1024', w: 600, h: 600 } }
const IMAGE_TITLE_SUFFIX = ' · AI illustration'
// The public capture gives up past 512 KB of markup; the picture must fit inside it.
const MAX_IMAGE_DATA_URL = 400_000
const DIAGRAM_SHAPES = new Set(['box', 'circle', 'text'])
const FORM_TYPES = new Set(['heading', 'text', 'textarea', 'number', 'date', 'select', 'checkbox'])
// CalculatorWidget evaluates only this character set; anything else shows "error".
const CALC_EXPR = /^[0-9+\-*/%.()\s]+$/
// Query keys the public projection strips, and that would mark a URL as carrying
// somebody's capability rather than pointing at a page.
const SECRET_QUERY = /token|key|secret|signature|sig|auth|password|session/i

// ── ids ─────────────────────────────────────────────────────────────────────
// Deterministic, so re-seeding updates the same rows (and the same synced server
// records) instead of piling up duplicates. Formatted as a v5-shaped UUID.
function stableId(key) {
  const h = createHash('sha1').update(`${NAMESPACE}:${key}`).digest('hex')
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

// ── dates ───────────────────────────────────────────────────────────────────
// Demo dates are written relative to seeding time ("@+5d") so a desk never shows
// a deadline that passed months ago. Rendered the way the app's own notes read.
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function formatDay(ms) {
  const d = new Date(ms)
  return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`
}
function resolveDates(text, now) {
  return text.replace(DATE_TOKEN, (_, t) => formatDay(now + (t === 'today' ? 0 : parseInt(t, 10) * DAY)))
}

// ── validation ──────────────────────────────────────────────────────────────
const isStr = (v, min = 1) => typeof v === 'string' && v.trim().length >= min
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function validateSpec(spec, file = 'spec') {
  const errs = []
  const err = (path, msg) => errs.push(`${file}: ${path}: ${msg}`)

  if (!isObj(spec)) return [`${file}: not a JSON object`]
  if (!Number.isInteger(spec.number) || spec.number < 1 || spec.number > 99) err('number', 'integer 1–99 required')
  if (!isStr(spec.slug) || !/^[a-z0-9-]+$/.test(spec.slug)) err('slug', 'lowercase-kebab required')
  if (!isStr(spec.persona)) err('persona', 'required')
  if (!CATEGORIES.includes(spec.category)) err('category', `one of: ${CATEGORIES.join(' | ')}`)
  if (!isObj(spec.room)) err('room', 'object required')
  else {
    if (!isStr(spec.room.title) || spec.room.title.length > 60) err('room.title', 'required, ≤ 60 chars')
    if (!isStr(spec.room.description, 20) || spec.room.description.length > 280)
      err('room.description', 'required, 20–280 chars')
  }
  if (!Array.isArray(spec.desks) || spec.desks.length < 1 || spec.desks.length > 4) {
    err('desks', '1–4 desks required')
    return errs
  }
  spec.desks.forEach((d, i) => validateDesk(d, `desks[${i}]`, err))
  return errs
}

function validateDesk(d, p, err) {
  if (!isObj(d)) return err(p, 'object required')
  if (!isStr(d.title) || d.title.length > 70) err(`${p}.title`, 'required, ≤ 70 chars')
  if (!isStr(d.description, 20) || d.description.length > 220) err(`${p}.description`, 'required, 20–220 chars')
  if (d.dueInDays !== undefined && (!Number.isInteger(d.dueInDays) || Math.abs(d.dueInDays) > 365))
    err(`${p}.dueInDays`, 'integer within ±365')
  if (!isStr(d.brief, 200)) err(`${p}.brief`, 'markdown, at least 200 chars')
  else if (/sample desk/i.test(d.brief)) err(`${p}.brief`, 'omit the sample notice — the seeder adds it')

  if (!isObj(d.callout)) err(`${p}.callout`, 'object required')
  else {
    if (!isStr(d.callout.title)) err(`${p}.callout.title`, 'required')
    if (!isStr(d.callout.body, 20)) err(`${p}.callout.body`, 'required, ≥ 20 chars')
    if (d.callout.accent !== undefined && !CARD_ACCENTS.has(d.callout.accent))
      err(`${p}.callout.accent`, `one of ${[...CARD_ACCENTS].join(' ')}`)
  }

  const cols = validateTable(d.table, `${p}.table`, err)
  validateChart(d.chart, cols, `${p}.chart`, err)
  if (!isObj(d.mindmap) || !isStr(d.mindmap.title) || !isObj(d.mindmap.root))
    err(`${p}.mindmap`, '{ title, root } required')
  else validateMindNode(d.mindmap.root, `${p}.mindmap.root`, err, 0)
  validatePage(d.page, `${p}.page`, err)

  const notes = d.notes ?? []
  if (!Array.isArray(notes) || notes.length > 2) err(`${p}.notes`, '0–2 notes')
  else notes.forEach((n, i) => (!isStr(n?.title) || !isStr(n?.body, 40)) && err(`${p}.notes[${i}]`, '{ title, body ≥ 40 chars }'))

  const stickies = d.stickies ?? []
  if (!Array.isArray(stickies) || stickies.length > 4) err(`${p}.stickies`, '0–4 stickies')
  else
    stickies.forEach((s, i) => {
      if (!isStr(s?.body)) err(`${p}.stickies[${i}].body`, 'required')
      if (s?.color !== undefined && !STICKY_COLORS.includes(s.color))
        err(`${p}.stickies[${i}].color`, `one of ${STICKY_COLORS.join(' ')}`)
    })

  const fields = d.fields ?? []
  if (!Array.isArray(fields) || fields.length > 4) err(`${p}.fields`, '0–4 fields')
  else fields.forEach((f, i) => validateField(f, `${p}.fields[${i}]`, err))

  if (d.timer !== undefined) {
    if (!isObj(d.timer) || !isStr(d.timer.title) || !Number.isInteger(d.timer.minutes) || d.timer.minutes < 1 || d.timer.minutes > 180)
      err(`${p}.timer`, '{ title, minutes 1–180 }')
  }
  if (d.palette !== undefined) {
    if (!Array.isArray(d.palette) || d.palette.length < 2 || d.palette.length > 6) err(`${p}.palette`, '2–6 swatches')
    else d.palette.forEach((c, i) => (!HEX.test(c?.hex ?? '') || !isStr(c?.label)) && err(`${p}.palette[${i}]`, '{ hex "#rrggbb", label }'))
  }

  validateBrowsers(d.browsers, `${p}.browsers`, err)
  validateImages(d.images, `${p}.images`, err)
  if (d.diagram !== undefined) validateDiagram(d.diagram, `${p}.diagram`, err)
  if (d.calculator !== undefined) validateCalculator(d.calculator, `${p}.calculator`, err)
  if (d.form !== undefined) validateForm(d.form, `${p}.form`, err)
  const advanced = ['diagram', 'calculator', 'form'].filter((k) => d[k] !== undefined)
  if (advanced.length < 2) err(p, `needs at least 2 of diagram / calculator / form (has ${advanced.join(', ') || 'none'})`)
}

function validateBrowsers(list, p, err) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 2) return err(p, '1–2 browsers required')
  list.forEach((b, i) => {
    const bp = `${p}[${i}]`
    if (!isObj(b) || !isStr(b.title) || b.title.length > 60) return err(bp, '{ title ≤ 60, url }')
    let u
    try {
      u = new URL(b.url)
    } catch {
      return err(`${bp}.url`, 'absolute URL required')
    }
    if (u.protocol !== 'https:') err(`${bp}.url`, 'https only')
    if (u.username || u.password) err(`${bp}.url`, 'no credentials in the URL')
    if ([...u.searchParams.keys()].some((k) => SECRET_QUERY.test(k))) err(`${bp}.url`, 'no token/key/session query parameters')
    // The widget canonicalises through new URL().toString() and rewrites its own
    // content and title when the committed URL differs, so store the canonical form.
    if (u.toString() !== b.url) err(`${bp}.url`, `store the canonical form "${u.toString()}"`)
    if (u.hash) err(`${bp}.url`, 'no #fragment: an in-page jump rewrites the widget on load')
  })
  const urls = list.map((b) => b?.url)
  if (new Set(urls).size !== urls.length) err(p, 'duplicate URL')
}

function validateImages(list, p, err) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 2) return err(p, '1–2 images required')
  list.forEach((im, i) => {
    const ip = `${p}[${i}]`
    if (!isObj(im)) return err(ip, '{ title, prompt, aspect }')
    if (!isStr(im.title) || im.title.length > 48) err(`${ip}.title`, 'required, ≤ 48 chars (the seeder appends "· AI illustration")')
    if (!isStr(im.prompt, 60) || im.prompt.length > 900) err(`${ip}.prompt`, '60–900 chars')
    if (!(im.aspect in IMAGE_ASPECTS)) err(`${ip}.aspect`, `one of ${Object.keys(IMAGE_ASPECTS).join(' ')}`)
    if (/@(today|[+-]\d)/.test(`${im.title}${im.prompt}`)) err(ip, 'no date tokens in images')
  })
}

function validateDiagram(dg, p, err) {
  if (!isObj(dg) || !isStr(dg.title)) return err(p, '{ title, nodes, edges } required')
  if (!Array.isArray(dg.nodes) || dg.nodes.length < 3 || dg.nodes.length > 10) return err(`${p}.nodes`, '3–10 nodes')
  const ids = new Set()
  dg.nodes.forEach((n, i) => {
    const np = `${p}.nodes[${i}]`
    if (!isObj(n) || !isStr(n.id) || !/^[a-z][a-z0-9-]*$/.test(n.id)) return err(`${np}.id`, 'lowercase id required')
    if (ids.has(n.id)) err(`${np}.id`, `duplicate "${n.id}"`)
    ids.add(n.id)
    if (!isStr(n.label) || n.label.length > 28) err(`${np}.label`, 'required, ≤ 28 chars')
    if (n.shape !== undefined && !DIAGRAM_SHAPES.has(n.shape)) err(`${np}.shape`, `one of ${[...DIAGRAM_SHAPES].join(' ')}`)
    if (n.color !== undefined && !HEX.test(n.color)) err(`${np}.color`, '6-digit #rrggbb')
  })
  if (!Array.isArray(dg.edges) || dg.edges.length < 2 || dg.edges.length > 14) return err(`${p}.edges`, '2–14 edges')
  dg.edges.forEach((e, i) => {
    const ep = `${p}.edges[${i}]`
    if (!isObj(e) || !ids.has(e.from) || !ids.has(e.to)) return err(ep, '{ from, to } must name nodes')
    if (e.from === e.to) err(ep, 'self-loop')
    if (e.label !== undefined && (!isStr(e.label) || e.label.length > 20)) err(`${ep}.label`, '≤ 20 chars')
  })
}

function evalExpr(expr) {
  if (!CALC_EXPR.test(expr)) return null
  // Same evaluation the widget does, over the same restricted character set.
  try {
    const v = Function(`"use strict"; return (${expr})`)()
    return Number.isFinite(v) ? Math.round(v * 1e10) / 1e10 : null
  } catch {
    return null
  }
}

function validateCalculator(c, p, err) {
  if (!isObj(c) || !isStr(c.title) || c.title.length > 48) return err(p, '{ title ≤ 48, expression, result }')
  if (!isStr(c.expression) || !CALC_EXPR.test(c.expression)) return err(`${p}.expression`, 'digits and + - * / % . ( ) only — use * and /, not × and ÷')
  const v = evalExpr(c.expression)
  if (v === null) return err(`${p}.expression`, 'does not evaluate to a finite number')
  // The author states what the sum comes to, so the desk's prose can be checked
  // against what the calculator will actually show.
  if (typeof c.result !== 'number' || Math.abs(c.result - v) > 1e-9) err(`${p}.result`, `expression evaluates to ${v}`)
}

function validateForm(f, p, err) {
  if (!isObj(f) || !isStr(f.title) || f.title.length > 48) return err(p, '{ title ≤ 48, fields } required')
  if (!Array.isArray(f.fields) || f.fields.length < 3 || f.fields.length > 9) return err(`${p}.fields`, '3–9 fields')
  f.fields.forEach((x, i) => {
    const fp = `${p}.fields[${i}]`
    if (!isObj(x) || !FORM_TYPES.has(x.type)) return err(`${fp}.type`, `one of ${[...FORM_TYPES].join(' ')}`)
    if (!isStr(x.label) || x.label.length > 40) err(`${fp}.label`, 'required, ≤ 40 chars')
    const v = x.value
    if (x.type === 'heading') return v === undefined || err(`${fp}.value`, 'a heading has no value')
    if (x.type === 'checkbox' && typeof v !== 'boolean') err(`${fp}.value`, 'boolean')
    if ((x.type === 'text' || x.type === 'textarea') && !isStr(v)) err(`${fp}.value`, 'non-empty string')
    if (x.type === 'number' && (typeof v !== 'string' || v === '' || !Number.isFinite(Number(v)))) err(`${fp}.value`, 'numeric string, e.g. "1250"')
    if (x.type === 'date' && !(typeof v === 'string' && /^@(today|[+-]\d{1,3}d)$/.test(v))) err(`${fp}.value`, 'a date token: "@today", "@+5d" or "@-2d"')
    if (x.type === 'select') {
      if (!Array.isArray(x.options) || x.options.length < 2 || !x.options.every((o) => isStr(o))) err(`${fp}.options`, '≥ 2 option strings')
      else if (!x.options.includes(v)) err(`${fp}.value`, 'must be one of options')
    }
  })
}

function validateTable(t, p, err) {
  const cols = new Map()
  if (!isObj(t) || !isStr(t.title)) {
    err(p, '{ title, columns, rows } required')
    return cols
  }
  if (!Array.isArray(t.columns) || t.columns.length < 2 || t.columns.length > 8) {
    err(`${p}.columns`, '2–8 columns')
    return cols
  }
  t.columns.forEach((c, i) => {
    const cp = `${p}.columns[${i}]`
    if (!isStr(c?.id) || !/^[a-z][a-z0-9-]*$/.test(c.id)) return err(`${cp}.id`, 'lowercase id required')
    if (cols.has(c.id)) return err(`${cp}.id`, `duplicate "${c.id}"`)
    if (!isStr(c.label)) err(`${cp}.label`, 'required')
    if (!COLUMN_TYPES.has(c.type)) err(`${cp}.type`, `one of ${[...COLUMN_TYPES].join(' ')}`)
    if (c.type === 'single-select') {
      if (!Array.isArray(c.options) || c.options.length < 2 || c.options.length > 7 || !c.options.every((o) => isStr(o)))
        err(`${cp}.options`, '2–7 option labels (strings) for single-select')
      else if (new Set(c.options).size !== c.options.length) err(`${cp}.options`, 'duplicate option')
      // Options are matched against cell values verbatim, so they cannot carry date tokens.
      else if (c.options.some((o) => /@(today|[+-]\d{1,3}d)/.test(o))) err(`${cp}.options`, 'no date tokens in option labels')
    }
    cols.set(c.id, c)
  })
  if (!Array.isArray(t.rows) || t.rows.length < 4 || t.rows.length > 20) {
    err(`${p}.rows`, '4–20 rows')
    return cols
  }
  t.rows.forEach((r, i) => {
    const rp = `${p}.rows[${i}]`
    if (!isObj(r)) return err(rp, 'object keyed by column id')
    for (const k of Object.keys(r)) if (!cols.has(k)) err(`${rp}.${k}`, 'unknown column')
    for (const [id, c] of cols) {
      const v = r[id]
      if (v === undefined || v === null || v === '') continue
      if (c.type === 'number' && typeof v !== 'number') err(`${rp}.${id}`, 'number expected')
      if (c.type === 'checkbox' && typeof v !== 'boolean') err(`${rp}.${id}`, 'boolean expected')
      if ((c.type === 'text-short' || c.type === 'text-long') && typeof v !== 'string') err(`${rp}.${id}`, 'string expected')
      if (c.type === 'single-select' && Array.isArray(c.options) && !c.options.includes(v))
        err(`${rp}.${id}`, `"${v}" is not one of the column's options`)
    }
    const first = t.columns[0]
    if (first && (r[first.id] === undefined || r[first.id] === '')) err(`${rp}.${first.id}`, 'first column must be filled')
  })
  return cols
}

function validateChart(c, cols, p, err) {
  if (!isObj(c) || !isStr(c.title)) return err(p, '{ title, type, x, series } required')
  if (!CHART_TYPES.has(c.type)) err(`${p}.type`, `one of ${[...CHART_TYPES].join(' ')}`)
  if (c.x !== null && c.x !== undefined) {
    const col = cols.get(c.x)
    if (!col) err(`${p}.x`, `unknown column "${c.x}"`)
    // A checkbox category would label the axis "true" / "false".
    else if (col.type !== 'text-short' && col.type !== 'single-select') err(`${p}.x`, 'category column must be text-short or single-select')
  } else if (c.type !== 'kpi') err(`${p}.x`, 'required unless type is kpi')
  if (!Array.isArray(c.series) || c.series.length < 1 || c.series.length > 3) return err(`${p}.series`, '1–3 series')
  c.series.forEach((s, i) => {
    const sp = `${p}.series[${i}]`
    if (!AGGS.has(s?.agg)) err(`${sp}.agg`, `one of ${[...AGGS].join(' ')}`)
    const col = cols.get(s?.column)
    if (!col) err(`${sp}.column`, `unknown column "${s?.column}"`)
    else if (s.agg !== 'count' && col.type !== 'number') err(`${sp}.column`, `"${s.column}" must be a number column for ${s.agg}`)
  })
  if (c.type === 'pie' && c.series.length !== 1) err(`${p}.series`, 'pie takes exactly one series')
}

function validateMindNode(n, p, err, depth) {
  if (!isObj(n) || !isStr(n.label) || n.label.length > 48) return err(p, 'node needs a label ≤ 48 chars')
  if (n.kind !== undefined && !MINDMAP_KINDS.has(n.kind)) err(`${p}.kind`, `one of ${[...MINDMAP_KINDS].join(' ')}`)
  const kids = n.children ?? []
  if (!Array.isArray(kids)) return err(`${p}.children`, 'array')
  if (depth === 0 && (kids.length < 3 || kids.length > 7)) err(`${p}.children`, 'root needs 3–7 branches')
  if (depth >= 3 && kids.length) err(`${p}.children`, 'max depth is 3 below the root')
  if (kids.length > 6 && depth > 0) err(`${p}.children`, '≤ 6 children per branch')
  kids.forEach((k, i) => validateMindNode(k, `${p}.children[${i}]`, err, depth + 1))
}

function validatePage(pg, p, err) {
  if (!isObj(pg) || !isStr(pg.title) || !Array.isArray(pg.blocks) || pg.blocks.length < 4)
    return err(p, '{ title, blocks[≥4] } required')
  pg.blocks.forEach((b, i) => {
    const keys = isObj(b) ? Object.keys(b) : []
    const k = keys[0]
    const bp = `${p}.blocks[${i}]`
    if (keys.length !== 1 || !['h3', 'h4', 'p', 'ul', 'ol', 'quote'].includes(k)) return err(bp, 'one of { h3 | h4 | p | ul | ol | quote }')
    if (k === 'ul' || k === 'ol') {
      if (!Array.isArray(b[k]) || b[k].length < 1 || !b[k].every((s) => isStr(s))) err(bp, 'list of strings')
    } else if (!isStr(b[k])) err(bp, 'non-empty string')
  })
}

function validateField(f, p, err) {
  if (!isObj(f) || !isStr(f.label)) return err(p, '{ label, type, value } required')
  if (!FIELD_TYPES.has(f.type)) return err(`${p}.type`, `one of ${[...FIELD_TYPES].join(' ')}`)
  if (f.type === 'number' && typeof f.value !== 'number') err(`${p}.value`, 'number expected')
  if (f.type === 'checkbox' && typeof f.value !== 'boolean') err(`${p}.value`, 'boolean expected')
  if (f.type === 'text-short' && !isStr(f.value)) err(`${p}.value`, 'string expected')
  if (f.type === 'single-select') {
    if (!Array.isArray(f.options) || f.options.length < 2 || !f.options.every((o) => isStr(o))) err(`${p}.options`, '≥ 2 option labels')
    else if (!f.options.includes(f.value)) err(`${p}.value`, 'must be one of options')
  }
}

// Across files: numbers, slugs and room titles must be unique, and every one of
// the configured personas should be present exactly once.
function validateSet(specs) {
  const errs = []
  const seen = (key, label) => {
    const m = new Map()
    for (const s of specs) {
      const v = s[key] ?? s.room?.title
      if (m.has(v)) errs.push(`duplicate ${label} "${v}" in ${m.get(v)} and ${s.__file}`)
      else m.set(v, s.__file)
    }
  }
  seen('number', 'number')
  seen('slug', 'slug')
  const titles = new Map()
  for (const s of specs) {
    const t = s.room?.title
    if (titles.has(t)) errs.push(`duplicate room title "${t}" in ${titles.get(t)} and ${s.__file}`)
    titles.set(t, s.__file)
  }
  return errs
}

// ── content builders ────────────────────────────────────────────────────────
function inlineMarks(text) {
  // **bold** only; everything else is literal text. Empty segments are dropped
  // because Tiptap rejects empty text nodes.
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((s) =>
      s.startsWith('**') && s.endsWith('**')
        ? { type: 'text', text: s.slice(2, -2), marks: [{ type: 'bold' }] }
        : { type: 'text', text: s }
    )
}
const para = (t) => ({ type: 'paragraph', content: inlineMarks(t) })

function pageDoc(blocks, now) {
  const r = (s) => resolveDates(s, now)
  return {
    type: 'doc',
    content: blocks.map((b) => {
      if (b.h3) return { type: 'heading', attrs: { level: 3 }, content: inlineMarks(r(b.h3)) }
      if (b.h4) return { type: 'heading', attrs: { level: 4 }, content: inlineMarks(r(b.h4)) }
      if (b.p) return para(r(b.p))
      if (b.quote) return { type: 'blockquote', content: [para(r(b.quote))] }
      const list = b.ul ?? b.ol
      return {
        type: b.ul ? 'bulletList' : 'orderedList',
        content: list.map((s) => ({ type: 'listItem', content: [para(r(s))] }))
      }
    })
  }
}

function mindNode(n, path, now) {
  return {
    id: path,
    label: resolveDates(n.label, now),
    kind: n.kind ?? (path === 'root' ? 'idea' : 'idea'),
    children: (n.children ?? []).map((c, i) => mindNode(c, `${path}-${i}`, now)),
    attachedWidgetIds: [],
    assignedAgentSlugs: [],
    pendingChildren: []
  }
}

function mindmapState(root, now) {
  return {
    root: mindNode(root, 'root', now),
    // Nothing selected, so the node panel (with its AI buttons) starts closed.
    // '' rather than null: up to 4.3.x the widget reads null as "missing" and
    // selects the root, which opens the panel; '' matches no node in any version.
    selectedId: '',
    viewRootId: 'root',
    agentSuggestions: {},
    agentConversations: {},
    agentStats: {}
  }
}

// ── layout ──────────────────────────────────────────────────────────────────
// Four columns read left → right as: what this is · the state of it · the work
// itself · the conversation around it. Heights follow content so nothing opens
// scrolled or half-empty.
const GAP = 24
const X = { a: 60, b: 724, c: 1208, d: 2212 }
const W = { a: 640, b: 460, c: 980, d: 440 }
const lines = (s, perLine) => s.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0)
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

function layoutDesk(d, { siblings = 0 } = {}) {
  const slots = {}
  // Column A — brief, then the mind map.
  const briefH = clamp(80 + lines(d.brief, 78) * 21, 420, 820)
  slots.brief = { x: X.a, y: 60, width: W.a, height: briefH }
  slots.mindmap = { x: X.a, y: 60 + briefH + GAP, width: W.a, height: 480 }

  // Column B — callout, fields (two per row), timer, stickies (two per row).
  let yb = 60
  const calloutH = clamp(120 + lines(d.callout.body, 52) * 20, 180, 320)
  slots.callout = { x: X.b, y: yb, width: W.b, height: calloutH }
  yb += calloutH + GAP
  const half = (W.b - GAP) / 2
  slots.fields = (d.fields ?? []).map((_, i) => ({
    x: X.b + (i % 2) * (half + GAP),
    y: yb + Math.floor(i / 2) * (150 + GAP),
    width: half,
    height: 150
  }))
  if (slots.fields.length) yb += Math.ceil(slots.fields.length / 2) * (150 + GAP)
  if (d.timer) {
    slots.timer = { x: X.b, y: yb, width: half, height: 210 }
  }
  const stickies = d.stickies ?? []
  // A timer takes the left half of a row; the first sticky sits beside it.
  let si = d.timer ? 1 : 0
  slots.stickies = stickies.map((s) => {
    // Rows are a fixed 300 tall so a long sticky can never run into the next row.
    const h = clamp(70 + lines(s.body, 26) * 19, 210, 300)
    const slot = { x: X.b + (si % 2) * (half + GAP), y: yb + Math.floor(si / 2) * (300 + GAP), width: half, height: h }
    si++
    return slot
  })
  if (d.timer || stickies.length) yb += Math.ceil(si / 2) * (300 + GAP)
  if (d.palette) {
    const sw = (W.b - GAP * 2) / 3
    slots.palette = d.palette.map((_, i) => ({
      x: X.b + (i % 3) * (sw + GAP),
      y: yb + Math.floor(i / 3) * (170 + GAP),
      width: sw,
      height: 170
    }))
  }

  // Column C — table, then chart + page side by side.
  const tableH = clamp(110 + d.table.rows.length * 37, 300, 760)
  slots.table = { x: X.c, y: 60, width: W.c, height: tableH }
  const yc = 60 + tableH + GAP
  const cw = (W.c - GAP) / 2
  slots.chart = { x: X.c, y: yc, width: cw, height: 440 }
  slots.page = { x: X.c + cw + GAP, y: yc, width: cw, height: 560 }

  // Column D — notes, stacked.
  let yd = 60
  slots.notes = (d.notes ?? []).map((n) => {
    const h = clamp(70 + lines(n.body, 50) * 20, 260, 620)
    const slot = { x: X.d, y: yd, width: W.d, height: h }
    yd += h + GAP
    return slot
  })

  // Lower band — the live material: browsers · images · the advanced tools.
  // Starts below everything above so nothing in the first four columns moves.
  const bottom = Math.max(
    ...Object.values(slots)
      .flatMap((s) => (Array.isArray(s) ? s : [s]))
      .filter(Boolean)
      .map((s) => s.y + s.height)
  )
  const y0 = bottom + 72
  let ye = y0
  slots.browsers = (d.browsers ?? []).map(() => {
    const slot = { x: X.a, y: ye, width: 1100, height: 700 }
    ye += 700 + GAP
    return slot
  })
  let yi = y0
  slots.images = (d.images ?? []).map((im) => {
    const a = IMAGE_ASPECTS[im.aspect] ?? IMAGE_ASPECTS.landscape
    const slot = { x: 1184, y: yi, width: a.w, height: a.h + 44 } // + frame header
    yi += a.h + 44 + GAP
    return slot
  })
  let yt = y0
  const XT = 1928
  if (d.diagram) {
    slots.diagram = { x: XT, y: yt, width: 744, height: 480 }
    yt += 480 + GAP
  }
  slots.taskLinks = Array.from({ length: siblings }, () => {
    // 170 is the card's natural height; any less and it grows itself on open.
    const slot = { x: XT, y: yt, width: 420, height: 170 }
    yt += 170 + GAP
    return slot
  })
  if (d.calculator) slots.calculator = { x: XT, y: yt, width: 300, height: 430 }
  if (d.form) {
    const { height } = formLayout(d.form.fields)
    slots.form = { x: d.calculator ? XT + 324 : XT, y: yt, width: 420, height: height + 80 }
  }
  return slots
}

// Form fields on a two-column grid; a heading takes a whole row. Positions are
// the widget's own field-surface pixels (CustomBlockWidget places each at x/y).
const FORM_H = { heading: 34, text: 58, number: 58, date: 58, select: 58, textarea: 92, checkbox: 34 }
function formLayout(fields) {
  const out = []
  let y = 12
  let col = 0
  let rowH = 0
  const newRow = () => {
    if (col > 0) y += rowH + 10
    col = 0
    rowH = 0
  }
  for (const f of fields) {
    const h = FORM_H[f.type]
    if (f.type === 'heading' || f.type === 'textarea') {
      newRow()
      out.push({ x: 16, y, w: 376, h })
      y += h + 10
      continue
    }
    out.push({ x: 16 + col * 196, y: f.type === 'checkbox' ? y + 12 : y, w: 180, h })
    rowH = Math.max(rowH, f.type === 'checkbox' ? h + 12 : h)
    col++
    if (col === 2) newRow()
  }
  newRow()
  return { positions: out, height: y + 6 }
}

// Left-to-right layered layout for a small flow: each node's column is its
// longest path from a source, rows in order of appearance. Cycles fall back to
// declaration order rather than looping.
function diagramLayout(nodes, edges) {
  const rank = new Map(nodes.map((n) => [n.id, 0]))
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false
    for (const e of edges) {
      const r = rank.get(e.from) + 1
      if (r > rank.get(e.to) && r < nodes.length) {
        rank.set(e.to, r)
        moved = true
      }
    }
    if (!moved) break
  }
  const rows = new Map()
  return nodes.map((n) => {
    const r = rank.get(n.id)
    const row = rows.get(r) ?? 0
    rows.set(r, row + 1)
    // Wide enough apart that an edge label fits between two nodes without
    // landing on either.
    return { id: n.id, x: r * 300, y: row * 150 + (n.shape === 'circle' ? -33 : 0) }
  })
}

// Generated images live in images/, named by persona, desk, slot and a hash of
// what produced them, so a changed prompt makes a new file and an unchanged one
// is never paid for twice.
function imageFile(spec, di, ii, im) {
  const h = createHash('sha1').update(`${IMAGE_MODEL}|${im.aspect}|${im.prompt}`).digest('hex').slice(0, 10)
  return `${spec.slug}-d${di}-i${ii}-${h}.jpg`
}

// A form date field stores YYYY-MM-DD in local time.
function isoDay(now, token) {
  const m = /^@(today|([+-]\d{1,3})d)$/.exec(token)
  const d = new Date(now + (m && m[2] ? parseInt(m[2], 10) : 0) * DAY)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ── records ─────────────────────────────────────────────────────────────────
// Returns every row the spec set describes, keyed by table. Timestamps are spread
// backwards from `now` so the desks look worked-on rather than minted in one go.
// `imageData(file)` returns the data: URL for a generated image file (seed.cjs
// reads it from images/). Leave it out to build without pictures, which --check
// and the tests do; the seeder refuses to write a desk whose image is missing.
function buildRecords(specs, { now = Date.now(), imageData = null } = {}) {
  const out = { nodes: [], widgets: [], tables: [], rows: [] }
  const rootId = stableId(ROOT_KEY)
  out.nodes.push({
    id: rootId,
    parent_id: null,
    kind: 'folder',
    title: ROOT_TITLE,
    description: ROOT_DESCRIPTION,
    sort_order: null, // decided at write time: keep the user's position if it exists
    created_at: now - 30 * DAY,
    updated_at: now,
    due_date: null
  })

  const sorted = [...specs].sort((a, b) => a.number - b.number)
  const readme = readmeDesk(sorted, rootId, now)
  out.nodes.push(readme.node)
  out.widgets.push(...readme.widgets)

  for (const spec of sorted) {
    const roomId = stableId(`room:${spec.slug}`)
    out.nodes.push({
      id: roomId,
      parent_id: rootId,
      kind: 'folder',
      title: spec.room.title,
      description: `${spec.room.description.trim()}${SAMPLE_ROOM_SUFFIX}`,
      sort_order: spec.number,
      created_at: now - 28 * DAY,
      updated_at: now,
      due_date: null
    })
    spec.desks.forEach((d, di) => buildDesk(out, spec, d, di, roomId, now, imageData))
  }
  return out
}

function buildDesk(out, spec, d, di, roomId, now, imageData) {
  const key = `${spec.slug}:${di}`
  const deskId = stableId(`desk:${key}`)
  const created = now - (21 - di * 3) * DAY
  out.nodes.push({
    id: deskId,
    parent_id: roomId,
    kind: 'task',
    title: resolveDates(d.title, now),
    description: `${resolveDates(d.description.trim(), now)}${SAMPLE_DESC_SUFFIX}`,
    sort_order: di,
    created_at: created,
    updated_at: now,
    due_date: d.dueInDays === undefined ? null : now + d.dueInDays * DAY
  })

  // Every other desk in the room, linked from this one.
  const siblings = spec.desks.map((sd, j) => ({ j, d: sd })).filter((x) => x.j !== di)
  const slots = layoutDesk(d, { siblings: siblings.length })
  let z = 1
  const widget = (wkey, kind, title, content, slot, color = null) =>
    out.widgets.push({
      id: stableId(`w:${key}:${wkey}`),
      task_id: deskId,
      kind,
      // Titles are display text too; a token left here would show as "@+2d".
      title: resolveDates(title, now),
      content,
      ...slot,
      z_index: z++,
      color,
      created_at: created + DAY,
      updated_at: now
    })

  widget('brief', 'markdown', 'Brief', `${SAMPLE_BRIEF_NOTICE}\n\n${resolveDates(d.brief.trim(), now)}`, slots.brief)

  widget(
    'callout',
    'card',
    d.callout.title,
    JSON.stringify({
      title: resolveDates(d.callout.title, now),
      body: resolveDates(d.callout.body, now),
      accent: d.callout.accent ?? '#6366f1',
      bgFill: true,
      icon: d.callout.icon ?? '🎯'
    }),
    slots.callout
  )

  // Table: option labels in the spec become option ids in storage, the way the
  // app's own select cells are stored.
  const tableId = stableId(`table:${key}`)
  const colId = (c) => `c-${c.id}`
  const optId = (c, label) => `o-${c.id}-${c.options.indexOf(label)}`
  out.tables.push({
    id: tableId,
    task_id: deskId,
    title: resolveDates(d.table.title, now),
    schema_json: JSON.stringify({
      columns: d.table.columns.map((c) => ({
        id: colId(c),
        type: c.type,
        label: resolveDates(c.label, now),
        config:
          c.type === 'single-select'
            ? { options: c.options.map((label, i) => ({ id: optId(c, label), label, color: SELECT_COLORS[i % SELECT_COLORS.length] })) }
            : c.type === 'number' && (c.prefix || c.suffix)
              ? { ...(c.prefix ? { prefix: c.prefix } : {}), ...(c.suffix ? { suffix: c.suffix } : {}) }
              : {}
      }))
    }),
    created_at: created,
    updated_at: now
  })
  d.table.rows.forEach((r, ri) => {
    const cells = {}
    for (const c of d.table.columns) {
      const v = r[c.id]
      if (v === undefined || v === null || v === '') continue
      cells[colId(c)] =
        c.type === 'single-select' ? optId(c, v) : typeof v === 'string' ? resolveDates(v, now) : v
    }
    out.rows.push({
      id: stableId(`row:${key}:${ri}`),
      table_id: tableId,
      cells_json: JSON.stringify(cells),
      sort_order: ri,
      created_at: created,
      updated_at: now
    })
  })
  widget('table', 'table', d.table.title, tableId, slots.table)

  const byId = new Map(d.table.columns.map((c) => [c.id, c]))
  widget(
    'chart',
    'chart',
    d.chart.title,
    JSON.stringify({
      tableId,
      type: d.chart.type,
      xColumnId: d.chart.x ? colId(byId.get(d.chart.x)) : null,
      series: d.chart.series.map((s) => ({
        columnId: colId(byId.get(s.column)),
        agg: s.agg,
        ...(s.label ? { label: s.label } : {})
      })),
      title: d.chart.title
    }),
    slots.chart
  )

  widget('mindmap', 'mindmap', d.mindmap.title, JSON.stringify(mindmapState(d.mindmap.root, now)), slots.mindmap)
  widget('page', 'page', d.page.title, JSON.stringify(pageDoc(d.page.blocks, now)), slots.page)

  ;(d.notes ?? []).forEach((n, i) =>
    widget(`note-${i}`, 'note', n.title, `${resolveDates(n.title, now).toUpperCase()}\n\n${resolveDates(n.body, now)}`, slots.notes[i])
  )
  ;(d.stickies ?? []).forEach((s, i) =>
    widget(`sticky-${i}`, 'sticky', s.title ?? '', resolveDates(s.body, now), slots.stickies[i], s.color ?? STICKY_COLORS[i % STICKY_COLORS.length])
  )
  ;(d.fields ?? []).forEach((f, i) => {
    const def = { id: `f-${i}`, type: f.type, label: resolveDates(f.label, now), config: {} }
    let value = f.value
    if (f.type === 'number') def.config = { ...(f.prefix ? { prefix: f.prefix } : {}), ...(f.suffix ? { suffix: f.suffix } : {}) }
    if (f.type === 'single-select') {
      def.config = { options: f.options.map((label, oi) => ({ id: `o-${oi}`, label, color: SELECT_COLORS[oi % SELECT_COLORS.length] })) }
      value = `o-${f.options.indexOf(f.value)}`
    }
    if (f.type === 'text-short') value = resolveDates(f.value, now)
    widget(`field-${i}`, 'field', f.label, JSON.stringify({ def, value }), slots.fields[i])
  })
  if (d.timer)
    widget(
      'timer',
      'timer',
      d.timer.title,
      JSON.stringify({ targetSec: d.timer.minutes * 60, elapsedSec: 0, state: 'idle', startedAt: null }),
      slots.timer
    )
  ;(d.palette ?? []).forEach((c, i) => widget(`color-${i}`, 'color', c.label, c.hex.toLowerCase(), slots.palette[i]))

  // Browsers: a plain canonical URL, which is exactly what the widget stores.
  ;(d.browsers ?? []).forEach((b, i) => widget(`browser-${i}`, 'webview', b.title, b.url, slots.browsers[i]))

  // Images: inline JPEG data: URLs (see the header for why not fb_files).
  ;(d.images ?? []).forEach((im, i) => {
    const file = imageFile(spec, di, i, im)
    const src = imageData ? imageData(file) : `data:image/jpeg;base64,`
    widget(`image-${i}`, 'image', `${im.title}${IMAGE_TITLE_SUFFIX}`, src, slots.images[i])
  })

  if (d.diagram) {
    const pos = new Map(diagramLayout(d.diagram.nodes, d.diagram.edges).map((p) => [p.id, p]))
    const graph = {
      nodes: d.diagram.nodes.map((n) => ({
        id: n.id,
        type: 'shape',
        position: { x: pos.get(n.id).x, y: pos.get(n.id).y },
        data: { label: resolveDates(n.label, now), shape: n.shape ?? 'box', color: (n.color ?? '#2563eb').toLowerCase() }
      })),
      edges: d.diagram.edges.map((e, i) => ({
        id: `e${i + 1}`,
        source: e.from,
        target: e.to,
        ...(e.label ? { label: resolveDates(e.label, now) } : {}),
        markerEnd: { type: 'arrowclosed' }
      }))
    }
    widget('diagram', 'diagram', d.diagram.title, JSON.stringify(graph), slots.diagram)
  }

  // Task links: the content is the bare desk id, and the title is the target's
  // title — the public list view shows only the widget title.
  siblings.forEach((s, i) =>
    widget(`link-${s.j}`, 'task-link', resolveDates(s.d.title, now), stableId(`desk:${spec.slug}:${s.j}`), slots.taskLinks[i])
  )

  if (d.calculator) widget('calculator', 'calculator', d.calculator.title, d.calculator.expression, slots.calculator)

  if (d.form) {
    const { positions } = formLayout(d.form.fields)
    const fields = d.form.fields.map((f, i) => {
      const at = positions[i]
      const field = { id: `f${i + 1}`, type: f.type, label: resolveDates(f.label, now), x: at.x, y: at.y, w: at.w, h: at.h }
      if (f.type === 'select') field.options = f.options
      if (f.type === 'date') field.value = isoDay(now, f.value)
      else if (f.type === 'text' || f.type === 'textarea') field.value = resolveDates(f.value, now)
      else if (f.type !== 'heading') field.value = f.value
      return field
    })
    // Exactly JSON.stringify({ title, fields }): the widget rewrites anything else on mount.
    widget('form', 'custom-block', d.form.title, JSON.stringify({ title: resolveDates(d.form.title, now), fields }), slots.form)
  }
}

// The root room's own desk: an index of every persona room, so whoever is doing
// the sharing can find the right one without opening 26 rooms.
function readmeDesk(specs, rootId, now) {
  const deskId = stableId('desk:readme')
  const byCat = CATEGORIES.map((cat) => {
    const rows = specs
      .filter((s) => s.category === cat)
      .map((s) => `- **${s.number}. ${s.persona}** → *${s.room.title}* — ${s.desks.map((d) => resolveDates(d.title, now)).join(' · ')}`)
    return rows.length ? `### ${cat}\n${rows.join('\n')}` : ''
  }).filter(Boolean)
  const index = `## Persona demo rooms

One room per target persona, each holding worked example desks that show how that
person would actually run their work in Plexii. All of it is **sample data** — the
people, companies and numbers are illustrative.

${byCat.join('\n\n')}`

  const howto = `HOW TO SHARE ONE

A whole room
  Rooms view → the room's menu → Create public link.
  The recipient sees the room and its desks in the browser.

A single desk, live, as it looks on the canvas
  Open the desk → Share (top bar) → Live web view
  → Publish this desk to the web.
  Every widget renders in the browser as it does here,
  and stays current as you edit.

Pick the room for the persona you are talking to.
Desks are self-explanatory: each opens on its brief.

Re-seed from the repo:
  node scripts/persona-demos/seed.cjs
(quit PlexiDesk first; it updates these rooms in place)`

  const w = (k, kind, title, content, slot, color = null) => ({
    id: stableId(`w:readme:${k}`),
    task_id: deskId,
    kind,
    title,
    content,
    ...slot,
    z_index: 1,
    color,
    created_at: now - 30 * DAY,
    updated_at: now
  })
  return {
    node: {
      id: deskId,
      parent_id: rootId,
      kind: 'task',
      title: 'Start here — persona demo index',
      description: 'Which demo room to share with which persona, and how to share it. Sample demo content.',
      sort_order: 0,
      created_at: now - 30 * DAY,
      updated_at: now,
      due_date: null
    },
    widgets: [
      w('index', 'markdown', 'Persona demo index', index, { x: 60, y: 60, width: 900, height: clamp(120 + lines(index, 110) * 21, 600, 1400) }),
      w('howto', 'note', 'How to share', howto, { x: 984, y: 60, width: 460, height: 520 }),
      w(
        'callout',
        'card',
        'Every room is sample data',
        JSON.stringify({
          title: 'Every room is sample data',
          body: 'Names, companies, figures and dates are illustrative, and every picture is an AI illustration titled as one. Each desk says so in the first line of its brief, and each room says so in its description, so nothing here can be mistaken for a real client or a real result. The browser widgets open real public pages.',
          accent: '#f59e0b',
          bgFill: true,
          icon: '⚠️'
        }),
        { x: 984, y: 604, width: 460, height: 270 }
      )
    ]
  }
}

module.exports = {
  ROOT_TITLE,
  IMAGE_MODEL,
  IMAGE_ASPECTS,
  IMAGE_TITLE_SUFFIX,
  MAX_IMAGE_DATA_URL,
  imageFile,
  evalExpr,
  formLayout,
  SAMPLE_BRIEF_NOTICE,
  CATEGORIES,
  STICKY_COLORS,
  stableId,
  resolveDates,
  formatDay,
  validateSpec,
  validateSet,
  buildRecords,
  layoutDesk,
  pageDoc
}
