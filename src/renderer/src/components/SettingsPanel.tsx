import { useEffect, useRef, useState } from 'react'
import { useCapabilityEnabled } from '../stores/capabilities'
import { createPortal } from 'react-dom'
import {
  ACCENT_OPTIONS,
  THEME_OPTIONS,
  type AccentColor,
  type FontChoice,
  type ThemeCustomization,
  type ThemeMode
} from '../lib/theme'
import ThemeBuilder from './ThemeBuilder'
import { readDevForcedTier, setDevForcedTier } from '../stores/capabilities'
import type { TierId } from '../lib/capabilityDefaults'
import { captureRitualOrigin, playThemeRitual } from '../lib/themeRitual'
import {
  getSoundPrefs,
  setSoundPrefs,
  subscribeSoundPrefs,
  TYPING_CLICK_STYLES,
  type SoundPrefs,
  type TypingClickStyle
} from '../lib/soundPrefs'
import { previewTypingClick } from '../lib/audioBeep'
import {
  loadVoiceCommandPrefs,
  patchVoiceCommandPrefs,
  subscribeVoiceCommandPrefs
} from '../lib/voiceCommandPrefs'
import {
  AUTO_ROUTING_DISPLAY,
  MODEL_OPTIONS,
  useModelMode
} from '../lib/modelPrefs'
import { haptic } from '../lib/haptics'
import Icon from './Icon'
import { useViewStore } from '../stores/view'
import AccountSection from './settings/AccountSection'
import OrganisationSection from './settings/OrganisationSection'
import TemplatesSection from './settings/TemplatesSection'
import DocumentsSyncSection from './settings/DocumentsSyncSection'
import ApiKeysSection from './settings/ApiKeysSection'
import AttentionSection from './settings/AttentionSection'
import AutonomySection from './settings/AutonomySection'
import BodyDoubleSection from './settings/BodyDoubleSection'
import ConnectedAppsSection from './settings/ConnectedAppsSection'
import BrowserExtensionsSection from './settings/BrowserExtensionsSection'
import VaultSection from './settings/VaultSection'
import BrowsingConsentSection from './settings/BrowsingConsentSection'
import BackupSection from './settings/BackupSection'
import NavigationSection from './settings/NavigationSection'
import PrivacyHelpSection from './settings/PrivacyHelpSection'

interface Props {
  mode: ThemeMode
  accent: AccentColor
  font: FontChoice
  customAccentHex: string
  customization: ThemeCustomization
  onModeChange: (m: ThemeMode) => void
  onAccentChange: (a: AccentColor) => void
  onFontChange: (f: FontChoice) => void
  onCustomAccentChange: (hex: string) => void
  onCustomizationChange: (patch: Partial<ThemeCustomization>) => void
  onResetCustomization: () => void
  onClose: () => void
  anchorX: number
  anchorY: number
  /** Open straight onto this tab — used when a tour or a deep link asks for one. */
  initialTab?: SettingsTab
}

// Settings is organised into tabs so each area (appearance, account,
// organisation, AI, templates, data, advanced) is a short, scannable pane rather
// than one long scroll. Every section component is unchanged — this shell only
// decides which ones render for the active tab. Organisation, Templates and the
// account/user settings all live here, which is the consolidation the roster
// asked for.
export type SettingsTab = 'appearance' | 'account' | 'organisation' | 'ai' | 'templates' | 'data' | 'advanced'
const TABS: { id: SettingsTab; label: string; icon: string }[] = [
  { id: 'appearance', label: 'Appearance', icon: 'palette' },
  { id: 'account', label: 'Account', icon: 'person' },
  { id: 'organisation', label: 'Organisation', icon: 'apartment' },
  { id: 'ai', label: 'AI', icon: 'auto_awesome' },
  { id: 'templates', label: 'Templates', icon: 'dashboard_customize' },
  { id: 'data', label: 'Data', icon: 'cloud_sync' },
  { id: 'advanced', label: 'Advanced', icon: 'tune' }
]

