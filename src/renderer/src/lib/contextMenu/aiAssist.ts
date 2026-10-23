// The AI assist submenu (E-12: ONE action set of eight, everywhere). The set is
// @shared/aiTextActions (WP3's): the seven rewrites in AI_DIRECT_ACTIONS plus
// the reading action in AI_READ_ACTIONS (Explain), in that order, then Change
// tone ▸, Translate ▸ and Custom prompt…. Nothing is written without the
// preview (AiAssistPreview): Explain's result can be copied or applied there
// like any other.
//
// The one sanctioned third level: Change tone and Translate need leaf children.

import type { MenuContribution, MenuContext } from './types'
import { runAiAssist, hasWorkableText } from './actions'
import { AI_ASSIST_LABEL } from './labels'
import {
  AI_DIRECT_ACTIONS,
  AI_READ_ACTIONS,
  AI_LANGUAGES,
  AI_TONES,
  CUSTOM_LANGUAGE_INSTRUCTION,
  CUSTOM_TONE_INSTRUCTION,
  toneInstruction,
  translateInstruction
} from '@shared/aiTextActions'

/** The eight, in menu order. Exported so the guard can hold the set to its source. */
export const AI_ACTION_SET = [...AI_DIRECT_ACTIONS, ...AI_READ_ACTIONS]

/**
 * Sentence case for a label read from the shared set (§9.4): "Fix Grammar" →
 * "Fix grammar". The set's own labels are WP3's to fix (reported); until they
 * are, the menu shows them in sentence case. Idempotent, so it stays harmless
 * once the source is fixed.
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
    label: 'Change tone',
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
        label: 'Custom tone…',
        onSelect: (c) => runAiAssist(c, 'Custom tone', CUSTOM_TONE_INSTRUCTION, true)
      }
    ]
  }

  const translate: MenuContribution = {
    id: 'core/ai/translate',
    priority: 21,
    label: 'Translate',
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
        label: 'Custom language…',
        onSelect: (c) => runAiAssist(c, 'Translate', CUSTOM_LANGUAGE_INSTRUCTION, true)
      }
    ]
  }

  const custom: MenuContribution = {
    id: 'core/ai/custom',
    separatorBefore: true,
    priority: 30,
    label: 'Custom prompt…',
    icon: 'auto_awesome',
    onSelect: (c) => runAiAssist(c, 'Custom prompt', '', true)
  }

  return {
    id: 'core/ai-assist',
    group: 'plexii',
    priority: 30,
    label: AI_ASSIST_LABEL,
    icon: 'auto_awesome',
    children: [...direct, changeTone, translate, custom]
  }
}
