import { useEffect } from 'react'
import { useAppNotifications } from '../stores/appNotifications'

// Watches a connected app's <webview> for the page it SETTLES on, and feeds that
// into the signed-out detector (src/shared/signInState.ts). Used by the
// full-pane view and by desk widgets bound to a connected app; the background
// unread probe reports through the same store call.
//
// SETTLED, because sign-in flows pass through sign-in-shaped URLs on their way
// somewhere else — a silent SSO refresh bounces through the identity provider
// and back in under a second. Reading the page only after it has stopped
// loading for SETTLE_MS keeps those hops from flashing "signed out".

const SETTLE_MS = 1_500

/** Script run in the guest: is a password field actually visible? */
export const PASSWORD_FIELD_PROBE =
  '(() => { const p = document.querySelector("input[type=password]"); return !!p && !!p.offsetParent })()'

interface WebviewLike {
  getURL: () => string
  getTitle: () => string
  isLoading: () => boolean
  executeJavaScript: (code: string) => Promise<unknown>
}

export function useSignInWatch(el: HTMLElement | null, appId: string | null | undefined): void {
  useEffect(() => {
    if (!el || !appId) return
    const wv = el as unknown as WebviewLike
    let timer: number | null = null
    let alive = true

    const check = (): void => {
      timer = null
      if (!alive) return
      let url = ''
      let title = ''
      try {
        if (wv.isLoading()) return // the next did-stop-loading re-arms
        url = wv.getURL()
        title = wv.getTitle()
      } catch {
        return // not attached yet
      }
      if (!/^https?:\/\//i.test(url)) return
      wv.executeJavaScript(PASSWORD_FIELD_PROBE)
        .then((pw) => !!pw)
        .catch(() => false) // CSP or a crashed guest: judge on URL and title alone
        .then((hasPasswordField) => {
          if (!alive) return
          useAppNotifications.getState().observeSignIn(appId, { url, title, hasPasswordField })
        })
    }

    const arm = (): void => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(check, SETTLE_MS)
    }
    const onInPage = (e: Event): void => {
      if ((e as unknown as { isMainFrame?: boolean }).isMainFrame === false) return
      arm()
    }

    el.addEventListener('did-stop-loading', arm as EventListener)
    el.addEventListener('did-navigate-in-page', onInPage as EventListener)
    return () => {
      alive = false
      if (timer !== null) window.clearTimeout(timer)
      el.removeEventListener('did-stop-loading', arm as EventListener)
      el.removeEventListener('did-navigate-in-page', onInPage as EventListener)
    }
  }, [el, appId])
}
