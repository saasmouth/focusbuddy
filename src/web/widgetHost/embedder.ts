// The link to whatever embeds the widget host (protocol.ts explains the shape).
//
// Posts go to window.parent and only messages FROM window.parent are read. In
// an <iframe> that is the embedding page; in PlexiiLite's <webview> the page is
// top-level, window.parent is the page itself, and PlexiiLite's preload relays
// both ways through window 'message' events. Origin is '*' because a webview's
// embedder has no web origin to name; the source check is what keeps another
// frame from loading a file into this page or reading its saves.
import { readEmbedderMessage, type EmbedderMessage, type HostMessage } from './protocol'

export interface Embedder {
  post(msg: HostMessage): void
  listen(cb: (msg: EmbedderMessage) => void): () => void
}

export function windowEmbedder(win: Window = window): Embedder {
  return {
    post(msg) {
      win.parent.postMessage(msg, '*')
    },
    listen(cb) {
      const on = (e: MessageEvent): void => {
        if (e.source !== win.parent) return
        const msg = readEmbedderMessage(e.data)
        if (msg) cb(msg)
      }
      win.addEventListener('message', on)
      return () => win.removeEventListener('message', on)
    }
  }
}
