import { useCallback, useEffect, useState } from 'react'
import type { BodyDoubleMode } from '@shared/types'

// The four body-double modes in the person's own words, plus the saved default.
//
// This lives in lib rather than inside PeerBodyDoubleDialog because three
// surfaces now need it: the dialog, the Settings section where the default is
// configured, and the onboarding module that explains the feature.
//
// The tagline says plainly what each mode opens. The camera is on for presence
// in all of them; the microphone and chat are what differ, and
// lib/bodyDoubleMedia is what actually enforces that.

export const MODE_META: Record<BodyDoubleMode, { label: string; tagline: string; icon: string }> = {
  silent: {
    label: 'Silent',
    tagline: 'Cameras only. No microphone and no chat, just someone else working too.',
    icon: 'volume_off'
  },
  greetings: {
    label: 'Intros only',
    tagline: 'Say hello and what you are working on. Mics mute after two minutes, then quiet.',
    icon: 'waving_hand'
  },
  light: {
    label: 'A little chat is fine',
    tagline: 'Mics start muted. Text chat, or unmute for a quick word now and then.',
    icon: 'forum'
  },
  open: {
    label: 'Happy to talk',
    tagline: 'Mics on and chat open. Co-working out loud.',
    icon: 'chat'
  }
}

/** Quietest first, so the list reads as "how much contact do you want". */
export const MODE_ORDER: BodyDoubleMode[] = ['silent', 'greetings', 'light', 'open']

const KEY = 'fb.bodyDouble.defaultMode'

/** Silent is the default on purpose: it is the option that opens the least. */
export const FALLBACK_MODE: BodyDoubleMode = 'silent'

export function isBodyDoubleMode(v: unknown): v is BodyDoubleMode {
  return typeof v === 'string' && (MODE_ORDER as string[]).includes(v)
}

/**
 * The mode a new session starts on.
 *
 * The dialog used to hard-code 'silent' into useState, so whatever someone
 * chose was forgotten the moment they closed it — there was nowhere to express
 * "this is how I always want to pair". An unreadable or unrecognised stored
 * value falls back rather than throwing: this is read during render.
 */
export function getDefaultBodyDoubleMode(): BodyDoubleMode {
  try {
    const raw = localStorage.getItem(KEY)
    return isBodyDoubleMode(raw) ? raw : FALLBACK_MODE
  } catch {
    return FALLBACK_MODE
  }
}

export function setDefaultBodyDoubleMode(mode: BodyDoubleMode): void {
  try {
    localStorage.setItem(KEY, mode)
  } catch {
    // A write that cannot persist must not break the picker in front of the
    // user — the session still runs on the mode they just chose.
  }
  // Other open surfaces (Settings and the dialog can both be mounted) follow
  // the change without a reload.
  window.dispatchEvent(new CustomEvent('fb:body-double-mode-changed', { detail: { mode } }))
}

/** Reactive read/write of the saved default, kept in step across surfaces. */
export function useDefaultBodyDoubleMode(): [BodyDoubleMode, (m: BodyDoubleMode) => void] {
  const [mode, setMode] = useState<BodyDoubleMode>(getDefaultBodyDoubleMode)

  useEffect(() => {
    function onChange(e: Event): void {
      const next = (e as CustomEvent<{ mode: BodyDoubleMode }>).detail?.mode
      if (isBodyDoubleMode(next)) setMode(next)
    }
    window.addEventListener('fb:body-double-mode-changed', onChange)
    return () => window.removeEventListener('fb:body-double-mode-changed', onChange)
  }, [])

  const save = useCallback((m: BodyDoubleMode) => {
    setMode(m)
    setDefaultBodyDoubleMode(m)
  }, [])

  return [mode, save]
}
