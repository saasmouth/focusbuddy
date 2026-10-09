import { useEffect, useState } from 'react'
import { futuristicPowerOn, futuristicPowerOff } from './audioBeep'

export type ThemeMode = 'light' | 'dark' | 'auto' | 'futuristic' | 'atelier' | 'gemstone'
// The hand-tuned presets, plus 'custom' for a user-chosen accent (any hex).
// The presets carry a light/dark palette pair; 'custom' is resolved at
// apply-time from the stored hex with an auto-derived hover. ruby + sapphire are
// the gem accents that pair with the Gemstone theme (emerald already exists).
export type PresetAccent =
  | 'violet'
  | 'blue'
  | 'emerald'
  | 'rose'
  | 'heritage'
  | 'ruby'
  | 'sapphire'
export type AccentColor = PresetAccent | 'custom'

// Curated, accessibility-first interface faces. Free for everyone — this is
// about legibility, not a paywalled cosmetic. Each is loaded via the Google
// Fonts <link> in index.html and falls back through Inter then the system
// sans, so a missing webfont never leaves text unstyled.
export type FontChoice = 'system' | 'atkinson' | 'lexend'

interface AccentPalette {
  base: string
  hover: string
}

const ACCENT_PALETTES: Record<PresetAccent, { light: AccentPalette; dark: AccentPalette }> = {
  violet: {
    light: { base: '124 58 237', hover: '109 40 217' },
    dark: { base: '167 139 250', hover: '196 181 253' }
  },
  blue: {
    light: { base: '37 99 235', hover: '29 78 216' },
    dark: { base: '96 165 250', hover: '147 197 253' }
  },
  emerald: {
    light: { base: '5 150 105', hover: '4 120 87' },
    dark: { base: '52 211 153', hover: '110 231 183' }
  },
  rose: {
    light: { base: '225 29 72', hover: '190 18 60' },
    dark: { base: '251 113 133', hover: '253 164 175' }
  },
  // Heritage gold — the Atelier theme's signature accent. Restrained, warm,
  // reads as luxury hardware rather than tech. Subtly different in light vs
  // atelier so the gold sits properly on cream surfaces in light, on deep
  // navy in atelier.
  heritage: {
    light: { base: '180 138 70', hover: '156 113 53' },
    dark: { base: '201 169 97', hover: '224 196 137' }
  },
  // Ruby — a warm, deep jewel red, richer than rose. Sapphire — a royal blue,
  // deeper than the plain blue accent. Both are tuned to glow on the Gemstone
  // theme's near-black ground while staying legible in light mode.
  ruby: {
    light: { base: '201 31 58', hover: '168 22 44' },
    dark: { base: '248 113 132', hover: '252 150 165' }
  },
  sapphire: {
    light: { base: '30 78 216', hover: '30 58 138' },
    dark: { base: '110 160 250', hover: '150 190 255' }
  }
}

const KEY_MODE = 'fb.theme.mode'
const KEY_ACCENT = 'fb.theme.accent'
const KEY_FONT = 'fb.theme.font'
const KEY_CUSTOM = 'fb.theme.customAccent'
const DEFAULT_CUSTOM_HEX = '#7c3aed'

export const ACCENT_OPTIONS: Array<{ value: PresetAccent; label: string; preview: string }> = [
  { value: 'violet', label: 'Violet', preview: '#7c3aed' },
  { value: 'blue', label: 'Blue', preview: '#2563eb' },
  { value: 'emerald', label: 'Emerald', preview: '#059669' },
  { value: 'ruby', label: 'Ruby', preview: '#c91f3a' },
  { value: 'sapphire', label: 'Sapphire', preview: '#1e4ed8' },
  { value: 'rose', label: 'Rose', preview: '#e11d48' },
  { value: 'heritage', label: 'Heritage', preview: '#b48a46' }
]

// Font stacks keyed by choice. The named faces are real Google Fonts pulled in
// by index.html; the fallback chain keeps text rendered if the webfont is
// slow or unavailable (e.g. offline).
const FONT_STACKS: Record<FontChoice, string> = {
  system: "'Inter Variable', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  atkinson: "'Atkinson Hyperlegible', 'Inter Variable', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  lexend: "'Lexend Variable', 'Lexend', 'Inter Variable', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif"
}

