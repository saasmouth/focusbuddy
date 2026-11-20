// The widget host's view: the one widget or document, drawn by the same
// component a desk uses, filling the page.
//
// It is drawn EMBEDDED and as DATA (lib/widgetSurface): no title bar, no card
// edge, no drag, no resize and no remove, because PlexiiLite's tile is the
// frame and the file is the object -- there is no desk to move it on. Each
// kind's code is loaded on its own (kinds.ts), so a sticky never downloads the
// spreadsheet engine.
import { Component, Suspense, lazy, useEffect, useMemo, useRef, useState, type ComponentType, type JSX, type ReactNode, type RefObject } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { Widget } from '@shared/types'
import { widgetFilePaneId, widgetFromFile } from '@shared/widgetFiles'
import { WidgetChromeContext, WidgetRemovableContext, WidgetSurfaceContext } from '@renderer/lib/widgetSurface'
import { useWidgetFilesStore } from '@renderer/stores/widgetFiles'
import { useWidgetStore } from '@renderer/stores/widgets'
import { loaderFor } from './kinds'
import type { HostView, Shown } from './controller'

const lazyByKind = new Map<string, ComponentType<{ widget: Widget }>>()
function componentFor(kind: string): ComponentType<{ widget: Widget }> | null {
  const load = loaderFor(kind)
  if (!load) return null
  let c = lazyByKind.get(kind)
  if (!c) lazyByKind.set(kind, (c = lazy(load)))
  return c
}

/** A drawing error becomes the honest state, reported once. */
class Boundary extends Component<{ onError: (detail: string) => void; children: ReactNode }, { failed: string | null }> {
  state = { failed: null as string | null }
  static getDerivedStateFromError(e: unknown): { failed: string } {
    return { failed: e instanceof Error ? e.message : String(e) }
  }
  componentDidCatch(e: unknown): void {
    this.props.onError(e instanceof Error ? e.message : String(e))
  }
  render(): ReactNode {
    return this.state.failed === null ? this.props.children : null
  }
}

function useBoxSize(): [RefObject<HTMLDivElement>, { width: number; height: number }] {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size]
}

function Drawn({ widget }: { widget: Widget }): JSX.Element | null {
  const C = componentFor(widget.kind)
  if (!C) return null
  return (
    <WidgetSurfaceContext.Provider value="embedded">
      <WidgetChromeContext.Provider value="data">
        <WidgetRemovableContext.Provider value={false}>
          <Suspense fallback={null}>
            <C widget={widget} />
          </Suspense>
        </WidgetRemovableContext.Provider>
      </WidgetChromeContext.Provider>
    </WidgetSurfaceContext.Provider>
  )
}

/** A widget file: the desk's file pane id, so its edits go to the file (stores/widgets). */
function WidgetFileShown({ fileId }: { fileId: string }): JSX.Element {
  const file = useWidgetFilesStore((s) => s.files[fileId])
  const load = useWidgetFilesStore((s) => s.load)
  const [ref, size] = useBoxSize()
  useEffect(() => {
    void load(fileId)
    useWidgetStore.getState().setActive(widgetFilePaneId(fileId))
  }, [fileId, load])
  const widget = useMemo(() => (file ? widgetFromFile(file, size) : null), [file, size])
  return (
    <div ref={ref} className="plexii-widget-host-box" data-widget-host-kind={file?.kind ?? ''}>
      {widget ? <Drawn widget={widget} /> : null}
    </div>
  )
}

/** An Office document: the desk's Office widget for it, keyed by the document id. */
function DocumentShown({ documentId, docType, title }: { documentId: string; docType: string; title: string }): JSX.Element {
  const [ref, size] = useBoxSize()
  const widget = useMemo(
    () => ({ id: `widget-host:${documentId}`, taskId: '', kind: docType, title, content: documentId, x: 0, y: 0, width: size.width, height: size.height, zIndex: 1, color: null }) as unknown as Widget,
    [documentId, docType, title, size]
  )
  useEffect(() => {
    useWidgetStore.getState().setActive(widget.id)
  }, [widget.id])
  return (
    <div ref={ref} className="plexii-widget-host-box" data-widget-host-kind={docType}>
      <Drawn widget={widget} />
    </div>
  )
}

interface State {
  shown: Shown | null
  problem: string | null
  generation: number
}

export function createReactView(root: HTMLElement, onRenderError: (detail: string) => void): HostView {
  let set: (f: (s: State) => State) => void = () => {}
  function App(): JSX.Element {
    const [s, setS] = useState<State>({ shown: null, problem: null, generation: 0 })
    set = setS
    if (s.problem !== null) {
      return <p className="plexii-widget-host-problem" role="status">{s.problem}</p>
    }
    if (!s.shown) return <div className="plexii-widget-host-box" aria-busy="true" />
    const { shown } = s
    return (
      <Boundary key={s.generation} onError={onRenderError}>
        {shown.family === 'widget'
          ? <WidgetFileShown fileId={shown.fileId!} />
          : <DocumentShown documentId={shown.documentId!} docType={shown.kind} title={shown.title} />}
      </Boundary>
    )
  }
  root.setAttribute('data-widget-host', 'starting')
  flushSync(() => createRoot(root).render(<App />))
  return {
    show(shown) {
      root.setAttribute('data-widget-host', 'shown')
      if (shown.readOnly) root.setAttribute('data-readonly', 'true')
      flushSync(() => set((s) => ({ ...s, shown })))
    },
    showProblem(message) {
      root.setAttribute('data-widget-host', 'problem')
      flushSync(() => set((s) => ({ ...s, problem: message })))
    }
  }
}
