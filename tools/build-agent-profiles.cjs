/* eslint-disable */
// Converts the starter-kit agent definitions (.claude/agents/*.md) into
// Plexii desk-agent PROFILES. Each agent's "## Identity" persona becomes a
// profile's systemPrompt (its expertise + approach), with kit-specific
// machinery (workflow_run / manifest / file paths / operator) stripped out — a
// profile only shapes HOW an agent works, never how its output is applied.
//
//   node tools/build-agent-profiles.cjs
//
// Writes src/renderer/src/lib/agentProfileLibrary.ts. Re-run after editing the
// source agents; do not hand-edit the generated file.

const fs = require('fs')
const path = require('path')

const AGENTS_DIR = path.resolve(__dirname, '..', '..', '..', '.claude', 'agents')
const OUT = path.resolve(__dirname, '..', 'src', 'renderer', 'src', 'lib', 'agentProfileLibrary.ts')

const ACRONYMS = { ai: 'AI', gtm: 'GTM', qa: 'QA', abm: 'ABM', saas: 'SaaS', rnd: 'R&D', crm: 'CRM' }
function titleCase(slug) {
  return slug
    .split('-')
    .map((w) => ACRONYMS[w.toLowerCase()] ?? (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

function iconFor(name, desc) {
  const s = (name + ' ' + desc).toLowerCase()
  const map = [
    ['research|scout|analyst|investig', 'travel_explore'],
    ['copy|writer|content|prose', 'edit_note'],
    ['brand|positioning|platform', 'palette'],
    ['plan|orchestrat|architect|steward|optimiz|critic', 'checklist'],
    ['contact|abm|account|outbound|sequence', 'contacts'],
    ['proposal|contract|opportunity|tracker', 'description'],
    ['tax|incentive|rnd|r&d', 'account_balance'],
    ['web|webflow|landing|page', 'language'],
    ['table|data', 'table_chart'],
    ['test|tester|qa', 'bug_report'],
    ['intake|interview|discovery|scoper', 'forum'],
    ['launch|prelaunch|runbook', 'rocket_launch'],
    ['case', 'auto_stories'],
    ['migrat|reposition', 'sync_alt'],
    ['skill|builder|navigator|coach|implementer|kit', 'school'],
    ['technical|lead|engineer', 'engineering'],
    ['marketing|gtm', 'campaign'],
    ['owner|link|canvas|section|tool|applier|ai-proposal', 'build']
  ]
  for (const [re, ic] of map) if (new RegExp(re).test(s)) return ic
  return 'smart_toy'
}

function clean(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/\.claude\/|workflow_run|manifest|add_artifact|delta|confidence block|projects\/|src\/|\.tsx|\.md\b/i.test(l))
    .join(' ')
    .replace(/\bthe operator\b/gi, 'the user')
    .replace(/\boperator\b/gi, 'user')
    .replace(/You run on (Sonnet|Opus|Haiku)[^.]*\.\s*/gi, '')
    .replace(/Internal name:.*$/i, '')
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .trim()
}

const files = fs
  .readdirSync(AGENTS_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort()

const profiles = []
for (const f of files) {
  const raw = fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8')
  const fm = /^---\n([\s\S]*?)\n---/.exec(raw)
  const front = fm ? fm[1] : ''
  const name = (/(^|\n)name:\s*(.+)/.exec(front)?.[2] || path.basename(f, '.md')).trim()
  const desc = (/(^|\n)description:\s*(.+)/.exec(front)?.[2] || '')
    .trim()
    .replace(/^["']|["']$/g, '')
  const idM = /##\s*Identity\s*\n([\s\S]*?)(?:\n##\s|\n#\s|$)/.exec(raw)
  let persona = idM ? clean(idM[1]) : ''
  if (persona.length < 40) persona = clean(desc)
  persona = persona.slice(0, 1100)
  let blurb = desc.split(/(?<=[.!?])\s/)[0] || desc
  if (blurb.length > 96) blurb = blurb.slice(0, 93).replace(/\s\S*$/, '') + '…'
  profiles.push({
    id: 'lib-' + path.basename(f, '.md'),
    name: titleCase(name),
    blurb,
    icon: iconFor(name, desc),
    systemPrompt: persona,
    builtIn: true
  })
}

const out = `// AUTO-GENERATED from .claude/agents/*.md by tools/build-agent-profiles.cjs.
// Each starter-kit agent becomes a desk-agent profile (its Identity persona,
// with kit machinery stripped). Do not hand-edit — re-run the generator.
// ${profiles.length} profiles.
import type { AgentProfile } from './agentProfiles'

export const LIBRARY_PROFILES: AgentProfile[] = ${JSON.stringify(profiles, null, 2)}
`

fs.writeFileSync(OUT, out)
console.log('Wrote', profiles.length, 'profiles ->', path.relative(process.cwd(), OUT))
