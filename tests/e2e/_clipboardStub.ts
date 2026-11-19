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
import type { ElectronApplication, Page } from '@playwright/test'

export interface StubClipboard {
  /** Everything on the clipboard, by type ('text/plain', 'text/html', custom). */
  data: Record<string, string>
  /** How many times something was written to it. */
  writes: number
}

/** Install (or reinstall, after a reload) the stub in this page. Starts empty unless given data. */
export async function installClipboardStub(page: Page, initial: Record<string, string> = {}): Promise<void> {
  await page.evaluate((init) => {
    type Store = { data: Record<string, string>; writes: number; id: string; version: number }
    const w = window as unknown as {
      __plexiiStubClipboard?: Store
      __plexiiStubInstalled?: boolean
      __plexiiStubSetFromMain?: (data: Record<string, string>) => void
    }
    // id: this install (a reload makes a new one); version: this page's own
    // writes, which the main-process half (installMainClipboardStub) picks up.
    w.__plexiiStubClipboard = { data: { ...init }, writes: 0, id: Math.random().toString(36).slice(2), version: Object.keys(init).length ? 1 : 0 }
    w.__plexiiStubSetFromMain = (data) => {
      ;(w.__plexiiStubClipboard as Store).data = { ...data }
    }
    if (w.__plexiiStubInstalled) return
    w.__plexiiStubInstalled = true
    const store = (): Store => w.__plexiiStubClipboard as Store
    const put = (data: Record<string, string>): void => {
      store().data = data
      store().writes++
      store().version++
    }
    const FILE_KEY = '__file:'
    const bytesOf = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const nativeExec = document.execCommand.bind(document)
    const isEditable = (el: Element | null): el is HTMLElement =>
      !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable)

    const fire = (kind: 'copy' | 'cut' | 'paste'): boolean => {
      const dt = new DataTransfer()
      if (kind === 'paste') {
        for (const [t, v] of Object.entries(store().data)) {
          // A picture on the clipboard reaches a paste event as a FILE, as
          // Chromium hands it over (types ['Files']), never as a string type.
          if (t.startsWith(FILE_KEY)) dt.items.add(new File([bytesOf(v)], 'image.png', { type: t.slice(FILE_KEY.length) }))
          else dt.setData(t, v)
        }
      }
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
        // A handler that took the event and set nothing (it wrote the clipboard
        // another way, as Draw does through its main process) leaves it as is.
        const out: Record<string, string> = {}
        for (const t of dt.types) out[t] = dt.getData(t)
        if (Object.keys(out).length) put(out)
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
            for (const t of item.types) {
              const blob = await item.getType(t)
              if (t.startsWith('image/') && t !== 'image/svg+xml') {
                // A picture is kept as its bytes (as base64), never as text.
                const bytes = new Uint8Array(await blob.arrayBuffer())
                let bin = ''
                for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
                out[FILE_KEY + t] = btoa(bin)
              } else out[t] = await blob.text()
            }
          }
          put(out)
        },
        read: async () => {
          const entries = Object.entries(store().data).map(([t, v]): [string, Blob] =>
            t.startsWith(FILE_KEY) ? [t.slice(FILE_KEY.length), new Blob([bytesOf(v)], { type: t.slice(FILE_KEY.length) })] : [t, new Blob([v], { type: t })]
          )
          if (!entries.length) return []
          return [new ClipboardItem(Object.fromEntries(entries))]
        }
      }
    })

    // The Edit menu: a ⌘/Ctrl C, X or V the page did not handle. It must decide
    // AFTER every page handler, as Electron's menu does, including handlers
    // added after this stub (an editor opened later, like PlexiiDraw, whose own
    // keydown runs its paste): so each such key arms, in the capture phase, a
    // one-shot listener that the window's bubble phase runs last of all.
    let pending: ((e: KeyboardEvent) => void) | null = null
    window.addEventListener(
      'keydown',
      (e) => {
        if (pending) window.removeEventListener('keydown', pending)
        pending = null
        if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
        const k = e.key.toLowerCase()
        const kind = k === 'c' ? 'copy' : k === 'x' ? 'cut' : k === 'v' ? 'paste' : null
        if (!kind) return
        const last = (ev: KeyboardEvent): void => {
          window.removeEventListener('keydown', last)
          pending = null
          if (ev !== e || ev.defaultPrevented) return
          ev.preventDefault()
          queueMicrotask(() => fire(kind))
        }
        pending = last
        window.addEventListener('keydown', last)
      },
      true
    )
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
    const s = (window as unknown as { __plexiiStubClipboard?: { data: Record<string, string>; writes: number; version: number } }).__plexiiStubClipboard
    if (!s) throw new Error('installClipboardStub first')
    s.data = { ...d }
    s.version++
  }, data)
}

/** The modifier a person presses on this machine. */
export const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

