// The AI text actions, in one place.
//
// The work widget menu's AI Assist submenu (renderer, lib/contextMenu/aiAssist.ts)
// and the native right-click menu on web pages (main, webContextMenu.ts) offer
// the same actions with the same words and the same instructions, so both read
// them from here. Every action runs through ai:transformText, which goes
// through the one routed client: on the device, or to cloud AI only when a key
// is set and the routing allows it, and the result says which engine answered.

export interface AiTextAction {
  id: string
  label: string
  /** The instruction sent to the model with the text. */
  instruction: string
}

// Direct one-tap rewrites (the order the work widget menu shows them in).
export const AI_DIRECT_ACTIONS: AiTextAction[] = [
  { id: 'expand', label: 'Expand', instruction: 'Expand this text with more detail and supporting points, keeping the same voice.' },
  { id: 'simplify', label: 'Simplify', instruction: 'Simplify this text so it is easy to read, removing jargon and shortening sentences.' },
  { id: 'summarise', label: 'Summarise', instruction: 'Summarise this text concisely, keeping the key points.' },
  { id: 'rewrite', label: 'Rewrite', instruction: 'Rewrite this text to read more clearly and naturally, preserving the meaning.' },
  { id: 'grammar', label: 'Fix Grammar', instruction: 'Fix the spelling, grammar and punctuation. Change nothing else.' },
  { id: 'clarity', label: 'Improve Clarity', instruction: 'Improve the clarity and flow without changing the meaning or adding new information.' },
  { id: 'continue', label: 'Continue Writing', instruction: 'Continue writing from where this text ends, in the same voice and style. Return the original text followed by the continuation.' }
]

// Reading actions: the result is about the text, it does not replace it. Only
// offered where nothing is written back (text read on a web page).
export const AI_READ_ACTIONS: AiTextAction[] = [
  {
    id: 'explain',
    label: 'Explain',
    instruction:
      'Explain this text in plain language: what it says and what it means. Use only what the text itself says; do not add facts, figures or names it does not contain.'
  }
]

export const AI_TONES = ['Professional', 'Casual', 'Friendly', 'Direct', 'Concise', 'Formal']
export const AI_LANGUAGES = ['English', 'Spanish', 'French', 'German', 'Japanese', 'Chinese']

export const toneInstruction = (tone: string): string => `Rewrite this text in a ${tone.toLowerCase()} tone, keeping the meaning.`
export const translateInstruction = (lang: string): string => `Translate this text into ${lang}. Return only the translation.`
export const CUSTOM_TONE_INSTRUCTION = 'Rewrite this text in the following tone: '
export const CUSTOM_LANGUAGE_INSTRUCTION = 'Translate this text into the following language: '

/** What the web page menu offers on selected text, in its order. Ids index AI_DIRECT_ACTIONS / AI_READ_ACTIONS. */
export const WEB_SELECTION_AI_ACTIONS = ['summarise', 'explain', 'simplify', 'rewrite'] as const

/** An action by id, from either list. */
export function aiTextAction(id: string): AiTextAction | null {
  return AI_DIRECT_ACTIONS.find((a) => a.id === id) ?? AI_READ_ACTIONS.find((a) => a.id === id) ?? null
}

/**
 * A web menu AI command id → what to run. Ids: an action id ("summarise"),
 * "tone:<Tone>", "translate:<Language>", "custom-tone", "custom-language",
 * "custom". Null for anything unknown (never guessed).
 */
export function resolveAiCommand(id: string): { label: string; instruction: string; awaitInput: boolean } | null {
  if (id === 'custom') return { label: 'Custom prompt', instruction: '', awaitInput: true }
  if (id === 'custom-tone') return { label: 'Custom tone', instruction: CUSTOM_TONE_INSTRUCTION, awaitInput: true }
  if (id === 'custom-language') return { label: 'Translate', instruction: CUSTOM_LANGUAGE_INSTRUCTION, awaitInput: true }
  if (id.startsWith('tone:')) {
    const tone = id.slice(5)
    return AI_TONES.includes(tone) ? { label: `Tone ${tone}`, instruction: toneInstruction(tone), awaitInput: false } : null
  }
  if (id.startsWith('translate:')) {
    const lang = id.slice(10)
    return AI_LANGUAGES.includes(lang) ? { label: `Translate to ${lang}`, instruction: translateInstruction(lang), awaitInput: false } : null
  }
  const a = aiTextAction(id)
  return a ? { label: a.label, instruction: a.instruction, awaitInput: false } : null
}
