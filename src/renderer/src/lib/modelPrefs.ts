import { useEffect, useState } from 'react'
import type { AIPurpose, ModelMode } from '@shared/types'

// Model picker preference — persisted to localStorage and synced to the main process
// (which is where the actual model ID is resolved per AI call).

const KEY = 'fb.model.mode'

export interface ModelOption {
  value: ModelMode
  label: string
  blurb: string
  costTier: '$' | '$$' | '$$$' | 'mixed'
}

export const MODEL_OPTIONS: ModelOption[] = [
  {
    value: 'auto',
    label: 'Auto',
    blurb: 'Smart routing — Haiku for summaries, Sonnet for reasoning. Best price-quality balance.',
    costTier: 'mixed'
  },
  {
    value: 'haiku',
    label: 'Haiku 4.5',
    blurb: 'Fastest and cheapest — great for chat and summaries, lighter on deep reasoning.',
    costTier: '$'
  },
  {
    value: 'sonnet',
    label: 'Sonnet 4.6',
    blurb: 'The workhorse — strong reasoning, good speed. Locked default for every action.',
    costTier: '$$'
  },
  {
    value: 'opus',
    label: 'Opus 4.7',
    blurb: 'Most capable — deeper reasoning, longer plans. Slowest and most expensive.',
    costTier: '$$$'
  }
]

// Auto-routing table — must stay in sync with main/ai/modelRouting.ts AUTO_ROUTING.
// Used by the picker UI to show users "what Auto will do" per action.
export const AUTO_ROUTING_DISPLAY: Record<AIPurpose, { model: string; cost: string }> = {
  chat: { model: 'Sonnet', cost: '$$' },
  welcome: { model: 'Sonnet', cost: '$$' },
  setup: { model: 'Sonnet', cost: '$$' },
  resume: { model: 'Sonnet', cost: '$$' },
  trail_summary: { model: 'Haiku', cost: '$' },
  body_double: { model: 'Haiku', cost: '$' },
  smart_stack: { model: 'Sonnet', cost: '$$' },
  living_page: { model: 'Haiku', cost: '$' },
  wire_transform: { model: 'Haiku', cost: '$' },
  desk_agent: { model: 'Sonnet', cost: '$$' },
  command_route: { model: 'Haiku', cost: '$' },
  intent_classify: { model: 'Haiku', cost: '$' },
  capture_cleanup: { model: 'Haiku', cost: '$' },
  document: { model: 'Sonnet', cost: '$$' },
  doc_rewrite: { model: 'Sonnet', cost: '$$' },
  tone_profile: { model: 'Haiku', cost: '$' },
  email_reply_draft: { model: 'Sonnet', cost: '$$' },
  mail_triage: { model: 'Haiku', cost: '$' },
  file_tag: { model: 'Haiku', cost: '$' },
  meeting_end: { model: 'Sonnet', cost: '$$' },
  agent_step: { model: 'Sonnet', cost: '$$' },
  memory_extract: { model: 'Haiku', cost: '$' },
  browser_agent: { model: 'Sonnet', cost: '$$' },
  // Mirrors AUTO_ROUTING in main/ai/modelRouting.ts, where custom_widget is OPUS.
  custom_widget: { model: 'Opus', cost: '$$$' }
}

function readFromStorage(): ModelMode {
  if (typeof localStorage === 'undefined') return 'auto'
  const raw = localStorage.getItem(KEY)
  if (raw === 'auto' || raw === 'haiku' || raw === 'sonnet' || raw === 'opus') return raw
  return 'auto'
}

let cached: ModelMode = readFromStorage()
const subscribers = new Set<(m: ModelMode) => void>()

// Push to main process so AI calls pick up the new mode. Fire-and-forget.
function pushToMain(mode: ModelMode): void {
  try {
    void window.api.model.set(mode)
  } catch {
    // ignore — early boot before preload
  }
}

// Apply on module load so main starts in sync with the saved pref
if (typeof window !== 'undefined') {
  pushToMain(cached)
}

export function getModelMode(): ModelMode {
  return cached
}

export function setModelMode(mode: ModelMode): void {
  cached = mode
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(KEY, mode)
    } catch {
      // ignore quota
    }
  }
  pushToMain(mode)
  subscribers.forEach((cb) => cb(mode))
}

export function useModelMode(): [ModelMode, (m: ModelMode) => void] {
  const [m, setM] = useState<ModelMode>(cached)
  useEffect(() => {
    const cb = (next: ModelMode): void => setM(next)
    subscribers.add(cb)
    return () => {
      subscribers.delete(cb)
    }
  }, [])
  return [m, setModelMode]
}
