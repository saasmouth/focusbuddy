# PlexiDesk: Build your desk

An interactive promotional site for PlexiDesk. The visitor answers one question (role + one piece of work), Claude builds the desk they'd use for it, and that desk becomes the live background of the page. Scrolling drives an eleven-chapter tour that rearranges the desk to explain each part of the product, using the visitor's own content.

## What's in the box

```
index.html               The whole site. One self-contained file, no build step.
api/personalise.js       Vercel Function. Calls the Claude API server-side (key never reaches the browser).
lib/plexii-prompts.js    Prompts + tolerant JSON parser used by the function.
tests/api.test.mjs       12 Node tests: endpoint behaviour, security checks, persona hint handling, prompt parity with index.html.
tests/e2e_test.py        160 Playwright checks: Learn more links, scroll stops, the five subpages (hash and built path routes), all 20 persona stories, deep links, desktop, mobile, light theme, OS-specific download links and the production endpoint path.
tests/shots/             Screenshots from the last test run (every chapter, three viewports).
build.mjs                Builds dist/: the main page plus one page per subpage with its own title, description, canonical and Open Graph tags.
vercel.json              Runs build.mjs, serves dist/ with clean URLs (/real-estate-agents), keeps /api/personalise.
package.json             `npm test` runs both suites.
```

## Subpages (campaign landing pages)

One per audience from TikTok videos 10 to 14. Each opens on the video's hook, so someone tapping through from the video lands on the line they just watched.

| Path | Hook (H1) | Tagline | Button | Approval moment in the tour |
|---|---|---|---|---|
| /real-estate-agents | POV: six listings, and the vendor just called | One desk per listing. | Show me a listing desk | Vendor report drafted; **Review & send**, nothing sends until the agent presses send |
| /graphic-designers | The client said “make it pop.” | One desk per client. | Show me a client desk | Round 2 feedback, with receipts; **Add tasks** |
| /marketing-teams | Our launch lived in nine different tools | One desk per campaign. | Show me a campaign desk | Three posts drafted from the brief; **Add to calendar** |
| /university-students | Essay due Friday. 41 tabs of readings. | One desk per assignment. | Show me an assignment desk | Plexii finds the quote and page number; **Add sources**. It never writes the essay |
| /startup-founders | Fundraising is six jobs at once | One desk per raise. | Show me a raise desk | Deck shows August's $22k, model says $27k; **Update slide** |

On a subpage the role picker disappears (the audience is known), the work field is worded for them ("Your listing, in a few words"), the tagline replaces "One task. One desk." in chapter 2, and the story lines are theirs. Every outbound link carries `utm_campaign=<path>` so downloads attribute to the right video. Building another desk stays on the subpage. The main page links to all five ("PlexiDesk for…"); each subpage links to the other four and back to every role.

The student page and the AI prompt both hold the line from the video: Plexii finds and cites sources, never writes the assignment. Those five audiences also work as typed roles and deep links on the main page.

**Routing.** The single file uses hash routes (`#/real-estate-agents`), which is what the claude.ai preview runs. `node build.mjs` writes `dist/real-estate-agents.html` and friends with `plexii-routes=path`, so in production they're real URLs with their own link previews. Set `SITE_URL` when building so canonicals point at your final domain.

