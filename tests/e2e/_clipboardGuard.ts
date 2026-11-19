// The clipboard guard: no default-run spec may reach the machine's clipboard.
//
// Why: the system clipboard is shared between workers (two specs copying at
// once land in each other's paste) and it is the OWNER's (a spec that writes it
// overwrites what they copied; one that reads it pastes their data into a test
// profile). Specs use the test's own clipboard instead, tests/e2e/_clipboardStub.ts,
// both halves. This guard makes forgetting that a failure instead of a silent
// write to the owner's clipboard (memory: e2e-fixture-and-clipboard-traps).
//
// launchApp installs it on every launch unless the spec opts out with
// `launchApp({ realClipboard: true })`; only the opt-in native specs
// (drawShortcutsNative, _drawCopyOutNative: real input or the real pasteboard,
// under the real-input lock) do. Until the stub is installed:
//
//   main  Electron's clipboard module (every read and write) and
//         webContents.copy / cut / paste / pasteAndMatchStyle / copyImageAt
//         (the Edit menu and context-menu roles) are refused: the call throws,
//         nothing reaches the system clipboard. installMainClipboardStub
//         replaces the module's methods and the webContents commands, so a
//         stubbed spec never meets the guard; a method the stub does not answer
//         (readImage, readBuffer, ...) stays refused.
//   page  in every page, on every load: a ⌘/Ctrl C, X or V keydown (which
//         Playwright sends with Chromium's native copy: / paste: command),
//         document.execCommand('copy' | 'cut' | 'paste') and navigator.clipboard
//         are refused while the page's half (installClipboardStub) is absent:
//         the key's default is prevented, so the native command never runs.
//
// Every refusal is recorded, and launchApp's dispose() fails the spec with the
// list, so a spec that forgets the stub goes red even when its own assertions
// would have passed.
import type { ElectronApplication } from '@playwright/test'

/** The marker a page's refusal is reported to main with (its console). */
export const CLIPBOARD_GUARD_MARK = '[plexii-clipboard-guard]'

/** Install the guard in a freshly launched app (launchApp does this). */
export async function installClipboardGuard(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp, clipboard, webContents }, MARK) => {
    type Guard = { violations: string[] }
    const g = globalThis as unknown as { __plexiiClipboardGuard?: Guard; __plexiiMainStub?: unknown }
    if (g.__plexiiClipboardGuard) return
    const guard: Guard = { violations: [] }
    g.__plexiiClipboardGuard = guard
    const refuse = (what: string): Error => {
      const msg = `${what} without the test clipboard (tests/e2e/_clipboardStub.ts): it would reach the machine's clipboard`
      if (guard.violations.length < 50) guard.violations.push(msg)
      return new Error(`[clipboard guard] ${msg}`)
    }

    // Electron's clipboard module.
    const cb = clipboard as unknown as Record<string, unknown>
    for (const name of [
      'readText', 'writeText', 'readHTML', 'writeHTML', 'readRTF', 'writeRTF', 'readImage', 'writeImage',
      'readBookmark', 'writeBookmark', 'readFindText', 'writeFindText', 'read', 'write', 'readBuffer',
      'writeBuffer', 'clear', 'availableFormats', 'has'
    ]) {
      if (typeof cb[name] !== 'function') continue
      cb[name] = () => {
        throw refuse(`clipboard.${name}()`)
      }
    }

    // The page's half of the guard, run in every page on every load.
    const PAGE_GUARD = `(() => {
      if (window.__plexiiClipboardGuardOn) return
      window.__plexiiClipboardGuardOn = true
      const MARK = ${JSON.stringify(MARK)}
      const stubbed = () => !!window.__plexiiStubInstalled
      const report = (what) => console.warn(MARK + ' ' + what + ' without the test clipboard (tests/e2e/_clipboardStub.ts): it would reach the machine\\'s clipboard')
      window.addEventListener('keydown', (e) => {
        if (stubbed() || !(e.metaKey || e.ctrlKey) || e.altKey) return
        const k = (e.key || '').toLowerCase()
        if (k !== 'c' && k !== 'x' && k !== 'v') return
        e.preventDefault()
        report((e.metaKey ? 'Meta' : 'Control') + (e.shiftKey ? '+Shift' : '') + '+' + k.toUpperCase() + ' pressed')
      }, true)
      const exec = document.execCommand.bind(document)
      document.execCommand = function (cmd, ui, value) {
        if (!stubbed() && (cmd === 'copy' || cmd === 'cut' || cmd === 'paste')) { report("document.execCommand('" + cmd + "')"); return false }
        return exec(cmd, ui, value)
      }
      const real = navigator.clipboard
      if (real) {
        const wrap = (name) => function (...args) {
          if (!stubbed()) { report('navigator.clipboard.' + name + '()'); return Promise.reject(new DOMException('Refused by the e2e clipboard guard', 'NotAllowedError')) }
          return real[name].apply(real, args)
        }
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: wrap('writeText'), readText: wrap('readText'), write: wrap('write'), read: wrap('read') } })
      }
    })()`

    const watch = (wc: Electron.WebContents): void => {
      const w = wc as unknown as Record<string, unknown>
      for (const cmd of ['copy', 'cut', 'paste', 'pasteAndMatchStyle', 'copyImageAt']) {
        w[cmd] = () => {
          throw refuse(`webContents.${cmd}()`)
        }
      }
      wc.on('console-message', (...args: unknown[]) => {
        // Electron 35+: one event object carrying `message`; before: (event, level, message).
        const first = args[0] as { message?: unknown } | undefined
        const message = typeof first?.message === 'string' ? first.message : typeof args[2] === 'string' ? args[2] : ''
        if (message.startsWith(MARK) && guard.violations.length < 50) guard.violations.push(message.slice(MARK.length + 1))
      })
      wc.on('dom-ready', () => void wc.executeJavaScript(PAGE_GUARD).catch(() => undefined))
      void wc.executeJavaScript(PAGE_GUARD).catch(() => undefined)
    }
    for (const wc of webContents.getAllWebContents()) watch(wc)
    electronApp.on('web-contents-created', (_e, wc) => watch(wc))
  }, CLIPBOARD_GUARD_MARK)
}

/** What the guard refused in this app so far (empty when the app is gone). */
export async function clipboardGuardViolations(app: ElectronApplication): Promise<string[]> {
  try {
    return await Promise.race([
      app.evaluate(() => [...((globalThis as unknown as { __plexiiClipboardGuard?: { violations: string[] } }).__plexiiClipboardGuard?.violations ?? [])]),
      new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 3_000))
    ])
  } catch {
    return []
  }
}
