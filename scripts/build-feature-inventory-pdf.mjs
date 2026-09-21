// The feature inventory, as a document.
//
// The CSV beside it is the thing you load into a database; this explains what
// is in it, what each column means, and where every value came from — because
// a seed nobody can audit gets distrusted the first time one row looks wrong.

import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const { meta, rows } = JSON.parse(readFileSync(resolve(ROOT, 'docs/plexii-feature-inventory.json'), 'utf8'))
const by = (d) => rows.filter((r) => r.domain === d)
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')

// ── The authored layer ──────────────────────────────────────────────────────
// Everything above is read out of source. This is written, and says so: the
// positioning a feature list cannot derive. Kept to the areas a person would
// actually sell, rather than one line per row — 428 marketing sentences would
// be padding, and the CSV carries an empty column for the ones you want.
const AREAS = [
  {
    area: 'The desk',
    modules: 'Canvas · 55 widget kinds · layouts · wires',
    pitch:
      'A canvas per piece of work, holding whatever that work needs — tasks, a table, a document, a live web page, an AI agent — side by side instead of scattered across apps.',
    depends: 'nodes, widgets, tables, documents',
    impact:
      'The most coupled surface in the product. A change to widget storage or layout reaches every desk and every widget kind; treat the widget contract as public API.'
  },
  {
    area: 'PlexiOffice',
    modules: '13 apps · 6 document types · Mail · Chat · Meet · Sign · Browser',
    pitch:
      'Documents, spreadsheets, slides, diagrams, design and drawing in one place, plus the communication around them — and a web browser that does not need a desk.',
    depends: 'documents, mail, office shell, view store',
    impact:
      'Document types share one editor stack; a change to the editor reaches the standalone route, the desk widget and the Office shell at once.'
  },
  {
    area: 'Browsing agent',
    modules: 'browserAgent · browserActions · browserOverlays · browserProgress · consent',
    pitch:
      'Plexii browses for you — researching, comparing and extracting — visibly, one step at a time, stoppable, and with the results landing on a desk as a table you can use.',
    depends: 'Anthropic API, webview, consent store, tables',
    impact:
      'Per-site consent and the refusal rules are safety boundaries. Changing the action vocabulary changes what the model can do to a live page; the sanitiser is the gate.'
  },
  {
    area: 'AI assistant',
    modules: 'anthropic · chat · action proposals · action executor',
    pitch:
      'One assistant across the whole workspace that proposes changes you approve, rather than a chat box that writes text you then copy somewhere.',
    depends: 'Anthropic API, every store it can act on',
    impact:
      'The proposal vocabulary is the widest contract in the app: adding a verb adds something the AI can do everywhere, and every applier must handle it.'
  },
  {
    area: 'Mail',
    modules: 'imap · mailPaging · mailTags · triage',
    pitch:
      'Your inbox, filed against the work it belongs to — folders that relate to a desk or task, so a busy mailbox stops being one undifferentiated list.',
    depends: 'IMAP, nodes, AI triage',
    impact: 'Paging is by UID rather than position; anything that assumes index ordering will break on a mailbox that changes under it.'
  },
  {
    area: 'Tables and data',
    modules: 'tables · schema · rows · views (Table/Cards/Kanban/Calendar/Gantt)',
    pitch:
      'A database that behaves like a spreadsheet, on a desk, fed by hand, by automations, or by what Plexii finds while browsing.',
    depends: 'tables store, widgets',
    impact: 'Column types coerce values on write. Changing a type affects existing rows, so migrations matter more here than anywhere else.'
  },
  {
    area: 'Custom widgets',
    modules: 'customWidget · sandbox · wizard · action vocabulary · helpers',
    pitch:
      'Describe the tool you need and Plexii builds it, running sandboxed on your desk with access only to what you wire into it.',
    depends: 'Anthropic API, sandbox scheme, widget inputs',
    impact:
      'ADR-0009 is the boundary: unlimited in what a widget can BE, bounded in what it can REACH. Loosening the sandbox is a security change, not a feature change.'
  },
  {
    area: 'The tray and navigation',
    modules: 'view store · openTray · segmentApps',
    pitch:
      'Everything you have open in one strip — desks, documents, chats, apps — so moving between contexts is a click rather than a retrace.',
    depends: 'view store',
    impact:
      'The view union is the app’s routing contract. A surface that holds "what am I looking at" in local state disappears from the tray, from Back, and from session restore.'
  },
  {
    area: 'Automation',
    modules: 'flows · agents · wires · signals · streamdeck',
    pitch:
      'Standing workers on your desks: rules that run, agents that watch, and physical buttons that fire them.',
    depends: 'flows, agents, widget links',
    impact: 'Saved flows persist verb names. Renaming a verb silently changes what every stored flow does — SPEC-044 exists because of this.'
  },
  {
    area: 'Knowledge and search',
    modules: 'knowledge · brain map · decisions · search',
    pitch:
      'What the workspace knows, linked: entries, a graph of how they connect, the decisions taken and what a change puts at risk.',
    depends: 'knowledge store, search index',
    impact: 'Decisions reference work items; deleting the referenced item must not orphan the decision.'
  },
  {
    area: 'People and organisation',
    modules: 'contacts · directory · org admin · people map · presence',
    pitch: 'Who is in the workspace, how they relate, and who is around right now.',
    depends: 'contacts, org, presence',
    impact: 'Org structure feeds permissions; a change to roles reaches sharing and the vault.'
  },
  {
    area: 'Sharing and collaboration',
    modules: 'shares · liveDesk · crdt · collaborations',
    pitch: 'Hand someone a desk — including someone who is not a user yet — and work on it together, live.',
    depends: 'crdt, shares, auth',
    impact: 'CRDT merge rules decide who wins a conflict. Changing them changes history, not just behaviour.'
  }
]

