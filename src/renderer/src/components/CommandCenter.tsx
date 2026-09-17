import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { effectiveQuickAddMap } from '../lib/keymap'
import { createPortal } from 'react-dom'
import { useNodeStore } from '../stores/nodes'
import { useRelatedDesksStore } from '../stores/relatedDesks'
import { useViewStore } from '../stores/view'
import { useWidgetStore } from '../stores/widgets'
import type { WidgetKind, SearchHit } from '@shared/types'
import { WIDGET_CATALOG, isAdvancedKind } from '../lib/widgetCatalog'
import { getNavPrefs, setNavPrefs } from '../lib/navPrefs'
import Icon from './Icon'
import { parseAttentionCommand, hasAttentionCommand } from '../lib/attentionCommand'
import { useCapabilityEnabled, useCapabilityStore } from '../stores/capabilities'
import { entitlementFor, capabilityForDocType, DOC_TYPE_LABEL } from '../lib/entitlementReason'
import { canCreateWidget } from '../lib/gating'
import { promptUpgrade } from '../stores/upgradePrompt'
import { useEditorCommandStore } from '../stores/editorCommands'
import { classifyOmniInput, searchUrl } from '../lib/omniIntent'
import { useWebPanel } from '../stores/webPanel'
import { useAssistantChrome } from '../stores/assistantChrome'
import { useChatStore, NEW_CHAT_KEY } from '../stores/chat'
import { useDocumentsStore } from '../stores/documents'
import { useQuickCreate } from '../stores/quickCreate'
import { recencyRank } from '../lib/viewRecency'
import { createShowcaseDesk } from '../lib/createShowcaseDesk'

interface Props {
  onOpenBodyDouble: () => void
  onOpenSmartStack: () => void
  canSmartStack: boolean
}

interface CommandResult {
  id: string
  label: string
  hint: string
  icon: string
  // 'jump' = navigate to a node, 'action' = run a function.
  kind: 'jump' | 'action'
  // Score for ranking — higher is better.
  score: number
  // Optional keyboard shortcut to surface in the row (e.g. a widget quick-add
  // key). Display only — the actual handler lives on the canvas.
  shortcut?: string
  run: () => void
}

