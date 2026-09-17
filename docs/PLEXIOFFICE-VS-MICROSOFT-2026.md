# PlexiOffice vs Microsoft Office (mid-2026) — the plan to make switching a no-brainer

This is the synthesis of the five PlexiOffice product owners (Docs, Sheets, Slides, Draw,
Design), each of whom analysed their Microsoft counterpart's June 2026 release against the
real Plexi code. It is the authoritative view of what still stops a customer from replacing
Office with Plexi, and exactly what to build to remove every remaining reason.

Everything here is grounded: Plexi capabilities were read from source; Microsoft feature
states were confirmed by web research and labelled where unverified. Owner confidence across
all five briefs was ~0.82, limited mainly by not exercising live Microsoft builds.

## The one-sentence finding

Across all five apps the same wall appears twice: **file fidelity** (a customer's existing
Office corpus must survive open → edit → save) and **the one power-user feature each app is
defined by** (track changes, LAMBDA+PivotTables, animations+charts, .vsdx+stencils,
print+multi-page). Close those and there is no rational reason left to stay on Office.

## Build once, win the whole suite (highest leverage first)

These are the moves that recur across multiple apps, so building them once pays off five ways.
Do these before per-app polish.

1. **True OOXML round-trip fidelity — the #1 migration gate, every app.** Today all four
   importers/exporters are lossy and honest about it, which is disqualifying for anyone
   migrating a library. Deepen each: Docs `.docx` (styles/tables/headers/comments/track-changes),
   Sheets `.xlsx` (conditional formats, validation, charts, pivots, grouping, named ranges,
   merged cells), Slides `.pptx` (shapes/images/layout on import; charts/tables on export),
   Draw `.vsdx` (import + export — currently neither exists). Always surface a fidelity report
   so loss is visible, never silent. Effort L per app; start with the read side everywhere.
2. **A suggestion / track-changes layer on the shared Yjs CRDT.** Docs' single biggest blocker,
   but built once on the shared collab layer it gives Sheets and Slides reviewer-attributed
   suggestions with accept/reject for free. Effort L.
3. **One chart core, shared by Sheets and Slides, sourced from live sheet data.** Slides has no
   charts at all (blocker); Sheets has only bar/line/pie. Build one engine both render through,
   so a chart authored in a sheet and one on a slide are the same object — and a slide chart can
   reference a live range. Closes two blockers and lands a leapfrog. Effort L.
4. **Unified comments + @mentions + accessibility across all apps.** Docs has threads (no
   @mention); Sheets, Slides and Draw have none. Build the shared comment+mention model once
   (borrow chat's mention system) plus a shared accessibility checker (alt text, heading/reading
   order, contrast). Effort M.
5. **One data grid: converge SheetGrid and the desk TableWidget on one engine + the formula
   engine.** Two parallel grids exist today with divergent selection/editing/keyboard and no
   shared formulas. Unify the interaction contract and share `sheetFormula` so computed columns
   work in both. Effort L.
6. **Route every AI edit through the ActionProposal (preview-before-apply) chain.** Sheets AI
   currently bypasses it; Docs is the reference. Standardise so no AI mutation is unreviewable.
   Effort M.
