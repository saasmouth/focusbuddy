// Building blocks of the one side menu (AreaAccordion): sub-headings and the
// icon-tile grid that PlexiiApps, Tools, Connected apps and Widgets all share,
// so every grid in the menu follows the same rules.

import Icon from '../Icon'

/** A sub-heading inside a section — PlexiiApps, Tools, Connected apps. */
export function SubHeading({ label, action }: { label: string; action?: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center gap-1 px-3 pt-2 pb-1">
      <span className="flex-1 min-w-0 truncate text-[10px] uppercase tracking-[0.12em] font-semibold text-[var(--ink-40)]">
        {label}
      </span>
      {action}
    </div>
  )
}

/**
 * A grid of icon tiles — PlexiiApps, Tools and Connected apps.
 *
 * COLUMNS FOLLOW THE WIDTH, and that is the whole trick. It was a fixed
 * `grid-cols-4`, so at the 232px minimum sidebar width each tile got ~52px and
 * "PlexiDiagrams" had nowhere to go but a second line. `auto-fit` with a
 * minimum tile width drops to three columns, then two, as the menu narrows —
 * which is what the operator asked for: fewer columns rather than wrapped
 * names. No ResizeObserver needed; the grid does it in CSS, so it also follows
 * a drag-resize live.
 *
 * TILE_MIN is the floor that keeps the longest real label on one line at this
 * font size — "PlexiDiagrams" is the one that sets it.
 */
export const TILE_MIN = 84

