// Regenerates manifest.json tools[] from the server source so the extension listing
// can never drift from what Plexii actually serves. Run from the repo root:
//   node tools/plexii-mcp-bridge/scripts/gen-manifest.mjs
// tests/unit/mcpServer.test.ts fails if the manifest and WORKSPACE_TOOLS disagree.
import { readFileSync, writeFileSync } from 'node:fs'
// order: readTools, RECALL_TOOLS, writeTools — mirror WORKSPACE_TOOLS by scanning each block in order
function block(s, start, end){ const a=s.indexOf(start); const b=end?s.indexOf(end,a):s.length; return s.slice(a,b) }
const server = readFileSync('src/main/mcpServer.ts','utf8')
const recall = readFileSync('src/main/mcpRecall.ts','utf8')
const reads = block(server, 'const readTools', 'const writeTools')
const writes = block(server, 'const writeTools', '// ── The composed server')
const recalls = block(recall, 'export const RECALL_TOOLS', 'export function recallServerSpec')
const names = (s) => [...s.matchAll(/name: '([a-z_]+)'/g)].map(m=>m[1])
const titles = (s) => [...s.matchAll(/annotations: \{ title: '([^']+)'/g)].map(m=>m[1])
const all = [reads, recalls, writes].flatMap(s => names(s).map((n,i)=>({name:n, description:titles(s)[i]})))
const m = JSON.parse(readFileSync('tools/plexii-mcp-bridge/manifest.json','utf8'))
m.tools = all
writeFileSync('tools/plexii-mcp-bridge/manifest.json', JSON.stringify(m, null, 2)+'\n')
console.log(all.length, 'tools')