export default function SettingsPanel({
  mode,
  accent,
  font,
  customAccentHex,
  customization,
  onModeChange,
  onAccentChange,
  onFontChange,
  onCustomAccentChange,
  onCustomizationChange,
  onResetCustomization,
  onClose,
  anchorX,
  anchorY,
  initialTab
}: Props): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const goOrg = useViewStore((s) => s.goOrg)
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? 'appearance')
  // An edition without body doubling should not advertise the preference.
  const bodyDoubleEnabled = useCapabilityEnabled('body_double')
  const [studioOpen, setStudioOpen] = useState(false)
  const [devTier, setDevTierState] = useState<TierId | null>(() => readDevForcedTier())
  const [sound, setSound] = useState<SoundPrefs>(() => getSoundPrefs())
  const [modelMode, setModelMode] = useModelMode()
  const [hapticsNative, setHapticsNative] = useState<boolean | null>(null)
  const [voicePrefs, setVoicePrefs] = useState<{
    commandMode: 'press-hold' | 'click-toggle'
    autoStopSilenceMs: number
    voiceback: boolean
  } | null>(null)

  useEffect(() => {
    window.api.haptics
      .available()
      .then((ok) => setHapticsNative(ok))
      .catch(() => setHapticsNative(false))
  }, [])

  useEffect(() => {
    // Through lib/voiceCommandPrefs, not straight to IPC: that module is what
    // the capture engine reads, so going through it is what makes a change
    // take effect on the next gesture instead of after a relaunch.
    void loadVoiceCommandPrefs()
    return subscribeVoiceCommandPrefs((p) => setVoicePrefs(p))
  }, [])

  async function patchVoicePrefs(
    patch: Partial<{
      commandMode: 'press-hold' | 'click-toggle'
      autoStopSilenceMs: number
      voiceback: boolean
    }>
  ): Promise<void> {
    await patchVoiceCommandPrefs(patch)
  }

  useEffect(() => {
    return subscribeSoundPrefs((p) => setSound(p))
  }, [])

  function updateSound(patch: Partial<SoundPrefs>): void {
    setSoundPrefs(patch)
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    function onClickOutside(e: MouseEvent): void {
      const target = e.target as Node
      if (ref.current?.contains(target)) return
      // ThemeBuilder is portalled to <body>, so it is a DOM sibling of this
      // popover rather than a descendant of ref. A click inside the studio must
      // still count as "inside" — otherwise it would close Settings and unmount
      // the studio between mousedown and click, dropping the actual control's
      // click and losing the theme change.
      if ((target as HTMLElement).closest?.('[data-testid="theme-builder"]')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    const armId = window.setTimeout(() => window.addEventListener('mousedown', onClickOutside), 50)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClickOutside)
      window.clearTimeout(armId)
    }
  }, [onClose])

  // Move focus into the popover when it opens so keyboard users land inside it
  // rather than being left on the trigger.
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>(
      'input, textarea, select, button, [tabindex]:not([tabindex="-1"])'
    )
    first?.focus()
  }, [])

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Settings"
      className="fixed z-[200] w-[560px] max-w-[calc(100vw-1.5rem)] max-h-[82vh] flex flex-col rounded-[var(--radius-card)] fb-glass-panel fb-pop-in"
      style={{ top: anchorY, right: window.innerWidth - anchorX }}
    >
      <div className="px-3 py-2 border-b border-[var(--edge-soft)] flex items-center justify-between shrink-0">
        <span className="fb-t-caption uppercase tracking-[0.12em] font-medium">
          Settings
        </span>
        <button onClick={onClose} className="icon-btn" aria-label="Close settings">
          <Icon name="close" size={14} />
        </button>
      </div>

      {/* Tab rail. Horizontal + wrapping so it reads as one compact strip under
          the header and uses the popover's width. */}
      <div
        role="tablist"
        aria-label="Settings sections"
        className="px-2 py-1.5 border-b border-[var(--edge-soft)] flex flex-wrap gap-1 shrink-0"
      >
        {TABS.map((t) => {
          const active = tab === t.id
          return (
            <button
              key={t.id}
              role="tab"
              id={`settings-tab-${t.id}`}
              // Without aria-controls and a matching tabpanel the tabs were
              // announced while their contents stayed orphaned -- the reported
              // "tabs are exposed, their visible controls are not".
              aria-controls="settings-tabpanel"
              // Roving tabindex: one tab stop for the whole strip, arrows move
              // between tabs. That is the ARIA tabs keyboard contract.
              tabIndex={active ? 0 : -1}
              onKeyDown={(e) => {
                const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
                if (dir === 0) return
                e.preventDefault()
                const i = TABS.findIndex((x) => x.id === tab)
                const next = TABS[(i + dir + TABS.length) % TABS.length]
                setTab(next.id)
                document.getElementById(`settings-tab-${next.id}`)?.focus()
              }}
              aria-selected={active}
              data-testid={`settings-tab-${t.id}`}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1 px-2 py-1 rounded-[var(--radius-field)] fb-t-caption font-medium border transition-colors ${
                active
                  ? 'border-accent bg-accent/10 text-[var(--ink-100)] fb-press'
                  : 'border-transparent text-[var(--ink-70)] hover:bg-[var(--surface-raised)]'
              }`}
            >
              <Icon name={t.icon} size={13} className={active ? 'text-accent' : 'text-[var(--ink-50)]'} />
              <span>{t.label}</span>
            </button>
          )
        })}
      </div>

      {/* Scrollable content pane — only the active tab's sections render. */}
      <div
        role="tabpanel"
        id="settings-tabpanel"
        aria-labelledby={`settings-tab-${tab}`}
        // Focusable so a keyboard user can reach and scroll the pane at all.
        tabIndex={0}
        className="flex-1 overflow-y-auto"
        data-testid={`settings-pane-${tab}`}
      >
        {tab === 'appearance' && (
          <>
            <div className="px-3 py-3 space-y-3">
              <div>
                <div className="fb-t-caption text-[var(--ink-70)] mb-1.5">Theme</div>
                <div className="grid grid-cols-5 gap-1">
                  {THEME_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      onClick={(e) => {
                        if (o.value === mode) return
                        captureRitualOrigin(e)
                        playThemeRitual(() => onModeChange(o.value))
                      }}
                      className={`flex flex-col items-center gap-1 py-2 rounded-[var(--radius-field)] border fb-t-caption transition-colors ${
                        mode === o.value
                          ? 'border-accent bg-accent/10 text-[var(--ink-100)] fb-press'
                          : 'border-[var(--edge-hairline)] bg-[var(--surface-raised)] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] fb-press'
                      }`}
                    >
                      <Icon
                        name={o.icon}
                        size={16}
                        className={mode === o.value ? 'text-accent' : 'text-[var(--ink-50)]'}
                      />
                      <span>{o.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="fb-t-caption text-[var(--ink-70)] mb-1.5">Accent</div>
                <div className="grid grid-cols-5 gap-1">
                  {ACCENT_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      onClick={(e) => {
                        if (o.value === accent) return
                        captureRitualOrigin(e)
                        playThemeRitual(() => onAccentChange(o.value))
                      }}
                      title={o.label}
                      className={`flex flex-col items-center gap-1 py-2 rounded-[var(--radius-field)] border transition-colors ${
                        accent === o.value
                          ? 'border-accent bg-[var(--surface-sunken)]'
                          : 'border-[var(--edge-soft)] bg-[var(--surface-raised)] hover:bg-[var(--surface-sunken)]'
                      }`}
                    >
                      <span
                        className="h-5 w-5 rounded-full border-2 border-[var(--surface-raised)] shadow-[var(--shadow-soft)]"
                        style={{ backgroundColor: o.preview }}
                      />
                      <span className="fb-t-caption text-[var(--ink-70)]">{o.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="px-3 pb-3 -mt-1">
              <button
                onClick={() => setStudioOpen(true)}
                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-[var(--radius-field)] border border-accent/40 bg-accent/[0.06] hover:bg-accent/10 text-[var(--ink-90)] transition-colors"
                data-testid="open-theme-studio"
              >
                <Icon name="palette" size={15} className="text-accent" />
                <div className="flex-1 text-left">
                  <div className="text-xs font-medium">Theme studio…</div>
                  <div className="fb-t-caption text-[var(--ink-50)]">
                    Custom accent colour and accessibility fonts. Free for everyone.
                  </div>
                </div>
                <Icon name="chevron_right" size={14} className="text-[var(--ink-40)]" />
              </button>

              {import.meta.env.DEV && (
                <div className="mt-2 rounded-[var(--radius-field)] border border-amber-300/60 dark:border-amber-600/40 bg-amber-50/70 dark:bg-amber-950/30 px-2.5 py-2">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Icon name="construction" size={13} className="text-amber-600 dark:text-amber-400" />
                    <span className="fb-t-caption uppercase tracking-[0.12em] font-semibold text-amber-700 dark:text-amber-400">
                      Developer
                    </span>
                  </div>
                  <div className="fb-t-caption text-[var(--ink-70)] mb-1.5 leading-snug">
                    Force a plan tier locally, no login needed. Dev builds only.
                  </div>
                  <div className="grid grid-cols-4 gap-1">
                    {([null, 'free', 'pro', 'team'] as const).map((t) => {
                      const active = devTier === t
                      return (
                        <button
                          key={t ?? 'off'}
                          onClick={() => {
                            setDevForcedTier(t)
                            setDevTierState(t)
                          }}
                          className={`px-1.5 py-1 rounded-[var(--radius-chip)] fb-t-caption capitalize border transition-colors ${
                            active
                              ? 'border-accent bg-accent/10 text-[var(--ink-100)] fb-press font-medium'
                              : 'border-[var(--edge-hairline)] bg-[var(--surface-raised)] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] fb-press'
                          }`}
                          data-testid={`dev-tier-${t ?? 'off'}`}
                        >
                          {t ?? 'Off'}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {tab === 'account' && (
          <>
            <AccountSection />
            {bodyDoubleEnabled && <BodyDoubleSection />}
          </>
        )}

        {tab === 'organisation' && (
          <OrganisationSection
            onManage={() => {
              goOrg()
              onClose()
            }}
          />
        )}

        {tab === 'ai' && (
          <>
            <ApiKeysSection />
            <AttentionSection />
            <AutonomySection />
            <BrowsingConsentSection />
          </>
        )}

        {tab === 'templates' && <TemplatesSection />}

        {tab === 'data' && (
          <>
            {/* The vault moved off the sidebar: it is a store you set up, not a
                place you browse on the way to work. */}
            <VaultSection />
            <BackupSection />
            <DocumentsSyncSection />
            <PrivacyHelpSection />
          </>
        )}

        {tab === 'advanced' && (
          <>
            {/* The sidebar lists connected apps only while a desk is open,
                because its rows are there to be dragged onto a canvas. Adding
                and removing them has to work with no desk open, so it lives
                here. */}
            <ConnectedAppsSection />
            {/* Extensions sit with Connected Apps: both are about what runs
                inside Plexii's browser surfaces. */}
            <BrowserExtensionsSection />
            <div className="px-3 py-3 space-y-2">
              <div className="fb-t-caption uppercase tracking-[0.12em] font-medium mb-1">
                Sounds
              </div>

              <label className="flex items-center justify-between py-1 cursor-pointer">
                <span className="text-xs text-[var(--ink-70)]">Sound effects</span>
                <input
                  type="checkbox"
                  checked={sound.enabled}
                  onChange={(e) => updateSound({ enabled: e.target.checked })}
                  className="h-3.5 w-3.5 accent-accent cursor-pointer"
                />
              </label>

              <div className={sound.enabled ? '' : 'opacity-50 pointer-events-none'}>
                <div className="py-1">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-[var(--ink-70)]">Volume</span>
                    <span className="fb-t-caption text-[var(--ink-50)] font-mono">
                      {Math.round(sound.volume * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(sound.volume * 100)}
                    onChange={(e) => updateSound({ volume: parseInt(e.target.value, 10) / 100 })}
                    className="w-full h-1 accent-accent cursor-pointer"
                  />
                </div>

                <label className="flex items-center justify-between py-1 cursor-pointer">
                  <span className="text-xs text-[var(--ink-70)]">Keyboard click</span>
                  <input
                    type="checkbox"
                    checked={sound.typingClick}
                    onChange={(e) => updateSound({ typingClick: e.target.checked })}
                    className="h-3.5 w-3.5 accent-accent cursor-pointer"
                  />
                </label>

                {sound.typingClick && (
                  <div className="pl-3 border-l-2 border-[var(--edge-soft)] py-1 space-y-3">
                    {(['tactile', 'ambient'] as const).map((family) => {
                      const styles = TYPING_CLICK_STYLES.filter((s) => s.family === family)
                      const heading = family === 'tactile' ? 'Tactile' : 'Ambient · spacey'
                      const subhead =
                        family === 'tactile'
                          ? 'Physical key feel'
                          : 'Low impact, breathy, dopamine'
                      return (
                        <div key={family} className="space-y-1">
                          <div className="flex items-baseline gap-1.5">
                            <div className="fb-t-caption text-[var(--ink-50)] uppercase tracking-wider">
                              {heading}
                            </div>
                            <div className="fb-t-caption text-[var(--ink-40)] truncate">
                              {subhead}
                            </div>
                          </div>
                          <div className="grid grid-cols-1 gap-0.5">
                            {styles.map((s) => {
                              const active = sound.typingClickStyle === s.value
                              return (
                                <button
                                  key={s.value}
                                  type="button"
                                  onClick={() => {
                                    updateSound({ typingClickStyle: s.value as TypingClickStyle })
                                    previewTypingClick(s.value as TypingClickStyle)
                                  }}
                                  className={`flex items-center justify-between gap-2 px-2 py-1.5 rounded-[var(--radius-chip)] text-left transition-colors ${
                                    active
                                      ? 'bg-accent/10 border border-accent/40 text-[var(--ink-100)]'
                                      : 'border border-transparent hover:bg-[var(--surface-sunken)] text-[var(--ink-70)]'
                                  }`}
                                >
                                  <div className="min-w-0">
                                    <div className="text-xs font-medium">{s.label}</div>
                                    <div className="fb-t-caption text-[var(--ink-50)] truncate">
                                      {s.blurb}
                                    </div>
                                  </div>
                                  {active ? (
                                    <Icon
                                      name="check_circle"
                                      size={14}
                                      filled
                                      className="text-accent shrink-0"
                                    />
                                  ) : (
                                    <Icon
                                      name="play_arrow"
                                      size={14}
                                      className="text-[var(--ink-40)] shrink-0"
                                    />
                                  )}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                <label className="flex items-start justify-between py-1 cursor-pointer gap-2">
                  <div className="flex-1">
                    <span className="text-xs text-[var(--ink-70)] block">
                      Quiet while widget active
                    </span>
                    <span className="fb-t-caption text-[var(--ink-50)]">
                      Suppress sounds while you're interacting with a widget (browser, sticky, etc.)
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    checked={sound.quietWhileWidgetActive}
                    onChange={(e) => updateSound({ quietWhileWidgetActive: e.target.checked })}
                    className="h-3.5 w-3.5 accent-accent cursor-pointer mt-0.5"
                  />
                </label>
              </div>
            </div>

            <div className="px-3 py-3 border-t border-[var(--edge-soft)] space-y-2">
              <div className="flex items-center justify-between mb-1">
                <div className="fb-t-caption uppercase tracking-[0.12em] font-medium">
                  Haptics
                </div>
                <span
                  className={`fb-t-caption font-mono px-1.5 py-0.5 rounded-[var(--radius-chip)] ${
                    hapticsNative === null
                      ? 'bg-[var(--surface-sunken)] text-[var(--ink-50)]'
                      : hapticsNative
                        ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                        : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                  }`}
                >
                  {hapticsNative === null ? 'checking…' : hapticsNative ? 'native' : 'audio fallback'}
                </span>
              </div>
              <p className="fb-t-caption text-[var(--ink-50)] leading-snug mb-1">
                {hapticsNative
                  ? 'NSHapticFeedbackPerformer is loaded — trackpad pulses fire on supported MacBooks.'
                  : "Audio-tactile substitute (no native module). Run `npx electron-rebuild -f -w node-mac-haptics` and restart to activate native."}
              </p>
              <div className="grid grid-cols-5 gap-1">
                {(['light', 'medium', 'rigid', 'success', 'warning'] as const).map((feel) => (
                  <button
                    key={feel}
                    onClick={() => haptic(feel)}
                    className="fb-btn-surface px-2 py-1.5 rounded-[var(--radius-chip)] fb-t-caption hover:bg-[var(--surface-sunken)] hover:border-accent transition-colors capitalize"
                  >
                    {feel}
                  </button>
                ))}
              </div>
            </div>

            <NavigationSection />

            {voicePrefs && (
              <div className="px-3 py-3 border-t border-[var(--edge-soft)] space-y-3">
                <div className="fb-t-caption uppercase tracking-[0.12em] font-medium">
                  Voice command (mic button)
                </div>
                <div>
                  <div className="fb-t-caption text-[var(--ink-70)] mb-1.5">
                    Trigger mode
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    {(
                      [
                        {
                          value: 'press-hold' as const,
                          label: 'Press & hold',
                          sub: 'Walkie-talkie — release to send'
                        },
                        {
                          value: 'click-toggle' as const,
                          label: 'Hands-free',
                          sub: 'Keeps listening after you let go; stops on silence'
                        }
                      ]
                    ).map((o) => (
                      <button
                        key={o.value}
                        onClick={() => void patchVoicePrefs({ commandMode: o.value })}
                        className={`text-left px-2.5 py-2 rounded-[var(--radius-field)] border fb-t-caption transition-colors ${
                          voicePrefs.commandMode === o.value
                            ? 'border-accent bg-accent/10 text-[var(--ink-100)] fb-press'
                            : 'border-[var(--edge-hairline)] bg-[var(--surface-raised)] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] fb-press'
                        }`}
                        data-testid={`voice-mode-${o.value}`}
                      >
                        <div className="font-medium">{o.label}</div>
                        <div className="fb-t-caption text-[var(--ink-50)] mt-0.5">
                          {o.sub}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
                {voicePrefs.commandMode === 'click-toggle' && (
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="fb-t-caption text-[var(--ink-70)]">
                        Auto-stop after silence
                      </span>
                      <span className="fb-t-caption font-mono text-[var(--ink-50)]">
                        {(voicePrefs.autoStopSilenceMs / 1000).toFixed(1)}s
                      </span>
                    </div>
                    <input
                      type="range"
                      min={1000}
                      max={15000}
                      step={500}
                      value={voicePrefs.autoStopSilenceMs}
                      onChange={(e) =>
                        void patchVoicePrefs({ autoStopSilenceMs: Number(e.target.value) })
                      }
                      className="w-full accent-accent"
                      data-testid="voice-silence-slider"
                    />
                  </div>
                )}
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={voicePrefs.voiceback}
                    onChange={(e) => void patchVoicePrefs({ voiceback: e.target.checked })}
                    className="accent-accent"
                    data-testid="voice-voiceback-checkbox"
                  />
                  <span className="fb-t-caption text-[var(--ink-70)]">
                    Speak the AI's reply aloud
                  </span>
                </label>
                <p className="fb-t-caption text-[var(--ink-50)] leading-snug">
                  Hold the Plexii mascot, or press ⌘⇧Space, and speak. What you said
                  lands in the Plexii composer for you to glance at and send — nothing
                  is acted on until you do. Speaking into a text field types the words
                  in instead.
                  {voicePrefs.commandMode === 'click-toggle' &&
                    ' In hands-free mode the mic stays open when you let go; press the mascot again to stop early.'}
                </p>
              </div>
            )}

            {/* AI model routing preferences live here too, alongside the AI tab's
                key/credit setup. */}
            <div className="px-3 py-3 border-t border-[var(--edge-soft)] space-y-2">
              <div className="fb-t-caption uppercase tracking-[0.12em] font-medium mb-1">
                AI model
              </div>
              <div className="grid grid-cols-1 gap-0.5">
                {MODEL_OPTIONS.map((opt) => {
                  const active = modelMode === opt.value
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setModelMode(opt.value)}
                      className={`flex items-start gap-2 px-2 py-1.5 rounded-[var(--radius-chip)] text-left transition-colors ${
                        active
                          ? 'bg-accent/10 border border-accent/40 text-[var(--ink-100)]'
                          : 'border border-transparent hover:bg-[var(--surface-sunken)] text-[var(--ink-70)]'
                      }`}
                    >
                      <Icon
                        name={
                          opt.value === 'auto'
                            ? 'tune'
                            : opt.value === 'haiku'
                              ? 'bolt'
                              : opt.value === 'sonnet'
                                ? 'psychology'
                                : 'auto_awesome'
                        }
                        size={14}
                        className={`mt-0.5 shrink-0 ${active ? 'text-accent' : 'text-[var(--ink-50)]'}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-xs font-medium">
                          {opt.label}
                          <span
                            className={`fb-t-caption font-mono px-1 rounded-[var(--radius-chip)] ${
                              active
                                ? 'bg-accent/15 text-accent'
                                : 'bg-[var(--surface-sunken)] text-[var(--ink-70)]'
                            }`}
                          >
                            {opt.costTier}
                          </span>
                        </div>
                        <div className="fb-t-caption text-[var(--ink-50)] leading-snug mt-0.5">
                          {opt.blurb}
                        </div>
                      </div>
                      {active && (
                        <Icon name="check_circle" size={14} filled className="text-accent shrink-0 mt-0.5" />
                      )}
                    </button>
                  )
                })}
              </div>

              {modelMode === 'auto' && (
                <div className="mt-2 pl-3 border-l-2 border-[var(--edge-soft)] space-y-0.5">
                  <div className="fb-t-caption uppercase tracking-wider text-[var(--ink-50)]">
                    Auto routing
                  </div>
                  {Object.entries(AUTO_ROUTING_DISPLAY).map(([purpose, info]) => (
                    <div
                      key={purpose}
                      className="flex items-center justify-between fb-t-caption py-0.5"
                    >
                      <span className="text-[var(--ink-70)] capitalize">
                        {purpose.replace('_', ' ')}
                      </span>
                      <span className="font-mono text-[var(--ink-70)]">
                        {info.model}{' '}
                        <span className="text-[var(--ink-40)]">{info.cost}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <div className="px-3 py-2 border-t border-[var(--edge-soft)] bg-[color-mix(in_oklab,var(--surface-sunken)_50%,transparent)] fb-t-caption text-[var(--ink-70)] shrink-0">
        Preferences saved locally.
      </div>

      {/* Portalled to <body> so its `fixed inset-0` overlay is relative to the
          viewport. The Settings popover carries `backdrop-blur`, which makes it a
          containing block for fixed-position descendants — rendering ThemeBuilder
          in-tree would center it on the popover (off-screen), not the window. */}
      {studioOpen &&
        createPortal(
          <ThemeBuilder
            mode={mode}
            accent={accent}
            font={font}
            customAccentHex={customAccentHex}
            customization={customization}
            onModeChange={onModeChange}
            onAccentChange={onAccentChange}
            onFontChange={onFontChange}
            onCustomAccentChange={onCustomAccentChange}
            onCustomizationChange={onCustomizationChange}
            onResetCustomization={onResetCustomization}
            onClose={() => setStudioOpen(false)}
          />,
          document.body
        )}
    </div>
  )
}
