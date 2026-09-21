// Build the 3.1 test script PDF.
//
// Callouts are positioned from markers.json, which the capture spec read back
// from the LIVE page — so a numbered circle sits exactly on the control the
// tester is told to click, and cannot drift when the layout changes.

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SHOTS = resolve(__dirname, '../test-results/testscript')
const markers = JSON.parse(readFileSync(resolve(SHOTS, 'markers.json'), 'utf8'))

const b64 = (name) => readFileSync(resolve(SHOTS, `${name}.png`)).toString('base64')

/** One numbered step, and where it points on the screenshot. */
const SECTIONS = [
  {
    shot: '01-office-home',
    title: 'The Browser is an app in PlexiOffice',
    what: 'A full web browser that lives in Office alongside PlexiDocs and PlexiSheets, rather than only as a widget on a desk.',
    why: 'Browsing is usually something you do BESIDE your work — looking something up, keeping a reference open across several desks, reading documentation. Before this it had nowhere to live but a desk it had nothing to do with, so people left Plexii and used Chrome. It was previously filed under "Communicate", where nobody looked for it.',
    steps: [
      'Click **Office** in the top-left switcher, then **Home**.',
      'Find the **Browser** tile in the app grid, eighth along beside PlexiMeet.',
      'Check the sidebar: **Browser** is listed under **APPS**, after PlexiDraw — NOT under COMMUNICATE.'
    ],
    pass: 'The Browser appears both as a tile on the Office home grid and under the APPS heading in the sidebar.'
  },
  {
    shot: '02-office-browser',
    title: 'Browsing without a desk',
    what: 'The same browser core the desk widget uses — history, search-engine picker, address bar — with no desk attached.',
    why: 'One browser engine, so a fix in either place fixes both. The page you were last on is remembered per device, so reopening Office puts you back where you were.',
    steps: [
      'Click the **Browser** tile. A real page loads.',
      'Type a URL or a search into the address bar and press Enter.',
      'Note **Ask Plexii** and **Send to desk** in the toolbar.',
      'Look at the tray above the footer: **Browser** is listed there.'
    ],
    pass: 'Pages load and navigate normally, and "Browser" appears in the tray as something you have open.'
  },
  {
    shot: '03-ask-plexii',
    title: 'Ask Plexii to work on the page',
    what: 'An AI agent that drives the page for you — reading, scrolling, clicking, following links — with six one-click presets.',
    why: 'A blank box asks you to guess both what the agent can do and how to phrase it. The presets are fully-formed tasks: "Summarise" alone would produce a run that reads one screenful and stops. Every preset also tells the agent what to RECORD, because the findings are the whole yield.',
    steps: [
      'Click **Ask Plexii** in the browser toolbar.',
      'Type your own instruction, or…',
      'Click a preset: **Summarise**, **Links**, **Images**, **Extract data**, **Find similar** or **Research**.',
      'Watch the run appear at the bottom with its live narration, running cost and a **Stop** button.'
    ],
    pass: 'A run starts, narrates each step, shows its cost, and can be stopped at any moment.',
    note: 'Plexii never signs in, pays, or moves files. It also never answers cookie dialogs on your behalf — it hides them so it can read the page underneath.'
  },
  {
    shot: '04-steer',
    title: 'Guide a run while it works',
    what: 'A box that lets you add instructions to a run that is already going, without restarting it.',
    why: 'Browsing is the one kind of AI work you sit and WATCH, so you see it heading somewhere useless a minute before it finishes. Previously the only controls were Stop and start again — which threw away everything it had found. Your words are treated as an UPDATE to the task, so findings are kept; say plainly that you want it to change course and it will.',
    steps: [
      'While a run is going, type into the guidance box, e.g. *"only UK suppliers, skip the blog posts"*.',
      'Press **Enter** or click **Send**.',
      'Confirmation reads "Passed on — it will pick this up on its next step."',
      'Watch the next step: the run should narrow, not start over.'
    ],
    pass: 'The run adjusts on its next step and keeps everything it had already found.'
  },
  {
    shot: '05-put-on-desk',
    title: 'Choose where the results go',
    what: 'When a run finishes, you pick which desk its results land on.',
    why: 'It used to use whichever desk was last ACTIVE — from a desk-less browser, one you were not looking at — and with no active desk at all it failed outright, after the run had already been paid for. The desk you were last on is offered first.',
    steps: [
      'Let a run finish. It shows what it found.',
      'Click **Put on a desk…**',
      'Pick a desk from the list.'
    ],
    pass: 'The results land on the desk you chose, and on no other.'
  },
  {
    shot: '06-result-on-desk',
    title: 'Research arrives as a usable table',
    what: 'A list of things becomes a real table widget; the prose answer becomes a note beside it.',
    why: 'The findings were previously handed BACK to an AI model to retype as a table, which truncated long runs inside the reply limit — so the more research a run did, the more was lost — and let a model round a price it had never seen. The table is now built directly from the data, verbatim, with every row. Column types come from the VALUES: a rating of 4.8 becomes a number column, a URL stays clickable text.',
    steps: [
      'Open the desk you chose.',
      'Check the table: every result should be present — compare the row count against what the run reported.',
      'Check the column types: numbers right-aligned with a # marker, URLs still readable as links.',
      'Read the note beside it for the run’s conclusion.',
      'Switch the table to **Cards**, **Kanban** or **Gantt** — it is a full table, not a picture of one.'
    ],
    pass: 'Every row the run found is in the table, values match the source pages exactly, and nothing has been invented.'
  },
  {
    shot: '07-tray',
    title: 'The tray — everything you have open',
    what: 'A strip above the footer listing every desk, document, chat and app you currently have open, across all four segments.',
    why: 'The app navigates rather than opens: each destination replaces the last. That suits a tool used one thing at a time, and not one where a desk, the document written from it and the chat about it are the same piece of work. Switching is now a click instead of a retrace.',
    steps: [
      'Open several things: a desk, a document, Mail, and an app from PlexiBrain or PlexiDesk.',
      'Each appears in the tray under its own name and icon.',
      'Click any tab to switch straight to it.',
      'Hover a tab and click **×** to close it — this only clears the tab, it deletes nothing.',
      'Right-click a tab for **Pin**, **Close the others** and **Close all**.'
    ],
    pass: 'Everything you open is listed and one click away. Closing a tab never deletes the thing itself.'
  },
  {
    shot: '08-office-docs',
    title: 'File a document onto a desk',
    what: 'Drag any document — doc, sheet, slides, diagram, design or drawing — onto a desk tab in the tray, or right-click its tray tab and choose a desk by name.',
    why: 'A drag with no visible affordance is a feature nobody finds, so there is a menu too. The widget POINTS AT the document rather than copying it: editing it on the desk and editing it in Office are the same file. It lands on the desk you chose even if that desk is not open.',
    steps: [
      'In Office, hover any document row — the tooltip says you can drag it onto a desk.',
      'Drag it onto a desk tab in the tray. The tab highlights as you hover.',
      'Or: open the document, right-click its tray tab, and pick a desk under **Send to desk**.',
      'Open that desk and confirm the document is there.',
      'Edit it on the desk, then open it in Office — the change is in both.'
    ],
    pass: 'The document appears on the chosen desk and is the SAME file, not a copy.'
  },
  {
    shot: '09-doc-panel',
    title: 'Documents open with the panel out of the way',
    what: 'The outline / comments / assistant panel starts minimised, and remembers your choice once you change it.',
    why: 'It used to start open on every surface, spending a slice of every document’s width on panels nobody had asked for — worst on a desk, where a document widget has least room to give.',
    steps: [
      'Open any document.',
      'The full width is the document. No panel.',
      'Click **Outline**, **Comments** or **Panel** in the toolbar to bring it in.',
      'Close and reopen the document — your choice is remembered.'
    ],
    pass: 'Documents open with full width; the toggles work; the preference persists.'
  }
]

