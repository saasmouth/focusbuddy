# Persona demo rooms

Sample rooms and desks, one room per target persona, for sharing with prospects.
Everything is **sample data**: the seeder writes the notice into every room
description, desk description and desk brief, and every picture is titled as an
AI illustration, so nothing here can pass for a real client or a real result.

```
Plexii Showcase · Persona demos          (room, top level)
├── Start here — persona demo index      (desk: which room for which persona, how to share)
├── <Persona room> × 26                  (room per persona, ordered by persona number)
│   ├── <worked example desk>            each desk: brief, callout, table + chart, mind map,
│   └── <worked example desk>            page, notes, stickies, fields, 1–2 live browsers,
│                                        1–2 AI illustrations, a diagram, a calculator and/or
│                                        a form block, and links to the other desk in the room
```

## Files

| File | What it is |
| --- | --- |
| `personas/NN-slug.json` | One persona: its room and desks, described as content. No coordinates. |
| `lib.cjs` | Validation, layout and record building. Pure, no I/O. The schema lives in `validateSpec`. |
| `seed.cjs` | The CLI: a transaction around `lib.buildRecords`. |
| `generate-images.cjs` | Generates the illustrations (OpenAI `gpt-image-2`, the app's own image provider) into `images/`, cached by prompt hash, with a provenance sidecar each and `images/manifest.json`. |
| `verify-urls.cjs` | Checks every browser URL live: 200, no redirect, a real page title, not a challenge/sign-in wall, not behind Cloudflare. Writes `checks/<persona>.urls.json`. |
| `prepare-profile.cjs` | Makes a `--dry-run` copy safe to open in the built app under Playwright. |
| `lib.test.cjs` | `node --test scripts/persona-demos/lib.test.cjs` (49 tests) |
| `tests/e2e/_personaUrlProbe.spec.ts` | Loads every browser URL in the **app's own browser**. The ground truth: many `.gov.au` sites (Fair Work, the ATO, cyber.gov.au, the Style Manual…) serve a plain fetch and desktop Chrome but refuse Electron's browser. |
| `tests/e2e/_personaDeskShots.spec.ts` | Renders every demo desk in the built app and reports unmounted widgets, error boundaries, empty setup states, broken images, calculator errors and browsers showing a challenge. |

## Running it

```bash
node scripts/persona-demos/seed.cjs --check                 # validate every spec
node scripts/persona-demos/generate-images.cjs              # generate any missing illustrations
node scripts/persona-demos/verify-urls.cjs                  # live URL checks
PERSONA_FILES=$(ls scripts/persona-demos/personas | paste -sd, -) \
  npx playwright test tests/e2e/_personaUrlProbe.spec.ts    # in-app URL checks
node scripts/persona-demos/seed.cjs --dry-run               # real write into a temp copy of the workspace DB
node scripts/persona-demos/prepare-profile.cjs <copy dir>
PERSONA_PROFILE=<copy dir> npx playwright test tests/e2e/_personaDeskShots.spec.ts   # render + health-check every desk
# quit PlexiDesk, then:
node scripts/persona-demos/seed.cjs                         # seed the signed-in workspace
node scripts/persona-demos/seed.cjs --remove                # move every seeded room/desk to the trash
```

`--profile <dir>` targets another workspace (e.g. `PlexiDeskDemo`); `--db <path>` an explicit file.

- **Re-runnable.** Ids are derived from the spec (persona slug + desk index + widget
  role), so a re-seed updates the same rows. Anything a spec no longer describes is
  trashed, not deleted, so the removal syncs. Widgets and desks you add yourself
  inside a demo room are never touched. A re-seed resets layout changes made in the app.
- **Syncs like a local edit.** Every row is written with `needs_sync = 1`, keeping
  its `sync_rev`, under `org_id = 'personal'`.
- **Safe.** Refuses to run while any process has the database open, backs the
  database up to `backups/pre-persona-demos-<time>.db` first, and rolls back on any
  error or foreign-key violation.
- **Importance 3.** At 4 or more every open desk opens behind the Pre-Task Bridge modal.

## What is (and is not) on the desks, and why

Prospects see these desks through share links, so only kinds that render publicly
are used (`PUBLIC_RENDER_POLICY` / `PUBLIC_CAPTURE_ALLOWED` in `src/shared/publicDesk.ts`);
a test fails if any other kind appears.

- **Images are inline JPEG `data:` URLs**, not `fb_files` blobs. The public capture
  keeps only `data:` images (an `fb-file://` picture publishes as an empty frame), and
  personal file sync uploads the bytes of only six files per cycle while marking the
  rest pushed (`src/renderer/src/lib/workspaceSync.ts`), so seeded blobs would mostly
  never reach the server. Each image is kept under 400 KB as a data URL.
- **No office documents** (doc / sheet / slides / map). Personal documents are not in
  workspace sync and cloud-docs sync never backfills, so a seeded document reaches
  another device as a widget without its document, and the widget there creates a
  blank one and syncs that pointer back. Slides also publish blank: nothing in the app
  produces the per-slide HTML the public viewer reads.
- **Nothing that acts on its own**: no agents, living docs or webhooks (they run AI or
  call out on open), no image-gen widget (it ignores its canvas position).
- **No metrics, stat cards, contacts, task lists, gallery or portals**: they publish
  as "not available publicly".

## Sharing

- **A room:** Rooms view → the room's menu → **Create public link**. The browser view lists the room's desks.
- **A desk, live:** open the desk → **Share** (top bar) → **Live web view** → **Publish this desk to the web**. Every widget renders in the browser as it does on the canvas, and stays current as you edit.

Minting links is done in the app, under your account. The packaged build exposes
no debugging port, so this script cannot mint them for you.