const DOMAINS = [
  ['App', 'Apps inside the four segments', 'Read from the segment registry (segmentApps.ts).'],
  ['Screen', 'Every destination the app can navigate to', 'Read from the View union (stores/view.ts).'],
  ['Widget', 'Building blocks you place on a desk', 'Read from the widget catalogue, including its written hint.'],
  ['Capability', 'The IPC surface, grouped by namespace', 'Counted from ipcMain.handle registrations in main.'],
  ['State', 'Renderer stores', 'Every store module, with how many files import it.'],
  ['Engine', 'Substantial main-process modules (AI, database, mail)', 'Files over 80 lines, with dependants and size.']
]

const COLUMNS = [
  ['id', 'Stable key, e.g. widget.table', 'Derived', 'Primary key. Stable across releases unless the thing is renamed in code.'],
  ['domain', 'App / Screen / Widget / Capability / State / Engine', 'Derived', 'What kind of thing this row is.'],
  ['name', 'Human name', 'Derived', 'The label the product itself uses where one exists.'],
  ['module', 'Which part of the system it belongs to', 'Derived', 'Use for grouping and ownership.'],
  ['description', 'What it is', 'Derived', 'From the catalogue hint or the module’s own header comment — the code’s words, not mine.'],
  ['status', 'active / legacy', 'Derived', 'Legacy rows are still rendered for existing data but hidden from pickers.'],
  ['surface', 'Operation count (capabilities)', 'Derived', 'How many IPC operations the namespace exposes. A rough proxy for how much of the product depends on it.'],
  ['callers', 'Source files calling any of its functions', 'Derived', 'Engines only. ZERO means implemented but called by nothing that ships — see "Unwired" below.'],
  ['dependents', 'Source files statically importing it', 'Derived', 'The change-impact column. Counts static imports only, so it can read low for a module reached another way — check callers alongside it.'],
  ['loc', 'Lines of code', 'Derived', 'Size, not quality. Useful for spotting where complexity sits.'],
  ['tests', 'Test files that mention it by name', 'Derived', 'A weak signal, and it UNDERCOUNTS: tests that refer to a thing by a different name are missed. It called calendar sync untested when it had five test files. Never act on it alone.'],
  ['weight', 'Importance 1-10', 'YOU', 'Deliberately empty. See the note below.'],
  ['owner', 'Who owns it', 'YOU', 'Empty.'],
  ['marketing_description', 'Positioning copy', 'YOU', 'Empty per row; the areas worth selling are written up in this document.'],
  ['notes', 'Anything else', 'YOU', 'Empty.']
]

