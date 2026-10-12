# Plexii brochure site

The traditional website behind every "Learn more" in the interactive demo. Ordinary scrolling, a page per topic.

```
index.html         The whole site (hash routes: #/product, #/pricing, #/blog/<post>) for the single-file preview.
build.mjs          Production build: one real HTML file per page with its own title, description, canonical, plus sitemap.xml and robots.txt.
vercel.json        Runs build.mjs and serves dist/ with clean URLs (/product, /blog/local-first-explained).
tests/e2e_test.py  59 Playwright checks: every page on desktop, mobile and light theme, links, deep links, OS downloads, the built site.
```

## Pages

| Page | What's on it |
|---|---|
| Home | Headline and desk composition, the problem (tabs, context, effort), how a desk works in three steps, module cards, Plexii's sources-and-consent design, local-first, audience links into the demo, plans, latest posts |
| Product | Eleven modules, each with what it does, the detail and why it matters: canvas, PlexiOffice, Plexii, Attention, Plans and calendar, meetings/chat/calls, Mail and PlexiSign, people and teams, focus and lock-in, voice and SpeedDeck, files/sync/privacy. A sticky index tracks where you are; `/product#mail` jumps straight to a module |
| Pricing | Free, Pro, Team, Enterprise; a 30-row comparison; FAQ |
| Download | Verified platform-specific release buttons (Mac v4.3.26, Windows v4.3.8), requirements, and install steps |
| Blog | Three posts: one desk per task, how Plexii shows sources and asks before acting, local-first explained |
| About | Why Plexii exists, who builds it, three beliefs |

Every claim is taken from the live site's features, pricing, download and privacy pages. Features that need a paid plan say so. Product visuals are drawn in HTML, so the site has no image files to manage and passes the published-page rules that block remote images.

## Deploy

1. New Vercel project from this folder.
2. Environment variables: `SITE_URL` (your final domain, used for canonicals and the sitemap) and `DEMO_URL` (where the interactive demo lives).
3. In the demo project, set `BROCHURE_URL` to this site's domain so every "Learn more" points here.

All URLs (app site, release version, support email) are in one block at the top of the script.

## Before it goes live

1. **The blog posts are drafts in your voice.** They state only things the product does, but read and approve them. They're dated October 2026 and signed "The Plexii team".
2. **About page is deliberately thin on people and place.** It says PlexiDesk is built by the team at SaaSMouth (as the live footer does). Add founders, location and photos when you're ready.
3. **Contact goes to michael@saasmouth.agency**, as on the live site. A support@ address on your own domain will look more established.
4. **Prices show "$" with no currency,** matching the live site. Decide AUD or USD and say so.
5. **Pricing FAQ follows the live pricing page** on API keys (Free uses your own key). The live home and download pages say otherwise; fix the live site.
6. **Screenshots.** The mock windows can be swapped for real product screenshots once you have clean ones without client data.
7. **Overlap with haptyx-web.vercel.app.** This site covers the same ground plus blog and about. Decide which one is the public site so you're not maintaining two; this one is built to replace it and links to its account, help and legal pages in the meantime.
