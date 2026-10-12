// Builds static pages for production: dist/index.html plus one page per audience
// (dist/real-estate-agents.html etc., served at /real-estate-agents via cleanUrls).
// Each page gets its own <title>, description, canonical and Open Graph tags so links
// shared on TikTok, LinkedIn and Instagram preview correctly. index.html stays the single source.
//   SITE_URL=https://www.yourdomain.com node build.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const SITE_URL = (process.env.SITE_URL || "https://haptyx-web.vercel.app").replace(/\/$/, "");
const API = process.env.PLEXII_API ?? "/api/personalise";
const src = readFileSync(new URL("./index.html", import.meta.url), "utf8");

// LANDINGS is plain data inside index.html: evaluate just that object literal
const m = src.match(/const LANDINGS = (\{[\s\S]*?\n\});/);
if (!m) throw new Error("LANDINGS block not found in index.html");
export const LANDINGS = Function(`"use strict"; return (${m[1]});`)();

const esc = s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
function page(slug) {
  const L = slug ? LANDINGS[slug] : null;
  const title = L ? `PlexiDesk for ${L.audience.toLowerCase()}: ${L.tagline.replace(/\.$/, "").toLowerCase()}` : "PlexiDesk: build the desk for your work";
  const desc = L ? L.description : "Tell PlexiDesk what you're working on and watch it build the desk you'd use for it: docs, numbers, research and Plexii, the assistant that shows its sources and only applies changes you approve.";
  const url = `${SITE_URL}/${slug || ""}`;
  let html = src
    .replace('<meta name="plexii-api" content="">', `<meta name="plexii-api" content="${esc(API)}">`)
    .replace('<meta name="plexii-routes" content="hash">', '<meta name="plexii-routes" content="path">')
    .replace(/<meta name="plexii-brochure" content="[^"]*">/, m => process.env.BROCHURE_URL ? `<meta name="plexii-brochure" content="${esc(process.env.BROCHURE_URL)}">` : m)
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(desc)}">`)
    .replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(title)}">`)
    .replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(desc)}">\n<meta property="og:url" content="${esc(url)}">\n<link rel="canonical" href="${esc(url)}">`);
  return html;
}

mkdirSync(new URL("./dist/", import.meta.url), { recursive: true });
writeFileSync(new URL("./dist/index.html", import.meta.url), page(null));
for (const slug of Object.keys(LANDINGS)) writeFileSync(new URL(`./dist/${slug}.html`, import.meta.url), page(slug));
console.log(`Built ${Object.keys(LANDINGS).length + 1} pages for ${SITE_URL}: /, ${Object.keys(LANDINGS).map(s => "/" + s).join(", ")}`);
