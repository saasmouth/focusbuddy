// What Print… prints: each editor's live document, bound to its DocumentOps.
//
// The ops are made by the HOST (createDocumentOps), which knows which document
// is on screen but not what is in the editor's memory: Write's live HTML and
// page setup, a deck's slides inside the save debounce, a sheet's computed
// cells. So each editor hands the ops a print SOURCE, a function that builds
// the same request its Download ▸ PDF sends (shared/printJob.ts), and
// DocumentOps.print() asks the source bound to it.
//
// Keyed by the ops object itself (a WeakMap), never by a document id: an
// editor still holds no id, and a host that drops its ops drops the binding.

import { useEffect, useRef } from 'react'
import type { PrintRequest } from '@shared/printJob'
import type { DocumentOps } from './documentOps'

type Source = () => PrintRequest | null

const SOURCES = new WeakMap<DocumentOps, Source>()

/** The source bound to these ops, if an editor has bound one. */
export function printSourceOf(ops: DocumentOps): Source | undefined {
  return SOURCES.get(ops)
}

/** Bind a print source to ops; returns the unbind (only removes its own binding). */
export function bindPrintSource(ops: DocumentOps, source: Source): () => void {
  SOURCES.set(ops, source)
  lastBound.set(ops.id, ops)
  return () => {
    if (SOURCES.get(ops) === source) SOURCES.delete(ops)
  }
}

/**
 * An editor's hook: bind `build` to the ops while mounted. `build` is read
 * through a ref, so it always sees the editor's latest state without rebinding.
 */
export function usePrintSource(ops: DocumentOps | undefined, build: () => PrintRequest | null): void {
  const ref = useRef(build)
  ref.current = build
  useEffect(() => {
    if (!ops || !ops.print) return
    return bindPrintSource(ops, () => ref.current())
  }, [ops])
}

// ── e2e seam ──────────────────────────────────────────────────────────────────
// The menu row and ⌘P are wired by the app registries (documentCommands); until
// then, and for driving print without a menu, the last ops bound per document
// are reachable as window.__fbPrint. It calls the same ops.print() a menu would.
const lastBound = new Map<string, DocumentOps>()

;(window as unknown as { __fbPrint?: unknown }).__fbPrint = {
  /** Documents whose editor has bound a print source, newest last. */
  bound: (): Array<{ id: string; canPrint: boolean; canExportPdf: boolean }> =>
    [...lastBound.values()].map((o) => ({ id: o.id, canPrint: !!o.print && SOURCES.has(o), canExportPdf: !!o.exportPdf })),
  /** Run Print… for a bound document (the newest when no id is given). */
  print: async (id?: string): Promise<boolean> => {
    const ops = id ? lastBound.get(id) : [...lastBound.values()].pop()
    if (!ops?.print) return false
    await ops.print()
    return true
  },
  /** Run Cells' Download ▸ PDF (ops.exportPdf) for a bound document. */
  exportPdf: async (id: string): Promise<boolean> => {
    const ops = lastBound.get(id)
    if (!ops?.exportPdf) return false
    await ops.exportPdf()
    return true
  }
}
