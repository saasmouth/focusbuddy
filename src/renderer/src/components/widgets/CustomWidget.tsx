import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import MentionTextarea from '../MentionTextarea'
import type { Widget, CustomWidgetContent, SavedCustomWidget } from '@shared/types'
import { CUSTOM_WIDGET_HISTORY_LIMIT, CUSTOM_WIDGET_MAX_STATE_BYTES } from '@shared/types'
import { parseBridgeMessage, SANDBOX_ATTR } from '@shared/customWidgetSandbox'
import WidgetFrame from './WidgetFrame'
import Icon from '../Icon'
import CustomWidgetWizard from './CustomWidgetWizard'
import { judgeWidgetAction, describeWidgetAction } from '@shared/customWidgetActions'
import { applyProposal } from '../../lib/actionExecutor'
import { useLinksStore } from '../../stores/links'
import {
  composeSpec,
  composeEditSpec,
  EMPTY_WIDGET_ANSWERS,
  type WidgetWizardAnswers
} from '@shared/customWidgetWizard'
import { useWidgetStore } from '../../stores/widgets'
import { promptText, confirmDialog } from '../plexi/PromptDialog'

// The Custom widget — the user describes a tool in plain language and the model
// writes it, right here on the desk.
//
// The generated document runs in an iframe sandboxed WITHOUT allow-same-origin,
// so it sits on an opaque origin with no reach into this app's storage, IPC or
// DOM. See @shared/customWidgetSandbox for the boundary itself; this file is the
// UI around it and the host half of the bridge.
//
// Three things the user can do with a built widget: refine it (describe a change,
// get a revision, revert if it got worse), save it to their library (durable, in
// the database, reusable on any desk), and allow it network access (off by
// default, because a widget holding what the user typed should not be able to
// post that anywhere unless they said so).

function parse(content: string): CustomWidgetContent {
  if (!content) return { spec: '', code: '' }
  try {
    const p = JSON.parse(content) as Partial<CustomWidgetContent>
    return {
      spec: typeof p.spec === 'string' ? p.spec : '',
      code: typeof p.code === 'string' ? p.code : '',
      state: p.state && typeof p.state === 'object' && !Array.isArray(p.state) ? p.state : {},
      net: p.net === true,
      acts: p.acts === true,
      history: Array.isArray(p.history) ? p.history : [],
      savedId: typeof p.savedId === 'string' ? p.savedId : undefined
    }
  } catch {
    return { spec: '', code: '' }
  }
}

// A short, stable fingerprint of the generated code, used only to bust the
// frame's cache when a refine changes it. Not a security boundary -- collisions
// here would show a stale widget, never run unintended code.
function hashCode(code: string): string {
  let h = 5381
  for (let i = 0; i < code.length; i++) h = ((h << 5) + h + code.charCodeAt(i)) >>> 0
  return h.toString(36)
}

function isDarkTheme(): boolean {
  try {
    return document.documentElement.classList.contains('dark')
  } catch {
    return false
  }
}

const EXAMPLES = [
  'A per-client retainer tracker: hours used against hours bought, with a bar that turns amber past 80%',
  'A print-size calculator that converts pixel dimensions to mm at a chosen DPI',
  'A contrast checker — two colour pickers, the ratio, and the WCAG pass/fail badges',
  'A revision-round counter per deliverable, so I can see who is over their two included rounds'
]