/**
 * The main process's half: Electron's clipboard module (what the app's main
 * process reads for a cross-app paste, readAppClipboard / readDrawClipboard,
 * and writes for Draw's copy), and webContents.copy / cut / paste (the Edit
 * menu, context-menu roles), answered from the test's own store, never the
 * system clipboard.
 *
 * It keeps step with the renderer half (installClipboardStub) every 40 ms, in
 * both directions: a copy in the page reaches what main reads, and a write in
 * main (Draw's copy, a spec's clipboard.writeText) reaches what the page
 * pastes. A page's own types (application/x-plexii-*) travel as Chromium does
 * store them: one pickled "web custom data" blob under its raw OS flavour, so
 * main's own parser (appClipboard.parseWebCustomData) still reads them.
 * Specs read and write through app.evaluate(({ clipboard }) => ...) as before.
 */
export async function installMainClipboardStub(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp, clipboard, webContents }) => {
    type Entries = Record<string, Buffer>
    type MainStub = { entries: Entries; seen: Map<number, { id: string; version: number }>; timer?: NodeJS.Timeout; copyImageAt: Array<{ x: number; y: number }> }
    const g = globalThis as unknown as { __plexiiMainStub?: MainStub }
    if (g.__plexiiMainStub) return
    const CUSTOM = 'electron application/osclipboard;format="org.chromium.web-custom-data"'
    const STANDARD = new Set(['text/plain', 'text/html', 'text/rtf', 'image/png', 'text/uri-list'])
    // A raw OS flavour written by the app (Draw writes public.png and
    // public.svg-image raw on macOS) is listed by the real clipboard under its
    // raw name AND the web type Chromium maps it to; so it is here.
    const RAW = /^electron application\/osclipboard;format="(.+)"$/
    const MAPPED: Record<string, string> = {
      'public.png': 'image/png',
      'public.svg-image': 'image/svg+xml',
      'public.utf8-plain-text': 'text/plain',
      'public.html': 'text/html',
      'public.rtf': 'text/rtf'
    }
    const st: MainStub = { entries: {}, seen: new Map(), copyImageAt: [] }
    g.__plexiiMainStub = st

    // Chromium's pickle of custom types: uint32 payload size, uint32 count, then
    // (type, data) as String16 each (uint32 length in UTF-16 units, padded to 4).
    const pickle = (pairs: Record<string, string>): Buffer => {
      const parts: Buffer[] = []
      const u32 = (n: number): Buffer => {
        const b = Buffer.alloc(4)
        b.writeUInt32LE(n)
        return b
      }
      const str16 = (s: string): Buffer => {
        const body = Buffer.alloc(((s.length * 2 + 3) & ~3))
        for (let i = 0; i < s.length; i++) body.writeUInt16LE(s.charCodeAt(i), i * 2)
        return Buffer.concat([u32(s.length), body])
      }
      const keys = Object.keys(pairs)
      parts.push(u32(keys.length))
      for (const k of keys) parts.push(str16(k), str16(pairs[k]))
      const payload = Buffer.concat(parts)
      return Buffer.concat([u32(payload.length), payload])
    }
    const unpickle = (buf: Buffer): Record<string, string> => {
      const out: Record<string, string> = {}
      let at = 4
      const u32 = (): number => {
        const v = buf.readUInt32LE(at)
        at += 4
        return v
      }
      const str16 = (): string => {
        const n = u32()
        let s = ''
        for (let i = 0; i < n; i++) s += String.fromCharCode(buf.readUInt16LE(at + i * 2))
        at += (n * 2 + 3) & ~3
        return s
      }
      try {
        const count = u32()
        for (let i = 0; i < count; i++) {
          const k = str16()
          out[k] = str16()
        }
      } catch {
        /* short blob: what was read */
      }
      return out
    }
    const fromPage = (data: Record<string, string>): Entries => {
      const e: Entries = {}
      const custom: Record<string, string> = {}
      for (const [t, v] of Object.entries(data)) {
        if (t.startsWith('__file:')) e[t.slice('__file:'.length)] = Buffer.from(v, 'base64')
        else if (STANDARD.has(t)) e[t] = Buffer.from(v, 'utf8')
        else custom[t] = v
      }
      if (Object.keys(custom).length) e[CUSTOM] = pickle(custom)
      return e
    }
    const toPage = (e: Entries): Record<string, string> => {
      const out: Record<string, string> = {}
      for (const [t, b] of Object.entries(e)) {
        if (t === CUSTOM) Object.assign(out, unpickle(b))
        // A picture goes to the page as bytes, which its paste event hands over as a file.
        else if (t === 'image/png') out['__file:image/png'] = b.toString('base64')
        else if (STANDARD.has(t)) out[t] = b.toString('utf8')
      }
      return out
    }
    const pushToPages = (): void => {
      const data = JSON.stringify(toPage(st.entries))
      for (const wc of webContents.getAllWebContents()) {
        void wc.executeJavaScript(`window.__plexiiStubSetFromMain && window.__plexiiStubSetFromMain(${data})`).catch(() => undefined)
      }
    }
    const setEntries = (e: Entries): void => {
      st.entries = e
      pushToPages()
    }
    const asBuffer = async (v: unknown): Promise<Buffer> =>
      typeof v === 'string' ? Buffer.from(v, 'utf8') : v instanceof Blob ? Buffer.from(await v.arrayBuffer()) : Buffer.from(String(v ?? ''), 'utf8')

    const cb = clipboard as unknown as Record<string, unknown>
    cb.readText = () => st.entries['text/plain']?.toString('utf8') ?? ''
    cb.writeText = (t: string) => setEntries({ 'text/plain': Buffer.from(String(t), 'utf8') })
    cb.readHTML = () => st.entries['text/html']?.toString('utf8') ?? ''
    cb.writeHTML = (h: string) => setEntries({ 'text/html': Buffer.from(String(h), 'utf8') })
    cb.clear = () => setEntries({})
    cb.availableFormats = () => Object.keys(st.entries)
    cb.has = (f: string) => f in st.entries
    cb.read = async () => {
      const e = st.entries
      const types = Object.keys(e)
      if (!types.length) return []
      return [{ types, getType: async (t: string) => (t in e ? new Blob([new Uint8Array(e[t])]) : Promise.reject(new Error(`no ${t}`))) }]
    }
    cb.write = async (input: unknown) => {
      const e: Entries = {}
      const add = async (rec: Record<string, unknown>): Promise<void> => {
        for (const [k, v] of Object.entries(rec)) {
          // The older object form: { text, html, rtf } beside Blob-keyed types.
          const t = k === 'text' ? 'text/plain' : k === 'html' ? 'text/html' : k === 'rtf' ? 'text/rtf' : k
          if (k === 'image' || k === 'bookmark') continue
          e[t] = await asBuffer(v)
        }
      }
      if (Array.isArray(input)) {
        for (const item of input as Array<{ types?: string[]; getType?: (t: string) => Promise<Blob> }>) {
          for (const t of item.types ?? []) if (item.getType) e[t] = await asBuffer(await item.getType(t))
        }
      } else if (input && typeof input === 'object') await add(input as Record<string, unknown>)
      for (const t of Object.keys(e)) {
        const web = MAPPED[RAW.exec(t)?.[1] ?? '']
        if (web && !(web in e)) e[web] = e[t]
      }
      setEntries(e)
    }
    // The Edit menu and context-menu roles: the page's own copy/cut/paste,
    // which the renderer half answers.
    const route = (wc: Electron.WebContents): void => {
      const w = wc as unknown as Record<string, unknown>
      for (const cmd of ['copy', 'cut', 'paste', 'pasteAndMatchStyle']) {
        const kind = cmd === 'pasteAndMatchStyle' ? 'paste' : cmd
        // Only a page with the renderer half: in any other, execCommand would
        // be Chromium's own and reach the system clipboard.
        w[cmd] = () => void wc.executeJavaScript(`window.__plexiiStubInstalled && document.execCommand(${JSON.stringify(kind)})`).catch(() => undefined)
      }
      // The web context menu's Copy Image writes the system clipboard from
      // Chromium directly; here it is only recorded (st.copyImageAt).
      w.copyImageAt = (x: number, y: number) => void st.copyImageAt.push({ x, y })
    }
    for (const wc of webContents.getAllWebContents()) route(wc)
    // Pages made later (a second window, a webview) are routed too.
    electronApp.on('web-contents-created', (_e, wc) => route(wc))

    // Keep step with each page's renderer half.
    st.timer = setInterval(() => {
      for (const wc of webContents.getAllWebContents()) {
        void wc
          .executeJavaScript('window.__plexiiStubClipboard ? JSON.stringify({ id: window.__plexiiStubClipboard.id, version: window.__plexiiStubClipboard.version, data: window.__plexiiStubClipboard.data }) : null')
          .then((raw: string | null) => {
            if (!raw) return
            const s = JSON.parse(raw) as { id: string; version: number; data: Record<string, string> }
            const prev = st.seen.get(wc.id)
            if (!prev || prev.id !== s.id) {
              // A new install (a reload): it starts from what main holds, unless it was given something.
              st.seen.set(wc.id, { id: s.id, version: s.version })
              if (s.version > 0) st.entries = fromPage(s.data)
              else pushToPages()
              return
            }
            if (s.version > prev.version) {
              st.seen.set(wc.id, { id: s.id, version: s.version })
              st.entries = fromPage(s.data)
            }
          })
          .catch(() => undefined)
      }
    }, 40)
  })
}
