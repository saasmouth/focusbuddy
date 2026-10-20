// Live resume-summary generation (spec §52 stage-model, §67, §70). Bridges the
// deterministic Resume to a real model call through the single model-client seam
// (PLX-AI-001), staying inside the governance rules: cached by the structured-input
// digest (RES-012), grounded in the Resume's source Events and marked ai_generated
// (DOM-014 / INV-04), and degrading to the deterministic Resume when there is no key
// or the call fails (ARC-022, RES-013). The model call is injectable so the wiring
// is unit-testable without a live key; production uses the real seam.

import type Anthropic from '@anthropic-ai/sdk' // type-only: no runtime SDK dependency (AI-001)
import { getModelClient } from './modelClient'
import { clientForKey } from './local/providerRouter'
import { resolveModel } from './modelRouting'
import { resolveAnthropicKey } from '../settingsStore'
import { structuredDigest, type SummaryCache } from './summaryCache'
import { withAiSummary, hasSufficientSignal, type StructuredResume } from '../resume/resume'
import { markAiGenerated, type AiMetadata } from '../../shared/aiProvenance'

export const RESUME_PROMPT_VERSION = 'resume-summary-1.0.0'

export interface LiveSummaryResult {
  resume: StructuredResume
  aiMetadata: AiMetadata | null
  cacheHit: boolean
  degraded: boolean // true when no key / no signal / call failed — deterministic Resume returned
}

export type ModelInvoke = (prompt: string, model: string) => Promise<string>

function extractText(resp: Anthropic.Message): string {
  return resp.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

// A prompt grounded strictly in the structured Resume — the model summarises only
// what the deterministic pipeline already produced, never inventing (INV-04).
export function buildResumePrompt(resume: StructuredResume): string {
  const changes = resume.groups
    .map((g) => {
      const kinds = g.changes.map((c) => `${c.kind}x${c.count}`).join(', ')
      return `- ${g.objectId}: ${kinds}${g.changes[0]?.lastSummary ? ` (${g.changes[0].lastSummary})` : ''}`
    })
    .join('\n')
  return [
    'You are writing a short catch-up for a user returning to a desk.',
    'Summarise ONLY the structured changes below. Do not invent anything not present.',
    `Deterministic summary: ${resume.summary}`,
    resume.decisionIds.length ? `Decisions possibly affected: ${resume.decisionIds.length}` : '',
    'Changes:',
    changes || '(none)',
    '',
    'Write two or three plain sentences. No preamble, no markdown.'
  ]
    .filter(Boolean)
    .join('\n')
}

// The real model call, through the seam. Throws if no key (caller degrades).
const realInvoke: ModelInvoke = async (prompt, model) => {
  const client = clientForKey(resolveAnthropicKey(), getModelClient)
  if (!client) throw new Error('no-anthropic-key')
  const resp = await client.messages.create({ model, max_tokens: 512, messages: [{ role: 'user', content: prompt }] })
  return extractText(resp)
}

export interface LiveSummaryOptions {
  cache: SummaryCache
  now: string
  invoke?: ModelInvoke
  keyAvailable?: () => boolean
}

export async function generateResumeSummaryLive(resume: StructuredResume, opts: LiveSummaryOptions): Promise<LiveSummaryResult> {
  // No signal or no source Events -> nothing to ground a summary on; stay
  // deterministic (RES-013 / RES-044).
  if (!hasSufficientSignal(resume) || resume.sourceEventIds.length === 0) {
    return { resume, aiMetadata: null, cacheHit: false, degraded: true }
  }
  const digest = structuredDigest(resume)
  const cached = opts.cache.get(digest)
  if (cached !== null) {
    const meta = markAiGenerated({ model: resolveModel('resume'), promptVersion: RESUME_PROMPT_VERSION, generatedAt: opts.now, sourceEventIds: resume.sourceEventIds })
    return { resume: withAiSummary(resume, cached), aiMetadata: meta, cacheHit: true, degraded: false } // RES-012
  }
  const keyAvailable = opts.keyAvailable ?? (() => !!clientForKey(resolveAnthropicKey(), getModelClient))
  if (!keyAvailable()) {
    return { resume, aiMetadata: null, cacheHit: false, degraded: true } // ARC-022: no key -> deterministic
  }
  const invoke = opts.invoke ?? realInvoke
  const model = resolveModel('resume')
  try {
    const text = await invoke(buildResumePrompt(resume), model)
    opts.cache.getOrCompute(digest, () => text) // persist for RES-012
    const meta = markAiGenerated({ model, promptVersion: RESUME_PROMPT_VERSION, generatedAt: opts.now, sourceEventIds: resume.sourceEventIds })
    return { resume: withAiSummary(resume, text), aiMetadata: meta, cacheHit: false, degraded: false }
  } catch (err) {
    // Never log the key; degrade to the deterministic Resume (ARC-022).
    console.warn('[live-resume] AI summary degraded:', (err as Error).message)
    return { resume, aiMetadata: null, cacheHit: false, degraded: true }
  }
}
