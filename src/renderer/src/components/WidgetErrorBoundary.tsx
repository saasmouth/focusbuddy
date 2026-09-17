import { Component, type ErrorInfo, type ReactNode } from 'react'
import Icon from './Icon'
import { reportCrash } from '../lib/crashReporter'

interface Props {
  // A human label for the thing that failed, shown in the fallback ("This table
  // hit a problem"). Falls back to "widget" when absent.
  label?: string
  // The widget id, logged with the error for diagnostics. Not shown.
  widgetId?: string
  children: ReactNode
}

interface State {
  error: Error | null
}

// Per-widget error boundary.
//
// The app already has a top-level ErrorBoundary, but with only that one, a
// single widget that throws during render unmounts the whole canvas and the user
// sees the full-screen recovery surface over an otherwise fine workspace. This
// boundary keeps the failure local: the one broken widget degrades to a small
// "hit a problem" card in its own box, every other widget on the desk keeps
// working, and the user can retry the failed one in place.
//
// Class component because React only catches render errors via class boundaries;
// there is no hook equivalent. The fallback is styled entirely from existing
// design tokens, so it inherits the current theme and changes no colors.
export default class WidgetErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Persist to the crash log (WS03) so a widget failure is seen, not lost, and
    // keep the local console line for live debugging.
    reportCrash({
      kind: 'widget-error',
      message: error?.message ?? String(error),
      stack: error?.stack ?? null,
      componentStack: info?.componentStack ?? null,
      context: `${this.props.label ?? 'widget'}${this.props.widgetId ? ` (${this.props.widgetId})` : ''}`
    })
    // eslint-disable-next-line no-console
    console.error('[WidgetErrorBoundary]', this.props.widgetId, this.props.label, error, info)
  }

  reset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div
        data-testid="widget-error"
        className="w-full h-full min-h-[64px] flex flex-col items-center justify-center gap-2 p-4 text-center rounded-[inherit] bg-[var(--surface-raised)]"
      >
        <span className="h-8 w-8 rounded-lg inline-flex items-center justify-center bg-amber-500/10 text-amber-600 dark:text-amber-400">
          <Icon name="warning" size={18} />
        </span>
        <div className="text-[12px] font-medium text-[var(--ink-80)]">
          This {this.props.label || 'widget'} hit a problem
        </div>
        <div className="text-[11px] text-[var(--ink-50)] max-w-[34ch] leading-snug">
          The rest of your desk is fine and nothing was lost.
        </div>
        <button
          type="button"
          onClick={this.reset}
          data-testid="widget-error-retry"
          className="mt-1 inline-flex items-center gap-1 fb-btn-surface fb-press px-2.5 py-1 text-[11px] font-medium text-[var(--ink-70)] transition-colors"
        >
          <Icon name="refresh" size={12} />
          <span>Retry</span>
        </button>
      </div>
    )
  }
}
