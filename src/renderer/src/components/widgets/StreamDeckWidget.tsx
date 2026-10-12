import { useCallback, useEffect, useRef, useState } from 'react'
import { alertDialog, confirmDialog, showCopyFallback } from '../plexi/PromptDialog'
import type { Widget } from '@shared/types'
import {
  STREAMDECK_COLUMNS,
  STREAMDECK_ROWS,
  STREAMDECK_SLOTS,
  emptyDeckConfig,
  makeButtonId,
  makePageId,
  parseDeckConfig,
  serializeDeckConfig,
  type ActionButton,
  type DeckButton,
  type DeckConfig,
  type DeckPage,
  type FolderButton,
  type StreamDeckAction
} from '@shared/streamdeck'
import { useWidgetStore } from '../../stores/widgets'
import {
  cloneButtonWithNewIds,
  useSpeedDeckStore
} from '../../stores/speeddeck'
import { streamDeckClick } from '../../lib/audioBeep'
import { haptic } from '../../lib/haptics'
import WidgetFrame from './WidgetFrame'
import Icon from '../Icon'
import StreamDeckButtonConfig from './streamdeck/StreamDeckButtonConfig'
import StreamDeckAI from './streamdeck/StreamDeckAI'
import AccessibilityPrompt from './streamdeck/AccessibilityPrompt'

interface Props {
  widget: Widget
  inline?: boolean
}

type Scope = 'task' | 'universal'

// SpeedDeck — Elgato-style 10×3 button grid. Two scopes:
//   - "This task" — config in widget.content, scoped to the host task's canvas
//   - "Universal" — config in userData/speeddeck-universal.json via the
//     speeddeck Zustand store, SHARED by every SpeedDeck widget across
//     every task and folder
//
// Edit mode adds:
//   - drag-and-drop between slots (swap, move, drop into folders)
//   - right-click → Copy / Cut / Paste / Duplicate / Make folder / Remove
//   - cross-deck clipboard (copy from task deck, paste to universal, etc.)
//
// All editor changes route through `mutate(scope, mutator)` which writes
// to the right backing store and persists.

// The scope choice is itself persisted in widget.content alongside the
// task deck, so each SpeedDeck widget remembers which tab the user left
// it on. Wrapper shape:
//   { scope: "task"|"universal", taskDeck: DeckConfig }
interface WidgetContent {
  scope: Scope
  taskDeck: DeckConfig
}

function parseWidgetContent(raw: string | null | undefined): WidgetContent {
  if (!raw) return { scope: 'task', taskDeck: emptyDeckConfig() }
  try {
    const parsed = JSON.parse(raw) as Partial<WidgetContent> & { _version?: number }
    // Backwards-compat: older SpeedDeck widgets stored the deck directly
    // in widget.content without the wrapper. If we see a top-level
    // _version field, treat the WHOLE thing as the task deck.
    if (parsed._version !== undefined) {
      return { scope: 'task', taskDeck: parsed as unknown as DeckConfig }
    }
    return {
      scope: parsed.scope === 'universal' ? 'universal' : 'task',
      taskDeck: parsed.taskDeck
        ? parseDeckConfig(JSON.stringify(parsed.taskDeck))
        : emptyDeckConfig()
    }
  } catch {
    return { scope: 'task', taskDeck: emptyDeckConfig() }
  }
}

function serializeWidgetContent(content: WidgetContent): string {
  return JSON.stringify(content)
}

