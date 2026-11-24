// IPC for AI Space + Connections ('aispace:*'). Registered by
// registerIpcHandlers. Secrets cross this boundary in ONE direction only: a
// key or token is sent here once to be stored; nothing here ever returns one.

import { ipcMain, shell, dialog, BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { getAiSpace } from './index'
import type { AiTask, OutputKind, RecordRef, ReviewState, RunStatus, SuggestionStatus, WorkspaceKind, AgentRole, ProjectAuthority } from '@shared/aispace/model'
import type { ApprovalLevel, ConnectionKind, GrantAction } from '@shared/aispace/connections'
import { validateEndpoint } from '@shared/aispace/netPolicy'

const svc = async () => (await getAiSpace()).svc
const tools = async () => (await getAiSpace()).tools
const mcp = async () => (await getAiSpace()).mcp

export function registerAiSpaceIpc(): void {
  // ── Context and Home ────────────────────────────────────────────────────────
  ipcMain.handle('aispace:getContext', async () => (await svc()).getContext())
  ipcMain.handle('aispace:setContext', async (_e, workspaceIds: string[]) => (await svc()).setContext(workspaceIds))
  ipcMain.handle('aispace:createWorkspace', async (_e, kind: string, name: string) => (await svc()).createWorkspace(kind as WorkspaceKind, name))
  ipcMain.handle('aispace:renameWorkspace', async (_e, id: string, name: string) => {
    ;(await svc()).store.renameWorkspace(id, name)
    return (await svc()).getContext()
  })
  ipcMain.handle('aispace:home', async () => (await svc()).home())
  ipcMain.handle('aispace:markHomeViewed', async () => (await svc()).markHomeViewed())
  ipcMain.handle('aispace:search', async (_e, query: string, filter?: { projectId?: string; type?: 'project' | 'task' | 'thread' | 'output' | 'decision'; provider?: string }) => (await svc()).search(query, filter ?? {}))

  // ── Projects ────────────────────────────────────────────────────────────────
  ipcMain.handle('aispace:createProject', async (_e, input: { workspaceId?: string; title: string; goal?: string; brief?: string; deskId?: string | null; roomId?: string | null }) => (await svc()).createProject(input))
  ipcMain.handle('aispace:projectForDesk', async (_e, deskId: string) => (await svc()).projectForDesk(deskId))
  ipcMain.handle('aispace:projectView', async (_e, projectId: string) => (await svc()).projectView(projectId))
  ipcMain.handle('aispace:markProjectViewed', async (_e, projectId: string) => (await svc()).markProjectViewed(projectId))
  ipcMain.handle('aispace:updateProject', async (_e, projectId: string, patch: { title?: string; goal?: string; budgetLimitMinor?: number | null; authority?: ProjectAuthority }) => {
    const s = await svc()
    s.inContext(projectId)
    return s.store.updateProject(projectId, patch)
  })
  ipcMain.handle('aispace:archiveProject', async (_e, projectId: string) => {
    const s = await svc()
    s.inContext(projectId)
    s.store.archiveProject(projectId)
    return { ok: true }
  })
  ipcMain.handle('aispace:impact', async (_e, projectId: string, opts?: { asOf?: number | null; since?: number | null }) => (await svc()).impact(projectId, opts ?? {}))
  ipcMain.handle('aispace:setProjectDefault', async (_e, projectId: string, connectionId: string | null, model: string | null) => (await svc()).setProjectDefault(projectId, connectionId, model))

  // ── Tasks and agents ────────────────────────────────────────────────────────
  ipcMain.handle('aispace:createTask', async (_e, input: { projectId: string; title: string; outcome?: string; deliverableKind?: OutputKind | null; assignee?: string | null; parentTaskId?: string | null; scheduledAt?: number | null; dependsOn?: string[] }) => {
    const s = await svc()
    s.inContext(input.projectId)
    return s.store.createTask(input)
  })
  ipcMain.handle('aispace:updateTask', async (_e, id: string, patch: Partial<Pick<AiTask, 'title' | 'outcome' | 'deliverableKind' | 'status' | 'assignee' | 'scheduledAt' | 'sortOrder' | 'parentTaskId'>>) => {
    const s = await svc()
    const t = s.store.getTask(id)
    if (!t) throw new Error('Task not found.')
    s.inContext(t.projectId)
    return s.store.updateTask(id, patch)
  })
  ipcMain.handle('aispace:setTaskDeps', async (_e, id: string, dependsOn: string[]) => {
    const s = await svc()
    const t = s.store.getTask(id)
    if (!t) throw new Error('Task not found.')
    s.inContext(t.projectId)
    return s.store.setDependencies(id, dependsOn)
  })
  ipcMain.handle('aispace:createAgent', async (_e, input: { projectId: string; name: string; role: string; connectionId?: string | null; model?: string | null; instructions?: string }) => {
    const s = await svc()
    s.inContext(input.projectId)
    return s.store.createAgent({ ...input, role: input.role as AgentRole })
  })
  ipcMain.handle('aispace:updateAgent', async (_e, id: string, patch: { name?: string; role?: string; connectionId?: string | null; model?: string | null; instructions?: string }) => {
    const s = await svc()
    const a = s.store.getAgent(id)
    if (!a) throw new Error('Agent not found.')
    s.inContext(a.projectId)
    return s.store.updateAgent(id, { ...patch, role: patch.role as AgentRole | undefined })
  })

  // ── Outputs ─────────────────────────────────────────────────────────────────
  ipcMain.handle('aispace:createOutput', async (_e, input: { projectId: string; kind: string; title: string; aiTaskId?: string | null; content?: string }) => {
    const s = await svc()
    s.inContext(input.projectId)
    const o = s.store.createOutput({ projectId: input.projectId, kind: input.kind as OutputKind, title: input.title, aiTaskId: input.aiTaskId ?? null })
    if (input.content && input.content.trim()) s.store.addVersion({ outputId: o.id, content: input.content, author: 'user:me', changeSummary: 'First version.' })
    return s.store.getOutput(o.id)
  })
  ipcMain.handle('aispace:addVersion', async (_e, input: { outputId: string; content: string; changeSummary?: string; expectedParentVersionId?: string | null; sources?: RecordRef[]; mediaRef?: string | null; mediaWidth?: number | null; mediaHeight?: number | null }) => {
    const s = await svc()
    const o = s.store.getOutput(input.outputId)
    if (!o) throw new Error('Output not found.')
    s.inContext(o.projectId)
    try {
      return { ok: true, version: s.store.addVersion({ ...input, author: 'user:me' }) }
    } catch (e) {
      if (e instanceof Error && e.name === 'StaleWriteError') {
        const se = e as Error & { currentVersionId: string | null; currentContent: string }
        return { ok: false, stale: true, message: e.message, currentVersionId: se.currentVersionId, currentContent: se.currentContent }
      }
      throw e
    }
  })
  ipcMain.handle('aispace:listVersions', async (_e, outputId: string) => {
    const s = await svc()
    const o = s.store.getOutput(outputId)
    if (!o) throw new Error('Output not found.')
    s.inContext(o.projectId)
    return { output: o, versions: s.store.listVersions(outputId) }
  })
  ipcMain.handle('aispace:approveVersion', async (_e, outputId: string, versionId: string) => {
    const s = await svc()
    const o = s.store.getOutput(outputId)
    if (!o) throw new Error('Output not found.')
    s.inContext(o.projectId)
    return s.store.approveVersion(outputId, versionId)
  })
  ipcMain.handle('aispace:publishVersion', async (_e, outputId: string, versionId: string) => {
    const s = await svc()
    const o = s.store.getOutput(outputId)
    if (!o) throw new Error('Output not found.')
    s.inContext(o.projectId)
    return s.store.publishVersion(outputId, versionId)
  })
  ipcMain.handle('aispace:setReviewState', async (_e, outputId: string, state: string) => {
    const s = await svc()
    const o = s.store.getOutput(outputId)
    if (!o) throw new Error('Output not found.')
    s.inContext(o.projectId)
    return s.store.setReviewState(outputId, state as ReviewState)
  })
  ipcMain.handle('aispace:renameOutput', async (_e, outputId: string, title: string) => {
    const s = await svc()
    const o = s.store.getOutput(outputId)
    if (!o) throw new Error('Output not found.')
    s.inContext(o.projectId)
    return s.store.renameOutput(outputId, title)
  })
  // Export one version as a file the person chooses where to save.
  ipcMain.handle('aispace:exportVersion', async (e, versionId: string) => {
    const s = await svc()
    const v = s.store.getVersion(versionId)
    const o = v ? s.store.getOutput(v.outputId) : null
    if (!v || !o) throw new Error('Version not found.')
    s.inContext(o.projectId)
    const ext = o.kind === 'site' ? 'html' : o.kind === 'code' ? 'txt' : o.kind === 'sheet' || o.kind === 'canvas' ? 'json' : 'md'
    const win = BrowserWindow.fromWebContents(e.sender)
    const safe = o.title.replace(/[^\w\- ]+/g, '').trim() || 'output'
    const res = win ? await dialog.showSaveDialog(win, { defaultPath: `${safe} v${v.n}.${ext}` }) : await dialog.showSaveDialog({ defaultPath: `${safe} v${v.n}.${ext}` })
    if (res.canceled || !res.filePath) return { ok: false }
    await writeFile(res.filePath, v.content, 'utf8')
    return { ok: true, path: res.filePath }
  })
  ipcMain.handle('aispace:shareVersion', async (_e, outputId: string, versionId: string, toWorkspaceId: string) => {
    const s = await svc()
    const o = s.store.getOutput(outputId)
    if (!o) throw new Error('Output not found.')
    s.inContext(o.projectId)
    return { shareId: s.store.shareVersion({ outputId, versionId, toWorkspaceId }) }
  })

  // ── Decisions, sources, captures, requests, suggestions ─────────────────────
  ipcMain.handle('aispace:recordDecision', async (_e, input: { projectId: string; topic: string; title: string; value: string; approve?: boolean; dueAt?: number | null; evidence?: RecordRef[]; previousValue?: string | null }) => {
    const s = await svc()
    s.inContext(input.projectId)
    const d = s.store.recordDecision({ projectId: input.projectId, topic: input.topic, title: input.title, value: input.value, dueAt: input.dueAt ?? null, evidence: input.evidence ?? [] })
    if (input.previousValue) s.store.setDecisionPrevious(d.id, input.previousValue)
    return input.approve ? s.store.approveDecision(d.id, 'user:me') : s.store.getDecision(d.id)
  })
  ipcMain.handle('aispace:approveDecision', async (_e, id: string) => {
    const s = await svc()
    const d = s.store.getDecision(id)
    if (!d) throw new Error('Decision not found.')
    s.inContext(d.projectId)
    return s.store.approveDecision(id, 'user:me')
  })
  ipcMain.handle('aispace:resolveDecision', async (_e, id: string, resolution: string) => {
    const s = await svc()
    const d = s.store.getDecision(id)
    if (!d) throw new Error('Decision not found.')
    s.inContext(d.projectId)
    return s.store.resolveDecision(id, resolution === 'rejected' ? 'rejected' : 'resolved', 'user:me')
  })
  ipcMain.handle('aispace:addSource', async (_e, input: { projectId: string; title: string; content: string; url?: string | null; kind?: string }) => {
    const s = await svc()
    const p = s.inContext(input.projectId)
    return s.store.addSource({ projectId: p.id, workspaceId: p.workspaceId, kind: (input.kind as 'note' | 'link' | 'file') ?? 'note', title: input.title, content: input.content, url: input.url ?? null, originalLocation: input.url ?? null })
  })
  ipcMain.handle('aispace:capture', async (_e, input: { url?: string | null; selectedText?: string | null; title?: string | null; projectId?: string | null; workspaceId?: string | null }) => (await svc()).capture(input))
  ipcMain.handle('aispace:fileThread', async (_e, threadId: string, projectId: string) => {
    const s = await svc()
    s.inContext(projectId)
    return s.store.fileThread(threadId, projectId)
  })
  ipcMain.handle('aispace:listMessages', async (_e, threadId: string) => {
    const s = await svc()
    const t = s.store.getThread(threadId)
    if (!t || !s.ctx().workspaceIds.includes(t.workspaceId)) throw new Error('Chat not found.')
    return { thread: t, messages: s.store.listMessages(threadId) }
  })
  // Talk to the Project Manager. The reply is a run on the project default
  // connection when there is one; otherwise the Manager answers from records.
  ipcMain.handle('aispace:askManager', async (_e, projectId: string, text: string, opts?: { inputs?: RecordRef[] }) => {
    const s = await svc()
    const p = s.inContext(projectId)
    const th = s.store.managerThread(p.id)
    s.store.addMessage({ threadId: th.id, role: 'user', author: 'user:me', text, refs: opts?.inputs ?? [] })
    const mgr = s.store.listAgents(p.id).find((a) => a.role === 'manager')
    const connectionId = mgr?.connectionId ?? p.defaultConnectionId
    const model = mgr?.model ?? p.defaultModel
    if (!connectionId || !model) {
      const view = s.projectView(p.id)
      const lines = [view.brief.headline, ...view.brief.updates.map((u) => `• ${u.text} ${u.detail}`), ...(view.brief.nextStep ? [`Next: ${view.brief.nextStep.text}`] : [])]
      s.store.addMessage({ threadId: th.id, role: 'assistant', author: 'Project Manager', text: `${lines.join('\n')}\n\nConnect a model in Connections and set it as this project’s default so I can answer in my own words.`, refs: [] })
      return { ok: true, threadId: th.id, ran: false }
    }
    const brief = p.briefOutputId ? s.store.getOutput(p.briefOutputId) : null
    const inputs: RecordRef[] = [...(brief?.approvedVersionId ? [{ type: 'version' as const, id: brief.approvedVersionId, versionId: brief.approvedVersionId }] : []), ...(opts?.inputs ?? [])]
    const recent = s.store.listMessages(th.id, 12).map((m) => `${m.role === 'user' ? 'Person' : 'You'}: ${m.text}`).join('\n')
    const ctxLines = s.projectView(p.id).brief.updates.map((u) => `- ${u.text} ${u.detail}`).join('\n')
    const res = s.startRun({ projectId: p.id, connectionId, model, instruction: `Recent project changes:\n${ctxLines || '- none'}\n\nConversation so far:\n${recent}\n\nReply to the person's last message as the Project Manager. Be brief and cite records by name.`, inputs, agentId: mgr?.id ?? null, threadId: th.id, replyInThread: true, maxOutputTokens: 1200 })
    return { ok: res.ok, threadId: th.id, ran: res.ok, reason: res.ok ? null : res.reason }
  })
  ipcMain.handle('aispace:managerThread', async (_e, projectId: string) => {
    const s = await svc()
    const p = s.inContext(projectId)
    const th = s.store.managerThread(p.id)
    return { thread: th, messages: s.store.listMessages(th.id) }
  })
  ipcMain.handle('aispace:openRequest', async (_e, input: { projectId: string; aiTaskId?: string | null; requestedBy: string; recipient: string; question: string; topics: string[]; canProceed?: string }) => {
    const s = await svc()
    s.inContext(input.projectId)
    return s.store.openRequest(input)
  })
  ipcMain.handle('aispace:deliverRequest', async (_e, requestId: string) => {
    const s = await svc()
    const r = s.store.getRequest(requestId)
    if (!r) throw new Error('Request not found.')
    s.inContext(r.projectId)
    return { ok: s.coordinator.deliver(requestId, `manual:${requestId}`) }
  })
  ipcMain.handle('aispace:resolveSuggestion', async (_e, id: string, status: string) => {
    const s = await svc()
    const sg = s.store.getSuggestion(id)
    if (!sg) throw new Error('Suggestion not found.')
    s.inContext(sg.projectId)
    return s.store.resolveSuggestion(id, status as Exclude<SuggestionStatus, 'pending'>, 'user:me')
  })

  // ── Impact actions ──────────────────────────────────────────────────────────
  ipcMain.handle('aispace:queueRevision', async (_e, projectId: string, outputId: string, changeId: string) => (await svc()).queueRevision(projectId, outputId, changeId))
  ipcMain.handle('aispace:judgeMatch', async (_e, projectId: string, outputId: string, changeId: string, related: boolean) => (await svc()).judgeMatch(projectId, outputId, changeId, related))
  ipcMain.handle('aispace:updateRunInput', async (_e, runId: string, from: RecordRef, to: RecordRef) => {
    const s = await svc()
    const r = s.store.getRun(runId)
    if (!r) throw new Error('Run not found.')
    s.inContext(r.projectId)
    return s.coordinator.updateRunInput(runId, from, to)
  })
  ipcMain.handle('aispace:previewBundle', async (_e, projectId: string, changeId: string) => {
    const s = await svc()
    s.inContext(projectId)
    return s.coordinator.previewBundle(projectId, changeId)
  })
  ipcMain.handle('aispace:approveBundle', async (_e, projectId: string, changeId: string, activityIds: string[]) => {
    const s = await svc()
    s.inContext(projectId)
    return s.coordinator.approveBundle(projectId, changeId, activityIds)
  })

  // ── Branches ────────────────────────────────────────────────────────────────
  ipcMain.handle('aispace:createBranch', async (_e, projectId: string, name: string) => {
    const s = await svc()
    s.inContext(projectId)
    return s.store.createBranch(projectId, name)
  })
  ipcMain.handle('aispace:applyBranchSelection', async (_e, input: { branchId: string; mainOutputId: string; fromVersionId: string; resolvedAgainstVersionId?: string | null }) => {
    const s = await svc()
    const b = s.store.getBranch(input.branchId)
    if (!b) throw new Error('Branch not found.')
    s.inContext(b.projectId)
    try {
      return { ok: true, version: s.store.applyBranchSelection(input) }
    } catch (e) {
      if (e instanceof Error && e.name === 'StaleWriteError') {
        const se = e as Error & { currentVersionId: string | null; currentContent: string }
        return { ok: false, conflict: true, message: 'The main version changed during the review. Resolve the difference first.', currentVersionId: se.currentVersionId, currentContent: se.currentContent }
      }
      throw e
    }
  })

  // ── Runs ────────────────────────────────────────────────────────────────────
  ipcMain.handle('aispace:listRuns', async (_e, filter?: { projectId?: string; statuses?: RunStatus[]; provider?: string }) => (await svc()).listRuns(filter ?? {}))
  ipcMain.handle('aispace:runDetail', async (_e, runId: string) => (await svc()).runDetail(runId))
  ipcMain.handle('aispace:startRun', async (_e, input: { projectId: string; connectionId: string; model: string; instruction: string; inputs: RecordRef[]; aiTaskId?: string | null; agentId?: string | null; threadId?: string | null; targetOutputId?: string | null; newOutput?: { kind: OutputKind; title: string } | null; background?: boolean; approvedUnknownCost?: boolean; branchId?: string | null }) => (await svc()).startRun({ ...input, principal: 'user:me' }))
  ipcMain.handle('aispace:cancelRun', async (_e, runId: string) => {
    const s = await svc()
    const r = s.store.getRun(runId)
    if (!r) throw new Error('Run not found.')
    s.inContext(r.projectId)
    return s.runner.cancelRun(runId)
  })
  ipcMain.handle('aispace:retryRun', async (_e, runId: string) => {
    const s = await svc()
    const r = s.store.getRun(runId)
    if (!r) throw new Error('Run not found.')
    s.inContext(r.projectId)
    return s.runner.retryRun(runId)
  })
  ipcMain.handle('aispace:handoverRun', async (_e, runId: string, toConnectionId: string, model: string) => {
    const s = await svc()
    const r = s.store.getRun(runId)
    if (!r) throw new Error('Run not found.')
    s.inContext(r.projectId)
    return s.runner.handoverRun(runId, toConnectionId, model)
  })
  ipcMain.handle('aispace:saveHeldDraft', async (_e, runId: string) => {
    const s = await svc()
    const r = s.store.getRun(runId)
    if (!r) throw new Error('Run not found.')
    s.inContext(r.projectId)
    return s.runner.saveHeldDraft(runId)
  })

  // ── Connections ─────────────────────────────────────────────────────────────
  ipcMain.handle('aispace:catalogue', async () => (await svc()).catalogue())
  ipcMain.handle('aispace:listConnections', async (_e, filter?: { kind?: ConnectionKind; includeDisconnected?: boolean }) => (await svc()).listConnections(filter ?? {}))
  ipcMain.handle('aispace:connectionDetail', async (_e, id: string) => (await svc()).connectionDetail(id))
  ipcMain.handle('aispace:accessImpact', async (_e, id: string) => (await svc()).accessImpact(id))
  ipcMain.handle('aispace:addModelApi', async (_e, input: { providerId: string; workspaceId: string; alias: string; billedTo?: string | null; secret: string; defaultModel?: string | null }) => (await svc()).addModelApi(input))
  ipcMain.handle('aispace:addChatAccount', async (_e, input: { providerId: string; workspaceId: string; alias: string }) => (await svc()).addChatAccount(input))
  ipcMain.handle('aispace:addAppApi', async (_e, input: { providerId: string; workspaceId: string; alias: string; token: string; billedTo?: string | null; draftParentId?: string | null; draftParentTitle?: string | null }) => {
    const s = await svc()
    if (!s.ctx().workspaceIds.includes(input.workspaceId)) throw new Error('Pick a workspace you’re working in.')
    const r = await (await tools()).addAppApi(input)
    return r.ok ? { ok: true, connection: s.connectionCard(r.connection), confirmed: r.confirmed } : r
  })
  ipcMain.handle('aispace:testConnection', async (_e, id: string) => {
    const s = await svc()
    const c = s.conns.getConnection(id)
    if (!c) throw new Error('Connection not found.')
    if (c.kind === 'app_api') {
      const r = await (await tools()).testAppApi(id)
      return { connection: s.connectionCard(r.connection), confirmed: r.confirmed }
    }
    if (c.kind === 'mcp') {
      const r = await (await mcp()).test(id)
      return { connection: s.connectionCard(s.conns.getConnection(id)!), confirmed: r.confirmed }
    }
    return s.testConnection(id)
  })
  ipcMain.handle('aispace:replaceKey', async (_e, id: string, secret: string, mode: string) => (await svc()).replaceKey(id, secret, mode === 'reconnect' ? 'reconnect' : 'rotate'))
  ipcMain.handle('aispace:pauseConnection', async (_e, id: string) => (await svc()).pause(id))
  ipcMain.handle('aispace:resumeConnection', async (_e, id: string) => (await svc()).resume(id))
  ipcMain.handle('aispace:disconnect', async (_e, id: string) => {
    const s = await svc()
    const c = s.conns.getConnection(id)
    if (c?.kind === 'mcp') await (await mcp()).forget(id)
    return s.disconnect(id)
  })
  ipcMain.handle('aispace:renameConnection', async (_e, id: string, alias: string, billedTo: string | null) => {
    const s = await svc()
    return s.connectionCard(s.conns.updateConnection(id, { alias: alias.trim() || 'Connection', billedTo: billedTo?.trim() || null }))
  })
  ipcMain.handle('aispace:setGrant', async (_e, input: { connectionId: string; projectId: string; agentIds?: string[]; actions: GrantAction[]; dataFilters?: string[]; approval?: ApprovalLevel; expiresAt?: number | null }) => (await svc()).setGrant(input))
  ipcMain.handle('aispace:revokeGrant', async (_e, grantId: string) => {
    const s = await svc()
    s.conns.revokeGrant(grantId, 'user:me')
    return { ok: true }
  })
  ipcMain.handle('aispace:reviewOperation', async (_e, operationId: string, classification: string) => {
    const s = await svc()
    s.conns.reviewOperation(operationId, classification === 'write' ? 'write' : 'read')
    return s.conns.getOperation(operationId)
  })
  ipcMain.handle('aispace:authoriseFallback', async (_e, fromId: string, toId: string) => {
    const s = await svc()
    s.conns.authoriseFallback(fromId, toId)
    return { ok: true }
  })
  ipcMain.handle('aispace:listDrafts', async () => (await svc()).conns.listDrafts())
  ipcMain.handle('aispace:deleteDraft', async (_e, id: string) => {
    ;(await svc()).conns.deleteDraft(id)
    return { ok: true }
  })

  // ── MCP ─────────────────────────────────────────────────────────────────────
  // Show the verified origin BEFORE anything is sent with credentials.
  ipcMain.handle('aispace:inspectMcpEndpoint', async (_e, endpoint: string) => (await mcp()).inspect(endpoint))
  ipcMain.handle('aispace:addMcpServer', async (_e, input: { workspaceId: string; alias: string; endpoint: string; bearerToken?: string | null; clientId?: string | null }) => {
    const s = await svc()
    if (!s.ctx().workspaceIds.includes(input.workspaceId)) throw new Error('Pick a workspace you’re working in.')
    return (await mcp()).add(input)
  })
  ipcMain.handle('aispace:authorizeMcp', async (_e, connectionId: string, requestedScope?: string | null) => (await mcp()).authorize(connectionId, requestedScope ?? null))
  ipcMain.handle('aispace:refreshMcpTools', async (_e, connectionId: string) => (await mcp()).refreshTools(connectionId))

  // ── Tools (app API + MCP) ───────────────────────────────────────────────────
  ipcMain.handle('aispace:callTool', async (_e, input: { projectId: string; connectionId: string; operationId: string; input: Record<string, unknown>; runId?: string | null }) => {
    const s = await svc()
    s.inContext(input.projectId)
    return (await tools()).call({ ...input, principal: 'user:me' })
  })
  ipcMain.handle('aispace:approveInvocation', async (_e, invocationId: string, input: Record<string, unknown>) => (await tools()).approve(invocationId, input))
  ipcMain.handle('aispace:declineInvocation', async (_e, invocationId: string) => {
    ;(await tools()).decline(invocationId)
    return { ok: true }
  })
  ipcMain.handle('aispace:reconcileInvocation', async (_e, invocationId: string, outcome: string) => {
    ;(await tools()).reconcile(invocationId, outcome === 'done' ? 'done' : 'not_done')
    return { ok: true }
  })

  // ── Open the original (Linked level) ────────────────────────────────────────
  // https only, opened in the person's default browser where they are signed in.
  ipcMain.handle('aispace:openOriginal', async (_e, url: string) => {
    const v = validateEndpoint(url)
    if (!v.ok || !v.url) return { ok: false, reason: v.reason }
    await shell.openExternal(v.url.toString())
    return { ok: true }
  })
}
