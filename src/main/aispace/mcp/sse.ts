// A small Server-Sent Events parser (HTML Living Standard, "Parsing an event
// stream"), for Streamable HTTP responses that arrive as text/event-stream.
//
// Chunks can split anywhere — inside a line, between the CR and LF of a CRLF —
// so the parser buffers until a line is complete. An event without its closing
// blank line is discarded at end of stream, as the standard says, so a cut-off
// stream can never yield half a JSON-RPC message.

export interface SseEvent {
  event: string
  data: string
  id: string | null
}

export class SseParser {
  private buf = ''
  private data: string[] = []
  private hasData = false
  private event = ''
  private lastId: string | null = null

  push(chunk: string): SseEvent[] {
    this.buf += chunk
    let text = this.buf
    // A trailing CR may be the first half of a CRLF: hold it for the next chunk.
    let held = ''
    if (text.endsWith('\r')) {
      text = text.slice(0, -1)
      held = '\r'
    }
    const lines = text.split(/\r\n|\r|\n/)
    this.buf = (lines.pop() ?? '') + held
    const out: SseEvent[] = []
    for (const line of lines) this.line(line, out)
    return out
  }

  // End of stream: whatever is pending is incomplete and is dropped.
  end(): SseEvent[] {
    const out: SseEvent[] = []
    if (this.buf.endsWith('\r')) this.line(this.buf.slice(0, -1), out)
    this.buf = ''
    this.data = []
    this.hasData = false
    this.event = ''
    return out
  }

  private line(line: string, out: SseEvent[]): void {
    if (line === '') {
      if (this.hasData) out.push({ event: this.event || 'message', data: this.data.join('\n'), id: this.lastId })
      this.data = []
      this.hasData = false
      this.event = ''
      return
    }
    if (line.startsWith(':')) return // comment / keep-alive
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') {
      this.data.push(value)
      this.hasData = true
    } else if (field === 'event') {
      this.event = value
    } else if (field === 'id') {
      if (!value.includes('\u0000')) this.lastId = value
    }
    // 'retry' and unknown fields are ignored: this client never reconnects a
    // POST stream on the server's say-so.
  }
}
