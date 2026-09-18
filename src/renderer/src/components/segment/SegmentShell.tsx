import { useCallback } from 'react'
import { useViewStore } from '../../stores/view'
import type { SegmentKind } from '../../lib/segmentApps'
import SegmentSwitcher from './SegmentSwitcher'
import OrgSwitcher from '../OrgSwitcher'
import Icon from '../Icon'
import UpgradeCard from '../UpgradeCard'
import {
  FLOATING_MENU_ASIDE_SCROLL,
  FLOATING_MENU_INSET,
  FLOATING_MENU_STYLE,
  MenuMinimizeButton,
  MenuRestorePill,
  useMinimizable
} from '../chrome/floatingMenu'
import PageEnter from '../chrome/pageEnter'

// A reusable "segment" shell: a full-bleed area with its own dedicated side menu
// and a home of app tiles. Each segment (PlexiWork, PlexiConnect, PlexiFlow) is a
// thin definition of its apps; the apps reuse the existing views, rendered inline
// so the segment's side menu stays put while you move between them. This gives
// every part of the system the same organised, focused feel as PlexiOffice.

export interface SegmentApp {
  key: string
  label: string
  blurb: string
  icon: string
  // Tailwind background classes for the colored icon tile.
  tint: string
  // Tailwind text-* class colouring the bare icon in the side menu (no tile).
  tone: string
  render: () => JSX.Element
}

export interface SegmentDef {
  // Which segment this is, so the shell can navigate rather than remember.
  kind: SegmentKind
  // The wordmark shown in the sidebar (e.g. "PLEXIWORK").
  wordmark: string
  title: string
  subtitle: string
  icon: string
  apps: SegmentApp[]
  proLabel?: string
}

