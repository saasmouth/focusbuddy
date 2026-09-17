// Mind-mapper AI pipeline.
//
// Three independently-invokable helpers:
//
//   1. expandMindMapNode(rootPath, nodeContext)
//      → Claude reads the path from the root to the selected node (so
//        it has full thematic context) and returns 3-5 child branches
//        with labels and suggested kinds (idea / task / question /
//        tool / agent).
//
//   2. listAvailableAgents(searchRoots)
//      → Scans .claude/agents/*.md files under the operator's
//        workspace. Parses YAML frontmatter for name + description.
//        Returns a sorted list the renderer can cache.
//
//   3. suggestAgentsForNode(node, agents)
//      → Claude is given the node text + the candidate agents'
//        descriptions and picks the 1-3 most relevant, with a one-line
//        rationale per pick. If no agent matches well it returns []
//        and the renderer surfaces "Propose a new agent".
//
// PHASE_2: createAgent(spec) — writes a new .claude/agents/<slug>.md
//   file from a structured spec; agent-builder logic ported into a
//   server-side helper.
// PHASE_3: invokeAgent(name, context) — actually dispatches the agent
//   against the canvas state with controlled write capabilities.
//
// All Claude calls go through the existing Anthropic client. Each
// returns a tagged-union { ok, ... } so the renderer can branch
// without unwrapping exceptions.

import { randomUUID } from 'crypto'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import type Anthropic from '@anthropic-ai/sdk'
import { MINDMAP_TASK_SCOPE_NOTE } from './vocabulary'
import { getModelClient } from './modelClient'
import { resolveAnthropicKey } from '../settingsStore'
import { findAgentsDirectory } from '../workspaceResolver'
import { MODEL_HAIKU, MODEL_SONNET } from './modelRouting'

export type MindMapNodeKind = 'idea' | 'task' | 'question' | 'tool' | 'agent'

export interface SuggestedChild {
  id: string
  label: string
  kind: MindMapNodeKind
  rationale?: string
}

export interface ExpandOk {
  ok: true
  children: SuggestedChild[]
}
export interface ExpandErr {
  ok: false
  error: string
  reason?: 'no_key' | 'api' | 'parse'
}

export async function expandMindMapNode(input: {
  // Labels from the root to the parent of the node we're expanding.
  // Lets Claude follow the thread of thought across levels rather
  // than treating each node in isolation.
  rootPath: string[]
  // The selected node's own label + kind (the node being expanded).
  nodeLabel: string
  nodeKind?: MindMapNodeKind
  // Optional user nudge — "go deeper on technical implementation",
  // "focus on legal risk", etc. Empty in v1; UI affordance later.
  guidance?: string
}): Promise<ExpandOk | ExpandErr> {
  const key = resolveAnthropicKey()
  if (!key) {
    return {
      ok: false,
      error: 'No Anthropic key set. Add one in Settings → AI · API keys.',
      reason: 'no_key'
    }
  }
  const client = getModelClient(key)

  const SYSTEM =
    'You expand a node in a personal mind map. Given the path of labels from the root and the current node, explore the idea FULLY and propose the distinct child branches that genuinely advance the thinking — not paraphrases, not synonyms.\n' +
    '\n' +
    'Return ONLY a JSON array. Each object must be:\n' +
    '\n' +
    '{"label":"<concise 2-7 word label>","kind":"idea"|"task"|"question"|"tool"|"agent","rationale":"<one short sentence>"}\n' +
    '\n' +
    'Rules:\n' +
    '- "idea" = a concept to explore further (default if unsure)\n' +
    '- "task" = something the user could do; should fit on a to-do line ' +
    MINDMAP_TASK_SCOPE_NOTE +
    '\n' +
    '- "question" = an open question the user should answer\n' +
    '- "tool" = a tool, app, or file the user should reach for\n' +
    '- "agent" = a domain of work an AI agent could own end-to-end\n' +
    '\n' +
    '- Let the IDEA decide the count, not a quota. Some nodes split cleanly into 2; a rich topic may genuinely warrant 8, 10, or more. Return as many as the thinking truly contains and NO MORE.\n' +
    '- Never pad to hit a number, and never drop a genuinely valuable branch just to stay small. Quality over quantity: every child must earn its place — if you would not act on it, leave it out. A handful of sharp branches beats a dozen vague ones.\n' +
    '- No fluff, no filler, no near-duplicates. If two candidates overlap, keep only the stronger one.\n' +
    '- Mix kinds where natural. A node with many "task" children is rarely the best decomposition.\n' +
    '- Labels must be specific enough that the user can act on them. Avoid "consider X" / "think about Y" wording.\n' +
    '- Do NOT include the parent\'s words back as children — go forward.'

  const userMsg =
    'Root path (top → here): ' +
    input.rootPath.concat([input.nodeLabel]).join(' → ') +
    `\n` +
    `Current node kind: ${input.nodeKind ?? 'idea'}\n` +
    (input.guidance ? `Guidance: ${input.guidance}\n` : '') +
    'Propose the children that genuinely advance this — as many or as few as the idea warrants:'

  try {
    const resp = await client.messages.create({
      model: MODEL_SONNET,
      // Generous so a rich node can return many high-quality branches without
      // being truncated mid-array (the count is decided by the idea, not a quota).
      max_tokens: 2048,
      system: SYSTEM,
      messages: [{ role: 'user', content: userMsg }]
    })
    const text = extractText(resp).trim()
    const parsed = parseChildrenArray(text)
    if (!parsed.ok) return parsed
    return { ok: true, children: parsed.children }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: msg.length > 240 ? msg.slice(0, 240) + '…' : msg,
      reason: 'api'
    }
  }
}