function table(headers, body, cls = '') {
  return `<table class="${cls}"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`
}

const inventory = DOMAINS.map(([d, title, source]) => {
  const list = by(d)
  const hasNums = d === 'State' || d === 'Engine'
  const hasCallers = d === 'Engine'
  const hasSurface = d === 'Capability'
  const heads = ['Name', 'Module', 'What it is', ...(hasSurface ? ['Ops'] : []), ...(hasCallers ? ['Callers'] : []), ...(hasNums ? ['Deps', 'LOC'] : []), 'Test mentions']
  const body = list.map((r) => [
    `<b>${esc(r.name)}</b> <code>${esc(r.id)}</code>`,
    esc(r.module),
    esc(r.description).slice(0, 190) + (r.status !== 'active' ? ` <i>(${esc(r.status)})</i>` : ''),
    ...(hasSurface ? [r.surface ?? ''] : []),
    ...(hasCallers ? [r.callers === 0 ? '<b style="color:#c0392b">0</b>' : (r.callers ?? '—')] : []),
    ...(hasNums ? [r.dependents ?? '', r.loc ?? ''] : []),
    r.tests ?? ''
  ])
  return `<section class="inv"><h2>${title} <span class="cnt">${list.length}</span></h2><p class="src">${source}</p>${table(heads, body, 'inv')}</section>`
}).join('')

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Plexii — Feature &amp; Module Inventory</title><style>
@page { size: A4; margin: 13mm 12mm 15mm; }
* { box-sizing: border-box; }
body { font: 9.5pt/1.45 -apple-system,"Segoe UI",Roboto,sans-serif; color:#1b1b1f; margin:0; }
h1 { font-size: 27pt; margin:0 0 5px; letter-spacing:-0.5px; }
h2 { font-size: 13pt; margin:0 0 3px; border-bottom:1.5px solid #1b1b1f; padding-bottom:5px; }
h3 { font-size: 10.5pt; margin:15px 0 5px; }
.cnt { background:#6b5cff; color:#fff; font-size:8.5pt; padding:1px 7px; border-radius:9px; vertical-align:2px; }
.cover { height:250mm; display:flex; flex-direction:column; justify-content:center; page-break-after:always; }
.sub { font-size:12.5pt; color:#55555f; margin-bottom:22px; }
dl { display:grid; grid-template-columns:38mm 1fr; gap:4px 10px; font-size:9.5pt; margin:0 0 22px; }
dt { color:#77777f; } dd { margin:0; }
.box { background:#f6f6f8; border-left:3px solid #6b5cff; padding:11px 13px; font-size:9pt; margin-bottom:9px; }
.warn { background:#fff8e6; border-left:3px solid #d99400; padding:11px 13px; font-size:9pt; }
.box p, .warn p { margin:0 0 6px; } .box p:last-child, .warn p:last-child { margin:0; }
table { width:100%; border-collapse:collapse; font-size:7.6pt; }
th { text-align:left; background:#f2f2f6; padding:4px 6px; border-bottom:1.2px solid #c8c8d0; font-size:7.5pt; text-transform:uppercase; letter-spacing:0.5px; color:#55555f; }
td { padding:2.5px 6px; border-bottom:0.5px solid #e6e6ec; vertical-align:top; }
tr { page-break-inside:avoid; }
thead { display:table-header-group; }
code { font:7.5pt ui-monospace,Menlo,monospace; color:#6b5cff; }
table.inv td:first-child { width:26%; } table.inv td:nth-child(2) { width:17%; }
section { page-break-before:always; }
section.inv { page-break-before:always; }
.src { font-size:8pt; color:#77777f; margin:4px 0 8px; }
.area { border:1px solid #e0e0e8; border-radius:5px; padding:9px 11px; margin-bottom:8px; page-break-inside:avoid; }
.area h4 { margin:0 0 4px; font-size:10pt; }
.area .mods { font-size:8pt; color:#77777f; margin-bottom:5px; }
.area .pitch { margin:0 0 5px; }
.area .imp { font-size:8.5pt; color:#55555f; background:#fafafc; padding:5px 8px; border-radius:3px; }
.first { page-break-before:auto; }
</style></head><body>
<div class="cover">
  <h1>Plexii — Feature &amp; Module Inventory</h1>
  <div class="sub">A database seed, derived from the codebase</div>
  <dl>
    <dt>Commit</dt><dd><code>${meta.commit}</code></dd>
    <dt>Generated</dt><dd>${meta.generated.slice(0, 10)}</dd>
    <dt>Rows</dt><dd>${rows.length}</dd>
    <dt>Source files</dt><dd>${meta.sourceFiles.toLocaleString()} &middot; ${meta.totalLoc.toLocaleString()} lines</dd>
    <dt>Test files</dt><dd>${meta.testFiles.toLocaleString()}</dd>
  </dl>
  <div class="box">
    <p><b>The CSV is the deliverable.</b> <code>docs/plexii-feature-inventory.csv</code> holds all ${rows.length} rows with the columns below, ready to load. This document explains what is in it and where each value came from — a seed nobody can audit gets distrusted the first time a row looks wrong.</p>
    <p><b>Everything factual is read out of source</b> by <code>scripts/extract-feature-inventory.mjs</code>: the widget catalogue, the View union, the segment registry, the IPC registrations, the store and engine layers. Re-run it and the inventory matches the code again.</p>
    <p><b>The written parts are marked.</b> Positioning is judgement and cannot be derived, so it is confined to the feature areas later in this document.</p>
  </div>
  <div class="warn">
    <p><b>There are no importance weights in here, deliberately.</b> Assigning 1-10 by feel would put invented numbers into a database meant to inform real decisions, and they would be indistinguishable from measured ones a month later.</p>
    <p>What you get instead are three measured signals you can weight yourself: <b>dependents</b> (how many files import it — the blast radius of a change), <b>surface</b> (how many operations a capability exposes), and <b>tests</b> (how many test files name it). The <code>weight</code> column is empty and yours.</p>
  </div>
</div>

<section class="first">
  <h2>The schema</h2>
  <p class="src">Columns in <code>plexii-feature-inventory.csv</code>. "Derived" is read from code; "YOU" is left empty.</p>
  ${table(['Column', 'Meaning', 'Source', 'How to use it'], COLUMNS.map((c) => [`<code>${c[0]}</code>`, esc(c[1]), c[2] === 'YOU' ? '<b>YOU</b>' : c[2], esc(c[3])]))}
  <h3>What is in it</h3>
  ${table(['Domain', 'What it covers', 'Rows', 'Derived from'], DOMAINS.map(([d, t, s]) => [`<b>${d}</b>`, esc(t), by(d).length, esc(s)]))}
  <h3>Cross-functionality</h3>
  <p>Links are not a separate table because they are already implicit in two columns and better recomputed than stored: <code>dependents</code> is the import graph, and a capability's namespace prefix maps to the stores and engines that call it. If you want an explicit edge list, the extractor already walks every file and can emit one — that is a small change to the script, not a new exercise.</p>
</section>

<section>
  <h2>Feature areas <span class="cnt">${AREAS.length}</span></h2>
  <p class="src">The authored layer: positioning and change-impact notes for the areas worth selling and worth being careful with. Written, not derived.</p>
  ${AREAS.map((a) => `<div class="area">
    <h4>${esc(a.area)}</h4>
    <div class="mods">${esc(a.modules)}</div>
    <p class="pitch">${esc(a.pitch)}</p>
    <div class="imp"><b>Depends on:</b> ${esc(a.depends)}<br><b>Impact of change:</b> ${esc(a.impact)}</div>
  </div>`).join('')}
</section>


<section>
  <h2>Unwired spec contracts <span class="cnt">${rows.filter((r) => r.status === 'unwired').length}</span></h2>
  <p class="src">Engines whose exported functions no other source file calls. Measured by <code>callers</code>, not inferred.</p>
  <p>These are implemented and tested, and the commits that added them report the matching spec requirements as complete. But nothing in the running app calls them, so <b>the rules they encode do not govern the product that ships</b>. They are not dead code: each is a deliberate contract. What is missing is the wiring.</p>
  ${table(['Module', 'What it is meant to enforce', 'Lines', 'Test mentions'], rows.filter((r) => r.status === 'unwired').map((r) => [`<b>${esc(r.name)}</b><br><code>${esc(r.id)}</code>`, esc(r.description), r.loc, r.tests]))}
  <div class="box" style="margin-top:10px">
    <p><b>Agent governance: investigated, and the running agents ARE governed — by a different mechanism.</b></p>
    <p>Every action a model proposes goes to a human for review; none is applied on its own. The one autonomous write a desk agent makes is a single <code>update-widget</code> to the one destination widget the user configured <i>and</i> explicitly set to auto-apply. Its kind and target are fixed in code — <code>buildDelivery</code> returns a type-narrowed update with the target id hard-coded — so the model controls only the text. AGT-001's intent holds structurally: an agent cannot do anything its human did not either approve or pre-authorise for one named widget.</p>
    <p><b>So <code>ai/agents.ts</code> is a contract for a runtime that does not exist yet.</b> Most of its fifteen requirements govern features the live system lacks: delegation between agents (AGT-014), schema-validated inter-agent messages (AGT-010/011/012), declared tool sets (AGT-020). The dispatcher's own header lists inter-agent dispatch as unbuilt Phase 3 work. The tracker marks these complete against capabilities that have not been built.</p>
  </div>
  <div class="warn" style="margin-top:8px">
    <p><b>One path to decide on deliberately: autonomous external transmission.</b> An agent on an interval trigger, auto-applying into its destination, with that destination wired into a "Send to a URL" widget, POSTs model-written content to an external address with no human in the loop. Verified, not inferred: the outbound-webhook spec passes 9/9, including a wired change POSTing its content.</p>
    <p>Every link in that chain is something the user built, and auto-apply is an explicit opt-in, so it is consented. But AGT-021 says external transmission is <i>gated</i>, and here the gate is configuration rather than confirmation. That is a product decision, not a defect.</p>
  </div>
</section>

${inventory}
</body></html>`

const htmlPath = resolve(ROOT, 'docs/plexii-feature-inventory.html')
writeFileSync(htmlPath, html)

const { chromium } = await import('@playwright/test')
const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto(`file://${htmlPath}`, { waitUntil: 'load' })
await page.emulateMedia({ media: 'print' })
const pdfPath = resolve(ROOT, 'docs/Plexii-Feature-Inventory.pdf')
await page.pdf({
  path: pdfPath, format: 'A4', printBackground: true, displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate: '<div style="font:8pt sans-serif;color:#88888f;width:100%;padding:0 12mm;display:flex;justify-content:space-between"><span>Plexii — Feature &amp; Module Inventory</span><span class="pageNumber"></span></div>',
  margin: { top: '13mm', bottom: '15mm', left: '12mm', right: '12mm' }
})
await browser.close()
console.log(pdfPath)
