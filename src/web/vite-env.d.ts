/// <reference types="vite/client" />

// Injected by vite.web.config.ts's `define` from package.json, the same way
// electron.vite.config.ts injects it for the desktop renderer. Declared here
// because the browser runtime is its own compilation unit and does not see
// src/renderer/src/vite-env.d.ts.
declare const __APP_VERSION__: string