// ── Agent inventory ────────────────────────────────────────────────────────

export interface LocalAgent {
  // Filename without extension. Stable id we round-trip with.
  slug: string
  // Absolute path to the .md file — useful when we open it in
  // a future "edit this agent" affordance.
  path: string
  // YAML frontmatter `name:` if present, else slug.
  name: string
  // YAML frontmatter `description:` if present, else "".
  description: string
}

export interface AgentInventory {
  // Where these agents were sourced from. The renderer surfaces this
  // so the user knows whether the list came from their workspace,
  // a userData fallback, or a manual override.
  source: 'override' | 'workspace' | 'userData-existing' | 'userData-new' | 'none'
  // Absolute path to the resolved .claude/agents directory, or null
  // if no agents directory was found anywhere. Renderer can open
  // this in Finder.
  agentsDir: string | null
  // The workspace root (parent of .claude/agents/). UI shows this
  // as the friendly "Agents from: <root>" text instead of the deeper
  // file path.
  workspaceRoot: string | null
  agents: LocalAgent[]
}

/**
 * Resolve the workspace's agents directory and return both the
 * inventory AND the metadata about where it came from. The
 * renderer uses the metadata to:
 *   - Surface "Agents from: <root>" in the suggestion header
 *   - Offer an "Open in Finder" button on the resolved directory
 *   - Show a one-line warning if the source is the userData fallback
 *     ("Pointing at PlexiDesk's userData — Settings → Workspace to
 *     change")
 *
 * Empty agents arrays come back with the resolved path filled in
 * so the user knows where to drop new agent .md files.
 */
export function listAvailableAgents(_searchRoots?: string[]): AgentInventory {
  // Legacy callers pass searchRoots; we ignore it and use the
  // resolver. Keeping the parameter accepted means existing IPC
  // wiring continues to compile during the transition.
  void _searchRoots
  const resolved = findAgentsDirectory()
  if (!resolved) {
    return {
      source: 'none',
      agentsDir: null,
      workspaceRoot: null,
      agents: []
    }
  }
  const files = readdirSync(resolved.path).filter((f) => f.endsWith('.md'))
  const agents: LocalAgent[] = []
  for (const f of files) {
    const slug = f.replace(/\.md$/, '')
    const path = join(resolved.path, f)
    try {
      const raw = readFileSync(path, 'utf-8')
      const fm = parseFrontmatter(raw)
      agents.push({
        slug,
        path,
        name: fm.name ?? slug,
        description: fm.description ?? ''
      })
    } catch {
      // Skip unreadable agent files; surfacing wouldn't help the user.
    }
  }
  agents.sort((a, b) => a.name.localeCompare(b.name))
  return {
    source: resolved.source,
    agentsDir: resolved.path,
    workspaceRoot: resolved.workspaceRoot,
    agents
  }
}

