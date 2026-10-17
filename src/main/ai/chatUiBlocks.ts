// Sanitiser for the envelope's optional "blocks" array (Plexii P4) — the
// interactive UI blocks the model emits inside an answer. Dependency-free (no
// Electron, no DB, no SDK) so it unit-tests in isolation, same policy as
// chatJson.ts and chatQuestion.ts.
//
// The renderer trusts what leaves here completely, so this is the one gate:
// anything malformed is DROPPED, never repaired into something the model did
// not say. Caps keep a runaway response from flooding the panel.

import type { ChatUiBlock } from '@shared/types'

const MAX_BLOCKS = 6
const MAX_ITEMS = 8
const MAX_LABEL = 80
const MAX_TEXT = 240

function str(v: unknown, cap: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t) return null
  if (t.length <= cap) return t
  // Cut at a word boundary, never mid-word — "Googl…" in a rendered card is a
  // defect, not a truncation. Only fall back to the hard cut when the tail has
  // no space to break at (one unbroken token).
  const hard = t.slice(0, cap - 1)
  const lastSpace = hard.lastIndexOf(' ')
  const cut = lastSpace > cap - 41 ? hard.slice(0, lastSpace) : hard
  return cut.trimEnd() + '…'
}

function optStr(v: unknown, cap: number): string | undefined {
  const s = str(v, cap)
  return s ?? undefined
}

function sanitizeChoices(b: Record<string, unknown>, fallbackId: string): ChatUiBlock | null {
  const rawOptions = Array.isArray(b.options) ? b.options : []
  const options: Array<{ id: string; label: string; icon?: string; description?: string }> = []
  for (const raw of rawOptions.slice(0, MAX_ITEMS)) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const label = str(o.label, MAX_LABEL)
    if (!label) continue
    options.push({
      id: str(o.id, MAX_LABEL) ?? `o${options.length + 1}`,
      label,
      icon: optStr(o.icon, 64),
      description: optStr(o.description, MAX_TEXT)
    })
  }
  // A choice with fewer than two options is not a choice.
  if (options.length < 2) return null
  return {
    type: 'choices',
    id: str(b.id, MAX_LABEL) ?? fallbackId,
    prompt: optStr(b.prompt, MAX_TEXT),
    multi: b.multi === true ? true : undefined,
    options
  }
}

function sanitizeScale(b: Record<string, unknown>, fallbackId: string): ChatUiBlock | null {
  const label = str(b.label, MAX_LABEL)
  const min = typeof b.min === 'number' && Number.isFinite(b.min) ? Math.round(b.min) : null
  const max = typeof b.max === 'number' && Number.isFinite(b.max) ? Math.round(b.max) : null
  if (!label || min === null || max === null) return null
  // A degenerate or absurd range renders as a broken control; drop it.
  if (max <= min || max - min > 100) return null
  return {
    type: 'scale',
    id: str(b.id, MAX_LABEL) ?? fallbackId,
    label,
    min,
    max,
    minLabel: optStr(b.minLabel, MAX_LABEL),
    maxLabel: optStr(b.maxLabel, MAX_LABEL)
  }
}

function sanitizeIconRow(b: Record<string, unknown>): ChatUiBlock | null {
  const rawItems = Array.isArray(b.items) ? b.items : []
  const items: Array<{ icon: string; label: string }> = []
  for (const raw of rawItems.slice(0, MAX_ITEMS)) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const icon = str(o.icon, 64)
    const label = str(o.label, MAX_LABEL)
    if (!icon || !label) continue
    items.push({ icon, label })
  }
  if (items.length === 0) return null
  return { type: 'icon-row', items }
}

function sanitizeCards(b: Record<string, unknown>): ChatUiBlock | null {
  const rawItems = Array.isArray(b.items) ? b.items : []
  const items: Array<{ icon?: string; title: string; body?: string }> = []
  for (const raw of rawItems.slice(0, MAX_ITEMS)) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const title = str(o.title, MAX_LABEL)
    if (!title) continue
    items.push({ title, icon: optStr(o.icon, 64), body: optStr(o.body, MAX_TEXT) })
  }
  if (items.length === 0) return null
  return { type: 'cards', items }
}

