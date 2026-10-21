// AI provider routing in the cloud runtime: there is no device to route to.
//
// On the desktop, src/main/ai/local/providerRouter.ts decides for every AI
// request whether it runs on the on-device model or goes to the cloud, and
// holds a per-request "cloud is allowed" grant in Node's AsyncLocalStorage
// (node:async_hooks). A browser tab has neither half: no on-device model, and no
// AsyncLocalStorage -- importing the desktop module is what broke `web:build`
// ("AsyncLocalStorage" is not exported by "__vite-browser-external").
//
// The Worker reaches the router only through shared data-layer code (the live
// Resume summary, embeddings, the local-model status probe), so this variant
// answers exactly what the desktop router answers under its own defaults when
// nothing has been wired up -- AI source "auto", no feature routes, no
// on-device model:
//
//   - nothing is local-only, because nothing can run locally;
//   - a key makes a plain cloud client, and no key makes none. The browser
//     never holds a provider key (see ./settingsStore.ts), so in practice every
//     caller here takes its "no key" path, which is an honest degrade;
//   - the local runtime reports "not installed", and asking it for an engine
//     fails with a message naming why.
//
// Only the names the Worker graph imports are provided. A new import of some
// other name fails the build by name, and tests/unit/webBundleGraph.test.ts
// fails first -- which is the point: decide what that name means in a browser
// before shipping it.
import type Anthropic from '@anthropic-ai/sdk'
import type * as Desktop from '../../../main/ai/local/providerRouter'
import type { LocalRuntime } from '../../../main/ai/local/providerRouter'

const NO_DEVICE_MODEL =
  'AI on this device is a desktop-app capability. The browser has no on-device model; use the desktop app, or Plexii AI credits.'

/** Same name as the desktop error, so callers that match on it behave the same. */
export class LocalModelMissingError extends Error {
  constructor() {
    super(NO_DEVICE_MODEL)
    this.name = 'LocalModelMissingError'
  }
}

/** Never: the browser cannot run a model, so nothing is held to the device. */
export function localOnlyActive(): boolean {
  return false
}

/** A plain cloud client for a key, or null with no key -- the desktop router's answer with no local routing. */
export function clientForKey(key: string | null, makeCloud: (key: string) => Anthropic): Anthropic | null {
  return key ? makeCloud(key) : null
}

const runtime: LocalRuntime = {
  engine: async () => {
    throw new LocalModelMissingError()
  },
  modelLabel: () => 'none',
  installed: () => false
}

export function getLocalRuntime(): LocalRuntime {
  return runtime
}

// Signature check against the desktop module: if one of these drifts there,
// typecheck:webruntime fails here instead of the browser misbehaving quietly.
// Type-only, so nothing of the desktop module is bundled.
;({ localOnlyActive, clientForKey, getLocalRuntime }) satisfies Pick<
  typeof Desktop,
  'localOnlyActive' | 'clientForKey' | 'getLocalRuntime'
>