export const FONT_OPTIONS: Array<{
  value: FontChoice
  label: string
  note: string
  stack: string
}> = [
  {
    value: 'system',
    label: 'Inter',
    note: 'The standard interface face — crisp at every size.',
    stack: FONT_STACKS.system
  },
  {
    value: 'atkinson',
    label: 'Atkinson Hyperlegible',
    note: 'Braille Institute design that maximises letter distinction for low vision.',
    stack: FONT_STACKS.atkinson
  },
  {
    value: 'lexend',
    label: 'Lexend',
    note: 'Shaped to lower visual stress and improve reading speed.',
    stack: FONT_STACKS.lexend
  }
]

// ── Custom accent helpers ────────────────────────────────────────────────
function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!m) return null
  const int = parseInt(m[1], 16)
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 }
}

function rgbTriplet(c: { r: number; g: number; b: number }): string {
  return `${c.r} ${c.g} ${c.b}`
}

// Hover variant of a custom accent. The preset palettes darken the accent on
// light themes and lighten it on dark themes for the pressed/hover affordance,
// so the custom derivation matches that direction rather than always darkening.
function deriveHover(c: { r: number; g: number; b: number }, effective: 'light' | 'dark'): string {
  if (effective === 'dark') {
    return rgbTriplet({
      r: clampByte(c.r + (255 - c.r) * 0.32),
      g: clampByte(c.g + (255 - c.g) * 0.32),
      b: clampByte(c.b + (255 - c.b) * 0.32)
    })
  }
  return rgbTriplet({ r: clampByte(c.r * 0.82), g: clampByte(c.g * 0.82), b: clampByte(c.b * 0.82) })
}

export function getCustomAccentHex(): string {
  if (typeof localStorage === 'undefined') return DEFAULT_CUSTOM_HEX
  const v = localStorage.getItem(KEY_CUSTOM)
  return v && hexToRgb(v) ? v : DEFAULT_CUSTOM_HEX
}

export function isValidHex(hex: string): boolean {
  return hexToRgb(hex) !== null
}

// ── Deep customisation (background, glass, icons) ─────────────────────────
// Everything here is free for every tier. It writes CSS variables + a couple
// of root attributes that the token sheet and Icon component consume; at the
// default values it's a no-op, so an uncustomised UI is byte-for-byte the
// stock look.
export type DeskBgMode = 'default' | 'solid' | 'gradient'
// The texture drawn on the desk paper: the stock dot grid, a composition-paper
// line grid, or nothing. Independent of the background colour above.
export type DeskPattern = 'dots' | 'grid' | 'none'

export interface ThemeCustomization {
  deskBgMode: DeskBgMode
  deskPattern: DeskPattern
  deskColor: string
  gradFrom: string
  gradTo: string
  gradAngle: number
  // Multipliers over the stock glass tokens. 1 = stock.
  glassBlur: number
  glassOpacity: number
  iconWeight: number
  iconFilled: boolean
}

export const DEFAULT_CUSTOMIZATION: ThemeCustomization = {
  deskBgMode: 'default',
  deskPattern: 'dots',
  deskColor: '#f1f2f4',
  gradFrom: '#7c3aed',
  gradTo: '#0ea5e9',
  gradAngle: 135,
  glassBlur: 1,
  glassOpacity: 1,
  iconWeight: 500,
  iconFilled: true
}

const KEY_CUSTOMIZE = 'fb.theme.customize'

export function applyCustomization(c: ThemeCustomization): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement

  // Canvas background.
  if (c.deskBgMode === 'default') {
    root.removeAttribute('data-desk-bg')
    root.style.removeProperty('--fb-desk-bg')
    root.style.removeProperty('--fb-desk-bg-color')
  } else if (c.deskBgMode === 'solid') {
    root.setAttribute('data-desk-bg', '1')
    root.style.setProperty('--fb-desk-bg', 'none')
    root.style.setProperty('--fb-desk-bg-color', c.deskColor)
  } else {
    root.setAttribute('data-desk-bg', '1')
    root.style.setProperty(
      '--fb-desk-bg',
      `linear-gradient(${c.gradAngle}deg, ${c.gradFrom}, ${c.gradTo})`
    )
    root.style.setProperty('--fb-desk-bg-color', 'transparent')
  }

  // Canvas pattern. 'dots' is the stock look baked into the base .desk-paper
  // rules, so it clears the attribute; 'grid' and 'none' set it and the
  // pattern rules in globals.css take over. A custom background (data-desk-bg)
  // wins over patterns by design.
  if (c.deskPattern && c.deskPattern !== 'dots') {
    root.setAttribute('data-desk-pattern', c.deskPattern)
  } else {
    root.removeAttribute('data-desk-pattern')
  }

  // Glass — translucency + blur scale across all three tiers at once.
  root.style.setProperty('--fb-glass-blur-scale', String(c.glassBlur))
  root.style.setProperty('--fb-glass-opacity-scale', String(c.glassOpacity))

  // Icons — global default weight + fill (per-instance explicit values win).
  root.style.setProperty('--fb-icon-wght', String(c.iconWeight))
  root.style.setProperty('--fb-icon-fill', c.iconFilled ? '1' : '0')
}

