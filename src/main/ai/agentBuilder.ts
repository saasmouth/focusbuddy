// Agent creation — writes a new agent markdown file into
// `<workspace>/.claude/agents/<slug>.md` following the kit's
// conventions. Bootstraps via Claude Sonnet to draft the body from a
// short structured spec; the user can edit before / after creation.
//
// We deliberately don't try to reproduce all of `agent-builder.md`'s
// design discipline here — that agent is the canonical authority. This
// is a lightweight on-ramp from the mindmap widget so the user can go
// from "no matching agent" → "agent file exists and Claude can pick
// it next time" in one modal, then refine via the real agent-builder
// agent when ready.

import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getModelClient } from './modelClient'
import { resolveAnthropicKey } from '../settingsStore'
import { ensureAgentsDirectory } from '../workspaceResolver'
import { MODEL_SONNET } from './modelRouting'

export type AgentModelTier = 'haiku' | 'sonnet' | 'opus'

/** The tools Claude Code currently supports for sub-agents. */
export type AgentTool =
  | 'Read'
  | 'Write'
  | 'Edit'
  | 'Bash'
  | 'Glob'
  | 'Grep'
  | 'WebFetch'
  | 'WebSearch'
  | 'Agent'

export interface AgentSpec {
  // Kebab-case slug used as the filename. Must be unique within
  // .claude/agents/. The renderer can suggest one from the mind-map
  // node label; the user can override before submitting.
  slug: string
  // One-line capability summary. This is what Claude reads when
  // ranking agents for a node — keep it specific.
  description: string
  model: AgentModelTier
  tools: AgentTool[]
  // Free-text purpose / situation that triggered the creation. Gets
  // distilled into the Identity + Workflow sections by Claude.
  purpose: string
  // Optional context from the mind map — root path + node label —
  // so the generated agent reads as "designed for THIS work" not a
  // generic blob.
  contextPath?: string[]
}

export interface CreateAgentOk {
  ok: true
  slug: string
  path: string
}
export interface CreateAgentErr {
  ok: false
  error: string
  reason?: 'no_key' | 'api' | 'fs' | 'exists' | 'no_workspace'
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/**
 * Validate + write a new agent file. Returns the absolute path on
 * success so the renderer can offer "Open in editor" or kick off a
 * subsequent suggestAgents() that includes this new entry.
 */
export async function createAgent(
  spec: AgentSpec
): Promise<CreateAgentOk | CreateAgentErr> {
  const slug = slugify(spec.slug)
  if (!slug) {
    return { ok: false, error: 'Slug must contain letters or numbers.', reason: 'fs' }
  }
  // Always-returns helper: resolves an existing .claude/agents under
  // the user's workspace OR creates one under userData. mkdirSync
  // inside the helper handles intermediate dirs with recursive: true.
  let resolved
  try {
    resolved = ensureAgentsDirectory()
  } catch (err) {
    return {
      ok: false,
      error: `Could not create agents directory: ${(err as Error).message}`,
      reason: 'no_workspace'
    }
  }
  const dir = resolved.path
  const targetPath = join(dir, `${slug}.md`)
  if (existsSync(targetPath)) {
    return {
      ok: false,
      error: `An agent named "${slug}" already exists at ${targetPath}. Pick a different name.`,
      reason: 'exists'
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

  // Generate the body via Claude. Sonnet is the right tier — agent
  // design is meta-work, but a one-paragraph user spec isn't deep
  // enough to need Opus.
  const client = getModelClient(key)

  const SYSTEM =
    'You write Claude Code sub-agent markdown files. Output ONLY the body content (no preamble, no markdown fence). The body should:\n' +
    '\n' +
    '1. Start with a top-level heading using the agent name as a slug-derived title (e.g. "# Copy Package Builder").\n' +
    '2. Have these sections in this order, each as `## `:\n' +
    '   - Identity (1 short paragraph — who this agent is and what role they play)\n' +
    '   - When to use (3-5 bullets of concrete trigger conditions)\n' +
    '   - How you work (3-6 numbered steps describing the workflow)\n' +
    '   - Inputs you need (what context / files the user must provide)\n' +
    '   - Output you produce (what the user gets back at the end)\n' +
    '   - Failure modes (1-3 bullets — when this agent should hand off or escalate)\n' +
    '\n' +
    'Style:\n' +
    '- Plain prose, not corporate-speak. Match the voice of the agentic starter kit.\n' +
    '- Specific, not generic. If the user gave you a topic (e.g. "press release writing"), don\'t hedge into "content writing in general".\n' +
    '- No filler. No "you should consider…". Just direct instructions to the agent.\n' +
    '- 250-400 words total. Tight is better than thorough at this stage.'

  const userMsg =
    `Agent slug: ${slug}\n` +
    `Description: ${spec.description}\n` +
    `Model tier: ${spec.model}\n` +
    `Tools available to this agent: ${spec.tools.join(', ')}\n` +
    (spec.contextPath && spec.contextPath.length > 0
      ? `Originating mind-map context: ${spec.contextPath.join(' › ')}\n`
      : '') +
    `\nPurpose / situation that triggered the creation:\n${spec.purpose}\n\n` +
    `Write the agent body now.`

  let body: string
  try {
    const resp = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 1800,
      system: SYSTEM,
      messages: [{ role: 'user', content: userMsg }]
    })
    const out: string[] = []
    for (const block of resp.content) {
      if (block.type === 'text') out.push(block.text)
    }
    body = out.join('\n').trim()
    if (!body) {
      return {
        ok: false,
        error: 'Claude returned an empty agent body.',
        reason: 'api'
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: msg.length > 240 ? msg.slice(0, 240) + '…' : msg,
      reason: 'api'
    }
  }

  // Assemble the final markdown — frontmatter + Claude's body. We use
  // the same field order as existing kit agents so they stay grep-
  // and diff-friendly.
  const frontmatter =
    '---\n' +
    `name: ${slug}\n` +
    `description: "${spec.description.replace(/"/g, '\\"')}"\n` +
    `model: ${spec.model}\n` +
    `tools: ${spec.tools.join(', ')}\n` +
    `maxTurns: 20\n` +
    `# Generated via the mindmap widget's agent-creation wizard.\n` +
    `# Originating context: ${(spec.contextPath ?? []).join(' › ') || 'manual'}\n` +
    '---\n\n'

  const fullContent = frontmatter + body + '\n'

  try {
    // ensureAgentsDirectory already created the directory; we just
    // write the file. Errors here are typically perms or quota.
    writeFileSync(targetPath, fullContent, 'utf-8')
  } catch (err) {
    return {
      ok: false,
      error: `Could not write agent file: ${(err as Error).message}`,
      reason: 'fs'
    }
  }

  return { ok: true, slug, path: targetPath }
}
