// A clipboard of the test's own, inside the renderer: copy, cut and paste for a
// spec without the macOS system clipboard.
//
// Why: the system clipboard is shared. Two workers copying at once land in each
// other's paste (the AD-2 / AK-2 flakes, memory e2e-fixture-and-clipboard-traps),
// and it is the OWNER's clipboard: a spec that writes it overwrites whatever they
// copied (tests-must-not-take-over-screen).
//
// What it stands in for, and how faithfully:
//   - document.execCommand('copy' | 'cut' | 'paste'): what the page's own
//     handlers call to raise a clipboard event. Here it raises a real
//     ClipboardEvent at the focused element, carrying a DataTransfer, and keeps
//     what the page put in it.
//   - navigator.clipboard (writeText, readText, write, read): the same store.
//   - The app menu's Edit › Copy / Cut / Paste. In Electron a ⌘C, ⌘X or ⌘V the
//     page does not handle (keydown not defaultPrevented) goes to the menu, whose
//     role runs webContents.copy() etc.: a clipboard event at the focused
//     element. The stub does exactly that after an unhandled ⌘/Ctrl key, so a
//     spec presses the real keys and the page is tested on what it does with
//     them, not on a call the spec made for it.
//   - An event the page leaves alone does what the browser would: a copy takes
//     the selected text; a paste into a focused field inserts the text.
// Never stubbed: the page's handlers, its DataTransfer use, and its keys.
import type { Page } from '@playwright/test'

export interface StubClipboard {
  /** Everything on the clipboard, by type ('text/plain', 'text/html', custom). */
  data: Record<string, string>
  /** How many times something was written to it. */
  writes: number
}

/** Install (or reinstall, after a reload) the stub in this page. Starts empty unless given data. */
export async function installClipboardStub(page: Page, initial: Record<string, string> = {}): Promise<void> {
  await page.evaluate((init) => {
    type Store = { data: Record<string, string>; writes: number }
    const w = window as unknown as { __plexiiStubClipboard?: Store; __plexiiStubInstalled?: boolean }
    w.__plexiiStubClipboard = { data: { ...init }, writes: 0 }
    if (w.__plexiiStubInstalled) return
    w.__plexiiStubInstalled = true
    const store = (): Store => w.__plexiiStubClipboard as Store
    const put = (data: Record<string, string>): void => {
      store().data = data
      store().writes++
    }
    const nativeExec = document.execCommand.bind(document)
    const isEditable = (el: Element | null): el is HTMLElement =>
      !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable)

    const fire = (kind: 'copy' | 'cut' | 'paste'): boolean => {
      const dt = new DataTransfer()
      if (kind === 'paste') for (const [t, v] of Object.entries(store().data)) dt.setData(t, v)
      const target = (document.activeElement as Element | null) ?? document.body
      const ev = new ClipboardEvent(kind, { clipboardData: dt, bubbles: true, cancelable: true, composed: true })
      target.dispatchEvent(ev)
      if (kind === 'paste') {
        if (!ev.defaultPrevented && isEditable(target)) {
          const text = store().data['text/plain'] ?? ''
          if (text) nativeExec('insertText', false, text)
        }
        return true
      }
      if (ev.defaultPrevented) {
        const out: Record<string, string> = {}
        for (const t of dt.types) out[t] = dt.getData(t)
        put(out)
        return true
      }
      // Left alone: the browser copies the selected text (a field's own, or the page's).
      let text = ''
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        text = target.value.slice(target.selectionStart ?? 0, target.selectionEnd ?? 0)
      } else {
        text = window.getSelection()?.toString() ?? ''
      }
      if (text) {
        put({ 'text/plain': text })
        if (kind === 'cut' && isEditable(target)) nativeExec('delete')
      }
      return true
    }

    document.execCommand = ((cmd: string, ui?: boolean, value?: string) =>
      cmd === 'copy' || cmd === 'cut' || cmd === 'paste' ? fire(cmd) : nativeExec(cmd, ui, value)) as typeof document.execCommand

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (t: string) => put({ 'text/plain': String(t) }),
        readText: async () => store().data['text/plain'] ?? '',
        write: async (items: ClipboardItem[]) => {
          const out: Record<string, string> = {}
          for (const item of items) {
            for (const t of item.types) out[t] = await (await item.getType(t)).text()
          }
          put(out)
        },
        read: async () => {
          const entries = Object.entries(store().data)
          if (!entries.length) return []
          return [new ClipboardItem(Object.fromEntries(entries.map(([t, v]) => [t, new Blob([v], { type: t })])))]
        }
      }
    })

    // The Edit menu: a ⌘/Ctrl C, X or V the page did not handle. Listened for
    // on the window in the bubble phase, so it sees the event after every page
    // handler has had its say.
    window.addEventListener('keydown', (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      const k = e.key.toLowerCase()
      const kind = k === 'c' ? 'copy' : k === 'x' ? 'cut' : k === 'v' ? 'paste' : null
      if (!kind || e.defaultPrevented) return
      e.preventDefault()
      queueMicrotask(() => fire(kind))
    })
  }, initial)
}

/** What is on the stub clipboard now. */
export async function stubClipboard(page: Page): Promise<StubClipboard> {
  return page.evaluate(() => {
    const s = (window as unknown as { __plexiiStubClipboard?: { data: Record<string, string>; writes: number } }).__plexiiStubClipboard
    return { data: { ...(s?.data ?? {}) }, writes: s?.writes ?? 0 }
  })
}

/** Put something on the stub clipboard, as copying it in another app would. */
export async function setStubClipboard(page: Page, data: Record<string, string>): Promise<void> {
  await page.evaluate((d) => {
    const s = (window as unknown as { __plexiiStubClipboard?: { data: Record<string, string>; writes: number } }).__plexiiStubClipboard
    if (!s) throw new Error('installClipboardStub first')
    s.data = { ...d }
  }, data)
}

/** The modifier a person presses on this machine. */
export const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