export function loadCustomization(): ThemeCustomization {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_CUSTOMIZATION }
  try {
    const raw = localStorage.getItem(KEY_CUSTOMIZE)
    if (!raw) return { ...DEFAULT_CUSTOMIZATION }
    const parsed = JSON.parse(raw) as Partial<ThemeCustomization>
    return { ...DEFAULT_CUSTOMIZATION, ...parsed }
  } catch {
    return { ...DEFAULT_CUSTOMIZATION }
  }
}

export function saveCustomization(c: ThemeCustomization): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(KEY_CUSTOMIZE, JSON.stringify(c))
  } catch {
    /* storage unavailable */
  }
}

export const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; icon: string }> = [
  { value: 'light', label: 'Light', icon: 'light_mode' },
  { value: 'dark', label: 'Dark', icon: 'dark_mode' },
  { value: 'auto', label: 'Auto', icon: 'brightness_auto' },
  { value: 'futuristic', label: 'Futuristic', icon: 'auto_awesome' },
  // Atelier — the premium flagship theme. Deep navy ground, warm cream
  // content surfaces, heritage-gold accent locked in. Hairline borders,
  // restrained typography, no bright colors anywhere. The "I'm in the
  // exclusive club" theme.
  { value: 'atelier', label: 'Atelier', icon: 'workspace_premium' },
  // Gemstone — the jewel theme. Onyx-black ground, faceted glass surfaces,
  // prismatic light refraction on edges, and a slow, whisper-soft sparkle.
  // Pairs with the emerald / ruby / sapphire gem accents. The "this is
  // exquisite" theme.
  { value: 'gemstone', label: 'Gemstone', icon: 'diamond' }
]

export function getEffectiveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'futuristic' || mode === 'atelier' || mode === 'gemstone') return 'dark'
  if (mode === 'auto') {
    if (typeof window === 'undefined') return 'light'
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  if (mode === 'light' || mode === 'dark') return mode
  return 'light'
}

export function applyTheme(mode: ThemeMode, accent: AccentColor, customHex?: string): void {
  if (typeof document === 'undefined') return
  const effective = getEffectiveTheme(mode)
  const root = document.documentElement
  root.classList.toggle('dark', effective === 'dark')
  root.classList.toggle('futuristic', mode === 'futuristic')
  root.classList.toggle('atelier', mode === 'atelier')
  root.classList.toggle('gemstone', mode === 'gemstone')
  // Atelier locks the accent to heritage gold — overriding the user's pick.
  // We don't persist this back; if they switch off atelier, their preferred
  // accent returns. (atelier IS the look — the whole point is the cohesion.)
  const effectiveAccent: AccentColor = mode === 'atelier' ? 'heritage' : accent
  root.setAttribute('data-accent', effectiveAccent)
  if (effectiveAccent === 'custom') {
    const rgb = hexToRgb(customHex ?? getCustomAccentHex()) ?? hexToRgb(DEFAULT_CUSTOM_HEX)!
    root.style.setProperty('--accent', rgbTriplet(rgb))
    root.style.setProperty('--accent-hover', deriveHover(rgb, effective))
  } else {
    const palette = ACCENT_PALETTES[effectiveAccent][effective]
    root.style.setProperty('--accent', palette.base)
    root.style.setProperty('--accent-hover', palette.hover)
  }
  // Mirror the theme onto the NATIVE window background. The BrowserWindow is
  // created with the light canvas grey (#f1f2f4); without this, any moment
  // Chromium exposes the window background (occlusion recovery, resize,
  // webview churn) flashes that grey over a dark desk — one of the reported
  // "blink" mechanisms. Both values track the --fb-canvas-* tokens in
  // globals.css, so the native background always matches the canvas it sits
  // behind.
  const nativeBg = effective === 'dark' ? '#220040' : '#f1f2f4'
  void window.api?.app?.setBackgroundColor?.(nativeBg)?.catch?.(() => {})
}

// Apply the chosen interface font by overriding the --font-sans / --font-display
// CSS variables on the document root. tokens.css declares these on :root, so an
// inline override on documentElement takes precedence everywhere they're used.
export function applyFont(font: FontChoice): void {
  if (typeof document === 'undefined') return
  const stack = FONT_STACKS[font] ?? FONT_STACKS.system
  const root = document.documentElement
  root.style.setProperty('--font-sans', stack)
  root.style.setProperty('--font-display', stack)
  root.setAttribute('data-font', font)
}

