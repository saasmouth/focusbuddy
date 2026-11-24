// Setup recovery for Add connection (SPEC-CONNECTIONS.md §2 "Support setup
// recovery when a user closes the provider tab halfway through").
//
// Two kinds of draft exist. Main keeps one for an MCP server waiting for
// browser sign-in (listDrafts/deleteDraft). This one is the renderer's own:
// where the person was in the steps and what they had typed, so closing the
// dialog loses nothing. It NEVER holds a key or token; those are typed again.

export interface LocalDraft {
  v: 1
  step: 1 | 2 | 3 | 4 | 5
  providerId: string | null
  mcpUrl: string
  workspaceId: string | null
  alias: string
  payer: string
  defaultModel: string | null
  draftParentId: string
  connectionId: string | null
  serverDraftId: string | null
  updatedAt: number
}

const KEY = 'fb.aispace.connectDraft.v1'

export function emptyDraft(): LocalDraft {
  return { v: 1, step: 1, providerId: null, mcpUrl: '', workspaceId: null, alias: '', payer: '', defaultModel: null, draftParentId: '', connectionId: null, serverDraftId: null, updatedAt: Date.now() }
}

export function readLocalDraft(): LocalDraft | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const d = JSON.parse(raw) as Partial<LocalDraft>
    if (d?.v !== 1 || !d.providerId) return null
    return { ...emptyDraft(), ...d } as LocalDraft
  } catch {
    return null
  }
}

export function writeLocalDraft(d: LocalDraft): void {
  try {
    // Only the fields above, by construction: nothing secret is in the shape.
    const safe: LocalDraft = {
      v: 1,
      step: d.step,
      providerId: d.providerId,
      mcpUrl: d.mcpUrl,
      workspaceId: d.workspaceId,
      alias: d.alias,
      payer: d.payer,
      defaultModel: d.defaultModel,
      draftParentId: d.draftParentId,
      connectionId: d.connectionId,
      serverDraftId: d.serverDraftId,
      updatedAt: Date.now()
    }
    localStorage.setItem(KEY, JSON.stringify(safe))
  } catch {
    /* storage unavailable: the dialog still works, it just can't resume */
  }
}

export function clearLocalDraft(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* storage unavailable */
  }
}