export default function StreamDeckWidget({ widget, inline = false }: Props): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const universal = useSpeedDeckStore((s) => s.universal)
  const hydrated = useSpeedDeckStore((s) => s.hydrated)
  const hydrate = useSpeedDeckStore((s) => s.hydrate)
  const mutateUniversal = useSpeedDeckStore((s) => s.mutateUniversal)
  const clipboard = useSpeedDeckStore((s) => s.clipboard)
  const setClipboard = useSpeedDeckStore((s) => s.setClipboard)

  // Hydrate the universal store once. Cheap — it's an idempotent IPC.
  useEffect(() => {
    void hydrate()
  }, [hydrate])

  const [content, setContent] = useState<WidgetContent>(() =>
    parseWidgetContent(widget.content)
  )
  useEffect(() => {
    setContent(parseWidgetContent(widget.content))
  }, [widget.content])

  // Debounced persist for the widget-stored (task) config.
  const persistTimer = useRef<number | null>(null)
  const persistTaskContent = useCallback(
    (next: WidgetContent) => {
      if (persistTimer.current !== null) window.clearTimeout(persistTimer.current)
      persistTimer.current = window.setTimeout(() => {
        void update(widget.id, { content: serializeWidgetContent(next) })
        persistTimer.current = null
      }, 350)
    },
    [update, widget.id]
  )

  // The "live" deck: the one the user is currently looking at, picked by
  // the scope toggle.
  const liveDeck: DeckConfig =
    content.scope === 'universal'
      ? universal ?? emptyDeckConfig()
      : content.taskDeck

  // Mutate the live deck. Routes to either the universal store or the
  // widget.content depending on scope. Returns void; the resulting
  // DeckConfig is read back from the relevant store on next render.
  const mutate = useCallback(
    (mutator: (draft: DeckConfig) => DeckConfig): void => {
      if (content.scope === 'universal') {
        void mutateUniversal(mutator)
      } else {
        setContent((prev) => {
          const next: WidgetContent = {
            ...prev,
            taskDeck: mutator(prev.taskDeck)
          }
          persistTaskContent(next)
          return next
        })
      }
    },
    [content.scope, mutateUniversal, persistTaskContent]
  )

  // Switch scope. Persists the choice so the same widget remembers next
  // session, but doesn't touch the underlying decks.
  const setScope = useCallback(
    (scope: Scope) => {
      setContent((prev) => {
        const next = { ...prev, scope }
        persistTaskContent(next)
        return next
      })
      setPageStack([scope === 'universal' ? (universal?.rootPageId ?? 'root') : content.taskDeck.rootPageId])
    },
    [content.taskDeck.rootPageId, universal, persistTaskContent]
  )

  const [pageStack, setPageStack] = useState<string[]>(() => [
    liveDeck.rootPageId
  ])
  // Reset stack if the underlying deck swaps (e.g. user switches scope
  // and the root page id changes).
  useEffect(() => {
    if (!liveDeck.pages[pageStack[pageStack.length - 1]]) {
      setPageStack([liveDeck.rootPageId])
    }
  }, [liveDeck, pageStack])

  const [editing, setEditing] = useState(false)
  const [editingSlot, setEditingSlot] = useState<number | null>(null)
  const [firingSlot, setFiringSlot] = useState<number | null>(null)
  const [errorByButton, setErrorByButton] = useState<Record<string, string>>({})
  const [aiOpen, setAiOpen] = useState(false)
  const [needsAccessibility, setNeedsAccessibility] = useState(false)

  // Right-click menu state — slot-level (one button) and deck-level
  // (the deck background, for share/export/import/reset actions).
  const [ctxMenu, setCtxMenu] = useState<{
    slot: number
    x: number
    y: number
    button: DeckButton | undefined
  } | null>(null)
  const [deckCtxMenu, setDeckCtxMenu] = useState<{ x: number; y: number } | null>(null)
  // Accessibility prompt modal — replaces the inline banner. Modal is
  // more compelling because it shows clear manual instructions AND
  // polls the permission state every 1.5s so it self-dismisses.
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Drag-drop state — which slot is being dragged, and which slot the
  // cursor is currently hovering. Used for highlight + drop semantics.
  const dragSourceRef = useRef<number | null>(null)
  const [dragOverSlot, setDragOverSlot] = useState<number | null>(null)
  // Track whether the user is dragging onto the "Back" affordance (move
  // a button out of the current folder, into the parent page).
  const [dragOverBack, setDragOverBack] = useState(false)

  const currentPageId = pageStack[pageStack.length - 1]
  const currentPage: DeckPage | null = liveDeck.pages[currentPageId] ?? null

  const navigateInto = useCallback(
    (folderButton: FolderButton): void => {
      if (!liveDeck.pages[folderButton.pageId]) {
        mutate((draft) => ({
          ...draft,
          pages: {
            ...draft.pages,
            [folderButton.pageId]: {
              id: folderButton.pageId,
              name: folderButton.label || 'Folder',
              buttons: {}
            }
          }
        }))
      }
      setPageStack((stack) => [...stack, folderButton.pageId])
    },
    [liveDeck.pages, mutate]
  )

  const navigateUp = useCallback((): void => {
    setPageStack((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack))
  }, [])

  const fireButton = useCallback(
    async (slot: number, button: ActionButton): Promise<void> => {
      streamDeckClick(button.sound ?? liveDeck.settings.defaultSound)
      haptic(button.haptic === 'strong' ? 'medium' : button.haptic === 'none' ? 'light' : 'light')
      setFiringSlot(slot)
      void window.api.activity.logPress({
        label: button.label || '(unnamed)',
        kind: button.action.type
      })
      try {
        const result = await window.api.streamdeck.execute(
          button.action as unknown as StreamDeckAction
        )
        if (!result.ok) {
          if (result.needsAccessibility) {
            setNeedsAccessibility(true)
          } else {
            setErrorByButton((m) => ({ ...m, [button.id]: result.error || 'Action failed' }))
            window.setTimeout(() => {
              setErrorByButton((m) => {
                const next = { ...m }
                delete next[button.id]
                return next
              })
            }, 3000)
          }
        }
      } catch (err) {
        setErrorByButton((m) => ({ ...m, [button.id]: (err as Error).message }))
      } finally {
        window.setTimeout(() => setFiringSlot(null), 180)
      }
    },
    [liveDeck.settings.defaultSound]
  )

  const handleSlotClick = useCallback(
    (slot: number): void => {
      if (!currentPage) return
      const button = currentPage.buttons[slot]
      if (editing) {
        setEditingSlot(slot)
        return
      }
      if (!button) return
      if (button.kind === 'folder') {
        streamDeckClick(liveDeck.settings.defaultSound)
        haptic('light')
        navigateInto(button)
      } else {
        void fireButton(slot, button)
      }
    },
    [currentPage, editing, fireButton, navigateInto, liveDeck.settings.defaultSound]
  )

  const handleSaveButton = useCallback(
    (slot: number, button: DeckButton | null): void => {
      mutate((draft) => {
        const page = draft.pages[currentPageId]
        if (!page) return draft
        const nextButtons = { ...page.buttons }
        if (button == null) {
          delete nextButtons[slot]
        } else {
          nextButtons[slot] = button
          if (button.kind === 'folder' && !draft.pages[button.pageId]) {
            draft.pages[button.pageId] = {
              id: button.pageId,
              name: button.label || 'Folder',
              buttons: {}
            }
          }
        }
        draft.pages[currentPageId] = { ...page, buttons: nextButtons }
        return { ...draft }
      })
      setEditingSlot(null)
    },
    [currentPageId, mutate]
  )

  // ─── Clipboard ops ──────────────────────────────────────────────────

  const copyButton = useCallback(
    (slot: number): void => {
      const btn = currentPage?.buttons[slot]
      if (!btn) return
      setClipboard(btn)
    },
    [currentPage, setClipboard]
  )

  const cutButton = useCallback(
    (slot: number): void => {
      const btn = currentPage?.buttons[slot]
      if (!btn) return
      setClipboard(btn)
      handleSaveButton(slot, null)
    },
    [currentPage, setClipboard, handleSaveButton]
  )

  const pasteButton = useCallback(
    (slot: number): void => {
      if (!clipboard) return
      const result = cloneButtonWithNewIds(clipboard, makePageId, makeButtonId)
      mutate((draft) => {
        const page = draft.pages[currentPageId]
        if (!page) return draft
        const pages = { ...draft.pages }
        if (result.spawnPage) {
          pages[result.spawnPage.id] = {
            id: result.spawnPage.id,
            name: result.spawnPage.name,
            buttons: {}
          }
        }
        pages[currentPageId] = {
          ...page,
          buttons: { ...page.buttons, [slot]: result.button }
        }
        return { ...draft, pages }
      })
    },
    [clipboard, currentPageId, mutate]
  )

  const duplicateButton = useCallback(
    (slot: number): void => {
      const btn = currentPage?.buttons[slot]
      if (!btn) return
      // Find first empty slot; if none, append to last with a swap-style
      // prompt. Here we just look for the next free position; if none,
      // fall back to "replace the same slot" (effectively a clone of
      // self with a new id which is harmless).
      let target = slot
      if (currentPage) {
        for (let i = 0; i < STREAMDECK_SLOTS; i++) {
          if (!currentPage.buttons[i]) {
            target = i
            break
          }
        }
      }
      const result = cloneButtonWithNewIds(btn, makePageId, makeButtonId)
      mutate((draft) => {
        const page = draft.pages[currentPageId]
        if (!page) return draft
        const pages = { ...draft.pages }
        if (result.spawnPage) {
          pages[result.spawnPage.id] = {
            id: result.spawnPage.id,
            name: result.spawnPage.name,
            buttons: {}
          }
        }
        pages[currentPageId] = {
          ...page,
          buttons: { ...page.buttons, [target]: result.button }
        }
        return { ...draft, pages }
      })
    },
    [currentPage, currentPageId, mutate]
  )

  // ─── Drag & drop ────────────────────────────────────────────────────

  const handleDragStart = useCallback(
    (slot: number, e: React.DragEvent<HTMLButtonElement>): void => {
      if (!editing) return
      const btn = currentPage?.buttons[slot]
      if (!btn) return
      dragSourceRef.current = slot
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/fb-speeddeck-slot', String(slot))
    },
    [editing, currentPage]
  )

  const handleDragOver = useCallback(
    (slot: number, e: React.DragEvent<HTMLButtonElement>): void => {
      if (!editing) return
      if (dragSourceRef.current === null) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDragOverSlot(slot)
    },
    [editing]
  )

  const handleDrop = useCallback(
    (slot: number, e: React.DragEvent<HTMLButtonElement>): void => {
      e.preventDefault()
      setDragOverSlot(null)
      const source = dragSourceRef.current
      dragSourceRef.current = null
      if (source === null || source === slot) return
      mutate((draft) => {
        const page = draft.pages[currentPageId]
        if (!page) return draft
        const src = page.buttons[source]
        if (!src) return draft
        const dst = page.buttons[slot]
        const nextButtons = { ...page.buttons }
        // If dropping ONTO a folder: move source INTO that folder's page
        // (if there's room).
        if (dst && dst.kind === 'folder') {
          const targetPage = draft.pages[dst.pageId] ?? {
            id: dst.pageId,
            name: dst.label || 'Folder',
            buttons: {}
          }
          let targetSlot = -1
          for (let i = 0; i < STREAMDECK_SLOTS; i++) {
            if (!targetPage.buttons[i]) {
              targetSlot = i
              break
            }
          }
          if (targetSlot === -1) {
            // Folder full — fall back to swap-into-source behaviour
            nextButtons[source] = dst
            nextButtons[slot] = src
            draft.pages[currentPageId] = { ...page, buttons: nextButtons }
            return { ...draft }
          }
          // Remove from current page, add to folder's page.
          delete nextButtons[source]
          draft.pages[currentPageId] = { ...page, buttons: nextButtons }
          draft.pages[dst.pageId] = {
            ...targetPage,
            buttons: { ...targetPage.buttons, [targetSlot]: src }
          }
          return { ...draft }
        }
        // Otherwise: swap source ↔ destination (handles "drop onto
        // empty slot" too — dst is undefined, so we just move source).
        if (dst) nextButtons[source] = dst
        else delete nextButtons[source]
        nextButtons[slot] = src
        draft.pages[currentPageId] = { ...page, buttons: nextButtons }
        return { ...draft }
      })
    },
    [currentPageId, mutate]
  )

  // Dropping onto the Back chip — move the dragged button to the parent
  // page (one level up the stack). Useful for "move out of folder".
  const handleDropOnBack = useCallback(
    (e: React.DragEvent<HTMLButtonElement>): void => {
      e.preventDefault()
      setDragOverBack(false)
      const source = dragSourceRef.current
      dragSourceRef.current = null
      if (source === null || pageStack.length < 2) return
      const parentPageId = pageStack[pageStack.length - 2]
      mutate((draft) => {
        const page = draft.pages[currentPageId]
        const parent = draft.pages[parentPageId]
        if (!page || !parent) return draft
        const src = page.buttons[source]
        if (!src) return draft
        // Pick first empty slot in parent.
        let target = -1
        for (let i = 0; i < STREAMDECK_SLOTS; i++) {
          if (!parent.buttons[i]) {
            target = i
            break
          }
        }
        if (target === -1) return draft // parent full
        const nextSrc = { ...page.buttons }
        delete nextSrc[source]
        const nextParent = { ...parent.buttons, [target]: src }
        draft.pages[currentPageId] = { ...page, buttons: nextSrc }
        draft.pages[parentPageId] = { ...parent, buttons: nextParent }
        return { ...draft }
      })
    },
    [currentPageId, mutate, pageStack]
  )

  // ─── Render ─────────────────────────────────────────────────────────

  if (!currentPage) {
    return (
      <WidgetFrame widget={widget} headerLabel="SpeedDeck" headerAccent="bg-stone-300/60 dark:bg-white/[0.09]">
        <button
          className="m-2 px-3 py-2 rounded bg-accent text-white text-[12px]"
          onClick={() => {
            const fresh = emptyDeckConfig()
            if (content.scope === 'universal') {
              void mutateUniversal(() => fresh)
            } else {
              const next: WidgetContent = { ...content, taskDeck: fresh }
              setContent(next)
              persistTaskContent(next)
            }
            setPageStack([fresh.rootPageId])
          }}
        >
          Reset deck
        </button>
      </WidgetFrame>
    )
  }

  // Deck-level handlers — share, export, import, reset.
  const exportDeck = (): void => {
    const json = serializeDeckConfig(liveDeck)
    const filename = `speeddeck-${content.scope}-${Date.now()}.json`
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }
  const copyDeckJson = async (): Promise<void> => {
    const json = serializeDeckConfig(liveDeck)
    try {
      await navigator.clipboard.writeText(json)
    } catch {
      await showCopyFallback('Copy this deck JSON manually', json)
    }
  }
  const importDeck = (): void => {
    fileInputRef.current?.click()
  }
  const resetDeck = async (): Promise<void> => {
    if (!(await confirmDialog({
      title: `Reset the ${content.scope === 'universal' ? 'Universal' : 'Task'} deck?`,
      body: 'This wipes every button and folder on the deck.',
      confirmLabel: 'Reset deck',
      danger: true
    }))) {
      return
    }
    const fresh = emptyDeckConfig()
    if (content.scope === 'universal') {
      void mutateUniversal(() => fresh)
    } else {
      const next: WidgetContent = { ...content, taskDeck: fresh }
      setContent(next)
      persistTaskContent(next)
    }
    setPageStack([fresh.rootPageId])
  }

  const body = (
    <div
      className="h-full w-full p-2 flex flex-col gap-2"
      style={{
        background:
          'radial-gradient(ellipse at top, rgba(139, 92, 246, 0.06) 0%, transparent 60%), #0a0e1e'
      }}
      data-speeddeck-root
      onContextMenu={(e) => {
        // Only fire deck-level menu when the right-click isn't on a tile
        // (tiles have their own onContextMenu handler and stopPropagation
        // happens via React's default event flow when a button handles it).
        if ((e.target as HTMLElement).closest('[data-speeddeck-slot]')) return
        e.preventDefault()
        setDeckCtxMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      {/* Top row — scope toggle + folder breadcrumb + actions */}
      <div className="flex items-center gap-1.5 px-1">
        {/* Scope toggle */}
        <div
          className="inline-flex items-center p-0.5 rounded gap-0.5"
          style={{
            background: 'rgba(0,0,0,0.32)',
            border: '1px solid rgba(255,255,255,0.06)'
          }}
        >
          <button
            onClick={() => setScope('task')}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
              content.scope === 'task'
                ? 'bg-accent/20 text-accent'
                : 'text-stone-400 hover:text-stone-100'
            }`}
            title="Buttons that live with this task only"
          >
            <Icon name="task_alt" size={10} className="inline-block mr-0.5" />
            Task
          </button>
          <button
            onClick={() => setScope('universal')}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
              content.scope === 'universal'
                ? 'bg-accent/20 text-accent'
                : 'text-stone-400 hover:text-stone-100'
            }`}
            title={
              hydrated
                ? 'Buttons that follow you across every task and folder'
                : 'Loading universal deck…'
            }
          >
            <Icon name="public" size={10} className="inline-block mr-0.5" />
            Universal
          </button>
        </div>

        {pageStack.length > 1 ? (
          <button
            onClick={navigateUp}
            onDragOver={(e) => {
              if (!editing || dragSourceRef.current === null) return
              e.preventDefault()
              setDragOverBack(true)
            }}
            onDragLeave={() => setDragOverBack(false)}
            onDrop={handleDropOnBack}
            className={`h-6 px-1.5 inline-flex items-center gap-0.5 rounded text-[11px] text-stone-300 hover:bg-white/[0.05] ${
              dragOverBack ? 'ring-1 ring-accent bg-accent/10' : ''
            }`}
            title={
              editing
                ? 'Drop a button here to move it to the parent folder'
                : 'Back to parent folder'
            }
          >
            <Icon name="arrow_back" size={12} />
            <span className="max-w-[80px] truncate">
              {liveDeck.pages[pageStack[pageStack.length - 2]]?.name || 'Back'}
            </span>
          </button>
        ) : (
          <span className="text-[10px] uppercase tracking-[0.16em] text-stone-500 font-semibold pl-1">
            SpeedDeck
          </span>
        )}
        <span className="text-[11px] text-stone-200 font-medium px-1.5 truncate flex-1 min-w-0">
          {pageStack.length > 1 ? currentPage.name : ''}
        </span>
        {clipboard && editing && (
          <span
            className="text-[9px] px-1.5 py-0.5 rounded font-mono"
            style={{
              background: 'rgba(139,92,246,0.10)',
              color: '#c4b5fd',
              border: '1px solid rgba(139,92,246,0.25)'
            }}
            title="A button is on the clipboard — right-click any slot to paste"
          >
            📋 {clipboard.label || '(unnamed)'}
          </span>
        )}
        <button
          onClick={() => setAiOpen(true)}
          className="h-6 px-2 inline-flex items-center gap-1 rounded text-[10px] font-medium text-accent hover:bg-accent/15 transition-colors"
          title="Build a macro with AI, or get suggestions from your activity"
        >
          <Icon name="auto_awesome" size={11} />
          <span>AI</span>
        </button>
        <button
          onClick={() => {
            setEditing((v) => !v)
            setEditingSlot(null)
            setCtxMenu(null)
          }}
          className={`h-6 px-2 inline-flex items-center gap-1 rounded text-[10px] font-medium transition-colors ${
            editing
              ? 'bg-accent text-white'
              : 'text-stone-300 hover:bg-white/[0.06]'
          }`}
          title={editing ? 'Done editing' : 'Edit deck'}
        >
          <Icon name={editing ? 'check' : 'tune'} size={11} />
          <span>{editing ? 'Done' : 'Edit'}</span>
        </button>
        {/* Visible deck-menu trigger so users don't have to discover
            the right-click affordance to reach share / export / import /
            reset / accessibility actions. */}
        <button
          onClick={(e) => {
            const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
            setDeckCtxMenu({ x: rect.left, y: rect.bottom + 4 })
          }}
          className="h-6 w-6 inline-flex items-center justify-center rounded text-stone-300 hover:bg-white/[0.06]"
          title="More — share, export, import, reset, fix permissions"
          aria-label="More options"
        >
          <Icon name="more_horiz" size={14} />
        </button>
      </div>

      {/* Accessibility prompt: full modal (not inline banner) so it's
          attention-grabbing AND can poll for the permission state to
          auto-dismiss. Opens when an action fails with needsAccessibility. */}
      <AccessibilityPrompt open={needsAccessibility} onClose={() => setNeedsAccessibility(false)} />

      {/* Hidden file input for the "Import deck" flow. We use the
          standard FilePicker so the user gets the native dialog +
          recent-files history. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (!file) return
          void file.text().then((text) => {
            try {
              const imported = parseDeckConfig(text)
              if (content.scope === 'universal') {
                void mutateUniversal(() => imported)
              } else {
                const next: WidgetContent = { ...content, taskDeck: imported }
                setContent(next)
                persistTaskContent(next)
              }
              setPageStack([imported.rootPageId])
            } catch (err) {
              void alertDialog({ title: 'Could not import deck', body: (err as Error).message })
            }
            // Reset the input so the same file can be re-imported.
            if (fileInputRef.current) fileInputRef.current.value = ''
          })
        }}
      />

      {/* Grid */}
      <div className="flex-1 min-h-0 flex items-center justify-center">
        <div
          className="grid w-full h-full"
          style={{
            gridTemplateColumns: `repeat(${STREAMDECK_COLUMNS}, 1fr)`,
            gridTemplateRows: `repeat(${STREAMDECK_ROWS}, 1fr)`,
            gap: '6px',
            maxWidth: '100%'
          }}
        >
          {Array.from({ length: STREAMDECK_SLOTS }).map((_, slot) => {
            const button = currentPage.buttons[slot]
            const isFiring = firingSlot === slot
            const isEditingThis = editingSlot === slot
            const error = button ? errorByButton[button.id] : undefined
            const isDragOver = dragOverSlot === slot
            return (
              <SlotTile
                key={slot}
                slot={slot}
                button={button}
                editing={editing}
                isEditingThis={isEditingThis}
                isFiring={isFiring}
                isDragOver={isDragOver}
                error={error}
                glow={liveDeck.settings.glow}
                onClick={() => handleSlotClick(slot)}
                onContextMenu={(e) => {
                  if (!editing) return
                  e.preventDefault()
                  setCtxMenu({ slot, x: e.clientX, y: e.clientY, button })
                }}
                onDragStart={(e) => handleDragStart(slot, e)}
                onDragOver={(e) => handleDragOver(slot, e)}
                onDragLeave={() => {
                  if (dragOverSlot === slot) setDragOverSlot(null)
                }}
                onDrop={(e) => handleDrop(slot, e)}
              />
            )
          })}
        </div>
      </div>

      {editing && (
        <div className="text-[10px] text-stone-400 px-1 leading-snug">
          Click any slot to configure. Drag to reorder. Right-click for copy / paste / duplicate / make folder.
          {content.scope === 'universal' && (
            <span className="text-accent/80">
              {' '}Editing the Universal deck — these buttons appear in every SpeedDeck across every task.
            </span>
          )}
        </div>
      )}

      {/* AI dialog */}
      <StreamDeckAI
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        deck={liveDeck}
        currentPageId={currentPageId}
        onSaveButton={(slot, button) => {
          handleSaveButton(slot, button)
          setAiOpen(false)
        }}
        onSaveFolderWithChildren={(slot, folder, children) => {
          mutate((draft) => {
            const page = draft.pages[currentPageId]
            if (!page) return draft
            const childPage = {
              id: folder.pageId,
              name: folder.label || 'Folder',
              buttons: {} as Record<number, ActionButton>
            }
            for (const c of children) {
              childPage.buttons[c.position] = c.button
            }
            return {
              ...draft,
              pages: {
                ...draft.pages,
                [currentPageId]: {
                  ...page,
                  buttons: { ...page.buttons, [slot]: folder }
                },
                [folder.pageId]: childPage
              }
            }
          })
          setAiOpen(false)
        }}
      />

      {/* Per-button config dialog */}
      {editingSlot !== null && (
        <StreamDeckButtonConfig
          slot={editingSlot}
          existing={currentPage.buttons[editingSlot] ?? null}
          deck={liveDeck}
          onSave={(b) => handleSaveButton(editingSlot, b)}
          onCancel={() => setEditingSlot(null)}
          onMakeFolder={(label, style) => {
            const pageId = makePageId()
            const newButton: FolderButton = {
              id: makeButtonId(),
              kind: 'folder',
              label: label || 'Folder',
              style,
              pageId
            }
            handleSaveButton(editingSlot, newButton)
          }}
        />
      )}

      {/* Right-click menu — copy/cut/paste/duplicate/make folder/remove */}
      {ctxMenu && (
        <SlotContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          hasButton={!!ctxMenu.button}
          hasClipboard={!!clipboard}
          onClose={() => setCtxMenu(null)}
          onCopy={() => copyButton(ctxMenu.slot)}
          onCut={() => cutButton(ctxMenu.slot)}
          onPaste={() => pasteButton(ctxMenu.slot)}
          onDuplicate={() => duplicateButton(ctxMenu.slot)}
          onMakeFolder={() => {
            const pageId = makePageId()
            const folder: FolderButton = {
              id: makeButtonId(),
              kind: 'folder',
              label: 'Folder',
              style: { icon: 'folder', color: '#8b5cf6' },
              pageId
            }
            handleSaveButton(ctxMenu.slot, folder)
          }}
          onRemove={() => handleSaveButton(ctxMenu.slot, null)}
          onConfigure={() => setEditingSlot(ctxMenu.slot)}
        />
      )}

      {/* Deck-level right-click menu — share, export, import, reset.
          Fires when the user right-clicks the deck background (not a tile). */}
      {deckCtxMenu && (
        <DeckContextMenu
          x={deckCtxMenu.x}
          y={deckCtxMenu.y}
          scope={content.scope}
          onClose={() => setDeckCtxMenu(null)}
          onExport={exportDeck}
          onCopyJson={() => void copyDeckJson()}
          onImport={importDeck}
          onReset={resetDeck}
          onOpenAccessibility={() => setNeedsAccessibility(true)}
        />
      )}
    </div>
  )

  if (inline) return body
  return (
    <WidgetFrame widget={widget} headerLabel="SpeedDeck" headerAccent="bg-violet-500/15">
      {body}
    </WidgetFrame>
  )
}