export function loadTheme(): {
  mode: ThemeMode
  accent: AccentColor
  font: FontChoice
  customAccentHex: string
} {
  if (typeof localStorage === 'undefined') {
    return { mode: 'auto', accent: 'violet', font: 'system', customAccentHex: DEFAULT_CUSTOM_HEX }
  }
  const mode = localStorage.getItem(KEY_MODE) as ThemeMode | null
  const accent = localStorage.getItem(KEY_ACCENT) as AccentColor | null
  const font = localStorage.getItem(KEY_FONT) as FontChoice | null
  return {
    mode:
      // Every ThemeMode must be listed here or the choice silently falls back
      // to 'auto' on the next launch. Gemstone was missing from the day it
      // shipped (b230ad6), so it never survived a relaunch.
      mode && ['light', 'dark', 'auto', 'futuristic', 'atelier', 'gemstone'].includes(mode)
        ? mode
        : 'auto',
    accent:
      accent && ['violet', 'blue', 'emerald', 'rose', 'heritage', 'custom'].includes(accent)
        ? accent
        : 'violet',
    font: font && ['system', 'atkinson', 'lexend'].includes(font) ? font : 'system',
    customAccentHex: getCustomAccentHex()
  }
}

export function saveTheme(
  mode: ThemeMode,
  accent: AccentColor,
  font?: FontChoice,
  customAccentHex?: string
): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(KEY_MODE, mode)
  localStorage.setItem(KEY_ACCENT, accent)
  if (font) localStorage.setItem(KEY_FONT, font)
  if (customAccentHex && isValidHex(customAccentHex)) localStorage.setItem(KEY_CUSTOM, customAccentHex)
}

export interface ThemeApi {
  mode: ThemeMode
  accent: AccentColor
  font: FontChoice
  customAccentHex: string
  customization: ThemeCustomization
  setMode: (m: ThemeMode) => void
  setAccent: (a: AccentColor) => void
  setFont: (f: FontChoice) => void
  // Set the custom accent hex AND switch the active accent to 'custom' so the
  // picker is live the moment the user touches the colour.
  setCustomAccent: (hex: string) => void
  // Merge a partial into the deep-customisation state; applies + persists live.
  setCustomization: (patch: Partial<ThemeCustomization>) => void
  resetCustomization: () => void
}

export function useTheme(): ThemeApi {
  const boot = loadTheme()
  const [mode, setModeState] = useState<ThemeMode>(() => boot.mode)
  const [accent, setAccentState] = useState<AccentColor>(() => boot.accent)
  const [font, setFontState] = useState<FontChoice>(() => boot.font)
  const [customAccentHex, setCustomAccentHexState] = useState<string>(() => boot.customAccentHex)
  const [customization, setCustomizationState] = useState<ThemeCustomization>(() =>
    loadCustomization()
  )

  useEffect(() => {
    applyTheme(mode, accent, customAccentHex)
    saveTheme(mode, accent, font, customAccentHex)
  }, [mode, accent, font, customAccentHex])

  useEffect(() => {
    applyFont(font)
  }, [font])

  useEffect(() => {
    applyCustomization(customization)
    saveCustomization(customization)
  }, [customization])

  useEffect(() => {
    if (mode !== 'auto') return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (): void => applyTheme(mode, accent, customAccentHex)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [mode, accent, customAccentHex])

  // Audio cue when entering/leaving futuristic — a "powering on" sweep
  const setMode = (next: ThemeMode): void => {
    if (next === 'futuristic' && mode !== 'futuristic') futuristicPowerOn()
    else if (mode === 'futuristic' && next !== 'futuristic') futuristicPowerOff()
    setModeState(next)
  }

  const setCustomAccent = (hex: string): void => {
    setCustomAccentHexState(hex)
    setAccentState('custom')
  }

  const setCustomization = (patch: Partial<ThemeCustomization>): void => {
    setCustomizationState((prev) => ({ ...prev, ...patch }))
  }
  const resetCustomization = (): void => {
    setCustomizationState({ ...DEFAULT_CUSTOMIZATION })
  }

  return {
    mode,
    accent,
    font,
    customAccentHex,
    customization,
    setMode,
    setAccent: setAccentState,
    setFont: setFontState,
    setCustomAccent,
    setCustomization,
    resetCustomization
  }
}