// The prompt section teaching the model to emit blocks — beside its validator
// so the contract and the gate can never drift apart (the chatQuestion.ts
// pattern). Re-ruled 2026-08-22 (Caleb, program ruling R5): blocks are
// INTERACTIVE CONTROLS, never containers for an answer's substance.
// Informational answers are streamed markdown prose; anything inline that is
// not direct words must act when tapped. This reverses the earlier
// "prefer blocks over prose" default, which produced non-streaming,
// truncated card-grid answers.
export function uiBlocksSection(): string {
  return (
    '\n\nINTERACTIVE BLOCKS — controls, never content:\n' +
    'Your envelope may include an optional "blocks" array placed between "reply" and "actions". Blocks render as real UI inside your message, and every one of them DOES something when tapped — the tap comes back to you as the user\'s next message. They are never containers for the substance of an answer.\n' +
    'THE PROSE RULE: when the user asked a question — research, an overview, an explanation, a comparison — the "reply" field IS the answer. Write it in full flowing markdown (short headings, paragraphs, lists, tables where they genuinely help) with [n] citations inline; it streams to the user as you write it. NEVER move an informational answer\'s content into blocks: a 1-sentence reply beside content-stuffed cards reads as a broken answer.\n' +
    'The only four shapes:\n' +
    '{"type":"choices","id":"c1","prompt":"optional one-line lead-in","multi":false,"options":[{"id":"o1","label":"Podcast studio","icon":"mic","description":"optional one-liner"}]} — tappable options for a decision you are offering the user. Use "multi":true when several can apply at once.\n' +
    '{"type":"scale","id":"s1","label":"How ambitious should this be?","min":1,"max":10,"minLabel":"Safe","maxLabel":"Moonshot"} — a slider for a quantity or intensity; the committed value comes back as the user\'s next message.\n' +
    '{"type":"icon-row","items":[{"icon":"description","label":"Docs"},{"icon":"table_chart","label":"Tracker"}]} — a compact tappable row naming tools, apps, or steps; tapping one asks you to say more about it.\n' +
    '{"type":"cards","items":[{"icon":"rocket_launch","title":"Launch week","body":"one line"}]} — small tappable cards for OPTIONS or directions the user may want to drill into; a tap asks you to expand on that item. Cards are doors, not paragraphs: a one-line body at most, never the answer itself.\n' +
    'Block rules:\n' +
    '- Offering directions or choices → "choices". Asking for a quantity → "scale". Naming tools/apps/steps → "icon-row". Enumerable OPTIONS to explore further → "cards". Information the user asked for → full markdown prose in "reply", always.\n' +
    '- "icon" values are Google Material Symbols names ("rocket_launch","description","calendar_month","search","checklist","mic","table_chart","groups","edit_note","travel_explore").\n' +
    '- Blocks display and ask — they never create. Work widgets still require "actions" entries; a clarifying question you NEED answered before acting still uses the "question" object.\n' +
    '- At most 3 blocks per turn, at most 6 options/items each. Most answers need no blocks at all; omit the array rather than sending it empty.'
  )
}

// Validate a raw envelope "blocks" value into renderable blocks. Never throws.
export function validateChatUiBlocks(raw: unknown): ChatUiBlock[] {
  if (!Array.isArray(raw)) return []
  const out: ChatUiBlock[] = []
  for (const item of raw) {
    if (out.length >= MAX_BLOCKS) break
    if (!item || typeof item !== 'object') continue
    const b = item as Record<string, unknown>
    const fallbackId = `b${out.length + 1}`
    let block: ChatUiBlock | null = null
    switch (b.type) {
      case 'choices':
        block = sanitizeChoices(b, fallbackId)
        break
      case 'scale':
        block = sanitizeScale(b, fallbackId)
        break
      case 'icon-row':
        block = sanitizeIconRow(b)
        break
      case 'cards':
        block = sanitizeCards(b)
        break
      default:
        block = null
    }
    if (block) out.push(block)
  }
  return out
}
