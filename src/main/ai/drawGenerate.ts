// "Describe it and PlexiiDraw draws it" — the vector half.
//
// The owner, after trying Diagrams' AI: "This works in diagrams, but not in
// draw. Draw needs to be able to build vector designs and paint designs."
// Until now documents:generate answered a drawing with a refusal in so many
// words — "Artwork is created in the PlexiiDraw studio, not generated from a
// prompt."
//
// WHAT COMES BACK IS EDITABLE ART, not a picture of art. The model returns a
// scene of named shapes (shared/draw/generate/scene.ts) which compiles to
// PlexiiDraw's own path nodes, so every anchor can be dragged and every fill
// changed afterwards. That is why this asks for JSON rather than SVG: SVG
// cannot be grammar-constrained, and the on-device model must return something
// structured or decline honestly rather than emit broken XML.
//
// ROUTING. The same routedClient every other feature uses, so the person's
// choice decides: their Anthropic key, Plexii credits, or the device. No key
// and local routing on is a SUPPORTED path here, not a failure — the whole
// point of the on-device model is that it still works. What this must never
// do is pretend: a reply that will not validate is refused with the reason,
// never silently replaced with something the app made up.

import type Anthropic from '@anthropic-ai/sdk'
import { getModelClient } from './modelClient'
import { resolveAnthropicKey } from '../settingsStore'
import { clientForKey } from './local/providerRouter'
import { resolveModel } from './modelRouting'
import { refusalReason, validateScene, SCENE_LIMITS, type Scene, type SceneProblem } from '@shared/draw/generate/scene'

export interface DrawGenerateInput {
  /** What the person typed. Passed through verbatim. */
  prompt: string
  /** The artboard the art is for, so the model works at the real size. */
  width: number
  height: number
  /**
   * Present for "change what I have selected": the current selection as a
   * scene, which the model rewrites. Absent for a fresh generation.
   */
  selection?: Scene
  /** The document's palette, so "recolour to the brand palette" has something to mean. */
  palette?: string[]
}

export type DrawGenerateResult =
  | { ok: true; scene: Scene; problems: SceneProblem[] }
  | { ok: false; error: string; needsKey?: boolean }

/** Tokens for a scene. Generous for a detailed illustration, finite. */
const GENERATION_TOKENS = 8000

/**
 * The prompt is the schema. Every field is named and the example is complete,
 * because an on-device model follows a worked example far better than it
 * follows prose, and node-llama-cpp's JSON grammar cannot express
 * "additionalProperties: false" — an unnamed field comes back garbled.
 */
function systemPrompt(w: number, h: number, palette: string[], editing: boolean): string {
  return [
    'You draw vector art for PlexiiDraw, a vector illustration app.',
    `The artboard is ${Math.round(w)} by ${Math.round(h)} units. Put the art inside it.`,
    '',
    'Reply with ONE JSON object and nothing else. No prose, no markdown fence.',
    '',
    '{',
    '  "name": "a short name for the drawing",',
    '  "items": [',
    '    { "shape": { "kind": "rect", "x": 0, "y": 0, "w": 100, "h": 50, "radius": 8 }, "fill": "#2563eb", "name": "body" },',
    '    { "shape": { "kind": "ellipse", "cx": 50, "cy": 25, "rx": 20, "ry": 20 }, "fill": "#ffffff" },',
    '    { "shape": { "kind": "polygon", "cx": 50, "cy": 25, "r": 20, "sides": 6 }, "fill": "#f59e0b" },',
    '    { "shape": { "kind": "star", "cx": 50, "cy": 25, "r": 20, "points": 5, "innerRatio": 0.5 }, "fill": "#f59e0b" },',
    '    { "shape": { "kind": "line", "x1": 0, "y1": 0, "x2": 100, "y2": 0 }, "stroke": { "color": "#111827", "width": 2 } },',
    '    { "shape": { "kind": "path", "d": "M0 0 L10 0 L5 9 Z" }, "fill": "#10b981" },',
    '    { "name": "a group", "children": [ { "shape": { "kind": "rect", "x": 0, "y": 0, "w": 10, "h": 10 }, "fill": "#111827" } ] }',
    '  ]',
    '}',
    '',
    'Rules:',
    '- Use ONLY those shape kinds, with exactly those field names.',
    '- Colours are hex strings like "#2563eb", or "none".',
    '- Every shape needs a fill, or a stroke, or both. A shape with neither is invisible.',
    '- Earlier items are painted first, so a background goes first and detail last.',
    '- Build a picture out of many simple shapes rather than one enormous path.',
    `- At most ${SCENE_LIMITS.nodes} shapes in total.`,
    palette.length ? `- The document's palette: ${palette.slice(0, 12).join(', ')}. Prefer these colours.` : '',
    editing
      ? '- You are given the current selection as the same JSON. Return the WHOLE selection, changed as asked, keeping the parts the instruction does not mention.'
      : '',
    '',
    'If the request is not something you can draw, reply {"items": []} and nothing else.'
  ]
    .filter(Boolean)
    .join('\n')
}