7. **Export everywhere, from one pipeline.** Draw has NO export at all (highest value-per-hour
   fix in the whole suite — reuse Design's PNG/PDF pipeline). Add SVG/JPG/WebP suite-wide. Effort S.

## Per-app purchase-blockers (ranked, with effort)

### PlexiDocs vs Word
1. Track changes / suggesting mode — L (see shared #2). The biggest single blocker; legal/enterprise/gov review depends on it.
2. True `.docx` round-trip — L (shared #1).
3. Citations, bibliography, footnotes/endnotes — M–L. Academic/legal/consulting cannot switch without them.
4. Auto, updating table of contents with page numbers — M.
5. Editable headers/footers + page numbers + section breaks — M (export already writes them; no on-screen editing).
6. Comment @mentions + assign + notify — S–M. 7. Live grammar/spell squiggles — M. 8. Accessibility checker — S–M. 9. Mail merge (from a suite sheet) — M. 10. Content template gallery — S. (Macros/VBA — L, defer.)

### PlexiSheets vs Excel
1. Robust `.xlsx` fidelity — L (shared #1). Single biggest blocker; cond-format/validation/charts/pivots/grouping/named-ranges/merges all drop today.
2. LAMBDA and LET — M then M/L. LET first, then LAMBDA (unlocks MAP/REDUCE/SCAN/BYROW/BYCOL).
3. Structured tables + `Table[Column]` references — L. Substrate for pivots and Power Query.
4. Interactive PivotTables (slicers, timelines, multiple value fields, drill) — L (today it's a static one-shot).
5. Typed error values (`#N/A` `#DIV/0!` `#VALUE!` `#NAME?` `#NUM!`) + `NA()`, make `ISNA` distinct from `ISERROR` — S/M. Cheapest credibility win.
6. Office-Scripts-class automation (JS/TS, not VBA) — L. 7. Power Query-class refreshable data shaping — L/XL (operator go/no-go). 8. Cell comments + range/sheet protection — M each.
Lower: merged cells (M), formula-based/top-N conditional formats (S/M), multi-column + custom sort + real autofilter conditions (S/M), modern array/text helpers (M), more chart types (M), what-if/Goal-Seek/Solver (M), arbitrary number-format codes (M).

### PlexiSlides vs PowerPoint
1. Element animations (entrance/emphasis/exit) + real transitions incl. Morph — L. Nothing animates today; `PresentOverlay` applies no transition at all. Table stakes.
2. Charts sourced from a live sheet — L (shared #3).
3. Native tables — M. 4. `.pptx` import fidelity (today text-only) — L (shared #1). 5. Video/audio media — M. 6. Master slides / layouts with placeholder inheritance — L.
7. Comments + accessibility (alt text/reading order) — M. 8. Expose rotation + gradient in the inspector — S (both already render/export; only UI missing — near-free). 9. Deck generation from a Word doc + a true Designer-class re-layout — M. 10. Speaker Coach — M.

### PlexiDiagrams vs Visio (and Lucidchart/draw.io)
_(Renamed from PlexiDraw, 2026-09-15. The stored doc type is still `map`; only the product name changed. "PlexiDraw" is now the separate vector + painting studio below.)_
1. `.vsdx` import — L. A Visio shop's libraries won't open at all today; the migration gate.
2. Image/PDF/SVG export — S. There is NO export whatsoever (shared #7); highest value-per-hour fix in Draw.
3. Rich stencil libraries (UML/BPMN/network/AWS-Azure-GCP) — L. Visio's actual moat; today 8 generic shapes.
4. Containers/swimlanes — M (the "swimlane" template has no lanes). 5. Smart orthogonal auto-routing — M. 6. User-invokable "Arrange" auto-layout button — S (the layout engine exists, but only runs on AI output).
7. Multi-select align/distribute/snap — M. 8. Layers — M. 9. Data-linked shapes — M. 10. Comments + collaborative cursors — M. 11. Resizable shapes — S (width/height already persist; add handles).

### PlexiDesign vs Publisher + InDesign (and Canva)
Timing gift: **Microsoft Publisher loses all support on 1 Oct 2026**, forcing a migration wave in exactly this window.

**Closed 2026-09-15** — PlexiDesign is now a free-form page designer rather than a fixed-size canvas:
- ~~Multi-page documents~~ — shipped, with publication page sizes (A4, Letter, A5 booklet, tri-fold, tabloid) that open multi-page.
- ~~Print production: bleed, crop marks~~ — shipped (CMYK / PDF-X still open).
- Master pages with inheritance and automatic page numbers (`{#}`, `{pages}`) — shipped.
- Threaded text frames with an honest overset marker — shipped.
- Text wrap around objects with a per-object standoff — shipped.
- Margins, column grid, draggable ruler guides, named layers, facing-page spreads — shipped.

Still open:
1. CMYK + PDF/X output — M. The remaining print-production blocker for a commercial printer.
2. Template breadth — M ongoing (13 templates, Pexels-only stock; lead with "AI makes your template" while the library grows).
3. Generative image edits (fill/expand/eraser) — M (only background-remove exists).
4. Text effects (curved text, shadow/outline) — S–M. 5. Paragraph + character styles as reusable named styles — M. 6. Comments on the design surface — S. 7. Export format breadth (SVG/JPG/WebP) — S. 8. `.idml` / `.pub` import for migrants — L.

### PlexiDraw vs Illustrator + Photoshop
New app, 2026-09-15. One document holds vector layers and painted raster layers in a single stack.

Shipped: bezier pen with editable anchors and mirrored handles; live shapes (rect, rounded rect, ellipse, polygon, star, line) that stay parametric; pencil with curve fitting; pathfinder booleans (Unite / Minus front / Intersect / Exclude) computed over flattened curves; solid and gradient fills; stroke width, caps, joins and dashes; per-object and per-layer opacity and blend modes; soft brush, eraser, paint bucket and eyedropper on raster layers; rasterize-a-vector-layer and merge-down; PNG, SVG and PDF export.

Still open:
1. Selection tools on raster layers (marquee, lasso, magic wand) — L. Photoshop's actual working model; today paint tools apply to the whole layer.
2. Adjustment layers + non-destructive filters — L. 3. Clipping masks and layer masks — M. 4. Brush library beyond the round soft brush (texture, scatter, stabiliser) — M.
5. Type on a path, and converting type to outlines — M. 6. Symbols / reusable components — M. 7. `.ai` / `.psd` import — L. 8. Colour management beyond sRGB — M.

## Leapfrogs to press in marketing (already real; Microsoft structurally cannot match)

- **Live widget/data embeds** inside docs, sheets, slides, diagrams AND designs — a slide, poster or process map that carries live, self-updating workspace data. No Office app can put a running tool on the canvas. This is the category-defining wedge; make it the tip of the spear.
- **One brand kit across the entire suite** — change a colour once, every document type updates. Canva's kit stops at Canva; Designer's stops at Copilot.
- **Local-first, offline, data-owned, no per-seat tax** — a straight cost + trust win vs Copilot's paid tier and Canva's ~$15/seat.
- **AI-native and honesty-bound** — preview-before-apply, no fabricated content, real errors surfaced; a stronger trust posture than Copilot's opaque agentic edits.
- **One suite on one canvas** beside tasks and data, one Cmd+K keyboard map, one shared canvas engine (Slides↔Design), structural-edit UX that auto-fixes references instead of silently repointing like Excel.

## Decisions needed from the operator

- Go/no-go on the two XL investments: Sheets **Power Query-class** data shaping and **Office-Scripts-class** automation. Everything else is S–L and clearly worth it; these two are multi-week initiatives that need an explicit call.
- Sequencing: recommend the "build once" list (fidelity → track-changes → chart core → comments/a11y → export) before per-app polish, because each unlocks several apps at once.

## Code cleanups surfaced during the review (not blockers)

- Sheets `evalCall` has duplicate `case` labels for `SIGN/EXP/LN/LOG/LOG10` (`lib/sheetFormula.ts` ~1241-1259 and ~1448-1467); the second set is unreachable dead code — remove one copy.
- Sheets AI apply path bypasses the ActionProposal chain the rest of the suite uses (see shared #6).

---
*Authored from the five PlexiOffice owner consultations, 2026-07-04. Owners: plexi-docs-owner,
plexi-sheets-owner, plexi-slides-owner, plexi-draw-owner, plexi-design-studio-owner.*