export function TileGrid({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div
      className="grid gap-1 px-2"
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${TILE_MIN}px, 1fr))` }}
      data-testid="nav-tile-grid"
    >
      {children}
    </div>
  )
}

export function Tile({
  label,
  active,
  onClick,
  testid,
  badge = 0,
  liveness = null,
  unit = 'unknown',
  note,
  signedOut = false,
  locked = false,
  hint,
  onDragStart,
  children
}: {
  label: string
  /** What the tile does, for its tooltip (the Work widgets section says which
   *  task list a click or a drag makes). */
  hint?: string
  active: boolean
  onClick: () => void
  testid?: string
  /** A second, quieter line — which account this tile is. Omitted when there
   *  is nothing to disambiguate. */
  note?: string
  /**
   * Makes the tile draggable onto a desk canvas.
   *
   * Omitted means not draggable, and that is the honest default: a tile with
   * a grab cursor that does nothing when dropped is worse than one that never
   * offered. Only tiles with a real destination get this.
   */
  onDragStart?: (e: React.DragEvent) => void
  /** An unread count the app itself reported. 0 renders nothing. */
  badge?: number
  /**
   * Whether that count is arriving live from a signed-in background session.
   *
   * 'live' is a sun and a green count; anything else is a moon and a grey one.
   * A bare number would be making two different claims with one mark — "4
   * unread right now" and "4 unread whenever we last managed to look".
   */
  liveness?: 'live' | 'signed-out' | 'asleep' | null
  /**
   * What `badge` counts. The title gives threads, the page's accessible labels
   * give messages, and saying "4" for either without saying which was the bug.
   */
  unit?: 'messages' | 'conversations' | 'unknown'
  /**
   * The app was signed in and has since landed on a sign-in page — the event
   * that silently stops its unread counts. Shown on every connected app, not
   * only watched ones, and cleared the moment the app is back on a normal
   * page. Clicking the tile opens the app, which is where you sign in.
   */
  signedOut?: boolean
  /** Not on this plan: still shown (it says why on click), marked for tests and styling. */
  locked?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      title={[note ? `${label} — ${note}` : label, hint].filter(Boolean).join('\n')}
      data-testid={testid}
      data-signed-out={signedOut ? 'true' : undefined}
      data-locked={locked ? 'true' : undefined}
      aria-current={active ? 'page' : undefined}
      className={`fb-nav-item flex-col justify-center gap-1 px-1 py-2 ${onDragStart ? 'cursor-grab active:cursor-grabbing ' : ''}${
        active
          ? 'bg-[rgb(var(--accent)/0.12)] text-[rgb(var(--accent))]'
          : 'text-[var(--ink-80)] hover:bg-[var(--surface-sunken)]'
      }`}
    >
      <span className="relative inline-flex items-center justify-center w-7 h-7 shrink-0">
        {children}
        {signedOut && (
          <span
            className="absolute -top-1 -left-1.5 inline-flex items-center justify-center w-[15px] h-[15px] rounded-full bg-amber-500 text-white"
            data-testid="nav-signed-out-badge"
            aria-hidden="true"
          >
            <Icon name="key" size={9} filled />
          </span>
        )}
        {badge > 0 && (
          <span
            className={`absolute -top-1 -right-1.5 min-w-[15px] h-[15px] px-1 rounded-full text-[9px] font-bold leading-[15px] text-center fb-tabular ${
              liveness === 'live'
                ? 'bg-emerald-500 text-white'
                : 'bg-[var(--ink-30)] text-[var(--surface-base)]'
            }`}
            data-testid="nav-unread-badge"
            data-live={liveness === 'live' ? 'true' : 'false'}
            title={
              // Name the unit when we know it. "4 unread" was ambiguous in the
              // worst way: the user read messages and we meant threads.
              (() => {
                const what =
                  unit === 'messages'
                    ? `${badge} unread ${badge === 1 ? 'message' : 'messages'}`
                    : unit === 'conversations'
                      ? `${badge} ${badge === 1 ? 'conversation' : 'conversations'} with unread`
                      : `${badge} unread`
                return liveness === 'live'
                  ? `${what} — signed in, checked just now`
                  : liveness === 'signed-out'
                    ? `${what} when last seen — signed out, so this is not current`
                    : `${what} when last seen — not being checked right now`
              })()
            }
          >
            {badge > 99 ? '99+' : badge}
          </span>
        )}
        {/* Awake or asleep. Shown whenever the app is watched, including at
            zero unread, because "nothing new" and "we cannot see" are not the
            same answer and the user asked to be able to tell. */}
        {liveness !== null && (
          <span
            className="absolute -bottom-1 -right-1 inline-flex items-center justify-center"
            data-testid="nav-liveness"
            data-liveness={liveness}
            title={
              liveness === 'live'
                ? 'Signed in — counts are arriving live'
                : liveness === 'signed-out'
                  ? 'Signed out — sign in to this app for live counts'
                  : 'Asleep — not being checked right now'
            }
          >
            <Icon
              name={liveness === 'live' ? 'wb_sunny' : 'bedtime'}
              size={11}
              filled
              className={liveness === 'live' ? 'text-amber-400' : 'text-[var(--ink-40)]'}
            />
          </span>
        )}
      </span>
      {/* ONE LINE, ALWAYS. A wrapped name makes every tile in the row taller
          and the grid ragged; the column count gives way instead (see
          TileGrid). The full name is on the tile's title, so an ellipsis never
          loses it. */}
      <span className="w-full text-[10px] leading-tight text-center truncate whitespace-nowrap">
        {label}
      </span>
      {signedOut ? (
        // Replaces the account note while it applies: "you are signed out" is
        // the more urgent line, and the account is still on the tooltip.
        <span
          className="w-full text-[9px] tracking-tight leading-tight text-center truncate whitespace-nowrap font-medium text-amber-700 dark:text-amber-400"
          data-testid="nav-signed-out"
          title={`${note ? `${label} (${note})` : label} was signed out — click to open it and sign in`}
        >
          Signed out — sign in
        </span>
      ) : (
        note && (
          <span
            className="w-full text-[9px] leading-tight text-center truncate whitespace-nowrap text-[var(--ink-40)]"
            data-testid="nav-tile-note"
          >
            {note}
          </span>
        )
      )}
    </button>
  )
}

