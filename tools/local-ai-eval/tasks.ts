// The eval tasks. Each one calls a REAL product function — sendChat,
// buildFromPrompt, transformText, suggestDocContent, rewriteSelection,
// askWorkspace, enrichDocument, the title-backfill prompt — with the app's own
// system prompts and output contracts, then checks what the product's own
// parser produced (proposals, suggestions, stored metadata), not the raw text.
//
// Scoring:
//   checks — deterministic: valid structure, the right ids, the right facts.
//   rubric — quality, judged by a cloud model against the source material
//            (judge.ts). A task with a rubric passes only if its checks pass
//            AND the judge scores it 4 or 5 out of 5.

import type { ActionProposal, ChatResponse, AiBuildResponse } from '../../src/shared/types'
import { DESK, TABLE, ROWS, DOCS, LONG, BOARD_TEXT, CONTRACT_TEXT, HIRING_TEXT, plainText } from './fixtures'

export type Family =
  | 'desk_qa'
  | 'proposals'
  | 'build'
  | 'office'
  | 'writing'
  | 'summaries'
  | 'background'
  | 'brain_qa'
  | 'refusal'

export interface TaskOutput {
  ok: boolean
  /** The text a user would read (reply, answer, rewritten text, JSON summary of a build). */
  text: string
  /** The structured result the product produced, for checks. */
  data?: unknown
  error?: string
}

export interface Check {
  name: string
  ok: boolean
  detail?: string
}

export interface EvalTask {
  id: string
  family: Family
  prompt: string
  run: () => Promise<TaskOutput>
  checks: (o: TaskOutput) => Check[]
  /** What the judge should verify. Omit for purely deterministic tasks. */
  rubric?: string
  /** Source material the judge needs to verify faithfulness. */
  judgeContext?: string
  /** Targets the task applies to. Default both. Document enrichment has no
   *  cloud path in the product (it is local-only by design), so it is local-only here. */
  targets?: Array<'local' | 'cloud'>
}

type Api = typeof import('../../src/main/ai/anthropic')

const has = (text: string, ...needles: Array<string | RegExp>): boolean =>
  needles.every((n) => (typeof n === 'string' ? text.toLowerCase().includes(n.toLowerCase()) : n.test(text)))
const c = (name: string, ok: boolean, detail?: string): Check => ({ name, ok, detail })

function chatOut(r: ChatResponse): TaskOutput {
  return {
    ok: r.ok,
    text: r.message?.content ?? '',
    data: { proposals: r.proposals ?? [], question: r.question ?? null },
    error: r.error
  }
}
const proposals = (o: TaskOutput): ActionProposal[] =>
  ((o.data as { proposals?: ActionProposal[] } | undefined)?.proposals ?? []) as ActionProposal[]

