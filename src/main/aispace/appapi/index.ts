// Direct app-API integrations (SPEC-CONNECTIONS.md §5). See adapter.ts for the
// operation model, invoke.ts for how a call runs, notion.ts for the first
// adapter. Webhooks are out of scope for this release; adapter.ts says where
// they plug in.

import type { OperationDef } from '@shared/aispace/connections'
import { operationDefsFor, type AppAdapter } from './adapter'
import { notionAdapter } from './notion'

export * from './adapter'
export { invokeOperation, verifyConnection, parseRetryAfter, MAX_ATTEMPTS, MAX_RETRY_WAIT_MS, type InvokeOptions } from './invoke'
export { validateJson, assertSupportedSchema, describeErrors, type SchemaError, type ValidationResult } from './jsonSchema'
export { RateLimiter, defaultRateLimiter, type TakeResult } from './rateLimit'
export { notionAdapter, createNotionAdapter, normaliseNotionId, NOTION_ORIGIN, NOTION_VERSION, NOTION_LIMITS } from './notion'

// Catalogue adapters by provider id (catalogue.ts PROVIDERS entries of kind 'app_api').
export const APP_ADAPTERS: Readonly<Record<string, AppAdapter>> = Object.freeze({ notion: notionAdapter })

export function appAdapterFor(providerId: string): AppAdapter | undefined {
  return Object.prototype.hasOwnProperty.call(APP_ADAPTERS, providerId) ? APP_ADAPTERS[providerId] : undefined
}

// The operation records a connection to this provider offers (for ais_operations).
export function appOperationDefs(providerId: string, connectionId: string | null): OperationDef[] {
  const a = appAdapterFor(providerId)
  return a ? operationDefsFor(a, connectionId) : []
}
