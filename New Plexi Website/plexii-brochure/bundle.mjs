// Makes preview.html: index.html with every screenshot inlined as a data URI, so the whole site is one
// self-contained file (what the claude.ai artifact preview needs). Production uses build.mjs instead.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(`${here}/index.html`, "utf8").replace(/src="shots\/([\w-]+)\.webp"/g, (_, n) =>
  `src="data:image/webp;base64,${readFileSync(`${here}/shots/${n}.webp`).toString("base64")}"`);
writeFileSync(`${here}/preview.html`, html);
console.log(`preview.html: ${(html.length / 1024 / 1024).toFixed(2)} MB`);