// ─── Deck-level right-click menu (share / export / import / reset) ────

interface DeckCtxMenuProps {
  x: number
  y: number
  scope: Scope
  onClose: () => void
  onExport: () => void
  onCopyJson: () => void
  onImport: () => void
  onReset: () => void
  onOpenAccessibility: () => void
}

function DeckContextMenu(props: DeckCtxMenuProps): JSX.Element {
  useEffect(() => {
    const handle = (e: MouseEvent | KeyboardEvent): void => {
      if ('key' in e && e.key === 'Escape') {
        props.onClose()
        return
      }
      if ('clientX' in e) {
        const el = document.getElementById('fb-speeddeck-deck-ctxmenu')
        if (el && !el.contains(e.target as Node)) props.onClose()
      }
    }
    document.addEventListener('mousedown', handle, true)
    document.addEventListener('keydown', handle, true)
    return () => {
      document.removeEventListener('mousedown', handle, true)
      document.removeEventListener('keydown', handle, true)
    }
  }, [props])

  const run = (fn: () => void): void => {
    fn()
    props.onClose()
  }

  const scopeLabel = props.scope === 'universal' ? 'Universal deck' : 'Task deck'

  return (
    <div
      id="fb-speeddeck-deck-ctxmenu"
      className="fixed z-[260] rounded-md py-1 min-w-[220px]"
      style={{
        left: props.x,
        top: props.y,
        background: 'rgba(20, 28, 48, 0.96)',
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow:
          'inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 0 0 1px rgba(139, 92, 246, 0.12), 0 16px 48px -12px rgba(0,0,0,0.6)'
      }}
    >
      <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-stone-500 font-semibold border-b border-white/[0.04] mb-1">
        {scopeLabel}
      </div>
      <DeckMenuItem
        icon="share"
        label="Copy deck JSON"
        sub="Paste-share with another PlexiDesk user"
        onClick={() => run(props.onCopyJson)}
      />
      <DeckMenuItem
        icon="download"
        label="Export deck to file…"
        sub="Save as .json to share or back up"
        onClick={() => run(props.onExport)}
      />
      <DeckMenuItem
        icon="upload"
        label="Import deck from file…"
        sub="Replaces the current deck"
        onClick={() => run(props.onImport)}
      />
      <div className="h-px bg-white/[0.06] my-1" />
      <DeckMenuItem
        icon="key"
        label="Accessibility permission…"
        sub="Re-open the macOS permission prompt"
        onClick={() => run(props.onOpenAccessibility)}
      />
      <div className="h-px bg-white/[0.06] my-1" />
      <DeckMenuItem
        icon="restart_alt"
        label="Reset deck…"
        sub="Wipe every button and folder"
        destructive
        onClick={() => run(props.onReset)}
      />
    </div>
  )
}

