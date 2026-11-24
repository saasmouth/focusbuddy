// The models each provider's connections offer. Claude ids come from the
// router (CONNECTION_CLAUDE_MODELS) so they move with it; other providers'
// lists live in the shared catalogue.

import type { ModelInfo, ProviderDefinition } from '@shared/aispace/connections'
import { PROVIDERS, providerById } from '@shared/aispace/catalogue'
import { CONNECTION_CLAUDE_MODELS } from '../ai/modelRouting'

export function providerModels(providerId: string): ModelInfo[] {
  if (providerId === 'anthropic') {
    return CONNECTION_CLAUDE_MODELS.map((m) => ({ id: m.id, label: m.label, modalities: ['text', 'image'], usdPerMInput: null, usdPerMOutput: null, maxOutputTokens: m.maxOutputTokens }))
  }
  return providerById(providerId)?.models ?? []
}

export function providerWithModels(def: ProviderDefinition): ProviderDefinition {
  return { ...def, models: providerModels(def.id) }
}

export function providersWithModels(): ProviderDefinition[] {
  return PROVIDERS.map(providerWithModels)
}
