import { FilesDockSlot } from '../files/FilesDock'
import { useCallback } from 'react'
import { useViewStore } from '../../stores/view'
import type { SegmentKind } from '../../lib/segmentApps'
import Icon from '../Icon'
import PlexiiIcon, { PlexiiTileIcon } from '../PlexiiIcon'
import { segmentAppEntity, viewKindEntity } from '../../lib/plexiiIconMap'
import WorkspaceSwitcher from '../WorkspaceSwitcher'
import AreaAccordion from '../nav/AreaAccordion'
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
  // The wordmark shown in the sidebar (e.g. "PLEXIIWORK").
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
  // The shell's test id is its KIND (segment-plexibrain), never its wordmark:
  // it was derived from the display wordmark, so the product-name respelling
  // (0066db39) silently turned segment-plexibrain into segment-plexiibrain and
  // left brainIngest, brainSyncPrune and plexiPeople waiting on an id that no
  // longer existed. Display names change; ids do not (lexicon rule).

  return (
    <div className="h-full flex bg-[var(--surface-base)] text-[var(--ink-100)] relative" data-testid={`segment-${def.kind}`}>
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
            <button onClick={goHome} className="text-[var(--ink-50)] hover:text-[var(--ink-90)]" title="Back to PlexiiDesk" data-testid="segment-exit">
              {/* The same PlexiiDesk tile the Office menu's way back wears. */}
              <PlexiiIcon kind="app" id="plexidesk" size={20} label="Back to PlexiiDesk" fallback="apps" />
            </button>
          </div>
        </div>

        {/* Workspace and area are ONE control. An area lives inside an
            organisation, so two stacked peers misdescribed the relationship and
            cost two rows to do it. See components/WorkspaceSwitcher.tsx. */}
        <WorkspaceSwitcher />

        {/* ONE menu, not four. The tab strip and this segment's own app list
            both went: the accordion carries every area's apps, so the thing you
            want is never in a menu you cannot see. Its sections default to open
            precisely so this does not become c581655d again — see
            components/nav/AreaAccordion.tsx. */}
        <AreaAccordion />

        <div className="mt-auto p-3">
          <UpgradeCard label={def.proLabel ?? `${def.title} Pro`} />
        </div>
      </aside>
      </div>
      )}
      {/* Files beside your work docks here (components/files/FilesDock). */}
      <FilesDockSlot belowPill={minimized} />

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
                {(() => {
                  const area = viewKindEntity(def.kind)
                  return area ? (
                    <PlexiiIcon kind={area.kind} id={area.id} size={28} fallback={def.icon} />
                  ) : (
                    <Icon name={def.icon} size={22} className="text-[rgb(var(--accent))]" />
                  )
                })()}
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
                    {(() => {
                      const ent = segmentAppEntity(def.kind, a.key)
                      return ent ? (
                        <PlexiiTileIcon kind={ent.kind} id={ent.id} fallback={a.icon} tone={a.tone} />
                      ) : (
                        <span className={`inline-flex items-center justify-center w-11 h-11 rounded-xl ${a.tone}`} style={{ background: 'color-mix(in srgb, currentColor 12%, transparent)' }}>
                          <Icon name={a.icon} size={22} />
                        </span>
                      )
                    })()}
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