**Update the videos.** The TikTok and LinkedIn captions from the social kit still point at plexii.com (which you don't own). Point each video's link at its subpage instead, e.g. `https://haptyx-web.vercel.app/real-estate-agents?utm_source=tiktok&utm_medium=video`.

## Personas

The hero offers 20 roles as one-tap chips: consultant, lawyer, accountant, recruiter, agency account manager, product manager, tech lead, UX researcher, journalist, academic researcher, teacher, executive assistant, sales rep, customer success manager, event planner, architect, HR manager, small business owner, content creator and grant writer.

**Pick a role, leave the work blank:** the page builds that persona's ready-made desk instantly. No AI call, no cost, no wait. Each persona has its own desk content (a doc, a sheet whose numbers drive the slide chart, research, a note, a deck, a Plexii answer with citations, three Attention items, collaborators and other desks) plus four story lines that rewrite the tour in their terms:

| Story line | Where it appears | Example (lawyer) |
|---|---|---|
| Pain | Chapter 1 | Matter files, precedents, time entries and the client's emails each live somewhere different… |
| Why | Chapter 2 | One matter, one desk: the memo, the numbers, the authorities and your call notes in one view. |
| Privacy | Chapter 10 | Client files stay on your machine first, and you decide what, if anything, syncs. |
| Outcome | Chapter 11 | Spend the billable hours on the advice, not on finding the file. |

**Add your own work:** Claude writes a desk for that exact job, briefed with the persona's context, and the persona's story lines still frame the tour.

**Type any role:** it's matched to the nearest persona (e.g. "Family lawyer", "YouTuber", "Fundraising manager", "Solutions architect" all land correctly; a marketer preset also exists for typed roles). Unmatched roles ("Nurse") get a neutral story and a generic desk, or a Claude-written one if they add work.

**Deep links for ads and outreach:** `?persona=lawyer` (key or label, e.g. `?persona=grant-writer`) skips the question and opens straight into that persona's story. Add `&work=Lease%20advice` to prefill the form instead; it waits for a click so a link never triggers AI spend by itself. Keys: `consultant lawyer accountant recruiter account product techlead ux journalist academic teacher ea sales csm events architect hr smallbiz creator grants marketer`.

All persona numbers are internally consistent (totals add up, the doc's figure is the highlighted sheet cell, the chart column has one unit), and a test fails if any persona's text would be truncated or cite something that isn't on its desk. People, firms and places are fictional.

## How the experience works

1. **Hero.** One question: "What's on your plate this week?" Role (20 persona chips or free text) and, optionally, the work. The button reads "Show me the lawyer desk" until work is typed, then "Build my desk".
2. **Build.** A status card ticks through the build while Claude writes the desk. The windows fly in scattered, which is chapter 1.
3. **Eleven chapters, scroll-driven.** Each chapter sets a desk state. The desk is real DOM, so windows are draggable at any point.

| # | Chapter | What the desk does |
|---|---|---|
| 1 | Tabs get closed. Context is lost. Effort is duplicated. | Windows scattered and tilted, a 14-tab strip of the visitor's actual tools, notification pings |
| 2 | One task. One desk. | Everything snaps into a tidy spatial layout |
| 3 | Your office apps, already on the desk | The slide's bar chart is drawn from the sheet's highlighted column, with a live connector from cell to bar. Copy covers .docx/.xlsx/.pptx round-trip and Visio import |
| 4 | Research without leaving the work | Browser window takes focus, the rest dim. Mentions sending a page from the app browser to a desk |
| 5 | AI that shows its sources and asks before it acts | Plexii panel opens with a "read N items" trace and citation chips (hover lights the window). The next step arrives as a proposed-change card: Apply / Dismiss |
| 6 | Everything you owe, in one place | Attention list. Items are dashed proposals until the card is applied; dismissing creates nothing |
| 7 | Lock in for five minutes | Desk gets a glowing edge, a real 5:00 countdown runs in the top bar, sidebar and taskbar dim |
| 8 | Bring people to the work | Collaborators join, live cursors, chat message; copy covers meetings from any editor, email invites, .ics, filed transcripts |
| 9 | Close it tonight. Pick it up tomorrow. | Desk packs into the switcher with a "Where you left off" summary and next step |
| 10 | Your work lives on your machine first | "Stored on this device first" boundary. Copy matches the privacy page: offline, opt-in sync, master-password vault, BYO key direct to Anthropic or managed, no training, no third-party analytics |
| 11 | Your desk is ready | OS-detected download button, other-platform link, plan summary, "also in the box", links to install help, pricing, features, privacy |

**Learn more.** The hero, the final chapter and the explore dock all offer "Learn more about PlexiDesk", which opens the brochure site (separate folder, `plexii-brochure`). Plan and module links go to its pricing and product pages. Set `BROCHURE_URL` when building for production.

**Scroll stops.** Every chapter is a stop. On mouse wheels, trackpads and the keyboard (arrows, Page Up/Down, Space, Home/End), one gesture moves exactly one chapter, however hard the flick; the page then holds until the gesture and any trackpad momentum have finished, so moving on takes a deliberate second scroll. Wheeling over the Plexii panel scrolls the panel instead. On touch screens, native CSS `scroll-snap-stop: always` does the same job without taking over the finger. Tuning lives in `STEP` (`threshold` px to trigger, `quietMs` of stillness before the next move, `maxHoldMs` safety release). Explore mode and the hero release the stops.

**Explore mode** hides the story, keeps the Ask panel open and lets the visitor drag windows and ask real questions about their desk. Answers are grounded only in the desk items and come back with source chips.

## Personalisation providers

The page picks the first that works and always ends up with a working desk:

1. **Your endpoint** if `<meta name="plexii-api" content="/api/personalise">` is set (production).
2. **Claude in the claude.ai artifact viewer** via the `sample` capability (the published preview). The viewer is asked once for consent and it uses their own Claude usage.
3. **Built-in role library**: six hand-written presets (founder, consultant, marketer, developer, sales, project manager) matched on the role text, with the desk named after the visitor's work. No network.

Everything the model returns goes through `normalise()`: strings are length-capped and stripped of markup, arrays forced to the right size, the sheet highlight must be a real cell, the doc figure must match it, and every AI source and task source must be the title of an item that's actually on the desk. Invented sources are dropped. Text is only ever inserted with `textContent`.

## Links and downloads

All URLs live in one block at the top of the script (`SITE`, `RELEASE`, `LINKS` in `index.html`). Change the domain or bump the version there and every button follows.

| Button | Mac visitor | Windows visitor | Anyone else (Linux, phone, unknown) |
|---|---|---|---|
| Main download CTA, explore dock, hero nav | `.../v4.3.26/PlexiDesk-4.3.26-mac-universal.dmg` | `.../v4.3.8/Haptyx-4.3.8-win-x64.exe` | `/download` page |
| Secondary link | Windows .exe | Mac .dmg | `/download` page |

Both platform files were checked and resolve: Mac is the signed PlexiDesk asset from v4.3.26; Windows remains the verified v4.3.8 asset until a matching newer installer ships. Site links go to `https://haptyx-web.vercel.app` (How it works, Features, Pricing, Sign in, Download, Privacy) with `utm_source=build_your_desk&utm_medium=interactive_demo`. On phones the copy explains it's a desktop app.

## Deploy (Vercel)

1. Put this folder in its own Vercel project (vercel.json handles the build). To merge it into haptyx-web instead, run `node build.mjs` and copy `dist/*` into that site's public folder plus `api/` and `lib/`.
2. Nothing to edit: build.mjs sets the API endpoint and path routing in every generated page. Set `SITE_URL` in the Vercel build environment.
3. Vercel project settings, Environment Variables:
   - `ANTHROPIC_API_KEY` (required)
   - `ALLOWED_ORIGINS` = `https://haptyx-web.vercel.app` (plus your final domain once you own it) (only needed if the page and function are on different hosts)
   - `PLEXII_MODEL` (optional, defaults to `claude-sonnet-5-5`)
4. Add a Vercel Firewall rate-limit rule on `/api/personalise` (e.g. 10 requests/minute per IP). The function has a per-instance limiter, but serverless instances don't share memory, so it's a backstop, not a guarantee.
5. Set a monthly spend limit on the Anthropic Console workspace that owns the key.

**Model choice.** Default is Claude Sonnet 5.5 with `effort: "low"` for speed. I deliberately did not use Haiku 4.5: Anthropic lists its retirement as not sooner than 15 October 2026, nine days from when this was built. Source: https://platform.claude.com/docs/en/about-claude/models/overview

**Cost estimate** (Sonnet 5.5 at $2 / $10 per million input / output tokens): a desk build is roughly 1.2k input + 1.5k output tokens, about US$0.017. An Ask question is about US$0.005. 1,000 personalised visits with two questions each is roughly US$27. These are estimates from prompt size, not measured invoices.

## Run the tests

```bash
pip install playwright && python -m playwright install chromium
npm test            # node API tests + Playwright e2e (writes tests/shots/)
```

What's covered: model-output validation and injection stripping, role matching, JSON parsing, preset consistency, form validation, every chapter state change and its reversal on scroll-up, approve/decline flow, source hover, dragging, explore mode, Escape, restart, offline fallback, the production endpoint path (including a 503 falling back cleanly), mobile and light theme, and zero page errors. API tests cover key handling, origin checks, CORS preflight, rate limiting, size limits, upstream failures, prompt hygiene, and that the server and in-page prompts haven't drifted apart.

Not covered by automated tests: a live call to the Claude API (no key in the build environment) and the `sample` path (only exists inside the claude.ai viewer). Both share the same validation code the tests exercise.

## Brand decisions applied

- Product **PlexiDesk**, company **Plexii**, assistant **Plexii** (matching the live site's "Meet Plexii"). The demo avoids "PlexiBrain".
- Modules referred to plainly (Docs, Sheets, Slides, Diagrams, Design, the built-in browser) to sidestep the Plexi/Plexii single-vs-double-i inconsistency between the app and the marketing PDF.
- Opening chapter uses the approved line "Tabs get closed. Context is lost. Effort is duplicated."
- AI copy leads with "shows its sources and asks before it acts". Nothing says the AI learns, watches or tracks, and the generation prompt forbids the model from saying it either.
- Only features listed on the live site appear (Sign, Mail, Plans, voice, SpeedDeck, Attention, lock-in all are). Still left out: Flows, Marketplace and anything else from the scope document the live site doesn't list.
- Australian English throughout.

## Open items

Resolved by the live site: pricing ($9.95 per user, Team $14.95 per seat), Sign is shipping, Slides charts from live sheet data, live collaboration exists, local-first wording.

Still yours to decide:

1. **plexii.com is not yours.** It redirects to a GoDaddy "for sale" page. Earlier campaign material assumed it was the public URL. Buy it or pick another domain before any launch spend; Product Hunt, ads and social bios all point there.
2. **Windows still uses the legacy Haptyx filename.** Mac now downloads the PlexiDesk-branded v4.3.26 asset; publish a verified PlexiDesk Windows installer before changing that platform's link.
3. **The live site contradicts itself on AI for Free.** Home and Download say Plexii is included with no API key; Pricing says Free runs on your own Anthropic key and managed AI is Pro. This demo follows Pricing. Fix whichever is wrong.
4. **"PlexiBrain" is still on the live site** (feature cards, pricing table, privacy) next to "Meet Plexii". The campaign rule was to retire it.
5. **"AI watches for drift"** (How it works) reads as surveillance and cuts against the local-first message. The demo describes lock-in without it. Consider "notices when you switch away from the desk".
6. **Broken links on the live site:** Twitter / X and Status page in the footer go to `#`.
7. **Keep platform versions explicit:** do not present the newest Mac version as the Windows version until both release assets exist and pass verification.
8. **Support goes to a personal address** (michael@saasmouth.agency). A support@ alias scales better.
9. **Logo.** Still the typeset wordmark; swap in the official SVG.
10. **Currency.** "$9.95" is unlabelled on the live site too. AUD or USD?
