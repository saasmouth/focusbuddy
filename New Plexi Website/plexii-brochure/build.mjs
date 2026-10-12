// Production build for the brochure site: one real HTML file per page, each with only its own
// content, title, description and canonical. Served with clean URLs (/product, /blog/local-first-explained).
//   SITE_URL=https://www.yourdomain.com DEMO_URL=https://demo.yourdomain.com node build.mjs
import { readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SITE_URL = (process.env.SITE_URL || "https://www.example.com").replace(/\/$/, "");
const DEMO_URL = process.env.DEMO_URL || "";
const src = readFileSync(`${here}/index.html`, "utf8");

const PAGES = {
  home: { path: "", title: "PlexiDesk: the place work gets done", desc: "PlexiDesk gives every piece of work its own desk: docs, sheets, slides, a browser, meetings, mail and an AI assistant that shows its sources and asks before it acts. Local-first, for Mac and Windows." },
  product: { path: "product", title: "Everything in PlexiDesk", desc: "The PlexiDesk canvas, PlexiOffice, the Plexii assistant, Attention, plans, meetings, mail, PlexiSign, people, focus, voice and local-first files, module by module." },
  pricing: { path: "pricing", title: "PlexiDesk pricing", desc: "Free forever for personal use. Pro from $9.95 per user a month, Team from $14.95 per seat, and Enterprise. Compare every capability." },
  download: { path: "download", title: "Download PlexiDesk", desc: "Download PlexiDesk for Mac (Apple Silicon and Intel) or Windows. Free forever for personal use." },
  blog: { path: "blog", title: "The Plexii blog", desc: "How we think about focused work, trustworthy AI and keeping your work on your own machine." },
  "blog/one-desk-per-task": { path: "blog/one-desk-per-task", title: "One desk per task: why we built PlexiDesk", desc: "Software is organised by app. Work isn't. Here's what changes when every task gets its own desk." },
  "blog/sources-and-consent": { path: "blog/sources-and-consent", title: "Show your sources, ask before you act: how Plexii is designed", desc: "The two rules behind Plexii, the PlexiDesk assistant, and how they keep the decisions yours." },
  "blog/local-first-explained": { path: "blog/local-first-explained", title: "Local-first, explained: where your work lives in PlexiDesk", desc: "Exactly what stays on your machine, what uses a server, and why." },
  about: { path: "about", title: "About Plexii", desc: "Plexii makes PlexiDesk, a workspace built around one piece of work at a time." },
  live: { path: "live", title: "Join a PlexiDesk live session", desc: "A free 30-minute walkthrough of PlexiDesk with time for your questions." },
  book: { path: "book", title: "Book a PlexiDesk demo", desc: "Thirty minutes with the Plexii team, built around your team's work." }
};

const mainStart = src.indexOf('<main id="main">') + '<main id="main">'.length;
const mainEnd = src.indexOf("</main>");
const inner = src.slice(mainStart, mainEnd);
const starts = [...inner.matchAll(/<div data-page="([^"]+)">/g)].map(m => ({ name: m[1], at: m.index }));
const blocks = Object.fromEntries(starts.map((s, i) => [s.name, inner.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : inner.length)]));
for (const k of Object.keys(PAGES)) if (!blocks[k]) throw new Error(`page "${k}" not found in index.html`);

const esc = s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
mkdirSync(`${here}/dist/blog`, { recursive: true });
for (const [name, p] of Object.entries(PAGES)) {
  const url = `${SITE_URL}/${p.path}`;
  let html = src.slice(0, mainStart) + "\n" + blocks[name].replace(`<div data-page="${name}">`, `<div data-page="${name}" class="on">`) + "\n" + src.slice(mainEnd);
  html = html
    .replace('<meta name="plexii-routes" content="hash">', '<meta name="plexii-routes" content="path">')
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(p.title)}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(p.desc)}">`)
    .replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(p.title)}">`)
    .replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(p.desc)}">\n<meta property="og:url" content="${esc(url)}">\n<link rel="canonical" href="${esc(url)}">`);
  html = html.replace(/src="shots\//g, 'src="/shots/');
  if (process.env.LEADS_URL ?? "/api/leads") html = html.replace('<meta name="plexii-leads" content="">', `<meta name="plexii-leads" content="${esc(process.env.LEADS_URL ?? "/api/leads")}">`);
  for (const [k, env] of [["booking", "BOOKING_URL"], ["live", "LIVE_URL"], ["live-date", "LIVE_DATE"]]) if (process.env[env]) html = html.replace(`<meta name="plexii-${k}" content="">`, `<meta name="plexii-${k}" content="${esc(process.env[env])}">`);
  if (DEMO_URL) html = html.replace(/<meta name="plexii-demo" content="[^"]*">/, `<meta name="plexii-demo" content="${esc(DEMO_URL)}">`);
  writeFileSync(`${here}/dist/${p.path || "index"}.html`, html);
}
cpSync(`${here}/shots`, `${here}/dist/shots`, { recursive: true });
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${Object.values(PAGES).map(p => `  <url><loc>${SITE_URL}/${p.path}</loc></url>`).join("\n")}\n</urlset>\n`;
writeFileSync(`${here}/dist/sitemap.xml`, sitemap);
writeFileSync(`${here}/dist/robots.txt`, `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);
console.log(`Built ${Object.keys(PAGES).length} pages + sitemap for ${SITE_URL}`);
