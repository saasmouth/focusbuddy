// Chat web search sends the message to DuckDuckGo, so it runs only when the
// request says so explicitly (the chat panel's globe). The model layer treats a
// missing flag as on; callers that never set it (dashboard cards, field AI,
// Stream Deck) must not search the web, so the flag is made explicit here.
export function withWebSearchOptIn<T extends { webSearch?: boolean }>(req: T): T {
  return { ...req, webSearch: req?.webSearch === true }
}
