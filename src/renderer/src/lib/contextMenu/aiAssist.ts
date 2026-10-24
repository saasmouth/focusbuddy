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
  AI_LANGUAGES,
  AI_MENU_LABELS,
  AI_TEXT_ACTIONS,
  AI_TONES,
  CUSTOM_LANGUAGE_INSTRUCTION,
  CUSTOM_TONE_INSTRUCTION,
  toneInstruction,
  translateInstruction,
} from '@shared/aiTextActions'

/** The eight, in menu order. Exported so the guard can hold the set to its source. */
export const AI_ACTION_SET = AI_TEXT_ACTIONS

// Returns null when there is no text to work on, so the row is absent rather
// than dead.
export function buildAiAssistContribution(ctx: MenuContext): MenuContribution | null {
  if (!hasWorkableText(ctx)) return null

  const direct: MenuContribution[] = AI_ACTION_SET.map((a, i) => ({
    id: `core/ai/${a.id}`,
    priority: i,
    label: a.label,
    onSelect: (c) => runAiAssist(c, a.label, a.instruction)
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
