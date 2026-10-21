// clipper2-wasm 0.4.0 declares its types at dist/es/clipper2z.d.ts but ships
// them at dist/clipper2z.d.ts; this points the ES entry at a minimal shape.
declare module 'clipper2-wasm/dist/es/clipper2z.js' {
  const Clipper2Z: (moduleArg?: Record<string, unknown>) => Promise<unknown>
  export default Clipper2Z
}
