// The AI Assist submenu (E-12: ONE action set of eight, everywhere). The set is
// @shared/aiTextActions (WP3's): AI_TEXT_ACTIONS, the seven rewrites plus the
// reading action (Explain), in that order, then Change tone ▸, Translate ▸ and
// Custom prompt…, with the submenu's own words from AI_MENU_LABELS. Nothing is
// written without the preview (AiAssistPreview): Explain's result can be
// copied or applied there like any other.
//
// The one sanctioned third level: Change tone and Translate need leaf children.

import type { MenuContribution, MenuContext } from './types'
import { runAiAssist, hasWorkableText } from './actions'
import {
  AI_DIRECT_ACTIONS,
  AI_READ_ACTIONS,
  AI_LANGUAGES,
  AI_TONES,
  CUSTOM_LANGUAGE_INSTRUCTION,
  CUSTOM_TONE_INSTRUCTION,
  toneInstruction,
  translateInstruction,
  type AiTextAction
} from '@shared/aiTextActions'

// TODO(WP3 aiTextActions, ctx-wp3-41 0e6b703b): import AI_TEXT_ACTIONS and
// AI_MENU_LABELS from @shared/aiTextActions once that branch is merged, and
// delete these two copies. They are the same list and the same words; WP3's
// labels are already sentence case, so sentenceCase() below becomes a no-op.
const AI_TEXT_ACTIONS: readonly AiTextAction[] = [...AI_DIRECT_ACTIONS, ...AI_READ_ACTIONS]
const AI_MENU_LABELS = {
  aiAssist: 'AI Assist',
  changeTone: 'Change tone',
  translate: 'Translate',
  customTone: 'Custom tone…',
  customLanguage: 'Custom language…',
  customPrompt: 'Custom prompt…'
} as const

/** The eight, in menu order. Exported so the guard can hold the set to its source. */
export const AI_ACTION_SET = AI_TEXT_ACTIONS

/**
 * Sentence case for a label read from the shared set (§9.4): "Fix Grammar" →
 * "Fix grammar". Only needed until WP3's sentence-case labels are merged;
 * idempotent, so harmless after.
 */
export function sentenceCase(label: string): string {
  const [first, ...rest] = label.split(' ')
  return [first, ...rest.map((w) => (/^[A-Z][a-z]+$/.test(w) ? w.toLowerCase() : w))].join(' ')
}

// Returns null when there is no text to work on, so the row is absent rather
// than dead.
export function buildAiAssistContribution(ctx: MenuContext): MenuContribution | null {
  if (!hasWorkableText(ctx)) return null

  const direct: MenuContribution[] = AI_ACTION_SET.map((a, i) => ({
    id: `core/ai/${a.id}`,
    priority: i,
    label: sentenceCase(a.label),
    onSelect: (c) => runAiAssist(c, sentenceCase(a.label), a.instruction)
  }))

  const changeTone: MenuContribution = {
    id: 'core/ai/tone',
    separatorBefore: true,
    priority: 20,
    label: AI_MENU_LABELS.changeTone,
    icon: 'campaign',
    children: [
      ...AI_TONES.map<MenuContribution>((tone) => ({
        id: `core/ai/tone/${tone.toLowerCase()}`,
        priority: 0,
        label: tone,
        onSelect: (c) => runAiAssist(c, `Tone ${tone}`, toneInstruction(tone))
      })),
      {
        id: 'core/ai/tone/custom',
        separatorBefore: true,
        priority: 99,
        label: AI_MENU_LABELS.customTone,
        onSelect: (c) => runAiAssist(c, 'Custom tone', CUSTOM_TONE_INSTRUCTION, true)
      }
    ]
  }

  const translate: MenuContribution = {
    id: 'core/ai/translate',
    priority: 21,
    label: AI_MENU_LABELS.translate,
    icon: 'translate',
    children: [
      ...AI_LANGUAGES.map<MenuContribution>((lang) => ({
        id: `core/ai/translate/${lang.toLowerCase()}`,
        priority: 0,
        label: lang,
        onSelect: (c) => runAiAssist(c, `Translate to ${lang}`, translateInstruction(lang))
      })),
      {
        id: 'core/ai/translate/custom',
        separatorBefore: true,
        priority: 99,
        label: AI_MENU_LABELS.customLanguage,
        onSelect: (c) => runAiAssist(c, 'Translate', CUSTOM_LANGUAGE_INSTRUCTION, true)
      }
    ]
  }

  const custom: MenuContribution = {
    id: 'core/ai/custom',
    separatorBefore: true,
    priority: 30,
    label: AI_MENU_LABELS.customPrompt,
    icon: 'auto_awesome',
    onSelect: (c) => runAiAssist(c, 'Custom prompt', '', true)
  }

  return {
    id: 'core/ai-assist',
    group: 'plexii',
    priority: 30,
    label: AI_MENU_LABELS.aiAssist,
    icon: 'auto_awesome',
    children: [...direct, changeTone, translate, custom]
  }
}