function DeckMenuItem({
  icon,
  label,
  sub,
  destructive,
  onClick
}: {
  icon: string
  label: string
  sub?: string
  destructive?: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`w-full px-3 py-1.5 text-left flex items-center gap-2 text-[12px] transition-colors ${
        destructive
          ? 'text-rose-300 hover:bg-rose-500/10'
          : 'text-stone-200 hover:bg-white/[0.06]'
      }`}
    >
      <Icon name={icon} size={12} className="opacity-80 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div>{label}</div>
        {sub && <div className="text-[10px] text-stone-500">{sub}</div>}
      </div>
    </button>
  )
}

// ─── Right-click menu ─────────────────────────────────────────────────

interface ContextMenuProps {
  x: number
  y: number
  hasButton: boolean
  hasClipboard: boolean
  onClose: () => void
  onCopy: () => void
  onCut: () => void
  onPaste: () => void
  onDuplicate: () => void
  onMakeFolder: () => void
  onRemove: () => void
  onConfigure: () => void
}

function SlotContextMenu(props: ContextMenuProps): JSX.Element {
  useEffect(() => {
    const handle = (e: MouseEvent | KeyboardEvent): void => {
      if ('key' in e && e.key === 'Escape') {
        props.onClose()
        return
      }
      if ('clientX' in e) {
        const el = document.getElementById('fb-speeddeck-ctxmenu')
        if (el && !el.contains(e.target as Node)) props.onClose()
      }
    }
    document.addEventListener('mousedown', handle, true)
    document.addEventListener('keydown', handle, true)
    return () => {
      document.removeEventListener('mousedown', handle, true)
      document.removeEventListener('keydown', handle, true)
    }
  }, [props])

  const run = (fn: () => void): void => {
    fn()
    props.onClose()
  }

  return (
    <div
      id="fb-speeddeck-ctxmenu"
      className="fixed z-[260] rounded-md py-1 min-w-[180px]"
      style={{
        left: props.x,
        top: props.y,
        background: 'rgba(20, 28, 48, 0.96)',
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow:
          'inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 0 0 1px rgba(139, 92, 246, 0.12), 0 16px 48px -12px rgba(0,0,0,0.6)'
      }}
    >
      <MenuItem
        icon="tune"
        label={props.hasButton ? 'Configure…' : 'Add button…'}
        onClick={() => run(props.onConfigure)}
      />
      <Divider />
      {props.hasButton && (
        <>
          <MenuItem
            icon="content_copy"
            label="Copy"
            shortcut="⌘C"
            onClick={() => run(props.onCopy)}
          />
          <MenuItem
            icon="content_cut"
            label="Cut"
            shortcut="⌘X"
            onClick={() => run(props.onCut)}
          />
        </>
      )}
      {props.hasClipboard && (
        <MenuItem
          icon="content_paste"
          label="Paste"
          shortcut="⌘V"
          onClick={() => run(props.onPaste)}
        />
      )}
      {props.hasButton && (
        <MenuItem
          icon="auto_awesome_motion"
          label="Duplicate"
          shortcut="⌘D"
          onClick={() => run(props.onDuplicate)}
        />
      )}
      <Divider />
      {!props.hasButton && (
        <MenuItem
          icon="folder"
          label="New folder here"
          onClick={() => run(props.onMakeFolder)}
        />
      )}
      {props.hasButton && (
        <MenuItem
          icon="delete"
          label="Remove"
          destructive
          onClick={() => run(props.onRemove)}
        />
      )}
    </div>
  )
}

