/// <reference types="vite/client" />

// Build-time inject from electron-vite's `define` (electron.vite.config.ts).
// Source: plexii/package.json "version" field. Bump there on every
// release and every consumer of __APP_VERSION__ updates automatically.
declare const __APP_VERSION__: string

// Project-specific env vars surfaced via import.meta.env.* — extends
// vite/client's ImportMetaEnv so the renderer code gets typed values.
interface ImportMetaEnv {
  // Optional toggle that overrides the dev/prod default for the
  // signaling backend. "true" forces RemoteMatcher; "false" forces
  // LocalMockMatcher. Anything else (incl. unset) falls back to
  // !import.meta.env.DEV.
  readonly VITE_USE_REMOTE_SIGNAL?: 'true' | 'false'
  // Origins for the hosted signaling service when running against a
  // real backend. Defaults to https://signal.fb.app + wss://signal.fb.app/ws.
  readonly VITE_SIGNAL_HTTP_URL?: string
  readonly VITE_SIGNAL_WS_URL?: string
  // Base URL of the hosted share viewer. Used to build the share links the
  // user copies. Unset, it follows ACTIVE.viewer in shared/productDomains.ts
  // (https://view.plexiidesk.com) rather than a literal repeated here.
  readonly VITE_VIEWER_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