export default function SegmentShell({ def, initialApp }: { def: SegmentDef; initialApp?: string }): JSX.Element {
  const goHome = useViewStore((s) => s.goHome)
  // WHICH APP IS OPEN IS NAVIGATION, not local state.
  //
  // This was a useState, and it backed three of the four segments — every app
  // in PlexiDesk, PlexiPeople and PlexiBrain. Nothing outside this component
  // could tell what you had open, so none of them reached the tray, Back did
  // nothing inside a segment, and a reload dropped you on the segment's home
  // having lost where you were. PlexiOffice had the identical bug.
  //
  // The view store already had a place to put it — kind + app, with
  // goPlexiDesk/goPlexiPeople/goPlexiBrain — and nothing was calling it.
  const activeKey = initialApp ?? null
  const setActiveKey = useCallback(
    (key: string | null): void => {
      const v = useViewStore.getState()
      const app = key ?? undefined
      if (def.kind === 'plexipeople') v.goPlexiPeople(app)
      else if (def.kind === 'plexibrain') v.goPlexiBrain(app)
      else if (def.kind === 'office') v.goOffice(app)
      else v.goPlexiDesk(app)
    },
    [def.kind]
  )
  const active = def.apps.find((a) => a.key === activeKey) ?? null
  // The segment menu floats as a rounded card and can be minimised to free the
  // area, exactly like the global Desk sidebar. Its state persists per reload.
  const { minimized, minimize, restore } = useMinimizable('fb.segmentMenu.minimized')

  return (
    <div className="h-full flex bg-[var(--surface-base)] text-[var(--ink-100)] relative" data-testid={`segment-${def.wordmark.toLowerCase()}`}>
      {minimized && (
        <MenuRestorePill onClick={restore} label={def.title} title={`Show the ${def.title} menu`} />
      )}
      {/* Dedicated segment side menu — a floating rounded card */}
      {!minimized && (
      <div
        className={`shrink-0 h-full box-border ${FLOATING_MENU_INSET}`}
        style={{ width: 'var(--fb-sidebar-fixed, 260px)' }}
      >
      <aside className={FLOATING_MENU_ASIDE_SCROLL} style={FLOATING_MENU_STYLE} data-testid="segment-sidebar">
        <div className="flex items-center gap-2 px-4 h-14 border-b border-[var(--edge-soft)]">
          <span className="text-[15px] font-bold tracking-[0.14em]">{def.wordmark}</span>
          <div className="ml-auto flex items-center gap-1.5">
            <MenuMinimizeButton onClick={minimize} title={`Minimise the ${def.title} menu`} />
            <button onClick={goHome} className="text-[var(--ink-50)] hover:text-[var(--ink-90)]" title="Back to PlexiDesk" data-testid="segment-exit">
              <Icon name="apps" size={18} />
            </button>
          </div>
        </div>

        <OrgSwitcher />
        <SegmentSwitcher />

        <nav className="px-2 pt-1 pb-3">
          <button
            onClick={() => setActiveKey(null)}
            data-testid="segment-nav-home"
            className={`flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-[13px] mb-0.5 ${
              active === null ? 'bg-[rgb(var(--accent)/0.12)] text-[rgb(var(--accent))] font-medium' : 'text-[var(--ink-80)] hover:bg-[var(--surface-sunken)]'
            }`}
          >
            <span className="inline-flex items-center justify-center w-6 h-6 shrink-0 text-indigo-500">
              <Icon name="home" size={17} />
            </span>
            <span>Home</span>
          </button>
        </nav>

        <div className="px-4 pt-1 pb-1.5 text-[10px] uppercase tracking-[0.12em] text-[var(--ink-40)] font-semibold">Apps</div>
        <div className="px-2">
          {def.apps.map((a) => (
            <button
              key={a.key}
              onClick={() => setActiveKey(a.key)}
              data-testid={`segment-app-${a.key}`}
              className={`flex items-center gap-2.5 w-full px-3 py-1.5 rounded-lg text-[13px] mb-0.5 ${
                activeKey === a.key ? 'bg-[rgb(var(--accent)/0.12)] text-[rgb(var(--accent))] font-medium' : 'text-[var(--ink-80)] hover:bg-[var(--surface-sunken)]'
              }`}
            >
              <span className={`inline-flex items-center justify-center w-6 h-6 shrink-0 ${a.tone}`}>
                <Icon name={a.icon} size={16} />
              </span>
              <span>{a.label}</span>
            </button>
          ))}
        </div>

        <div className="mt-auto p-3">
          <UpgradeCard label={def.proLabel ?? `${def.title} Pro`} />
        </div>
      </aside>
      </div>
      )}

      {/* Content: an app view inline, or the segment home of app tiles.
          Inner app switches unravel in like every page (PageEnter), except
          the Home dashboard, which runs its own richer widget cascade. */}
      <div className="flex-1 min-w-0 overflow-hidden">
        {active ? (
          active.key === 'home' ? (
            <div className="h-full overflow-auto">{active.render()}</div>
          ) : (
            <PageEnter id={`segment-app-${active.key}`} className="h-full overflow-auto">
              {active.render()}
            </PageEnter>
          )
        ) : (
          <PageEnter id="segment-home" className="h-full overflow-auto">
            <div className="max-w-[1100px] mx-auto px-6 py-8">
              <div className="flex items-center gap-2.5 mb-1">
                <Icon name={def.icon} size={22} className="text-[rgb(var(--accent))]" />
                <h1 className="text-[22px] font-semibold">{def.title}</h1>
              </div>
              <p className="text-[13px] text-[var(--ink-50)] mb-6">{def.subtitle}</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {def.apps.map((a) => (
                  <button
                    key={a.key}
                    onClick={() => setActiveKey(a.key)}
                    data-testid={`segment-tile-${a.key}`}
                    className="fb-btn-surface flex flex-col items-start gap-2.5 p-4 text-left hover:border-[rgb(var(--accent)/0.5)] hover:shadow-sm transition"
                  >
                    <span className={`inline-flex items-center justify-center w-11 h-11 rounded-xl ${a.tone}`} style={{ background: 'color-mix(in srgb, currentColor 12%, transparent)' }}>
                      <Icon name={a.icon} size={22} />
                    </span>
                    <span className="text-[14px] font-semibold">{a.label}</span>
                    <span className="text-[12px] text-[var(--ink-50)] leading-snug">{a.blurb}</span>
                  </button>
                ))}
              </div>
            </div>
          </PageEnter>
        )}
      </div>
    </div>
  )
}