function MenuItem({
  icon,
  label,
  shortcut,
  destructive,
  onClick
}: {
  icon: string
  label: string
  shortcut?: string
  destructive?: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`w-full px-3 py-1.5 text-left flex items-center gap-2 text-[12px] transition-colors ${
        destructive
          ? 'text-rose-300 hover:bg-rose-500/10'
          : 'text-stone-200 hover:bg-white/[0.06]'
      }`}
    >
      <Icon name={icon} size={12} className="opacity-80 shrink-0" />
      <span className="flex-1">{label}</span>
      {shortcut && (
        <span className="text-[10px] text-stone-500 font-mono">{shortcut}</span>
      )}
    </button>
  )
}

function Divider(): JSX.Element {
  return <div className="h-px bg-white/[0.06] my-0.5" />
}

// ─── Single tile ──────────────────────────────────────────────────────

interface TileProps {
  slot: number
  button: DeckButton | undefined
  editing: boolean
  isEditingThis: boolean
  isFiring: boolean
  isDragOver: boolean
  error: string | undefined
  glow: number
  onClick: () => void
  onContextMenu: (e: React.MouseEvent<HTMLButtonElement>) => void
  onDragStart: (e: React.DragEvent<HTMLButtonElement>) => void
  onDragOver: (e: React.DragEvent<HTMLButtonElement>) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent<HTMLButtonElement>) => void
}

