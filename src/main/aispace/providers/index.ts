// Model adapters for Plexii Connections. See types.ts for the contract.

import { createAnthropicAdapter } from './anthropic'
import type { AdapterOptions } from './http'
import { createOpenAIAdapter } from './openai'
import type { ModelAdapter, ModelProviderId } from './types'

export * from './types'
export type { AdapterOptions } from './http'
export { createAnthropicAdapter, classifyAnthropicError, ANTHROPIC_DEFAULT_BASE, ANTHROPIC_VERSION } from './anthropic'
export {
  createOpenAIAdapter,
  classifyOpenAIError,
  isResponseId,
  OPENAI_DEFAULT_BASE,
  RESPONSE_ID_PATTERN,
  BACKGROUND_UNTESTED_DETAIL
} from './openai'

export const MODEL_PROVIDER_IDS: readonly ModelProviderId[] = ['anthropic', 'openai']

export function isModelProviderId(id: string): id is ModelProviderId {
  return (MODEL_PROVIDER_IDS as readonly string[]).includes(id)
}

export function createModelAdapter(providerId: ModelProviderId, opts: AdapterOptions = {}): ModelAdapter {
  return providerId === 'anthropic' ? createAnthropicAdapter(opts) : createOpenAIAdapter(opts)
}