const md = (s) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>')

function figure(sec) {
  const m = markers[sec.shot]
  if (!m) return ''
  // The rings and numbers are already burned into the screenshot: they were
  // drawn into the live page next to the controls they point at, so nothing
  // here has to reconcile CSS pixels, devicePixelRatio and zoom across two
  // coordinate spaces. Two earlier attempts at that arithmetic put markers
  // confidently on the wrong controls.
  const key = m.markers.length
    ? `<div class="key">${m.markers.map((k) => `<span><i>${k.n}</i>${k.label}</span>`).join('')}</div>`
    : ''
  // No inset crops. Two attempts at cropping the run dock produced a region
  // half a dock off and then a nearly empty one; the rings on the full shot are
  // measured in-page and correct, so the space goes to making THEM bigger.
  return `<div class="figwrap"><div class="fig"><img src="data:image/png;base64,${b64(sec.shot)}"></div>${key}</div>`
}

const sections = SECTIONS.map(
  (s, i) => `
<section>
  <div class="hd"><span class="num">${i + 1}</span><h2>${s.title}</h2></div>
  ${figure(s)}
  <div class="grid">
    <div><h3>What it is</h3><p>${md(s.what)}</p></div>
    <div><h3>Why it matters</h3><p>${md(s.why)}</p></div>
  </div>
  <h3>How to test it</h3>
  <ol>${s.steps.map((t) => `<li>${md(t)}</li>`).join('')}</ol>
  <div class="pass"><b>Passes if:</b> ${md(s.pass)}</div>
  ${s.note ? `<div class="note"><b>Note:</b> ${md(s.note)}</div>` : ''}
  <div class="result">Result: &nbsp; <span class="box"></span> Pass &nbsp;&nbsp; <span class="box"></span> Fail &nbsp;&nbsp; Notes: <span class="rule"></span></div>
</section>`
).join('')

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Plexii 3.1 — Test Script</title>
<style>
  @page { size: A4; margin: 14mm 13mm 16mm; }
  * { box-sizing: border-box; }
  body { font: 10.5pt/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; color: #1b1b1f; margin: 0; }
  .cover { height: 247mm; display: flex; flex-direction: column; justify-content: center; page-break-after: always; }
  .cover h1 { font-size: 30pt; margin: 0 0 6px; letter-spacing: -0.5px; }
  .cover .sub { font-size: 13pt; color: #55555f; margin-bottom: 28px; }
  .cover dl { display: grid; grid-template-columns: 34mm 1fr; gap: 5px 10px; font-size: 10pt; margin: 0 0 26px; }
  .cover dt { color: #77777f; }
  .cover dd { margin: 0; }
  .howto { background: #f6f6f8; border-left: 3px solid #6b5cff; padding: 12px 14px; font-size: 9.5pt; }
  .howto p { margin: 0 0 7px; } .howto p:last-child { margin: 0; }
  section { page-break-before: always; page-break-inside: avoid; }
  .hd { display: flex; align-items: baseline; gap: 9px; border-bottom: 1.5px solid #1b1b1f; padding-bottom: 6px; margin-bottom: 12px; }
  .num { background: #6b5cff; color: #fff; font-size: 10pt; font-weight: 700; width: 20px; height: 20px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; flex: none; }
  h2 { font-size: 15pt; margin: 0; letter-spacing: -0.2px; }
  h3 { font-size: 9pt; text-transform: uppercase; letter-spacing: 0.9px; color: #77777f; margin: 10px 0 4px; }
  p { margin: 0; }
  .figwrap { margin-bottom: 4px; }
  .fig { position: relative; line-height: 0; border: 1px solid #dcdce4; border-radius: 5px; overflow: hidden; max-width: 172mm; margin: 0 auto; }
  .fig img { width: 100%; display: block; }
  .ring { position: absolute; border: 2.5px solid #ff2d55; border-radius: 4px; box-shadow: 0 0 0 2px rgba(255,255,255,.6); }
  .pin { position: absolute; transform: translate(-50%,-50%); background: #ff2d55; color: #fff; font: 700 9pt/1 sans-serif; width: 19px; height: 19px; border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 2px solid #fff; margin-top: -15px; margin-left: -15px; }
  .key { display: flex; flex-wrap: wrap; justify-content: center; gap: 3px 14px; font-size: 8.5pt; color: #55555f; margin-top: 6px; }
  .detail { margin-top: 8px; max-width: 152mm; margin-left: auto; margin-right: auto; border: 1px solid #dcdce4; border-radius: 5px; overflow: hidden; }
  .detail img { width: 100%; display: block; }
  .dlabel { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.8px; color: #77777f; background: #f6f6f8; padding: 4px 9px; border-bottom: 1px solid #e4e4ec; }
  .key i { background: #ff2d55; color: #fff; font-style: normal; font-weight: 700; width: 13px; height: 13px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 7.5pt; margin-right: 5px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 20px; }
  ol { margin: 0; padding-left: 18px; } li { margin-bottom: 3px; }
  .pass { background: #eefaf0; border-left: 3px solid #1a9e4b; padding: 7px 11px; margin-top: 9px; font-size: 9.5pt; }
  .note { background: #fff8e6; border-left: 3px solid #d99400; padding: 8px 11px; margin-top: 7px; font-size: 9.5pt; }
  .result { margin-top: 9px; padding-top: 8px; border-top: 1px dashed #c8c8d0; font-size: 9pt; color: #55555f; display: flex; align-items: center; }
  .box { display: inline-block; width: 11px; height: 11px; border: 1.2px solid #77777f; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
  .rule { flex: 1; border-bottom: 1px solid #c8c8d0; margin-left: 6px; height: 11px; }
</style></head><body>
<div class="cover">
  <h1>Plexii 3.1 — Test Script</h1>
  <div class="sub">Browsing, research, and the things you have open</div>
  <dl>
    <dt>Build</dt><dd>PlexiDesk 3 Preview &middot; released to <code>main</code></dd>
    <dt>Commit</dt><dd><code>${process.env.COMMIT || 'ad53be71'}</code></dd>
    <dt>Date</dt><dd>${new Date().toISOString().slice(0, 10)}</dd>
    <dt>Sections</dt><dd>${SECTIONS.length}</dd>
  </dl>
  <div class="howto">
    <p><b>How to use this.</b> Each section covers one feature: what it is, why it exists, and the steps to exercise it. Work through them in order — several build on the one before.</p>
    <p><b>The screenshots are the real build,</b> and every numbered marker was measured from the running app, so a circle sits on the actual control you need to click.</p>
    <p><b>Record a result for each section.</b> If something fails, note what you saw rather than what you expected — the gap between the two is the useful part.</p>
    <p><b>Where AI is involved,</b> check it against the source. Nothing should appear in a table that is not on the page it came from.</p>
  </div>
</div>
${sections}
</body></html>`

const htmlPath = resolve(SHOTS, 'test-script.html')
writeFileSync(htmlPath, html)

// Print it. Chromium is already a dependency via Playwright, and printing the
// same HTML keeps the PDF and the on-screen version identical by construction.
const { chromium } = await import('@playwright/test')
const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto(`file://${htmlPath}`, { waitUntil: 'load' })
await page.emulateMedia({ media: 'print' })
const pdfPath = resolve(__dirname, '../docs/Plexii-3.1-Test-Script.pdf')
await page.pdf({
  path: pdfPath,
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate:
    '<div style="font:8pt sans-serif;color:#88888f;width:100%;padding:0 13mm;display:flex;justify-content:space-between"><span>Plexii 3.1 — Test Script</span><span class="pageNumber"></span></div>',
  margin: { top: '14mm', bottom: '16mm', left: '13mm', right: '13mm' }
})
await browser.close()
console.log(pdfPath)