function SlotTile({
  slot,
  button,
  editing,
  isEditingThis,
  isFiring,
  isDragOver,
  error,
  glow,
  onClick,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop
}: TileProps): JSX.Element {
  void slot
  const color = button?.style.color || '#8b5cf6'
  const isFolder = button?.kind === 'folder'
  const hasContent = !!button
  const glowAlpha = Math.max(0, Math.min(1, glow))

  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      draggable={editing && hasContent}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      data-speeddeck-slot={slot}
      className="group relative overflow-hidden transition-transform"
      style={{
        borderRadius: 10,
        background: hasContent
          ? `linear-gradient(155deg, ${withAlpha(color, 0.45)}, ${withAlpha(color, 0.15)}), #0d1226`
          : 'rgba(255, 255, 255, 0.02)',
        border: hasContent
          ? `1px solid ${withAlpha(color, 0.55)}`
          : '1px dashed rgba(255, 255, 255, 0.08)',
        boxShadow: isDragOver
          ? `0 0 0 2px rgba(139, 92, 246, 0.65), 0 0 24px rgba(139, 92, 246, 0.45)`
          : hasContent
          ? [
              `inset 0 1px 0 rgba(255, 255, 255, ${0.12 + glowAlpha * 0.08})`,
              `inset 0 -10px 24px ${withAlpha(color, 0.25 + glowAlpha * 0.15)}`,
              `0 0 0 1px ${withAlpha(color, 0.06)}`,
              `0 0 18px -2px ${withAlpha(color, 0.35 + glowAlpha * 0.25)}`,
              isFiring ? `0 0 36px ${withAlpha(color, 0.85)}` : ''
            ]
              .filter(Boolean)
              .join(', ')
          : 'inset 0 1px 0 rgba(255, 255, 255, 0.03)',
        transform: isFiring ? 'scale(0.96)' : 'scale(1)',
        transition: 'transform 120ms cubic-bezier(0.2, 0.8, 0.2, 1), box-shadow 240ms ease',
        cursor: editing || hasContent ? 'pointer' : 'default'
      }}
      title={
        error
          ? error
          : button
            ? `${button.label || '(unnamed)'}${
                button.kind === 'folder' ? ' — folder' : ''
              }`
            : editing
              ? `Slot — click to configure, right-click for paste`
              : ''
      }
    >
      {hasContent && button.style.image && (
        <img
          src={button.style.image}
          alt=""
          className="absolute inset-0 w-full h-full object-cover opacity-90"
          style={{ borderRadius: 10 }}
        />
      )}

      {hasContent ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-1.5 pb-1">
          {!button.style.image && (
            <Icon
              name={button.style.icon || (isFolder ? 'folder' : 'play_arrow')}
              size={Math.min(28, 22)}
              className="text-white drop-shadow"
              filled
            />
          )}
          {button.label && (
            <span
              className="text-[9px] uppercase tracking-wider font-semibold text-white truncate max-w-full leading-tight"
              style={{
                textShadow: '0 1px 2px rgba(0,0,0,0.6)'
              }}
            >
              {button.label}
            </span>
          )}
          {isFolder && (
            <span
              className="absolute top-1 right-1 text-[8px] text-white/60"
              title="Folder"
            >
              <Icon name="folder" size={9} />
            </span>
          )}
        </div>
      ) : editing ? (
        <div className="absolute inset-0 flex items-center justify-center text-stone-500 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
          <Icon name="add" size={20} />
        </div>
      ) : null}

      {error && (
        <span
          className="absolute inset-0 pointer-events-none rounded-[10px]"
          style={{
            boxShadow: 'inset 0 0 0 2px rgba(244, 114, 182, 0.7)',
            animation: 'fb-streamdeck-error 1.6s ease-out 1'
          }}
        />
      )}

      {isEditingThis && (
        <span
          className="absolute inset-0 pointer-events-none rounded-[10px]"
          style={{
            boxShadow: 'inset 0 0 0 2px rgba(139, 92, 246, 0.8)'
          }}
        />
      )}
    </button>
  )
}

function withAlpha(color: string, alpha: number): string {
  const m = color.trim().match(/^#?([0-9a-f]{6})$/i)
  if (m) {
    const v = parseInt(m[1], 16)
    const r = (v >> 16) & 255
    const g = (v >> 8) & 255
    const b = v & 255
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  return `rgba(139, 92, 246, ${alpha})`
}

// Re-exports — kept for backward compatibility with anything that
// imports the deck shape via this module.
export type { DeckButton, DeckConfig, DeckPage }
// Reference one shared-export to keep its import live if anything else
// in the file needs it later.
void serializeDeckConfig
