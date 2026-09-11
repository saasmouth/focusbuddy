// Build-time constants injected by `define`, declared once for every project
// that compiles against them.
//
// electron.vite.config.ts inlines this into the main and preload bundles and
// vite.web.config.ts into the browser bundle, both from the same package.json
// version -- so code that reads it works on either runtime. It is NOT defined
// under vitest, which compiles no config, so read it through the
// `typeof __APP_VERSION__ !== 'undefined'` guard used at every other call site.
declare const __APP_VERSION__: string