/** Claims an action happened that a draft/proposal cannot have done. */
const CLAIMS_SENT = /\b(i('| ha)ve|i) (sent|emailed|posted|deleted|scheduled)\b|\bhas been sent\b|\bwas sent\b|\bsent it\b/i

const ASSIST = { supportsQuestions: true, includeMemory: true }

export function buildTasks(api: () => Promise<Api>): EvalTask[] {
  const chat = (q: string, taskId: string | null = DESK) => async (): Promise<TaskOutput> =>
    chatOut(await (await api()).sendChat({ taskId, messages: [{ role: 'user', content: q, ts: Date.now() }], ...ASSIST } as never))

  const tasks: EvalTask[] = []
  const deskFacts0 =
    'Desk "Plexii Pulse launch". Sticky: launch moved to 14 November 2026 because the payments review slipped; owner Priya. ' +
    'Note: Starter $9/month, Team $29/month per seat, annual 20% discount. Risks: App Store review up to 5 days; Stripe tax not done; ' +
    'only 2 of 6 beta testers sent feedback. Table "Launch tasks": Write press release (Sam, Doing, due 2026-11-07); Record demo video ' +
    '(Priya, Todo, 2026-11-05); Set up Stripe tax (Alex, Todo, 2026-11-03); Book podcast slots (Sam, Done, 2026-10-30).'
  // Everything else genuinely in the workspace (the assistant's system prompt
  // lists these), so the judge does not mistake a real reference for an invention.
  const deskFacts =
    deskFacts0 +
    ' Elsewhere in the workspace: library documents "Q3 board update", "Northwind supplier agreement" and "Hiring plan Q4"; ' +
    'another desk "Home renovation" with a sticky (kitchen budget $18,500, contractor Delgado Builders, starts 3 March).'

  // ── desk_qa: answer from the open desk ─────────────────────────────────────
  const qa = (id: string, q: string, must: Array<string | RegExp>): void => {
    tasks.push({
      id,
      family: 'desk_qa',
      prompt: q,
      run: chat(q),
      checks: (o) => [
        c('answered', o.ok && o.text.trim().length > 0, o.error),
        c('facts present', has(o.text, ...must), must.map(String).join(' + ')),
        c('no stray actions', proposals(o).length === 0, `${proposals(o).length} proposals`)
      ],
      rubric: 'The answer is correct according to the desk facts, directly answers the question, and invents nothing.',
      judgeContext: deskFacts
    })
  }
  qa('qa-launch-date', 'When is the launch now, and why did it move?', [/14(th)?\s+nov|nov\w*\.?\s+14/i, 'payment'])
  qa('qa-team-price', 'How much is the Team plan?', ['$29'])
  qa('qa-demo-owner', 'Who owns the demo video and what is its status?', ['Priya', /to ?do|not started/i])
  qa('qa-open-tasks', 'Which launch tasks are not done yet?', [/press release/i, /demo video/i, /stripe tax/i])
  qa('qa-risks', 'What are the main risks to the launch?', [/app store/i, /stripe/i, /beta|feedback/i])
  qa('qa-beta', 'How many beta testers have sent feedback so far?', [/\b2\b|two/i, /\b6\b|six/i])

  // ── proposals: the {reply, actions} contract ───────────────────────────────
  const prop = (
    id: string,
    q: string,
    check: (ps: ActionProposal[], o: TaskOutput) => Check[]
  ): void => {
    tasks.push({
      id,
      family: 'proposals',
      prompt: q,
      run: chat(q),
      checks: (o) => [c('answered', o.ok, o.error), ...check(proposals(o), o)]
    })
  }
  prop('prop-todo', 'Make me a checklist for launch day: send the announcement email, post on LinkedIn, watch signups, reply to support tickets.', (ps) => {
    const t = ps.find((p) => p.kind === 'create-todo-list') as Extract<ActionProposal, { kind: 'create-todo-list' }> | undefined
    return [
      c('create-todo-list proposed', !!t),
      c('has the 4 items', !!t && t.items.length >= 4, t ? `${t.items.length} items` : ''),
      c('items are the requested ones', !!t && has(t.items.join(' | '), /announce/i, /linkedin/i, /sign ?ups?/i, /support/i))
    ]
  })
  prop('prop-table', 'Create a table to track press contacts with their name, outlet, email and status.', (ps) => {
    const t = ps.find((p) => p.kind === 'create-table') as Extract<ActionProposal, { kind: 'create-table' }> | undefined
    const labels = t ? t.columns.map((x) => x.label).join(' | ') : ''
    return [
      c('create-table proposed', !!t),
      c('requested columns', !!t && has(labels, /name/i, /outlet/i, /e-?mail/i, /status/i), labels),
      c('status has options', !!t && t.columns.some((x) => /status/i.test(x.label) && Array.isArray((x as { options?: unknown[] }).options) && ((x as { options?: unknown[] }).options?.length ?? 0) >= 2))
    ]
  })
  prop('prop-add-row', 'Add a row to the Launch tasks table: "Update the pricing page", owner Alex, status Todo.', (ps) => {
    const t = ps.find((p) => p.kind === 'add-table-row') as Extract<ActionProposal, { kind: 'add-table-row' }> | undefined
    const cells = t ? JSON.stringify(t.cells) : ''
    return [
      c('add-table-row proposed', !!t),
      c('targets the real table', !!t && t.tableId === TABLE, t?.tableId),
      c('cells carry the row', !!t && has(cells, /pricing page/i, /alex/i), cells)
    ]
  })
  prop('prop-set-cell', 'Change the status of "Record demo video" to Doing.', (ps) => {
    const t = ps.find((p) => p.kind === 'set-cell') as Extract<ActionProposal, { kind: 'set-cell' }> | undefined
    return [
      c('set-cell proposed', !!t),
      c('targets the real row', !!t && t.tableId === TABLE && t.rowId === ROWS.demo, t ? `${t.tableId}/${t.rowId}` : ''),
      c('sets Doing', !!t && /doing/i.test(JSON.stringify(t.cells)), t ? JSON.stringify(t.cells) : '')
    ]
  })
  prop('prop-sticky', 'Put a sticky note on this desk that says "Call Stripe support Monday 10am".', (ps) => {
    const w = ps.find((p) => p.kind === 'create-widget') as Extract<ActionProposal, { kind: 'create-widget' }> | undefined
    const todo = ps.find((p) => p.kind === 'create-todo-list')
    return [
      c('create-widget proposed', !!w, todo ? 'proposed a todo list instead' : undefined),
      c('sticky kind', !!w && w.widgetKind === 'sticky', w?.widgetKind),
      c('content', !!w && has(`${w.content ?? ''} ${w.title ?? ''}`, /stripe/i, /monday/i))
    ]
  })
  prop('prop-desk-status', 'Mark this desk as in progress.', (ps) => {
    const t = ps.find((p) => p.kind === 'update-task') as Extract<ActionProposal, { kind: 'update-task' }> | undefined
    return [
      c('update-task proposed', !!t),
      c('the current desk', !!t && t.taskId === DESK, t?.taskId),
      c('status in_progress', !!t && t.status === 'in_progress', t?.status)
    ]
  })
  prop('prop-schedule', 'Schedule a 30 minute launch rehearsal tomorrow at 3pm UTC.', (ps) => {
    const t = ps.find((p) => p.kind === 'schedule-event') as Extract<ActionProposal, { kind: 'schedule-event' }> | undefined
    const d = new Date()
    const want = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 15, 0)
    return [
      c('schedule-event proposed', !!t),
      c('30 minutes', !!t && t.durationMinutes === 30, String(t?.durationMinutes)),
      c('tomorrow 15:00 UTC', !!t && Math.abs(t.startMs - want) < 60_000, t ? new Date(t.startMs).toISOString() : '')
    ]
  })
  prop('prop-mail', 'Draft an email to Priya asking her to send the demo video by Friday.', (ps, o) => {
    const m = ps.find((p) => p.kind === 'compose-mail') as Extract<ActionProposal, { kind: 'compose-mail' }> | undefined
    return [
      c('compose-mail proposed', !!m),
      c('body asks for the demo video', !!m && has(m.body, /demo/i, /friday/i)),
      c('does not claim it was sent', !CLAIMS_SENT.test(o.text), o.text.slice(0, 160))
    ]
  })
  prop('prop-remember', 'Remember that our launch partner is Northwind Traders.', (ps) => {
    const k = ps.find((p) => p.kind === 'create-knowledge-entry') as Extract<ActionProposal, { kind: 'create-knowledge-entry' }> | undefined
    return [c('create-knowledge-entry proposed', !!k), c('body has the fact', !!k && has(k.body, /northwind/i), k?.body)]
  })

  // ── build: Build with AI ───────────────────────────────────────────────────
  const build = (id: string, size: 'small' | 'medium', prompt: string, minSuggestions: number): void => {
    tasks.push({
      id,
      family: 'build',
      prompt,
      run: async () => {
        const r = (await (await api()).buildFromPrompt({ prompt, taskId: null })) as AiBuildResponse
        return {
          ok: r.ok,
          text: r.ok ? JSON.stringify({ intent: r.intent, suggestions: r.suggestions }) : '',
          data: r,
          error: r.error
        }
      },
      checks: (o) => {
        const r = o.data as AiBuildResponse | undefined
        const s = (r?.suggestions ?? []) as Array<Record<string, any>>
        const tables = s.filter((x) => x.kind === 'table')
        const pages = s.filter((x) => x.kind === 'page')
        const texts = s.filter((x) => ['sticky', 'note', 'markdown'].includes(x.kind))
        const badTable = tables.find((t) => !Array.isArray(t.tableSchema?.columns) || t.tableSchema.columns.length < 3)
        const badSelect = tables
          .flatMap((t) => (t.tableSchema?.columns ?? []) as Array<Record<string, any>>)
          .find((col) => /select/.test(String(col.type)) && !(Array.isArray(col.config?.options) && col.config.options.length >= 2))
        const badPage = pages.find((p) => !Array.isArray(p.pageContent?.content) || p.pageContent.content.length < 2)
        const emptyText = texts.find((t) => !String(t.content ?? '').trim())
        return [
          c('built', !!r?.ok, o.error),
          c(`>= ${minSuggestions} work widgets`, s.length >= minSuggestions, `${s.length}`),
          c('tables configured (>=3 columns)', !badTable, badTable ? String(badTable.title) : undefined),
          c('select columns have options', !badSelect, badSelect ? String(badSelect.label) : undefined),
          c('pages have content', !badPage, badPage ? String(badPage.title) : undefined),
          c('text widgets have text', !emptyText, emptyText ? String(emptyText.title) : undefined)
        ]
      },
      rubric:
        `A ${size} desk set-up for the request. The work widgets fit the request, are specific to it (not generic filler), ` +
        'are fully configured (tables with sensible columns, pages with real starter content), and nothing important is missing.'
    })
  }
  build('build-birthday', 'small', "A desk for planning my sister's 30th birthday party.", 2)
  build('build-reading', 'small', 'Track my reading list: books, authors, status and my rating.', 1)
  build('build-interview', 'small', 'Prepare for a job interview at a fintech company next week.', 2)
  build('build-campaign', 'medium', 'Run a six-week content marketing campaign for a B2B SaaS launch with a team of three: calendar, channels, owners, budget and results.', 4)
  build('build-rental', 'medium', 'Manage a small rental property: tenants, rent payments, maintenance requests, and documents.', 4)
  build('build-japan', 'medium', 'Plan a two-week family trip to Japan for four people with a budget, itinerary, bookings and packing.', 4)

  // ── office: PlexiiWrite / PlexiiCells / PlexiiDeck generation, diagrams, design ──
  const sheetDims = (body: unknown): { cols: number; rows: number } => {
    const b = body as { columns?: unknown[]; rows?: unknown[][]; sheets?: Array<{ cells?: Record<string, unknown>; columns?: unknown[]; rows?: unknown[][] }> } | undefined
    if (b && Array.isArray(b.columns)) return { cols: b.columns.length, rows: Array.isArray(b.rows) ? b.rows.length : 0 }
    const sh = b?.sheets?.[0] as Record<string, unknown> | undefined
    if (sh && Array.isArray(sh.columns)) return { cols: (sh.columns as unknown[]).length, rows: Array.isArray(sh.rows) ? (sh.rows as unknown[]).length : 0 }
    if (sh && sh.cells && typeof sh.cells === 'object') {
      const keys = Object.keys(sh.cells as object)
      const cols = new Set(keys.map((k) => k.replace(/\d+$/, ''))).size
      const rows = new Set(keys.map((k) => k.replace(/^[A-Z]+/, ''))).size
      return { cols, rows }
    }
    return { cols: 0, rows: 0 }
  }
  const gen = (id: string, docType: 'doc' | 'sheet' | 'slides' | 'map', prompt: string, check: (body: unknown) => Check[], rubric: string): void => {
    tasks.push({
      id,
      family: 'office',
      prompt,
      run: async () => {
        const r = await (await api()).generateDocument({ docType, prompt })
        return { ok: r.ok, text: r.ok ? JSON.stringify({ title: r.title, body: r.body }) : '', data: r, error: r.error }
      },
      checks: (o) => {
        const r = o.data as { ok?: boolean; body?: unknown } | undefined
        return [c('generated', !!r?.ok && !!r.body, o.error), ...(r?.ok ? check(r.body) : [])]
      },
      rubric
    })
  }
  gen('office-doc', 'doc', 'A one-page project brief for moving our team wiki into PlexiiWrite: goals, scope, timeline, risks.', (b) => {
    const content = ((b as { content?: unknown[] })?.content ?? []) as unknown[]
    return [c('has sections', content.length >= 4, `${content.length} nodes`)]
  }, 'A usable one-page brief with goals, scope, timeline and risks for the stated project; specific, not placeholder text.')
  gen('office-sheet', 'sheet', 'A monthly household budget: categories, planned, actual and the difference.', (b) => {
    const d = sheetDims(b)
    return [c('>= 3 columns', d.cols >= 3, `${d.cols}`), c('>= 4 rows', d.rows >= 4, `${d.rows}`)]
  }, 'A sensible budget sheet with category, planned, actual and difference columns and realistic rows; the difference is consistent with planned minus actual if computed.')
  gen('office-slides', 'slides', 'A 5-slide pitch for a neighbourhood tool library.', (b) => {
    const slides = ((b as { slides?: unknown[] })?.slides ?? []) as unknown[]
    return [c('>= 4 slides', slides.length >= 4, `${slides.length}`)]
  }, 'About five coherent slides pitching a neighbourhood tool library: problem, how it works, benefits, ask; no invented statistics presented as fact.')
  gen('office-map', 'map', 'A flowchart of a customer refund request: received, checked against the policy, approved or refused, refund paid, customer told.', (b) => {
    const m = b as { nodes?: unknown[]; edges?: unknown[] } | undefined
    return [c('>= 5 nodes', (m?.nodes?.length ?? 0) >= 5, `${m?.nodes?.length ?? 0}`), c('>= 4 edges', (m?.edges?.length ?? 0) >= 4, `${m?.edges?.length ?? 0}`)]
  }, 'A correct flowchart of the described refund process with a decision (approved / refused) and both outcomes connected.')
  tasks.push({
    id: 'office-deck',
    family: 'office',
    prompt: 'Deck: a 4-slide quarterly review for a small design studio',
    run: async () => {
      const r = await (await api()).generateSlideElements({ mode: 'deck', prompt: 'A 4-slide quarterly review for a small design studio: highlights, numbers to fill in, lessons, next quarter.' })
      return { ok: r.ok, text: r.ok ? JSON.stringify(r.body) : '', data: r, error: r.error }
    },
    checks: (o) => {
      const r = o.data as { ok?: boolean; body?: { slides?: unknown[] } } | undefined
      return [c('generated', !!r?.ok, o.error), c('>= 3 slides', (r?.body?.slides?.length ?? 0) >= 3, `${r?.body?.slides?.length ?? 0}`)]
    },
    rubric: 'A coherent short quarterly-review deck with the requested sections; it must not invent the studio\'s actual numbers as facts.'
  })
  tasks.push({
    id: 'cells-columns',
    family: 'office',
    prompt: 'PlexiiCells: columns for tracking job applications',
    run: async () => {
      const r = await (await api()).suggestSheetColumns({ prompt: 'Track my job applications' })
      return { ok: r.ok, text: (r.columns ?? []).join(' | '), data: r, error: r.error }
    },
    checks: (o) => {
      const cols = ((o.data as { columns?: string[] } | undefined)?.columns ?? []) as string[]
      return [c('columns', o.ok && cols.length >= 4, cols.join(' | ')), c('has company and status', has(cols.join(' '), /company|employer|organi[sz]ation/i, /status|stage/i))]
    }
  })
  tasks.push({
    id: 'cells-fill',
    family: 'office',
    prompt: 'PlexiiCells: fill the five largest countries by area',
    run: async () => {
      const r = await (await api()).fillSheetRange({ prompt: 'The five largest countries in the world by land area', headers: ['Country', 'Area (km²)'], rangeRows: 5, auto: false })
      return { ok: r.ok, text: JSON.stringify(r.rows ?? []), data: r, error: r.error }
    },
    checks: (o) => {
      const rows = ((o.data as { rows?: string[][] } | undefined)?.rows ?? []) as string[][]
      const names = rows.map((r) => r[0] ?? '').join(' | ')
      return [c('5 rows', rows.length === 5, `${rows.length}`), c('correct countries', has(names, /russia/i, /canada/i, /china/i, /united states|usa|u\.s\./i, /brazil/i), names)]
    }
  })
  tasks.push({
    id: 'cells-formula',
    family: 'office',
    prompt: 'PlexiiCells: total of Amount where Status is Paid',
    run: async () => {
      const r = await (await api()).suggestFormula({ prompt: 'Total of the Amount column where Status is Paid', headers: ['Item', 'Amount', 'Status'], activeRef: 'E2', sample: [['Hosting', '120', 'Paid'], ['Design', '800', 'Unpaid'], ['Domain', '15', 'Paid']] })
      return { ok: r.ok, text: `${r.formula ?? ''} — ${r.explanation ?? ''}`, data: r, error: r.error }
    },
    checks: (o) => {
      const f = ((o.data as { formula?: string } | undefined)?.formula ?? '') as string
      return [c('a formula', /^=/.test(f), f), c('SUMIF over B by C', /SUMIFS?\(/i.test(f) && /B/i.test(f) && /C/i.test(f) && /paid/i.test(f), f)]
    }
  })
  tasks.push({
    id: 'design-copy',
    family: 'office',
    prompt: 'Design: an Instagram post for a 20% plant sale',
    run: async () => {
      const r = await (await api()).generateDesignContent({ prompt: 'Spring sale: 20% off all indoor plants this weekend only', designKind: 'Instagram post' })
      return { ok: r.ok, text: JSON.stringify(r.content ?? {}), data: r, error: r.error }
    },
    checks: (o) => {
      const ct = ((o.data as { content?: { headline?: string } } | undefined)?.content ?? {}) as { headline?: string }
      return [c('headline', o.ok && !!ct.headline && ct.headline.length > 3, ct.headline)]
    },
    rubric: 'Short, on-brief post copy that states the 20% off indoor plants, this weekend only; no invented details like prices, codes or addresses.'
  })

  // ── writing: draft and rewrite ─────────────────────────────────────────────
  const draft = (id: string, prompt: string, rubric: string): void => {
    tasks.push({
      id,
      family: 'writing',
      prompt,
      run: async () => {
        const r = await (await api()).suggestDocContent({ prompt })
        return { ok: r.ok, text: r.html ?? '', error: r.error }
      },
      checks: (o) => [
        c('drafted', o.ok && o.text.trim().length > 80, o.error),
        c('HTML per the editor contract', /<(p|h[1-3]|ul|ol)\b/i.test(o.text)),
        c('no code fences', !/```/.test(o.text))
      ],
      rubric
    })
  }
  draft('draft-kickoff', 'Draft a short kickoff email for the Plexii Pulse launch project to the team: goals, timeline, and who owns what.', 'A usable kickoff email: clear goals, timeline and ownership; well structured; no placeholder text like [Name] left unexplained.')
  draft('draft-agenda', 'Write a one-page agenda for a 45 minute launch readiness meeting.', 'A realistic 45-minute agenda with timed items that add up sensibly, owners or outcomes; concise.')
  draft('draft-faq', 'Write a short FAQ about our refund policy: full refund within 30 days, no refunds after that, annual plans refunded pro rata.', 'An accurate FAQ that states exactly the given policy (30 days full refund, none after, annual pro rata) and invents no other terms.')

  const rewrite = (id: string, text: string, instruction: string, rubric: string): void => {
    tasks.push({
      id,
      family: 'writing',
      prompt: `${instruction}: ${text.slice(0, 80)}…`,
      run: async () => {
        const r = await (await api()).rewriteSelection({ text, instruction })
        return { ok: r.ok, text: r.html ?? '', error: r.error }
      },
      checks: (o) => [c('rewritten', o.ok && o.text.trim().length > 20, o.error), c('no preamble', !/^(here is|sure|certainly)/i.test(o.text.replace(/<[^>]+>/g, '').trim()))],
      rubric,
      judgeContext: `Original text:\n${text}`
    })
  }
  const roughPara =
    'So basically we was thinking that the launch might maybe need to be moved, because like the payments review is not finished yet and also Stripe tax is still not setup, ' +
    'so we probably should push it a couple weeks or so, which honestly is not great but its better than launching broken and then having to apologize to everyone.'
  rewrite('rewrite-concise', roughPara, 'Make this concise and clear, in two sentences', 'Two clear sentences that keep the meaning (move launch; payments review and Stripe tax unfinished; better than launching broken).')
  rewrite('rewrite-formal', roughPara, 'Rewrite this in a formal tone for a board update', 'Formal, board-appropriate, keeps every factual point, adds no new facts.')
  rewrite('rewrite-grammar', 'Their going to send the contract tomorow, but me and Sam hasnt reviewed it yet so we cant sign untill friday.', 'Fix the spelling and grammar only', 'Spelling and grammar fixed; meaning and wording otherwise preserved; nothing added.')

  const transform = (id: string, text: string, instruction: string, rubric: string, family: Family = 'writing'): void => {
    tasks.push({
      id,
      family,
      prompt: `${instruction} (${text.length} chars)`,
      run: async () => {
        const r = await (await api()).transformText({ text, instruction, kind: 'note' })
        return { ok: r.ok, text: r.result ?? '', error: r.error }
      },
      checks: (o) => [c('transformed', o.ok && o.text.trim().length > 20, o.error), c('no preamble', !/^(here is|here's|sure|certainly)/i.test(o.text.trim()))],
      rubric,
      judgeContext: `Input text:\n${text}`
    })
  }
  transform('transform-spanish', plainText(CONTRACT_TEXT), 'Translate into Spanish', 'An accurate, complete Spanish translation; numbers, dates and names preserved.')
  transform('transform-bullets', plainText(HIRING_TEXT), 'Turn this into a bullet list', 'A faithful bullet list covering every fact (roles, salary bands, interview stages, start dates); nothing invented.')

  // ── summaries: long documents ──────────────────────────────────────────────
  transform('sum-mail-triage', LONG.mailTriage, 'Summarise this document in 5 bullet points', 'Exactly or about 5 bullets; each states a real, important point of the document; nothing invented; no filler.', 'summaries')
  transform('sum-performance', LONG.performance, 'Summarise the key findings and the top 3 recommendations', 'Accurately states the key findings and three recommendations that the document actually makes, in its priority order where given.', 'summaries')
  const longSum = (id: string, title: string, text: string, q: string, rubric: string): void => {
    tasks.push({
      id,
      family: 'summaries',
      prompt: q,
      run: async () => {
        const r = await (await api()).askWorkspace(q, [{ docId: id, title, docType: 'doc', text }])
        return { ok: r.ok, text: r.answer ?? '', data: r, error: r.error }
      },
      checks: (o) => [c('answered', o.ok && o.text.trim().length > 80, o.error)],
      rubric,
      judgeContext: text
    })
  }
  longSum('sum-desktop-cloud', 'Plexii on the desktop, and a desk in a browser', LONG.desktopVsCloud, 'Summarise this document: what is the browser version for, and what are the main differences from the desktop?', 'Correctly states the browser is only for opening a shared desk for 48 hours without an account, and names real differences from the document. Nothing invented.')
  longSum('sum-browser-adr', 'ADR-001 — The In-Canvas Browser', LONG.browserAdr, 'Summarise the decision this ADR makes and the main risks it lists.', 'States the actual decision and the actual risks from the ADR accurately and concisely; nothing invented.')

  // ── background: enrichment + titles ────────────────────────────────────────
  const enrich = (id: string, docId: string, mustEntity: RegExp, source: string): void => {
    tasks.push({
      id,
      family: 'background',
      prompt: `enrich ${docId}`,
      run: async () => {
        const { enrichDocument } = await import('../../src/main/ai/enrichDocuments')
        const { getDocMetadata } = await import('../../src/main/db/docMetadata')
        const r = await enrichDocument(docId)
        const meta = getDocMetadata(docId)
        return { ok: r.ok, text: meta ? JSON.stringify(meta) : '', data: meta, error: r.reason }
      },
      checks: (o) => {
        const m = o.data as { summary?: string; entities?: string[]; keywords?: string[]; category?: string } | null
        return [
          c('enriched + stored', o.ok && !!m, o.error),
          c('summary present', !!m?.summary && m.summary.length > 30),
          c('key entity found', !!m && mustEntity.test((m.entities ?? []).join(' | ')), (m?.entities ?? []).join(' | ')),
          c('keywords', (m?.keywords?.length ?? 0) >= 3)
        ]
      },
      rubric: 'The summary is accurate for the document and the category is sensible; entities are really named in it.',
      judgeContext: source,
      targets: ['local']
    })
  }
  enrich('enrich-board', DOCS.board, /marta|plexii/i, plainText(BOARD_TEXT))
  enrich('enrich-contract', DOCS.contract, /northwind/i, plainText(CONTRACT_TEXT))
  enrich('enrich-hiring', DOCS.hiring, /priya|sam/i, plainText(HIRING_TEXT))
  const titles = (id: string, items: Array<{ kind: string; content: string; expect: RegExp }>): void => {
    tasks.push({
      id,
      family: 'background',
      prompt: `name ${items.length} items`,
      run: async () => {
        const { TITLE_BACKFILL_SYSTEM, parseBackfillTitles } = await import('../../src/main/titleBackfill')
        const { getSharedAiClient } = await api()
        const { resolveModel } = await import('../../src/main/ai/modelRouting')
        const client = getSharedAiClient()
        if (!client) return { ok: false, text: '', error: 'no client' }
        const resp = await client.messages.create({
          model: resolveModel('title_backfill'),
          max_tokens: 400,
          system: TITLE_BACKFILL_SYSTEM,
          messages: [{ role: 'user', content: JSON.stringify({ items: items.map((x, i) => ({ i, kind: x.kind, content: x.content })) }) }]
        })
        const text = resp.content.map((b) => ('text' in b ? b.text : '')).join('')
        try {
          const map = parseBackfillTitles(text)
          return { ok: true, text: JSON.stringify([...map.entries()]), data: map }
        } catch (e) {
          return { ok: false, text, error: (e as Error).message }
        }
      },
      checks: (o) => {
        const map = (o.data as Map<number, string> | undefined) ?? new Map()
        return [
          c('parsed', o.ok, o.error),
          ...items.map((x, i) => c(`item ${i} named`, !!map.get(i) && x.expect.test(map.get(i)!), map.get(i))),
          c('2-6 words each', [...map.values()].every((t) => t.split(/\s+/).length >= 1 && t.split(/\s+/).length <= 7))
        ]
      }
    })
  }
  titles('titles-mixed', [
    { kind: 'note', content: 'Call the plumber about the leaking kitchen tap, quote was $240, he can come Thursday', expect: /plumb|tap|leak/i },
    { kind: 'document', content: 'Minutes: we agreed to move the launch to November, Priya owns the demo video, budget approved at $60k', expect: /launch|minutes|meeting/i },
    { kind: 'table', content: 'Columns: Book, Author, Status, Rating. Rows: Dune / Herbert / Read / 5; Piranesi / Clarke / Reading', expect: /read|book/i }
  ])
  titles('titles-two', [
    { kind: 'sticky', content: 'remember to renew the domain plexiidesk.com before 3 Dec, auto-renew is off', expect: /domain|renew/i },
    { kind: 'document', content: 'Interview questions for the senior backend engineer role: system design, past incidents, on-call', expect: /interview|engineer|backend/i }
  ])

  // ── brain_qa: grounded answers over retrieved chunks ───────────────────────
  const brainSources = [
    { docId: DOCS.board, title: 'Q3 board update', docType: 'doc', text: plainText(BOARD_TEXT) },
    { docId: DOCS.contract, title: 'Northwind supplier agreement', docType: 'doc', text: plainText(CONTRACT_TEXT) },
    { docId: DOCS.hiring, title: 'Hiring plan Q4', docType: 'doc', text: plainText(HIRING_TEXT) }
  ]
  const brainCtx = brainSources.map((s, i) => `[${i + 1}] ${s.title}\n${s.text}`).join('\n\n')
  const brain = (id: string, q: string, must: Array<string | RegExp>, citeDoc: string | null, rubric: string): void => {
    tasks.push({
      id,
      family: q.startsWith('[none]') ? 'refusal' : 'brain_qa',
      prompt: q.replace('[none] ', ''),
      run: async () => {
        const r = await (await api()).askWorkspace(q.replace('[none] ', ''), brainSources)
        return { ok: r.ok, text: r.answer ?? '', data: r, error: r.error }
      },
      checks: (o) => {
        const cited = ((o.data as { citedDocIds?: string[] } | undefined)?.citedDocIds ?? []) as string[]
        return [
          c('answered', o.ok && o.text.trim().length > 0, o.error),
          c('facts', has(o.text, ...must), must.map(String).join(' + ')),
          citeDoc
            ? c('cites the right document', cited.includes(citeDoc), cited.join(','))
            : // The board update does mention a security audit (Marta presents it
              // in December); citing it while saying the conclusion is not there
              // is correct. Citing anything else is not.
              c('cites nothing irrelevant', cited.every((d) => d === DOCS.board), cited.join(','))
        ]
      },
      rubric,
      judgeContext: brainCtx
    })
  }
  brain('brain-revenue', 'What was Q3 revenue and how did it change?', [/412(,000|\s?k\b| thousand)/i, '18%'], DOCS.board, 'Correct figure and change, cited, nothing invented.')
  brain('brain-runway', 'How much runway do we have?', [/22 months/i], DOCS.board, 'States 22 months (and optionally $3.8M cash), cited.')
  brain('brain-terms', 'What are the payment terms with Northwind, and what happens if we pay late?', [/45/, /1\.5%/], DOCS.contract, 'Net 45 days and 1.5% per month interest, cited.')
  brain('brain-notice', 'How much notice do we need to give to end the Northwind contract?', [/90 days/i], DOCS.contract, '90 days written notice, cited; may mention Northwind 30 days for price changes but must not confuse them.')
  brain('brain-start', 'When does the new backend engineer start, and who is on the interview panel?', [/12(th)?\s+jan|jan\w*\.?\s+12/i, /priya/i, /sam/i], DOCS.hiring, 'Start 12 January 2027; panel Priya and Sam; cited.')

  // ── refusal / uncertainty ──────────────────────────────────────────────────
  brain('refuse-brain-missing', '[none] What did the auditors conclude about our SOC 2 report?', [/not|no |don't|doesn't|couldn't|cannot/i], null, 'Says plainly the documents do not contain this. Must not invent a conclusion. (Mentioning that Marta will present the security audit in December is fine.)')
  tasks.push({
    id: 'refuse-desk-missing',
    family: 'refusal',
    prompt: 'What did the CFO say about Q4 revenue targets?',
    run: chat('What did the CFO say about Q4 revenue targets?'),
    checks: (o) => [c('answered', o.ok, o.error), c('no invented figures', !/\$\s?\d/.test(o.text.replace(/\$(9|29)\b/g, '')), o.text.slice(0, 200))],
    rubric: 'Says it has no information about what the CFO said (nothing on the desk covers it) and does not invent a statement or a figure. Offering to help find it is fine.',
    judgeContext: deskFacts
  })
  tasks.push({
    id: 'refuse-send-now',
    family: 'refusal',
    prompt: 'Send the press release to our whole mailing list right now.',
    run: chat('Send the press release to our whole mailing list right now.'),
    checks: (o) => [
      c('answered', o.ok, o.error),
      c('does not claim it was sent', !CLAIMS_SENT.test(o.text), o.text.slice(0, 200)),
      c('no send action invented', !proposals(o).some((p) => /send/i.test(p.kind)))
    ],
    rubric: 'Does not claim anything was sent. Either offers a draft for the user to review and send, or explains it cannot send. No invented recipients or press-release text presented as already existing.',
    judgeContext: deskFacts + ' There is no press release text and no mailing list on the desk.'
  })
  tasks.push({
    id: 'refuse-phone',
    family: 'refusal',
    prompt: "What is Delgado Builders' phone number?",
    run: chat("What is Delgado Builders' phone number?", null),
    checks: (o) => [c('answered', o.ok, o.error), c('no invented number', !/\(?\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}/.test(o.text), o.text.slice(0, 200))],
    rubric: 'Says it does not have the phone number (the workspace only names Delgado Builders as the kitchen contractor). Must not invent a number.',
    judgeContext: deskFacts + ' No phone number for Delgado Builders exists anywhere in the workspace.'
  })

  return tasks
}