// ── Agent suggestion ───────────────────────────────────────────────────────

export interface AgentSuggestion {
  slug: string
  name: string
  rationale: string
}

export interface SuggestOk {
  ok: true
  suggestions: AgentSuggestion[]
}
export interface SuggestErr {
  ok: false
  error: string
  reason?: 'no_key' | 'api' | 'parse' | 'no_agents'
}

export async function suggestAgentsForNode(input: {
  rootPath: string[]
  nodeLabel: string
  nodeKind?: MindMapNodeKind
  candidates: LocalAgent[]
}): Promise<SuggestOk | SuggestErr> {
  if (input.candidates.length === 0) {
    return {
      ok: false,
      error:
        'No agents found in this workspace. Look in .claude/agents/ — that directory should contain the operator\'s agent markdown files.',
      reason: 'no_agents'
    }
  }
  const key = resolveAnthropicKey()
  if (!key) {
    return {
      ok: false,
      error: 'No Anthropic key set. Add one in Settings → AI · API keys.',
      reason: 'no_key'
    }
  }
  const client = getModelClient(key)

  // We compose a tight list — slug + first-line description — so the
  // model can pick without burning tokens on the full agent body.
  const list = input.candidates
    .map((a) => {
      const first = a.description.split('\n')[0].slice(0, 240)
      return `- ${a.slug}: ${first}`
    })
    .join('\n')

  const SYSTEM =
    'You match a mind-map node to the 1-3 most relevant agents from a workspace inventory.\n' +
    '\n' +
    'Return ONLY a JSON array, sorted by best fit. Each object:\n' +
    '\n' +
    '{"slug":"<exact-slug-from-list>","rationale":"<one sentence why this fits>"}\n' +
    '\n' +
    'Rules:\n' +
    '- "slug" MUST be exact-match one of the listed slugs. Do not invent.\n' +
    '- 1-3 suggestions max. If no agent fits well, return [] — that\'s a signal the user should propose a new agent.\n' +
    '- Match on capability, not topic. A "build a landing page" node fits a copy-package-builder even if it\'s not literally about copy.'

  const userMsg =
    `Mind-map node: "${input.nodeLabel}" (kind: ${input.nodeKind ?? 'idea'})\n` +
    `Context path (root → here): ${input.rootPath.concat([input.nodeLabel]).join(' → ')}\n` +
    `\n` +
    `Available agents:\n${list}\n` +
    `\n` +
    `Return up to 3 best matches as JSON:`

  try {
    const resp = await client.messages.create({
      model: MODEL_HAIKU, // cheap, 33-agent list × short rationale fits easily
      max_tokens: 512,
      system: SYSTEM,
      messages: [{ role: 'user', content: userMsg }]
    })
    const text = extractText(resp).trim()
    const parsed = parseAgentSuggestionArray(text)
    if (!parsed.ok) return parsed
    // Map slugs back to canonical names from the candidates list so
    // the renderer can render the display name without doing its own
    // lookup.
    const byCount = new Map(input.candidates.map((c) => [c.slug, c.name]))
    const suggestions: AgentSuggestion[] = []
    for (const s of parsed.suggestions.slice(0, 3)) {
      if (!byCount.has(s.slug)) continue
      suggestions.push({
        slug: s.slug,
        name: byCount.get(s.slug) ?? s.slug,
        rationale: s.rationale
      })
    }
    return { ok: true, suggestions }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: msg.length > 240 ? msg.slice(0, 240) + '…' : msg,
      reason: 'api'
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractText(resp: Anthropic.Message): string {
  const out: string[] = []
  for (const block of resp.content) {
    if (block.type === 'text') out.push(block.text)
  }
  return out.join('\n').trim()
}

interface Frontmatter {
  name?: string
  description?: string
}

// Tiny YAML frontmatter parser — only the two keys we care about
// (name + description). Skips full YAML support to avoid pulling in
// js-yaml. If a future agent file uses richer frontmatter we'll
// upgrade then.
function parseFrontmatter(raw: string): Frontmatter {
  const trimmed = raw.replace(/^﻿/, '')
  if (!trimmed.startsWith('---')) return {}
  const end = trimmed.indexOf('\n---', 3)
  if (end === -1) return {}
  const body = trimmed.slice(3, end)
  const out: Frontmatter = {}
  // Match name + description, allowing single- or double-quoted values
  // OR a folded multi-line scalar via the | / > YAML operators.
  for (const key of ['name', 'description'] as const) {
    const flat = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(body)
    if (flat) {
      out[key] = unquoteYaml(flat[1].trim())
      continue
    }
    const folded = new RegExp(
      `^${key}:\\s*[|>]\\s*\\n((?:\\s+.+\\n?)+)`,
      'm'
    ).exec(body)
    if (folded) {
      out[key] = folded[1]
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .join(' ')
    }
  }
  return out
}

function unquoteYaml(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"')
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  return trimmed
}

// Tolerant JSON array parser — same shape we used for ActionProposal
// extraction. Strips markdown fences, finds the first `[…]` block,
// filters unknown shapes.
type ChildrenParseOk = { ok: true; children: SuggestedChild[] }
type ChildrenParseErr = { ok: false; error: string; reason: 'parse' }
function parseChildrenArray(raw: string): ChildrenParseOk | ChildrenParseErr {
  let cleaned = raw.trim()
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) {
    return { ok: false, error: 'Claude did not return a JSON array.', reason: 'parse' }
  }
  let arr: unknown
  try {
    arr = JSON.parse(cleaned.slice(start, end + 1))
  } catch (err) {
    return {
      ok: false,
      error: `JSON parse failed: ${(err as Error).message}`,
      reason: 'parse'
    }
  }
  if (!Array.isArray(arr)) {
    return { ok: false, error: 'Not an array.', reason: 'parse' }
  }
  const out: SuggestedChild[] = []
  const allowed: MindMapNodeKind[] = ['idea', 'task', 'question', 'tool', 'agent']
  // Let the idea decide the count — only a generous safety bound against a
  // pathological runaway response (the prompt already gates hard on quality).
  for (const item of arr.slice(0, 40)) {
    if (typeof item !== 'object' || item === null) continue
    const obj = item as Record<string, unknown>
    if (typeof obj.label !== 'string' || !obj.label.trim()) continue
    const rawKind = typeof obj.kind === 'string' ? obj.kind.toLowerCase() : ''
    const kind = (allowed as readonly string[]).includes(rawKind)
      ? (rawKind as MindMapNodeKind)
      : 'idea'
    out.push({
      id: randomUUID(),
      label: obj.label.trim().slice(0, 100),
      kind,
      rationale:
        typeof obj.rationale === 'string'
          ? obj.rationale.trim().slice(0, 200)
          : undefined
    })
  }
  return { ok: true, children: out }
}

type SuggestParseOk = { ok: true; suggestions: { slug: string; rationale: string }[] }
function parseAgentSuggestionArray(raw: string): SuggestParseOk | SuggestErr {
  let cleaned = raw.trim()
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) {
    return { ok: false, error: 'Claude did not return a JSON array.', reason: 'parse' }
  }
  let arr: unknown
  try {
    arr = JSON.parse(cleaned.slice(start, end + 1))
  } catch (err) {
    return {
      ok: false,
      error: `JSON parse failed: ${(err as Error).message}`,
      reason: 'parse'
    }
  }
  if (!Array.isArray(arr)) {
    return { ok: false, error: 'Not an array.', reason: 'parse' }
  }
  const out: { slug: string; rationale: string }[] = []
  for (const item of arr.slice(0, 5)) {
    if (typeof item !== 'object' || item === null) continue
    const obj = item as Record<string, unknown>
    if (typeof obj.slug !== 'string' || !obj.slug.trim()) continue
    out.push({
      slug: obj.slug.trim(),
      rationale: typeof obj.rationale === 'string' ? obj.rationale.trim() : ''
    })
  }
  return { ok: true, suggestions: out }
}