export default function CustomWidget({ widget }: { widget: Widget }): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const data = useMemo(() => parse(widget.content), [widget.content])

  const [spec, setSpec] = useState('')
  const [busy, setBusy] = useState<false | 'build' | 'refine'>(false)
  // The build/change wizard, when it is open. 'edit' starts from the answers
  // given last time, so changing behaviour is picking a different option rather
  // than describing from memory a widget you built weeks ago.
  const [wizard, setWizard] = useState<false | 'build' | 'edit'>(false)
  const [error, setError] = useState<string | null>(null)
  const [needsKey, setNeedsKey] = useState(false)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [showSource, setShowSource] = useState(false)
  const [showLibrary, setShowLibrary] = useState(false)
  const [library, setLibrary] = useState<SavedCustomWidget[]>([])
  const [dark, setDark] = useState(isDarkTheme)

  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  // The widget's own saved data, held in a ref so an update from inside the
  // frame never re-composes the document — re-composing would reload the widget
  // and throw away whatever the user was mid-way through doing in it.
  const stateRef = useRef<Record<string, unknown>>(data.state ?? {})
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Only the first natural-height report auto-sizes the widget. After that the
  // user's own resize is authoritative and we stop fighting them for it.
  const autoSized = useRef(false)

  useEffect(() => {
    stateRef.current = data.state ?? {}
  }, [data.state])

  // Follow the app's theme so a generated widget is never a white rectangle in a
  // dark workspace.
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(isDarkTheme()))
    try {
      obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    } catch {
      /* no-op */
    }
    return () => obs.disconnect()
  }, [])

  const patch = useCallback(
    (next: Partial<CustomWidgetContent>) => {
      // Merge onto what is actually stored, not onto a render-time snapshot, so
      // a state write from inside the frame is never rolled back by a menu
      // action that happened to be holding an older copy.
      const live = useWidgetStore.getState().widgets.find((w) => w.id === widget.id)
      const current = parse(live?.content ?? widget.content)
      const merged: CustomWidgetContent = { ...current, ...next }
      void update(widget.id, { content: JSON.stringify(merged) })
    },
    [update, widget.content, widget.id]
  )

  // Wires into this widget. When one is drawn, removed, or its source changes,
  // the frame is handed a fresh snapshot — which is what makes a generated
  // widget live rather than a picture of whenever it happened to load.
  const links = useLinksStore((s) => s.links)
  const allWidgetsForInputs = useWidgetStore((s) => s.widgets)
  const inputSignature = useMemo(() => {
    const sourceIds = links
      .filter((l) => l.targetWidgetId === widget.id && l.enabled !== false)
      .map((l) => l.sourceWidgetId)
      .sort()
    // Content is part of the signature: editing a wired sticky should reach the
    // widget reading it, not wait for a wire to be redrawn.
    return sourceIds
      .map((id) => {
        const w = allWidgetsForInputs.find((x) => x.id === id)
        return `${id}:${w?.updatedAt ?? 0}:${(w?.content ?? '').length}`
      })
      .join('|')
  }, [links, allWidgetsForInputs, widget.id])

  useEffect(() => {
    if (!data.code) return
    let live = true
    void window.api.customWidgetInputs
      .get(widget.id)
      .then((inputs) => {
        if (!live) return
        iframeRef.current?.contentWindow?.postMessage(
          { __plexiHost: 1, type: 'inputs', payload: inputs },
          '*'
        )
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [inputSignature, data.code, widget.id])

  // ── the host half of the bridge ────────────────────────────────────────────
  useEffect(() => {
    function onMessage(e: MessageEvent): void {
      // Only this widget's own frame. Without this check every custom widget on
      // the desk would act on every other one's messages.
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return
      const msg = parseBridgeMessage(e.data)
      if (!msg) return

      switch (msg.type) {
        case 'act': {
          // The widget is ASKING. Nothing here trusts the request: the verb must
          // be one the policy allows, the target must be wired into this widget,
          // and unless the user has switched this widget's write access on it is
          // put to them before it runs.
          const answer = (payload: { ok: boolean; reason?: string }): void => {
            iframeRef.current?.contentWindow?.postMessage(
              { __plexiHost: 1, type: 'act-result', id: msg.payload.id, payload },
              '*'
            )
          }
          void (async () => {
            const scope = await window.api.customWidgetInputs
              .scope(widget.id)
              .catch(() => ({ tableIds: [] as string[] }))
            const verdict = judgeWidgetAction(msg.payload.action, {
              tableIds: scope.tableIds,
              acts: data.acts === true
            })
            if (!verdict.ok) {
              answer({ ok: false, reason: verdict.reason })
              return
            }
            if (verdict.needsApproval) {
              const ok = await confirmDialog({
                title: `${widget.title || 'This widget'} wants to make a change`,
                body: `${describeWidgetAction(verdict.action)}\n\nTurn on “Let this widget make changes” in its menu to stop being asked each time.`
              })
              if (!ok) {
                answer({ ok: false, reason: 'You declined that change.' })
                return
              }
            }
            const res = await applyProposal(
              { id: `cw-${msg.payload.id}`, ...verdict.action } as never,
              { activeTaskId: widget.taskId }
            )
            answer(res.ok ? { ok: true } : { ok: false, reason: res.message })
            if (!res.ok) setRuntimeError(res.message)
          })()
          return
        }
        case 'state': {
          const json = JSON.stringify(msg.payload)
          if (json.length > CUSTOM_WIDGET_MAX_STATE_BYTES) {
            setRuntimeError('This widget tried to save more data than a widget may hold.')
            return
          }
          stateRef.current = msg.payload
          // Debounced: a widget saving on every keystroke costs one write per
          // idle moment, not one per character.
          if (saveTimer.current) clearTimeout(saveTimer.current)
          saveTimer.current = setTimeout(() => {
            // Re-read the widget at write time rather than closing over `data`.
            // A refine landing inside the debounce window would otherwise have
            // its new code overwritten by the version this closure captured.
            const live = useWidgetStore.getState().widgets.find((w) => w.id === widget.id)
            const current = parse(live?.content ?? widget.content)
            void update(widget.id, {
              content: JSON.stringify({ ...current, state: stateRef.current })
            })
          }, 400)
          return
        }
        case 'title':
          if (msg.payload !== widget.title) void update(widget.id, { title: msg.payload })
          return
        case 'height':
          void update(widget.id, { height: Math.max(120, msg.payload + 44) })
          return
        case 'natural-height':
          if (autoSized.current) return
          autoSized.current = true
          if (msg.payload > 40) {
            void update(widget.id, { height: Math.max(140, Math.min(msg.payload + 52, 900)) })
          }
          return
        case 'error':
          setRuntimeError(msg.payload)
          return
        case 'ready':
          setRuntimeError(null)
          return
      }
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [data, update, widget.id, widget.title])

  // The frame's URL, served by the fb-widget: protocol handler in main.
  //
  // NOT an srcdoc. `about:srcdoc` inherits the embedding page's CSP, and this
  // renderer runs under `script-src 'self'`, so a srcdoc widget rendered its
  // markup and had every line of its JavaScript refused -- measured, not
  // assumed. A document served from its own scheme carries its own policy.
  //
  // Keyed on the code and the theme only. State deliberately does NOT appear in
  // the URL: a widget must not reload itself every time the user types into it.
  const frameSrc = useMemo(() => {
    if (!data.code) return ''
    const v = hashCode(data.code) + (data.net ? 'n' : '')
    return `fb-widget://${widget.id}/?v=${v}&dark=${dark ? '1' : '0'}`
  }, [data.code, data.net, dark, widget.id])

  // ── actions ───────────────────────────────────────────────────────────────
  const build = useCallback(
    async (description: string, isRefine: boolean, answers?: WidgetWizardAnswers) => {
      const text = description.trim()
      if (!text) return
      setBusy(isRefine ? 'refine' : 'build')
      setError(null)
      setNeedsKey(false)
      setRuntimeError(null)
      try {
        const r = await window.api.customWidget.generate({
          spec: text,
          currentCode: isRefine ? data.code : undefined,
          net: data.net,
          width: widget.width,
          height: widget.height
        })
        if (!r.ok) {
          setError(r.error)
          setNeedsKey(r.needsKey === true)
          return
        }
        const history = isRefine && data.code
          ? [{ code: data.code, spec: data.spec, at: Date.now() }, ...(data.history ?? [])].slice(
              0,
              CUSTOM_WIDGET_HISTORY_LIMIT
            )
          : (data.history ?? [])
        autoSized.current = false
        patch({
          spec: isRefine ? `${data.spec}\n\nThen: ${text}`.trim() : text,
          code: r.code,
          history,
          // Keep what was answered so Edit reopens it. Only overwritten when
          // this build came FROM the wizard; a free-text refine leaves the
          // stored answers alone rather than blanking them.
          ...(answers ? { wizard: answers } : {})
        })
        setSpec('')
        // Name it on first build so the header stops saying "Custom".
        if (!isRefine && (!widget.title || widget.title === 'Custom')) {
          void window.api.customWidget
            .suggestName({ spec: text })
            .then((n) => update(widget.id, { title: n.name }))
            .catch(() => undefined)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [data, patch, update, widget.height, widget.id, widget.title, widget.width]
  )

  // Finish the wizard: compose a precise brief from the answers and build.
  // Editing composes a DIFF against the previous answers, so the model is told
  // what changed rather than being asked to re-guess the whole widget.
  const onWizardDone = useCallback(
    (answers: WidgetWizardAnswers) => {
      const ctx = { width: widget.width, height: widget.height, net: data.net }
      const editing = wizard === 'edit' && !!data.code
      const brief = editing
        ? composeEditSpec(data.wizard ?? EMPTY_WIDGET_ANSWERS, answers, ctx)
        : composeSpec(answers, ctx)
      setWizard(false)
      void build(brief, editing, answers)
    },
    [build, data.code, data.net, data.wizard, widget.height, widget.width, wizard]
  )

  // A fresh generation from the original description, discarding code that was
  // never finished. Deliberately NOT a refine: there is nothing in a document
  // that stops mid-attribute worth building on.
  const onRebuild = useCallback(() => {
    const original = (data.spec || '').split('\n\nThen: ')[0].trim()
    if (!original) {
      setWizard('build')
      return
    }
    void build(original, false, data.wizard)
  }, [build, data.spec, data.wizard])

  const onRefine = useCallback(async () => {
    // Refining means "change THIS code". When the code never finished there is
    // nothing to change -- asking a model to improve a document that stops
    // mid-attribute produces more of the same -- so the feedback is folded into
    // the original description and the widget is built fresh.
    const unfinished =
      !!data.code && !/<style/i.test(data.code) && !/<script/i.test(data.code)
    const v = await promptText({
      title: unfinished ? 'What should it do differently?' : 'Change this widget',
      label: unfinished
        ? 'This one never finished, so it will be rebuilt from your description plus whatever you add here.'
        : 'Describe what should be different. The current version is kept so you can revert.',
      placeholder: 'e.g. add a total row, and make overdue items red',
      multiline: true,
      confirmLabel: 'Rebuild'
    })
    if (!v) return
    if (unfinished) {
      const original = (data.spec || '').split('\n\nThen: ')[0].trim()
      void build(original ? `${original}\n\nAlso: ${v}` : v, false, data.wizard)
      return
    }
    void build(v, true)
  }, [build, data.code, data.spec, data.wizard])

  const onRevert = useCallback(async () => {
    const prev = (data.history ?? [])[0]
    if (!prev) return
    const ok = await confirmDialog({
      title: 'Revert to the previous version?',
      body: 'The current version is discarded.'
    })
    if (!ok) return
    autoSized.current = false
    patch({ code: prev.code, spec: prev.spec, history: (data.history ?? []).slice(1) })
  }, [data.history, patch])

  const onToggleNet = useCallback(async () => {
    if (!data.net) {
      const ok = await confirmDialog({
        title: 'Allow this widget to use the internet?',
        body:
          'It will be able to call public web APIs — and to send what you type into it. ' +
          'Only turn this on for a widget you asked to fetch live data.'
      })
      if (!ok) return
    }
    patch({ net: !data.net })
  }, [data.net, patch])

  const onToggleActs = useCallback(async () => {
    if (!data.acts) {
      const ok = await confirmDialog({
        title: 'Let this widget make changes without asking?',
        body:
          'It will be able to add rows and update cells in the tables WIRED INTO IT, and save notes to ' +
          'PlexiBrain — without a confirmation each time. It still cannot touch anything you have not ' +
          'wired to it. Leave this off and it will ask you every time instead.'
      })
      if (!ok) return
    }
    patch({ acts: !data.acts })
  }, [data.acts, patch])

  const onSave = useCallback(async () => {
    if (!data.code) return
    const suggestion = await window.api.customWidget
      .suggestName({ spec: data.spec })
      .catch(() => ({ name: widget.title || 'Custom widget', icon: 'widgets' }))
    const name = await promptText({
      title: 'Save to my widgets',
      label: 'It will be available on every desk, and can be placed as many times as you like.',
      initial: widget.title && widget.title !== 'Custom' ? widget.title : suggestion.name,
      confirmLabel: 'Save'
    })
    if (!name) return
    const r = await window.api.customWidget.save({
      id: data.savedId,
      name,
      spec: data.spec,
      code: data.code,
      icon: suggestion.icon,
      net: data.net,
      width: widget.width,
      height: widget.height
    })
    if (!r.ok) {
      setError(r.error)
      return
    }
    patch({ savedId: r.widget.id })
    setError(null)
  }, [data, patch, widget.height, widget.title, widget.width])

  const openLibrary = useCallback(async () => {
    const list = await window.api.customWidget.list().catch(() => [])
    setLibrary(list)
    setShowLibrary(true)
  }, [])

  const loadSaved = useCallback(
    (s: SavedCustomWidget) => {
      autoSized.current = false
      stateRef.current = {}
      void window.api.customWidget.markUsed(s.id).catch(() => undefined)
      void update(widget.id, {
        title: s.name,
        width: s.width || widget.width,
        height: s.height || widget.height,
        content: JSON.stringify({
          spec: s.spec,
          code: s.code,
          state: {},
          net: s.net,
          history: [],
          savedId: s.id
        } satisfies CustomWidgetContent)
      })
      setShowLibrary(false)
    },
    [update, widget.height, widget.id, widget.width]
  )

  const deleteSaved = useCallback(
    async (s: SavedCustomWidget) => {
      const ok = await confirmDialog({
        title: `Delete "${s.name}"?`,
        body: 'It is removed from your library. Widgets already on a desk keep working.',
        danger: true
      })
      if (!ok) return
      await window.api.customWidget.delete(s.id)
      setLibrary((prev) => prev.filter((x) => x.id !== s.id))
    },
    []
  )

  const menuExtras = useMemo(() => {
    const items: Array<{ label: string; icon?: string; onClick: () => void }> = []
    if (data.code) {
      items.push({ label: 'Change this widget…', icon: 'auto_fix_high', onClick: () => void onRefine() })
      items.push({ label: 'Save to my widgets…', icon: 'bookmark_add', onClick: () => void onSave() })
      if ((data.history ?? []).length > 0) {
        items.push({ label: 'Revert to previous version', icon: 'undo', onClick: () => void onRevert() })
      }
      items.push({
        label: showSource ? 'Hide source' : 'View source',
        icon: 'code',
        onClick: () => setShowSource((v) => !v)
      })
      items.push({
        label: data.net ? 'Internet access: on' : 'Internet access: off',
        icon: data.net ? 'public' : 'public_off',
        onClick: () => void onToggleNet()
      })
      items.push({
        label: data.acts ? 'Can make changes: on' : 'Can make changes: off',
        icon: data.acts ? 'bolt' : 'lock',
        onClick: () => void onToggleActs()
      })
      items.push({
        label: 'Start over',
        icon: 'restart_alt',
        onClick: () => {
          void confirmDialog({
            title: 'Start over?',
            body: 'The built widget and anything saved inside it are discarded.'
          }).then((ok) => {
            if (!ok) return
            stateRef.current = {}
            autoSized.current = false
            void update(widget.id, { content: JSON.stringify({ spec: '', code: '' }) })
          })
        }
      })
    }
    if (data.code) {
      // Structured editing, listed FIRST: the free-text refine below is the
      // escape hatch, not the main way to change what a widget does.
      items.unshift({
        label: 'Change what it does…',
        icon: 'tune',
        onClick: () => setWizard('edit')
      })
    }
    items.push({ label: 'My widgets…', icon: 'grid_view', onClick: () => void openLibrary() })
    return items
  }, [data.acts, data.code, data.history, data.net, onRefine, onRevert, onSave, onToggleActs, onToggleNet, openLibrary, showSource, update, widget.id])

  // ── render ────────────────────────────────────────────────────────────────
  let body: JSX.Element

  if (busy) {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Icon name="auto_awesome" size={22} className="animate-pulse text-indigo-500" />
        <div className="text-[12px] text-stone-500 dark:text-stone-400">
          {busy === 'refine' ? 'Rebuilding your widget…' : 'Building your widget…'}
        </div>
        <div className="text-[11px] text-stone-400 dark:text-stone-500">
          Writing the whole thing from scratch — this usually takes 15–40 seconds.
        </div>
      </div>
    )
  } else if (data.code) {
    const looksUnfinished =
      !/<style/i.test(data.code) && !/<script/i.test(data.code) && /<[a-z]/i.test(data.code)
    body = (
      <div className="group/cw relative h-full w-full">
        {looksUnfinished && (
          <div
            data-testid="custom-widget-unfinished"
            className="absolute inset-x-0 top-0 z-10 flex items-start gap-2 border-b border-amber-300/60 bg-amber-50/95 px-3 py-2 text-[11px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/90 dark:text-amber-200"
          >
            <Icon name="warning" size={14} className="mt-[1px] shrink-0" />
            <div className="min-w-0 flex-1">
              <div>This widget was never finished — it has no styling and no behaviour.</div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                <button
                  className="underline underline-offset-2 opacity-80 hover:opacity-100"
                  data-testid="custom-widget-rebuild"
                  onClick={() => onRebuild()}
                >
                  Rebuild it from your description
                </button>
                <button
                  className="underline underline-offset-2 opacity-80 hover:opacity-100"
                  data-testid="custom-widget-rebuild-feedback"
                  onClick={() => void onRefine()}
                >
                  Or say what it should do differently
                </button>
              </div>
            </div>
          </div>
        )}
        <iframe
          ref={iframeRef}
          // allow-same-origin is absent on purpose: it is what keeps this code
          // off this app's origin and away from its data.
          sandbox={SANDBOX_ATTR}
          src={frameSrc}
          title={widget.title || 'Custom widget'}
          className="h-full w-full border-0 bg-white dark:bg-stone-900"
          // Referrer and permissions are already unavailable on an opaque
          // origin; stated here so the intent survives a future refactor.
          referrerPolicy="no-referrer"
          allow=""
        />
        {runtimeError && (
          <div className="absolute inset-x-0 bottom-0 flex items-start gap-2 border-t border-amber-300/60 bg-amber-50/95 px-3 py-2 text-[11px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/90 dark:text-amber-200">
            <Icon name="warning" size={14} className="mt-[1px] shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="break-words">{runtimeError}</div>
              <button
                className="mt-1 underline underline-offset-2 opacity-80 hover:opacity-100"
                onClick={() => void onRefine()}
              >
                Describe the fix
              </button>
            </div>
            <button
              className="shrink-0 opacity-60 hover:opacity-100"
              onClick={() => setRuntimeError(null)}
              aria-label="Dismiss"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
        {/* Refining lived only in the header menu, which is a small ⋯ over a
            full-bleed iframe — findable if you know it is there, invisible if
            you do not. This is the same actions, where the widget is. */}
        <div className="absolute bottom-2 right-2 z-10 flex items-center gap-1 opacity-60 transition-opacity hover:opacity-100 group-hover/cw:opacity-100 focus-within:opacity-100">
          <button
            onClick={() => void onRefine()}
            data-testid="custom-widget-refine"
            title="Tell it what to change, in your own words"
            className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-white/95 px-2.5 py-1 text-[11px] font-medium text-stone-700 shadow-sm hover:border-indigo-300 hover:text-indigo-600 dark:border-white/15 dark:bg-stone-900/95 dark:text-stone-200"
          >
            <Icon name="edit" size={12} />
            Tell it what to change
          </button>
          <button
            onClick={() => setWizard('edit')}
            data-testid="custom-widget-change"
            title="Change what this widget does, by answering the questions again"
            className="rounded-full border border-stone-200 bg-white/95 p-1.5 text-stone-600 shadow-sm hover:border-indigo-300 hover:text-indigo-600 dark:border-white/15 dark:bg-stone-900/95 dark:text-stone-300"
          >
            <Icon name="tune" size={13} />
          </button>
        </div>
        {showSource && (
          <div className="absolute inset-0 flex flex-col bg-stone-950/95">
            <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
              <span className="text-[11px] font-medium text-stone-300">Generated source</span>
              <div className="flex items-center gap-2">
                <button
                  className="text-[11px] text-stone-400 hover:text-stone-100"
                  onClick={() => void navigator.clipboard.writeText(data.code).catch(() => undefined)}
                >
                  Copy
                </button>
                <button
                  className="text-stone-400 hover:text-stone-100"
                  onClick={() => setShowSource(false)}
                  aria-label="Close source"
                >
                  <Icon name="close" size={15} />
                </button>
              </div>
            </div>
            <pre className="flex-1 overflow-auto px-3 py-2 text-[10.5px] leading-[1.5] text-stone-300">
              <code>{data.code}</code>
            </pre>
          </div>
        )}
      </div>
    )
  } else {
    body = (
      <div className="flex h-full flex-col gap-2 overflow-auto p-3">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-stone-600 dark:text-stone-300">
          <Icon name="auto_awesome" size={14} className="text-indigo-500" />
          Describe the widget you need
        </div>
        <MentionTextarea
          value={spec}
          onChange={(e) => setSpec(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void build(spec, false)
          }}
          placeholder="A tool that…"
          wrapperClassName="flex-1 flex flex-col"
          className="min-h-[76px] h-full w-full resize-none rounded-lg border border-stone-200 bg-white px-2.5 py-2 text-[12px] leading-[1.5] text-stone-800 outline-none placeholder:text-stone-400 focus:border-indigo-400 dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-100 dark:placeholder:text-stone-500"
        />
        <div className="flex flex-wrap gap-1">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => setSpec(ex)}
              className="max-w-full truncate rounded-full border border-stone-200 px-2 py-[3px] text-[10.5px] text-stone-500 hover:border-indigo-300 hover:text-indigo-600 dark:border-white/10 dark:text-stone-400 dark:hover:border-indigo-500/40 dark:hover:text-indigo-300"
              title={ex}
            >
              {ex.length > 46 ? ex.slice(0, 46) + '…' : ex}
            </button>
          ))}
        </div>
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] text-red-700 dark:border-red-500/25 dark:bg-red-950/40 dark:text-red-300">
            {error}
            {needsKey && (
              <div className="mt-1 opacity-80">
                Settings → AI → Anthropic API key.
              </div>
            )}
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            disabled={!spec.trim()}
            onClick={() => void build(spec, false)}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
          >
            <Icon name="bolt" size={14} />
            Build it
          </button>
          <button
            onClick={() => setWizard('build')}
            data-testid="custom-widget-wizard-open"
            title="Answer a few questions instead of writing a description"
            className="flex items-center gap-1.5 rounded-lg border border-stone-200 px-2.5 py-1.5 text-[12px] text-stone-600 hover:border-indigo-300 hover:text-indigo-600 dark:border-white/10 dark:text-stone-300"
          >
            <Icon name="auto_awesome" size={14} />
            Guide me
          </button>
          <button
            onClick={() => void openLibrary()}
            className="rounded-lg border border-stone-200 px-2.5 py-1.5 text-[12px] text-stone-600 hover:border-stone-300 dark:border-white/10 dark:text-stone-300"
          >
            My widgets
          </button>
        </div>
      </div>
    )
  }

  return (
    <WidgetFrame
      widget={widget}
      headerLabel="custom"
      headerAccent="bg-indigo-100/70 dark:bg-indigo-500/10"
      headerMenuExtras={menuExtras}
    >
      {body}
      {wizard && (
        <CustomWidgetWizard
          mode={wizard}
          initial={wizard === 'edit' ? (data.wizard ?? EMPTY_WIDGET_ANSWERS) : EMPTY_WIDGET_ANSWERS}
          onCancel={() => setWizard(false)}
          onDone={onWizardDone}
        />
      )}
      {showLibrary && (
        <div className="absolute inset-0 z-20 flex flex-col bg-white/95 dark:bg-stone-900/95">
          <div className="flex items-center justify-between border-b border-stone-200 px-3 py-2 dark:border-white/10">
            <span className="text-[11px] font-medium text-stone-600 dark:text-stone-300">
              My widgets
            </span>
            <button
              onClick={() => setShowLibrary(false)}
              className="text-stone-400 hover:text-stone-700 dark:hover:text-stone-100"
              aria-label="Close"
            >
              <Icon name="close" size={15} />
            </button>
          </div>
          <div className="flex-1 overflow-auto p-2">
            {library.length === 0 ? (
              <div className="px-2 py-6 text-center text-[11px] text-stone-400 dark:text-stone-500">
                Nothing saved yet. Build a widget, then choose “Save to my widgets”.
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {library.map((s) => (
                  <div
                    key={s.id}
                    className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-stone-100 dark:hover:bg-white/[0.06]"
                  >
                    <Icon name={s.icon || 'widgets'} size={16} className="shrink-0 text-indigo-500" />
                    <button
                      onClick={() => loadSaved(s)}
                      className="min-w-0 flex-1 text-left"
                      title={s.spec}
                    >
                      <div className="truncate text-[12px] text-stone-700 dark:text-stone-200">
                        {s.name}
                      </div>
                      <div className="truncate text-[10.5px] text-stone-400 dark:text-stone-500">
                        {s.net ? 'Internet access · ' : ''}
                        {s.useCount > 0 ? `used ${s.useCount}×` : 'not used yet'}
                      </div>
                    </button>
                    <button
                      onClick={() => void deleteSaved(s)}
                      className="shrink-0 text-stone-300 opacity-0 hover:text-red-500 group-hover:opacity-100 dark:text-stone-600"
                      aria-label={`Delete ${s.name}`}
                    >
                      <Icon name="delete" size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </WidgetFrame>
  )
}