// Floating Command Center — a bottom-centred pill with the most-used
// actions. Expands into a full command palette on Cmd+K (also clickable
// by the magnifier icon). Mirrors actions already in the chrome — it's
// additive, not a replacement. Closing it never breaks an existing flow.
//
// Why a separate component:
//  - Cmd+K should work from anywhere in the app, including dialogs that
//    aren't aware of the chrome.
//  - The pill stays visible at all times as a low-friction reminder that
//    these actions exist — onboarding has a lot to teach, this surface
//    reinforces it constantly without lecturing.
//
// Palette ranking is simple substring + recency. No vector search, no AI —
// this surface needs to be instant, not clever.
export default function CommandCenter({
  onOpenBodyDouble,
  onOpenSmartStack,
  canSmartStack
}: Props): JSX.Element {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Attention S5: capability probe gates the capture entry — at boot, and
  // re-probed live when the Settings toggle flips (DEC-023).
  const [workItemsOn, setWorkItemsOn] = useState(false)
  useEffect(() => {
    const probe = (): void => {
      window.api.workItems
        .enabled()
        .then(setWorkItemsOn)
        .catch(() => {})
    }
    probe()
    window.addEventListener('fb:workitems-toggled', probe)
    return () => window.removeEventListener('fb:workitems-toggled', probe)
  }, [])
  const [highlightIdx, setHighlightIdx] = useState(0)
  // DEC-028: the armed @attention pill — Tab on the Attention row (or on an
  // "@a…" partial) arms it; the query then IS the capture text.
  // Deep content search results (notes, doc bodies, table cells, files) from the
  // main process, fetched async + debounced as the query changes.
  const [deepHits, setDeepHits] = useState<SearchHit[]>([])
  const inputRef = useRef<HTMLInputElement | null>(null)
  const bodyDoubleEnabled = useCapabilityEnabled('body_double')
  const caps = useCapabilityStore((s) => s.capabilities)

  const nodes = useNodeStore((s) => s.nodes)

  // Object counts, fetched only for desks whose name is ambiguous. Two desks
  // called the same thing need telling apart; every other desk does not, so
  // this stays silent in the common case instead of counting the workspace.
  const [deskObjectCounts, setDeskObjectCounts] = useState<Record<string, number>>({})
  useEffect(() => {
    const byTitle = new Map<string, string[]>()
    for (const n of nodes) {
      if (n.archived || n.kind !== 'task') continue
      const t = (n.title || '').trim().toLowerCase()
      if (!t) continue
      byTitle.set(t, [...(byTitle.get(t) ?? []), n.id])
    }
    const ambiguous = [...byTitle.values()].filter((ids) => ids.length > 1).flat()
    if (ambiguous.length === 0) {
      setDeskObjectCounts({})
      return
    }
    let cancelled = false
    void window.api.widgets
      .countsByTask(ambiguous)
      .then((c) => {
        if (!cancelled) setDeskObjectCounts(c)
      })
      .catch(() => {
        /* counts are a nicety; the room and status still disambiguate */
      })
    return () => {
      cancelled = true
    }
  }, [nodes])
  const setActive = useNodeStore((s) => s.setActive)
  const goHome = useViewStore((s) => s.goHome)
  const goAllTasks = useViewStore((s) => s.goAllTasks)
  const goProjects = useViewStore((s) => s.goProjects)
  const goCalendar = useViewStore((s) => s.goCalendar)
  const goVault = useViewStore((s) => s.goVault)
  const goTask = useViewStore((s) => s.goTask)
  const goProject = useViewStore((s) => s.goProject)
  const goFiles = useViewStore((s) => s.goFiles)
  const goDesign = useViewStore((s) => s.goDesign)
  const goDraw = useViewStore((s) => s.goDraw)
  const goOffice = useViewStore((s) => s.goOffice)
  const goPlexiDesk = useViewStore((s) => s.goPlexiDesk)
  const goPlexiPeople = useViewStore((s) => s.goPlexiPeople)
  const goPlexiBrain = useViewStore((s) => s.goPlexiBrain)
  const goDocument = useViewStore((s) => s.goDocument)
  const goKnowledge = useViewStore((s) => s.goKnowledge)
  const goReports = useViewStore((s) => s.goReports)
  const goForms = useViewStore((s) => s.goForms)
  const goApps = useViewStore((s) => s.goApps)
  const goSign = useViewStore((s) => s.goSign)
  const goMail = useViewStore((s) => s.goMail)
  const requestCreate = useQuickCreate((s) => s.request)
  const activeTaskId = useNodeStore((s) => s.activeTaskId)
  const setZoom = useWidgetStore((s) => s.setZoom)
  const setPan = useWidgetStore((s) => s.setPan)
  const createWidget = useWidgetStore((s) => s.create)
  // Commands the active rich editor (Document, Slides) has published. Empty
  // unless the user is inside one. These drive the editor straight from Cmd+K.
  const editorCommands = useEditorCommandStore((s) => s.commands)
  const editorScope = useEditorCommandStore((s) => s.scope)

  // The pill's middle buttons swap based on what the user is doing.
  // - On the canvas (kind === 'task'): widget-creation shortcuts that
  //   mirror the most-used catalog kinds. Closest match to the 2.0 mockup's
  //   "Note · Browser · Table · Board · Timer · Whiteboard · Calculator".
  // - Elsewhere (home, project dashboard, etc.): action-shortcuts that
  //   make sense without a canvas — New, Body double, Smart Stack.
  // All actions are also reachable from the palette and chrome, so the
  // pill is a convenience, never the only path.
  // Spawn a widget on the active task at a sensible position, gated by the
  // capability matrix. Shared by the pill, the palette's "Add" commands, and
  // (via the same catalog) the canvas quick-add shortcuts.
  const spawnWidget = useCallback(
    (kind: WidgetKind): void => {
      if (!activeTaskId) return
      if (!canCreateWidget(caps, kind)) {
        promptUpgrade(`The ${kind} widget is a Pro feature.`)
        return
      }
      const entry = WIDGET_CATALOG.find((e) => e.kind === kind)
      void createWidget({
        taskId: activeTaskId,
        kind,
        title: '',
        content: entry?.defaultContent || '',
        x: 80 + Math.round(Math.random() * 120),
        y: 80 + Math.round(Math.random() * 80),
        width: entry?.defaultWidth ?? 320,
        height: entry?.defaultHeight ?? 240,
        color: kind === 'sticky' ? '#fef08a' : null
      })
    },
    [activeTaskId, caps, createWidget]
  )

  function openPalette(): void {
    setPaletteOpen(true)
    setQuery('')
    setHighlightIdx(0)
  }
  function closePalette(): void {
    setPaletteOpen(false)
  }

  // Cmd+K from anywhere — open palette. Cmd+Shift+K = body double quick
  // launch. Esc inside palette = close.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        if (paletteOpen) closePalette()
        else openPalette()
        return
      }
      if (paletteOpen && e.key === 'Escape') {
        e.preventDefault()
        closePalette()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paletteOpen])

  // Open the palette from elsewhere (the top-bar Search button) now that the
  // bottom pill is gone. Keeps one canonical palette with a discoverable entry.
  useEffect(() => {
    const open = (): void => openPalette()
    window.addEventListener('fb:open-command-palette', open)
    return () => window.removeEventListener('fb:open-command-palette', open)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (paletteOpen) {
      // Defer to next tick so the portal mounts before focusing.
      const t = window.setTimeout(() => inputRef.current?.focus(), 0)
      return () => window.clearTimeout(t)
    }
    return undefined
  }, [paletteOpen])

  // Deep content search across the whole workspace — debounced, only while the
  // palette is open and the query is meaningful. Results merge into the list
  // below the instant name matches.
  useEffect(() => {
    const q = query.trim()
    if (!paletteOpen || q.length < 2) {
      setDeepHits([])
      return undefined
    }
    let cancelled = false
    const t = window.setTimeout(() => {
      void window.api.search.query(q).then((hits) => {
        if (!cancelled) setDeepHits(hits)
      })
    }, 160)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [query, paletteOpen])

  const results = useMemo<CommandResult[]>(() => {
    const q = query.trim().toLowerCase()
    const items: CommandResult[] = []

    // Active-editor commands first. When the user is inside a document or slide
    // deck and opens the palette, formatting / view / insert actions are almost
    // always what they want, so these outrank navigation. On an empty query they
    // lead the list in their declared order; on a real query they only appear
    // when they actually match, but then they rank above general results.
    for (let idx = 0; idx < editorCommands.length; idx++) {
      const c = editorCommands[idx]
      const hay = `${c.label} ${c.keywords ?? ''} ${c.group ?? ''}`
      const m = matchScore(hay, q)
      const score = q === '' ? 300 - idx : m > 0 ? m + 150 : 0
      items.push({
        id: `ec-${c.id}`,
        label: c.label,
        hint: c.group ? `${editorScope ?? 'Editor'} · ${c.group}` : editorScope ?? 'Editor',
        icon: c.icon ?? 'bolt',
        kind: 'action',
        score,
        shortcut: c.shortcut,
        run: () => {
          c.run()
          if (!c.keepOpen) closePalette()
        }
      })
    }

    // Static actions
    items.push({
      id: 'go-home',
      label: 'Go to Home',
      hint: 'Dashboard',
      icon: 'dashboard',
      kind: 'action',
      score: q === '' ? 90 : matchScore('home dashboard', q),
      run: () => {
        setActive(null)
        goHome()
        closePalette()
      }
    })
    items.push({
      id: 'onboarding-hub',
      label: 'Take a tour',
      hint: 'Replay onboarding',
      icon: 'explore',
      kind: 'action',
      score: matchScore('take a tour replay onboarding help getting started guide', q),
      run: () => {
        closePalette()
        window.dispatchEvent(new CustomEvent('fb:onboarding-hub'))
      }
    })
    items.push({
      id: 'create-showcase',
      label: 'Create Wire & Agent Showcase desk',
      hint: '10 worked connect + agent examples',
      icon: 'bolt',
      kind: 'action',
      score: matchScore('wire agent showcase demo connections automation examples sample desk transform', q),
      run: () => {
        closePalette()
        void createShowcaseDesk()
      }
    })
    items.push({
      id: 'sync-brain',
      label: 'Sync workspace to Brain',
      hint: 'Index every desk, document & file',
      icon: 'hub',
      kind: 'action',
      score: matchScore('sync workspace brain knowledge index ingest everything drive documents files graph', q),
      run: () => {
        closePalette()
        void window.api.brain.ingestWorkspace().then(() => goPlexiBrain())
      }
    })
    // Relate this desk to others so the brain reads them together. Only when a
    // desk is open (relatedness is per-desk).
    if (activeTaskId) {
      items.push({
        id: 'related-desks',
        label: 'Related desks',
        hint: 'Choose which desks the brain reads with this one',
        icon: 'hub',
        kind: 'action',
        score: matchScore('related desks link connect brain scope context associate', q),
        run: () => {
          closePalette()
          useRelatedDesksStore.getState().show(activeTaskId)
        }
      })
    }
    // Body double + Smart Stack moved here from the (now removed) bottom pill,
    // so they still have a home. Body double needs the capability; Smart Stack
    // needs an active desk with enough widgets.
    if (bodyDoubleEnabled) {
      items.push({
        id: 'body-double',
        label: 'Find a body double',
        hint: 'Quiet co-working presence',
        icon: 'group',
        kind: 'action',
        score: matchScore('body double focus co-working presence', q),
        run: () => {
          closePalette()
          onOpenBodyDouble()
        }
      })
    }
    if (canSmartStack) {
      items.push({
        id: 'smart-stack',
        label: 'Smart Stack widgets',
        hint: 'Auto-arrange this desk',
        icon: 'auto_awesome_motion',
        kind: 'action',
        score: matchScore('smart stack arrange organise widgets desk', q),
        run: () => {
          closePalette()
          onOpenSmartStack()
        }
      })
    }
    items.push({
      id: 'go-all-tasks',
      label: 'All tasks',
      hint: 'Browse + filter every task',
      icon: 'checklist',
      kind: 'action',
      score: q === '' ? 85 : matchScore('all tasks list', q),
      run: () => {
        setActive(null)
        goAllTasks()
        closePalette()
      }
    })
    // DEC-020: the Plans/Calendar/Desks-flat sidebar tabs retired — the
    // palette is now these views' front door, so each keeps an entry here.
    items.push({
      id: 'go-plans',
      label: 'Plans',
      hint: 'Plan boards + timelines',
      icon: 'account_tree',
      kind: 'action',
      score: q === '' ? 72 : matchScore('plans projects gantt timeline', q),
      run: () => {
        setActive(null)
        goProjects()
        closePalette()
      }
    })
    items.push({
      id: 'go-calendar',
      label: 'Calendar',
      hint: 'Tasks by date',
      icon: 'calendar_month',
      kind: 'action',
      score: q === '' ? 70 : matchScore('calendar schedule', q),
      run: () => {
        setActive(null)
        goCalendar()
        closePalette()
      }
    })
    items.push({
      id: 'go-vault',
      label: 'Vault',
      hint: 'Encrypted credentials',
      icon: 'lock',
      kind: 'action',
      score: q === '' ? 60 : matchScore('vault credentials passwords', q),
      run: () => {
        setActive(null)
        goVault()
        closePalette()
      }
    })
    // Navigation to the other top-level surfaces.
    // On an empty query, float the modules the person actually uses to the top.
    // recencyRank is -1 when a module hasn't been visited, 0 for the most recent.
    const recBonus = (kind: string): number => {
      if (q !== '') return 0
      const r = recencyRank(kind)
      return r >= 0 ? (8 - r) * 2 : 0
    }
    const navTargets: Array<{ id: string; label: string; hint: string; icon: string; words: string; viewKind: string; go: () => void }> = [
      { id: 'go-plexidesk', label: 'PlexiDesk', hint: 'Home, desk, plans, tasks, calendar, files', icon: 'desktop_windows', words: 'plexidesk desk home plans projects tasks calendar files workspaces recent gantt', viewKind: 'plexidesk', go: goPlexiDesk },
      { id: 'go-office', label: 'PlexiOffice', hint: 'Docs, sheets, slides, mail, chat, meet, sign', icon: 'grid_view', words: 'plexioffice office docs sheets slides diagrams designs artwork sign documents mail inbox chat meet', viewKind: 'office', go: goOffice },
      { id: 'go-plexipeople', label: 'PlexiPeople', hint: 'Team status, directory, organisation map', icon: 'groups', words: 'plexipeople people team directory members organisation organization org map presence', viewKind: 'plexipeople', go: goPlexiPeople },
      { id: 'go-plexibrain', label: 'PlexiBrain', hint: 'Knowledge, search, flows, insights', icon: 'neurology', words: 'plexibrain brain knowledge search map flows agents connect api insights automation', viewKind: 'plexibrain', go: goPlexiBrain },
      { id: 'go-documents', label: 'Documents', hint: 'Docs, sheets, slides', icon: 'article', words: 'documents docs sheets slides', viewKind: 'office', go: goOffice },
      { id: 'go-design', label: 'PlexiDesign', hint: 'Page layout — brochures, flyers, newsletters', icon: 'plexii:design', words: 'design plexidesign publisher indesign layout page brochure poster flyer newsletter booklet print masterpage', viewKind: 'design', go: goDesign },
      { id: 'go-draw', label: 'PlexiDraw', hint: 'Vector and painting — pen, shapes, brushes', icon: 'brush', words: 'draw plexidraw illustrator photoshop vector paint brush pen bezier path svg artwork illustration logo icon', viewKind: 'draw', go: goDraw },
      { id: 'go-diagrams', label: 'PlexiDiagrams', hint: 'Flowcharts, org charts, process maps', icon: 'account_tree', words: 'diagram plexidiagrams flowchart visio lucidchart org chart process swimlane mindmap connector', viewKind: 'office', go: () => goOffice('diagrams') },
      { id: 'go-files', label: 'Files', hint: 'File manager', icon: 'folder', words: 'files folders manager', viewKind: 'files', go: goFiles },
      { id: 'go-mail', label: 'Mail', hint: 'Email inbox', icon: 'mail', words: 'mail email inbox', viewKind: 'office', go: () => goOffice('mail') },
      { id: 'go-inbox', label: 'PlexiInbox', hint: 'Notifications, share invites', icon: 'inbox', words: 'inbox notifications invites plexi', viewKind: 'office', go: () => goOffice('inbox') },
      { id: 'go-messages', label: 'Messages', hint: 'Chats', icon: 'forum', words: 'messages chat dm', viewKind: 'office', go: () => goOffice('chat') }
    ]
    for (const t of navTargets) {
      items.push({
        id: t.id,
        label: t.label,
        hint: t.hint,
        icon: t.icon,
        kind: 'action',
        score: (q === '' ? 55 : matchScore(t.words, q)) + recBonus(t.viewKind),
        run: () => {
          setActive(null)
          t.go()
          closePalette()
        }
      })
    }
    items.push({
      id: 'new-task',
      label: 'New folder or task',
      hint: 'Create a desk or task',
      icon: 'add',
      kind: 'action',
      score: q === '' ? 58 : matchScore('new folder task desk create', q),
      run: () => {
        window.dispatchEvent(new CustomEvent('fb:command-new-task'))
        closePalette()
      }
    })
    // DEC-019(b) + DEC-028: ONE universal Attention entry. Typing
    // "@attention <text>" captures that text directly; typing "@a…" (any
    // prefix of attention) surfaces this entry on top, and Tab ARMS the
    // Slack-style pill — the query then IS the capture text and Enter files
    // it. The console opens prefilled at the classify step either way.
    // Operator ruling (2026-08-30): a query that MENTIONS Attention — plain
    // "attention", "@attention", or an "@a…" partial — belongs to the capture
    // row, full stop. The omni rows (Ask Plexii hard-scores 2000) yield to
    // ALL of these, not just the literal token; without this, Enter on
    // "attention" asked the model instead of opening Capture.
    const attnAddressed =
      workItemsOn &&
      (hasAttentionCommand(q) ||
        /^@?attention\b/i.test(q) ||
        (/^@([a-z]*)$/i.test(q) && 'attention'.startsWith(q.slice(1).toLowerCase())))
    if (workItemsOn) {
      const attnPrefix = /^@?attention\b[:,]?\s*(.*)$/i.exec(q)
      // DEC-031: the token ANYWHERE in the query addresses Attention just as
      // explicitly as opening with it. Before this, "…by friday @attention"
      // scored as a fuzzy match, lost to Ask Plexii, and took a 30s round trip
      // through the model that filed nothing (operator live QA).
      const attnInline = !attnPrefix && hasAttentionCommand(q) ? parseAttentionCommand(q) : null
      const atPartial = !attnPrefix && !attnInline ? /^@([a-z]*)$/i.exec(q) : null
      const atMatches = !!atPartial && 'attention'.startsWith(atPartial[1].toLowerCase())
      const prefill = attnPrefix?.[1]?.trim() ?? attnInline?.captureText ?? ''
      items.push({
        id: 'attention-capture',
        // Operator ruling (2026-08-30): selecting Attention OPENS the Capture
        // window — typing happens THERE, not in this bar. The ⌘K armed pill
        // (DEC-028c) is retired here; text typed after the token still files
        // directly (DEC-031's grammar, unchanged), and chat + the home bar
        // keep their own flows.
        label: prefill
          ? `Attention — capture “${prefill.slice(0, 40)}${prefill.length > 40 ? '…' : ''}”`
          : 'Attention — open Capture',
        hint: 'Opens the Capture window · @attention <text> files directly',
        icon: 'notifications',
        kind: 'action',
        // An explicit @-address (armed pill, full prefix, or @-partial)
        // outranks EVERYTHING — Enter on the raw query must capture, never
        // fall through to search or navigation.
        score:
          attnPrefix || attnInline
            ? 500
            : atMatches
              ? 490
              : q === ''
                ? 57
                : matchScore('attention capture work item remind todo queue', q),
        run: () => {
          window.dispatchEvent(
            new CustomEvent('fb:command-new-work-item', {
              detail: prefill ? { captureText: prefill } : undefined
            })
          )
          closePalette()
        }
      })
    }
    // New design: open the PlexiDesign hub to pick a size or template.
    items.push({
      id: 'new-design',
      label: 'New design',
      hint: 'PlexiDesign — brochure, flyer, newsletter, any size',
      icon: 'plexii:design',
      kind: 'action',
      score: q === '' ? 56 : matchScore('new design plexidesign publisher indesign layout page brochure poster flyer newsletter booklet print create', q),
      run: () => {
        setActive(null)
        goDesign()
        closePalette()
      }
    })
    // New artwork: open the PlexiDraw hub to pick an artboard.
    items.push({
      id: 'new-draw',
      label: 'New artwork',
      hint: 'PlexiDraw — vector and painting, any artboard',
      icon: 'brush',
      kind: 'action',
      score: q === '' ? 55 : matchScore('new artwork drawing plexidraw illustrator photoshop vector paint brush pen bezier path illustration logo icon create', q),
      run: () => {
        setActive(null)
        goDraw()
        closePalette()
      }
    })
    // Global quick-create: "New <module item>" from anywhere. Each sets a pending
    // request and navigates; the module creates the item as it opens, so there is
    // no separate "start new" screen to click through.
    const createTargets: Array<{ id: string; label: string; words: string; icon: string; key: string; viewKind: string; go: () => void }> = [
      { id: 'new-project', label: 'New plan', words: 'new plan project gantt timeline create', icon: 'account_tree', key: 'projects', viewKind: 'plexidesk', go: () => goPlexiDesk('plans') },
      { id: 'new-flow', label: 'New flow', words: 'new flow automation create', icon: 'bolt', key: 'flows', viewKind: 'plexibrain', go: () => goPlexiBrain('flows') },
      { id: 'new-meeting', label: 'Start a meeting', words: 'new meeting meet call video start', icon: 'video_call', key: 'meet', viewKind: 'office', go: () => goOffice('meet') },
      // The remaining createable types. Their views already consume these keys
      // (PlexiReportsView / PlexiFormsView / PlexiBuildView / PlexiSignView /
      // MailView), so every "New <thing>" in the app is one palette command.
      { id: 'new-report', label: 'New report', words: 'new report insight dashboard create', icon: 'monitoring', key: 'reports', viewKind: 'plexibrain', go: goReports },
      { id: 'new-form', label: 'New form', words: 'new form survey intake create', icon: 'assignment', key: 'forms', viewKind: 'office', go: goForms },
      { id: 'new-app', label: 'New app', words: 'new app build no-code tool create', icon: 'construction', key: 'build', viewKind: 'plexibrain', go: goApps },
      { id: 'new-sign', label: 'New signature request', words: 'new sign signature request esign send document create', icon: 'draw', key: 'sign', viewKind: 'office', go: goSign },
      { id: 'compose-mail', label: 'Compose mail', words: 'new mail email compose write send message', icon: 'edit_note', key: 'mail', viewKind: 'office', go: () => goMail() }
    ]
    for (const t of createTargets) {
      items.push({
        id: t.id,
        label: t.label,
        hint: 'Create and open it',
        icon: t.icon,
        kind: 'action',
        score: (q === '' ? 57 : matchScore(t.words, q)) + recBonus(t.viewKind),
        run: () => {
          requestCreate(t.key)
          setActive(null)
          t.go()
          closePalette()
        }
      })
    }
    // Office files create directly (no quick-create detour): a blank file exists
    // the moment the command runs and opens straight into its editor.
    const docTargets: Array<{ id: string; label: string; words: string; icon: string; docType: 'doc' | 'sheet' | 'slides' }> = [
      { id: 'new-document', label: 'New document', words: 'new document doc write text word create', icon: 'description', docType: 'doc' },
      { id: 'new-sheet', label: 'New spreadsheet', words: 'new spreadsheet sheet table excel create', icon: 'table_chart', docType: 'sheet' },
      { id: 'new-deck', label: 'New presentation', words: 'new presentation deck slides powerpoint create', icon: 'slideshow', docType: 'slides' }
    ]
    for (const t of docTargets) {
      items.push({
        id: t.id,
        label: t.label,
        hint: 'Create and open it',
        icon: t.icon,
        kind: 'action',
        score: (q === '' ? 57 : matchScore(t.words, q)) + recBonus('office'),
        run: () => {
          // Gate the office create on the editor's entitlement. A locked
          // editor never creates; a licensing gap offers the upgrade.
          const ent = entitlementFor(capabilityForDocType(t.docType), DOC_TYPE_LABEL[t.docType])
          if (!ent.enabled) {
            closePalette()
            ent.onLockedClick()
            return
          }
          setActive(null)
          closePalette()
          void useDocumentsStore
            .getState()
            .createBlank(t.docType)
            .then((doc) => goDocument(doc.id))
        }
      })
    }
    items.push({
      id: 'body-double',
      label: 'Find a body double',
      hint: 'Pair with someone to focus together',
      icon: 'diversity_3',
      kind: 'action',
      score: q === '' ? 75 : matchScore('body double pair partner focus together', q),
      run: () => {
        onOpenBodyDouble()
        closePalette()
      }
    })
    if (canSmartStack) {
      items.push({
        id: 'smart-stack',
        label: 'Smart Stack',
        hint: 'Group widgets into sections by AI',
        icon: 'hub',
        kind: 'action',
        score: q === '' ? 65 : matchScore('smart stack group sections AI', q),
        run: () => {
          onOpenSmartStack()
          closePalette()
        }
      })
    }
    if (activeTaskId) {
      items.push({
        id: 'reset-view',
        label: 'Reset canvas view',
        hint: 'Zoom 100%, pan 0,0',
        icon: 'crop_free',
        kind: 'action',
        score: q === '' ? 50 : matchScore('reset zoom view canvas pan', q),
        run: () => {
          setZoom(1)
          setPan(0, 0)
          closePalette()
        }
      })
      items.push({
        id: 'toggle-snap',
        label: getNavPrefs().snapToGridEnabled ? 'Snap to grid: on (turn off)' : 'Snap to grid: off (turn on)',
        hint: 'Round dragged widgets to an 8px grid',
        icon: 'grid_4x4',
        kind: 'action',
        score: q === '' ? 48 : matchScore('snap grid align canvas', q),
        run: () => {
          setNavPrefs({ snapToGridEnabled: !getNavPrefs().snapToGridEnabled })
          closePalette()
        }
      })
      // "Add <widget>" for every picker-visible kind, driven by the catalog so
      // the palette always matches the picker. The quick-add shortcut (if any)
      // is shown in the row and works directly on the canvas.
      for (const entry of WIDGET_CATALOG) {
        if (entry.hideFromPicker) continue
        // Match the picker's core/Advanced tiering: at an empty query only the
        // CORE kinds show, keeping the default palette uncluttered; Advanced kinds
        // stay fully reachable the moment the user types (scored below).
        if (q === '' && isAdvancedKind(entry.kind)) continue
        const sc = effectiveQuickAddMap()[entry.kind]
        items.push({
          id: `add-${entry.kind}`,
          label: `Add ${entry.label}`,
          hint: entry.hint,
          icon: entry.icon,
          kind: 'action',
          score: q === '' ? 40 : matchScore(`add ${entry.label} ${entry.kind} widget ${entry.category}`, q),
          shortcut: sc,
          run: () => {
            spawnWidget(entry.kind)
            closePalette()
          }
        })
      }
    }

    // Empty query → list every folder + task for browsing (capped). For a real
    // query, deep search (below) owns node results too, so they rank correctly
    // by title/description match rather than appearing twice.
    if (q === '') {
      let added = 0
      for (const n of nodes) {
        if (n.archived) continue
        if (n.kind === 'work_item') continue // never browsable as a desk (S1)
        if (added >= 60) break
        const isFolder = n.kind === 'folder'
        items.push({
          id: `node-${n.id}`,
          label: n.title || (isFolder ? '(untitled folder)' : '(untitled task)'),
          hint: isFolder ? 'Open folder' : 'Open task',
          icon: isFolder ? 'folder' : 'task_alt',
          kind: 'jump',
          score: 30 + (n.kind === 'task' && n.status !== 'done' ? 5 : 0),
          run: () => {
            if (isFolder) goProject(n.id)
            else {
              setActive(n.id)
              goTask(n.id)
            }
            closePalette()
          }
        })
        added++
      }
    }

    // Desks and rooms straight from the in-memory store, matched by name.
    //
    // Deep search owns node results when there is a query, but it reads an
    // index written after the fact -- so a desk created seconds ago was not
    // findable by its own exact title, which is exactly when someone looks for
    // it. The store updates synchronously on create and rename, so matching it
    // here makes a new or renamed desk findable immediately, with no separate
    // index to keep transactional. Deep hits still outrank these, and the two
    // are deduplicated.
    if (q !== '') {
      const seen = new Set(deepHits.map((h) => `${h.type}-${h.id}`))
      // Same-named desks are the reported ambiguity: two "Plexii Marketing"
      // desks, one holding five objects and one ten, told apart by nothing.
      const byTitle = new Map<string, number>()
      for (const n of nodes) {
        if (n.archived || n.kind === 'work_item') continue
        const t = (n.title || '').trim().toLowerCase()
        if (t) byTitle.set(t, (byTitle.get(t) ?? 0) + 1)
      }
      for (const n of nodes) {
        if (n.archived || n.kind === 'work_item') continue
        const isFolder = n.kind === 'folder'
        if (seen.has(`${isFolder ? 'folder' : 'task'}-${n.id}`)) continue
        const score = Math.max(
          matchScore(n.title || '', q),
          matchScore(n.description || '', q) * 0.6
        )
        if (score <= 0) continue
        const duplicate = (byTitle.get((n.title || '').trim().toLowerCase()) ?? 0) > 1
        const room = n.parentId ? nodes.find((pn) => pn.id === n.parentId)?.title : null
        // Spend the disambiguating detail only where it is needed, so the
        // common case stays a clean one-line hint.
        const parts = [isFolder ? 'Open folder' : 'Open desk']
        if (duplicate) {
          if (room) parts.push(room)
          if (!isFolder && n.status) parts.push(String(n.status).replace('_', ' '))
          const count = deskObjectCounts[n.id]
          if (typeof count === 'number') parts.push(`${count} object${count === 1 ? '' : 's'}`)
        }
        items.push({
          id: `node-${n.id}`,
          label: n.title || (isFolder ? '(untitled folder)' : '(untitled desk)'),
          hint: parts.join(' · '),
          icon: isFolder ? 'folder' : 'task_alt',
          kind: 'jump',
          // Below a strong deep hit, above the static nav rows.
          score: 120 + score / 2,
          run: () => {
            if (isFolder) goProject(n.id)
            else {
              setActive(n.id)
              goTask(n.id)
            }
            closePalette()
          }
        })
      }
    }


    // Deep content search — anything the main process found in note/page/doc
    // bodies, table cells, file names, and node descriptions. Ranked above the
    // static commands when there's a real query, since this is what the user is
    // usually after. Each routes to where the match lives.
    for (const h of deepHits) {
      items.push({
        id: `hit-${h.type}-${h.id}`,
        label: h.title,
        hint: h.snippet ? `${hitKindLabel(h)} · ${h.snippet}` : hitKindLabel(h),
        icon: hitIcon(h),
        kind: 'action',
        // h.score (0..1000+) scaled so a strong content/title match sits at the
        // top, a weak body match still above the static nav items.
        score: 140 + h.score / 8,
        run: () => {
          runHit(h, {
            goProject,
            goTask,
            goDocument,
            goFiles,
            goKnowledge,
            goCalendar,
            goMeet: () => goOffice('meet'),
            goSign,
            goMailHit: (uid) => goMail(uid),
            setActive
          })
          closePalette()
        }
      })
    }

    // The omnibar routes (A2, AI-01, R11-R13): the palette is the one door,
    // so the three routes the workspace could not answer live here — a URL
    // opens in the in-app web panel, a phrase can search the web, a question
    // goes to Plexii. Ranking encodes the intent preview: an address or a
    // question outranks everything (Enter does what the shape of the input
    // says); a bare phrase's web search sits above static nav but below a
    // strong workspace hit, so naming a document still goes to the document
    // and Tab/arrows reach the web in one step. Never on an empty query.
    // DEC-031: an @attention token is an explicit address to Attention. The
    // omni rows must not compete with it — "Ask Plexii" hard-scores 2000 when
    // the input reads as a question, which is exactly how the operator's
    // "…by friday @attention" lost to a 30s model round trip that filed
    // nothing. No omni row is offered while the token is present.
    if (q !== '' && !attnAddressed) {
      const intents = classifyOmniInput(query, [])
      const lead = intents[0]?.kind
      for (const intent of intents) {
        if (intent.kind === 'goto') continue // the palette's own rows navigate
        const top = intent.kind === lead && (lead === 'url' || lead === 'ask')
        items.push({
          id: `omni-${intent.kind}`,
          label:
            intent.kind === 'url'
              ? intent.label
              : intent.kind === 'search'
                ? `Search the web — “${query.trim()}”`
                : `Ask Plexii — “${query.trim()}”`,
          hint:
            intent.kind === 'url'
              ? 'Opens in Plexii'
              : intent.kind === 'search'
                ? 'Web results in Plexii'
                : 'Plexii answers in the side panel',
          icon: intent.kind === 'url' ? 'language' : intent.kind === 'search' ? 'travel_explore' : 'forum',
          kind: 'action',
          score: top ? 2000 : intent.kind === 'search' ? 175 : 60,
          run: () => {
            const text = query.trim()
            if (intent.kind === 'url' && intent.url) {
              useWebPanel.getState().openWeb(intent.url, { expanded: true })
            } else if (intent.kind === 'search') {
              useWebPanel
                .getState()
                .openWeb(searchUrl(useWebPanel.getState().engine, text), { expanded: true })
            } else {
              useAssistantChrome.getState().openPanel()
              void useChatStore.getState().send(null, text, NEW_CHAT_KEY)
            }
            closePalette()
          }
        })
      }
    }

    const ranked = items
      .filter((i) => (q === '' ? true : i.score > 0))
      .sort((a, b) => b.score - a.score)
    // Empty query shows the FULL list so every command — each Add-widget entry,
    // all navigation, every desk/task — is scrollable and findable by eye, not
    // just a top slice. A search query is self-limiting, but cap it generously
    // so a single common letter can't render hundreds of rows at once.
    return q === '' ? ranked : ranked.slice(0, 50)
  }, [
    query,
    nodes,
    deskObjectCounts,
    workItemsOn,
    canSmartStack,
    activeTaskId,
    onOpenBodyDouble,
    onOpenSmartStack,
    setActive,
    goHome,
    goAllTasks,
    goProjects,
    goCalendar,
    goVault,
    goTask,
    goProject,
    goFiles,
    goDesign,
    goDraw,
    goOffice,
    goPlexiDesk,
    goPlexiPeople,
    goPlexiBrain,
    goDocument,
    goKnowledge,
    goReports,
    goForms,
    goApps,
    goSign,
    goMail,
    requestCreate,
    spawnWidget,
    deepHits,
    setZoom,
    setPan,
    editorCommands,
    editorScope
  ])

  // Clamp highlight within results length whenever the list changes.
  useEffect(() => {
    if (highlightIdx >= results.length) setHighlightIdx(Math.max(0, results.length - 1))
  }, [results.length, highlightIdx])

  function paletteKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIdx((i) => Math.min(results.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIdx((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const r = results[highlightIdx]
      if (r) r.run()
    }
  }

  return (
    <>
      {/* The bottom pill was removed: adding objects now lives on the desk (the
          Add-widget button + the canvas + FAB) and everything else is in this
          palette, opened by ⌘K or the top-bar Search button. */}

      {/* Palette overlay — when open */}
      {paletteOpen &&
        createPortal(
          <div
            className="fb-scrim fixed inset-0 z-[200] flex items-start justify-center pt-[18vh]"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) closePalette()
            }}
            role="dialog"
            aria-label="Command palette"
            aria-modal="true"
          >
            <div
              className="fb-card w-[520px] max-w-[88vw] max-h-[60vh] flex flex-col overflow-hidden"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--edge-soft)]">
                <Icon name="search" size={14} className="text-[var(--ink-50)] shrink-0" />
                {editorScope && editorCommands.length > 0 && (
                  <span
                    className="shrink-0 inline-flex items-center gap-1 text-[11px] font-medium text-accent bg-accent/10 border border-accent/20 rounded-md px-1.5 py-0.5"
                    title={`Commands here drive the active ${editorScope.toLowerCase()}`}
                  >
                    <Icon name="bolt" size={11} />
                    {editorScope}
                  </span>
                )}
                <input
                  ref={inputRef}
                  data-testid="command-palette-input"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setHighlightIdx(0)
                  }}
                  onKeyDown={paletteKeyDown}
                  placeholder={
                    editorScope && editorCommands.length > 0
                      ? `Command the ${editorScope.toLowerCase()}, or search everything…`
                      : 'Search everything — tasks, notes, docs, files, actions…'
                  }
                  className="flex-1 bg-transparent text-[13px] text-[var(--ink-100)] placeholder:text-[var(--ink-40)]"
                />
                <kbd className="text-[10px] font-mono text-[var(--ink-40)] bg-[var(--surface-sunken)] px-1.5 py-0.5 rounded">
                  Esc
                </kbd>
              </div>
              <div className="flex-1 overflow-y-auto">
                {results.length === 0 ? (
                  <div className="px-3 py-8 text-center text-[12px] text-[var(--ink-50)]">
                    Nothing matches "{query}". Try a folder name, task name, or "body double", "calendar", "vault".
                  </div>
                ) : (
                  <div role="listbox">
                    {results.map((r, i) => (
                      <button
                        key={r.id}
                        data-testid={`palette-row-${r.id}`}
                        role="option"
                        aria-selected={i === highlightIdx}
                        onMouseEnter={() => setHighlightIdx(i)}
                        onClick={r.run}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-left ${
                          i === highlightIdx
                            ? 'bg-accent/10'
                            : 'hover:bg-[var(--surface-sunken)]'
                        }`}
                      >
                        <Icon
                          name={r.icon}
                          size={14}
                          className={
                            i === highlightIdx
                              ? 'text-accent shrink-0'
                              : 'text-[var(--ink-50)] shrink-0'
                          }
                        />
                        <div className="flex-1 min-w-0">
                          <div
                            className={`text-[13px] truncate ${
                              i === highlightIdx
                                ? 'text-[var(--ink-100)] font-medium'
                                : 'text-[var(--ink-90)]'
                            }`}
                          >
                            {r.label}
                          </div>
                          <div className="text-[10px] text-[var(--ink-50)] truncate">
                            {r.hint}
                          </div>
                        </div>
                        {r.shortcut && (
                          <kbd className="text-[9px] font-mono text-[var(--ink-50)] bg-[var(--surface-sunken)] px-1 py-0.5 rounded shrink-0">
                            {r.shortcut}
                          </kbd>
                        )}
                        {i === highlightIdx && (
                          <kbd className="text-[9px] font-mono text-[var(--ink-40)] bg-[var(--surface-sunken)] px-1 py-0.5 rounded shrink-0">
                            ↵
                          </kbd>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="px-3 py-2 border-t border-[var(--edge-soft)] text-[10px] text-[var(--ink-50)] flex items-center justify-between">
                <span>
                  <kbd className="font-mono">↑↓</kbd> navigate ·{' '}
                  <kbd className="font-mono">↵</kbd> run
                </span>
                <span>{results.length} result{results.length === 1 ? '' : 's'}</span>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}


// ── Deep-search hit helpers ─────────────────────────────────────────────────

function hitIcon(h: SearchHit): string {
  switch (h.type) {
    case 'folder':
      return 'folder'
    case 'task':
      return 'task_alt'
    case 'document':
      return h.docType === 'sheet' ? 'table_chart' : h.docType === 'slides' ? 'slideshow' : 'description'
    case 'file':
      return 'draft'
    case 'table-row':
      return 'table_chart'
    case 'knowledge':
      return 'neurology'
    case 'event':
      return 'calendar_month'
    case 'meeting':
      return 'video_call'
    case 'sign':
      return 'draw'
    case 'mail':
      return 'mail'
    default:
      return 'widgets' // widget
  }
}

function hitKindLabel(h: SearchHit): string {
  switch (h.type) {
    case 'folder':
      return 'Folder'
    case 'task':
      return 'Task'
    case 'document':
      return h.docType === 'sheet' ? 'Spreadsheet' : h.docType === 'slides' ? 'Slides' : 'Document'
    case 'file':
      return 'File'
    case 'table-row':
      return 'Table'
    case 'knowledge':
      return 'PlexiBrain'
    case 'event':
      return 'Calendar'
    case 'meeting':
      return 'Meeting'
    case 'sign':
      return 'Signature'
    case 'mail':
      return 'Email'
    default:
      return 'On a desk'
  }
}

interface HitNav {
  goProject: (id: string) => void
  goTask: (id: string) => void
  goDocument: (id: string) => void
  goFiles: () => void
  goKnowledge: (entryId?: string) => void
  goCalendar: () => void
  goMeet: () => void
  goSign: () => void
  goMailHit: (uid: number) => void
  setActive: (id: string | null) => void
}

function runHit(h: SearchHit, nav: HitNav): void {
  switch (h.type) {
    case 'folder':
      nav.goProject(h.id)
      break
    case 'task':
      nav.setActive(h.id)
      nav.goTask(h.id)
      break
    case 'widget':
    case 'table-row':
      // Open the canvas the widget / table lives on.
      if (h.taskId) {
        nav.setActive(h.taskId)
        nav.goTask(h.taskId)
      }
      break
    case 'document':
      nav.goDocument(h.id)
      break
    case 'file':
      nav.goFiles()
      break
    case 'knowledge':
      nav.goKnowledge(h.id)
      break
    case 'event':
      nav.goCalendar()
      break
    case 'meeting':
      nav.goMeet()
      break
    case 'sign':
      nav.goSign()
      break
    case 'mail':
      nav.goMailHit(Number(h.id))
      break
  }
}

// Simple substring + word-prefix score. Higher means better match.
// We don't need fuzzy; the palette is for instant recall, not exploration.
function matchScore(haystack: string, q: string): number {
  if (!q) return 0
  const h = haystack.toLowerCase()
  const needle = q.toLowerCase()
  if (h.startsWith(needle)) return 100
  if (h.includes(` ${needle}`)) return 80
  if (h.includes(needle)) return 50
  // Per-word prefix tolerance — let "tre" match "treatment plan".
  const words = h.split(/\s+/)
  const qWords = needle.split(/\s+/)
  let s = 0
  for (const qw of qWords) {
    if (words.some((w) => w.startsWith(qw))) s += 20
  }
  return s
}