/** The user message: the instruction, plus the selection when editing one. */
function userMessage(input: DrawGenerateInput): string {
  const prompt = input.prompt.trim()
  if (!input.selection) return `Draw this:\n\n${prompt}\n\nReturn the JSON now.`
  // Compact: the on-device window is 16k, and a selection of 200 shapes
  // pretty-printed would eat most of it before the instruction arrives.
  const current = JSON.stringify(input.selection)
  return [
    'Here is the current selection:',
    '',
    current.length > 40_000 ? `${current.slice(0, 40_000)}…` : current,
    '',
    '---',
    '',
    'Change it as follows:',
    prompt,
    '',
    'Return the whole selection as JSON now.'
  ].join('\n')
}

/** The first balanced JSON object in a reply, fences and chatter stripped. */
export function firstJsonObject(text: string): unknown {
  const t = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/i, '')
  const start = t.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < t.length; i++) {
    const c = t[i]!
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(t.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

const textOf = (m: Anthropic.Message): string =>
  m.content.map((b) => (b.type === 'text' ? b.text : '')).join('')

export async function generateDrawScene(input: DrawGenerateInput): Promise<DrawGenerateResult> {
  const prompt = (input?.prompt ?? '').trim()
  if (!prompt) return { ok: false, error: 'Describe the art you want before generating.' }

  const client = clientForKey(resolveAnthropicKey(), getModelClient)
  if (!client) {
    return {
      ok: false,
      needsKey: true,
      error: 'Add an Anthropic API key in Settings → AI, or turn on the on-device model, to generate art.'
    }
  }

  const system = systemPrompt(input.width, input.height, input.palette ?? [], !!input.selection)
  const send = (extra?: string): Promise<Anthropic.Message> =>
    client.messages.create({
      model: resolveModel('document'),
      max_tokens: GENERATION_TOKENS,
      system: extra ? `${system}\n\n${extra}` : system,
      messages: [{ role: 'user', content: userMessage(input) }]
    }) as Promise<Anthropic.Message>

  let raw: string
  try {
    raw = textOf(await send())
  } catch (e) {
    return { ok: false, error: `The model could not be reached: ${(e as Error).message}` }
  }
  if (raw.length > SCENE_LIMITS.jsonBytes) {
    return { ok: false, error: 'The model returned more than a drawing; nothing was applied.' }
  }

  let result = validateScene(firstJsonObject(raw))
  if (!result.scene) {
    // One retry, told exactly what was wrong — the same shape localClient uses
    // for its own contracts. A second failure is reported as a failure; it is
    // never dressed up as an empty success.
    const why = refusalReason(result.problems)
    try {
      raw = textOf(await send(`Your previous reply could not be used: ${why}. Return corrected JSON only.`))
    } catch (e) {
      return { ok: false, error: `The model could not be reached: ${(e as Error).message}` }
    }
    result = validateScene(firstJsonObject(raw))
  }
  if (!result.scene) {
    return { ok: false, error: `The model did not return art this app can draw — ${refusalReason(result.problems)}` }
  }
  return { ok: true, scene: result.scene, problems: result.problems }
}
