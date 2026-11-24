// The credential broker (SPEC-CONNECTIONS.md §3 "Route calls through a broker
// that resolves secrets at execution time").
//
// A caller never holds a secret longer than one call: `withSecret` reads it
// from the vault, hands it to the function, and redacts it from anything that
// comes back as an error. Models, threads, payloads, exports and audit entries
// never receive it, because nothing outside this function's callback sees it.
//
// New calls stop the moment a connection is paused, disconnected or needs
// reconnecting (§3 "On disconnect, block new calls immediately").

import type { Connection } from '@shared/aispace/connections'
import { BLOCKING_STATUSES, CONNECTION_STATUS_LABEL, redactSecrets } from '@shared/aispace/connections'
import type { Vault } from './vault'
import { vaultRef } from './vault'

export class ConnectionBlockedError extends Error {
  constructor(readonly connection: Pick<Connection, 'id' | 'alias' | 'status'>) {
    super(`${connection.alias}: ${CONNECTION_STATUS_LABEL[connection.status]}. New calls are stopped.`)
    this.name = 'ConnectionBlockedError'
  }
}

export class MissingSecretError extends Error {
  constructor(readonly connectionId: string) {
    super('This connection has no stored credential. Reconnect it.')
    this.name = 'MissingSecretError'
  }
}

export type BrokerPurpose = 'verify' | 'run' | 'invoke' | 'poll' | 'cancel'

export interface Broker {
  withSecret<T>(connection: Connection, purpose: BrokerPurpose, fn: (secret: string) => Promise<T>): Promise<T>
  store(connectionId: string, secret: string): void
  forget(connectionId: string): void
  hasSecret(connectionId: string): boolean
}

export function createBroker(vault: Vault): Broker {
  return {
    async withSecret(connection, purpose, fn) {
      // Verification and polling/cancelling work already in flight are allowed
      // on a connection that needs attention; starting new work is not.
      const startsWork = purpose === 'run' || purpose === 'invoke'
      if (startsWork && BLOCKING_STATUSES.has(connection.status)) throw new ConnectionBlockedError(connection)
      if (connection.status === 'disconnected') throw new ConnectionBlockedError(connection)
      const secret = vault.get(vaultRef.key(connection.id))
      if (!secret) throw new MissingSecretError(connection.id)
      try {
        return await fn(secret)
      } catch (e) {
        // Belt and braces: whatever an adapter throws, the secret itself never
        // leaves in an error message.
        if (e instanceof Error) {
          const msg = e.message.split(secret).join('[redacted]')
          if (msg !== e.message) e.message = msg
          e.message = redactSecrets(e.message)
        }
        throw e
      }
    },
    store(connectionId, secret) {
      vault.set(vaultRef.key(connectionId), secret.trim())
    },
    forget(connectionId) {
      vault.clear(vaultRef.key(connectionId))
      vault.clear(vaultRef.oauth(connectionId))
    },
    hasSecret(connectionId) {
      return vault.has(vaultRef.key(connectionId)) || vault.has(vaultRef.oauth(connectionId))
    }
  }
}
