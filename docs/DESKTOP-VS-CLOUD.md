# Plexii on the desktop and Plexii in a browser

The two run **the same renderer**. Not a port, not a cut-down edition: the cloud
app builds the desktop's own interface and gives it the desktop's own data
layer, compiled to WebAssembly. That is why this document is short on
differences and specific about the ones that exist.

Where they differ, it is for one of three reasons, and telling them apart is the
whole point of this page:

| | meaning |
| --- | --- |
| **Cannot** | A browser genuinely cannot do it. No amount of work changes this. |
| **Chosen** | A browser could, and we decided it should not — almost always because doing it safely is not possible. |
| **Not yet** | Ordinary remaining work. Nothing stands in the way. |

Anything marked **Not yet** is a to-do list, not a limitation.

---

## Widgets

All 46 kinds are listed. The renderer dispatches every one of them in both
runtimes; a kind marked ✅ behaves identically.

| Widget | Cloud | Why |
| --- | --- | --- |
| sticky | ✅ | |
| note | ✅ | |
| markdown | ⚠️ | Editing works. **Export to PDF/HTML** needs a headless print pipeline the browser has no equivalent for. *Not yet* — a server-side render would restore it. |
| card | ✅ | |
| page | ⚠️ | Works. **AI regeneration** is unported. *Not yet* |
| doc | ✅ | |
| living-doc | ⚠️ | Works. Scheduled AI regeneration unported. *Not yet* |
| table | ⚠️ | Works. **Import from a CSV/spreadsheet file** needs a native file picker returning a path. *Not yet* — a drop/upload route would restore it. |
| sheet | ✅ | |
| slides | ✅ | |
| chart | ✅ | |
| field | ✅ | |
| task-link | ✅ | |
| timer | ✅ | |
| color | ✅ | |
| shape | ✅ | |
| section | ✅ | |
| minimap | ✅ | |
| image | ✅ | Images are downsampled on ingest and served from OPFS through a service worker. |
| image-gen | ❌ | Generation calls the image provider through the desktop. *Not yet* — needs a server-side generate route. |
| video | ✅ | Range requests are served, so seeking works. |
| voice-recorder | ⚠️ | Recording and playback work. **Transcription and action extraction** are unported. *Not yet* |
| pdf | ⚠️ | Opens in a frame or a new tab rather than an embedded viewer. See *Embedded browsing* below. |
| file | ✅ | Contents sync. Files over 50 MB are marked "on this device only". |
| drive | ✅ | |
| mindmap | ⚠️ | Works. **AI expansion** is unported. *Not yet* |
| diagram | ✅ | |
| map | ✅ | |
| design | ✅ | |
| calculator | ✅ | |
| custom-block | ✅ | |
| scratchpad | ✅ | |
| streamdeck | ❌ | Sends key and media events to the operating system. **Cannot** |
| local-app-launcher | ❌ | Launches native applications. **Cannot** |
| webview | ⚠️ | See *Embedded browsing*. |
| gdoc / gsheet / gslide | ⚠️ | Same — Google refuses to be framed, so these open in a tab. |
| email | ⚠️ | Same frame limitation, and mail itself is unavailable (below). |
| portal | ✅ | |
| chat-thread | ✅ | |
| meeting-record | ⚠️ | Records display. Live capture is unported. *Not yet* |
| agent | ❌ | Agents execute on the machine — filesystem, shell, local models. **Chosen**: running them on our servers is a different product with different trust. |
| webhook | ❌ | Outbound POSTs go through the main process to sidestep CORS; a tab would be refused by many endpoints. *Not yet* — a relay through Signal restores it. |
| inbound-hook | ❌ | Already server-backed: it registers a hook with Signal, which relays payloads over the socket. Only the `webhooks` channel is unserved. *Not yet* |
| attention | ❌ | The Attention layer needs preferences and an active org the cloud runtime has not wired. *Not yet* |

---

## Capabilities

| Capability | Cloud | Why |
| --- | --- | --- |
| Desks, rooms, widgets, canvas | ✅ | Same renderer, same database. |
| Two-way sync with the desktop | ✅ | Same loop, same conflict rules. |
| Drive files, folders, tags, trash, search | ✅ | Bytes live in OPFS; the 900 lines of Drive logic are shared code. |
| Multiple tabs at once | ✅ | One tab holds the database and the rest talk to it. |
| Offline use | ✅ | The database is local, as on the desktop. |
| Sign-in, second factor, orgs, sharing | ✅ | |
| Desk claim links | ✅ | Better than the desktop, in fact — a recipient needs no install. |
| **Embedded browsing** | ⚠️ | The desktop embeds a real browser with its own cookie jar. A tab can only use an `<iframe>`, and most sites refuse framing outright. Shows the address and an "Open" button so a refusal is legible. **Cannot** |
| **Mail (IMAP)** | ❌ | IMAP is a raw TCP protocol. A browser has no sockets. **Cannot** — would need Signal to hold the mailbox, which is a feature rather than a port. |
| **The Vault** | ⚠️ | Shows whether a vault exists, always locked. Its PBKDF2 and AES-GCM are synchronous; the browser offers them only asynchronously. Hand-writing a cipher for the module that holds passwords is not acceptable. **Not yet** — the fix is to make the Vault's crypto async on both runtimes. |
| **Provider keys (BYOK)** | ⚠️ | Anthropic only. A browser cannot hold a key safely, so the key goes to Signal, is encrypted at rest, and is used server-side; nothing reads it back. The other providers need their own proxies first. **Chosen**, then *Not yet*. |
| **AI (credits)** | ✅ | Proxied through Signal exactly as on the desktop. |
| **Agents** | ❌ | See the agent widget. **Chosen** |
| OCR of scanned PDFs | ❌ | Needs native page rasterisation. Text that is already text extracts normally. **Cannot** |
| Thumbnails | ⚠️ | Generated for images. PDFs, video frames and documents need native tooling. **Cannot** |
| Open a file in its native app / reveal in Finder | ❌ | **Cannot** |
| Import a folder tree | ❌ | A tab is never given a filesystem path. Dropping files works. **Cannot** |
| Storing a linked image as a real file | ❌ | The desktop fetches and stores it; a tab is refused by CORS. Once the desktop stores it, the cloud shows it. **Cannot** (in the tab), solved by the pair. |
| App auto-update | ➖ | Not applicable — the browser app is whatever was last deployed. |
| Onboarding completion remembered | ⚠️ | Reappears on reload. *Not yet* |

---

## The measured gap

The browser serves **107 of the ~527** channels the desktop exposes. That
number sounds worse than it is: a full session — sign-up, desk creation, widget
editing, file upload, sharing — reaches for exactly **one** channel it does not
have, `mail:getAccount`, and that one cannot exist.

The rest of the unserved channels belong to features nobody touched in that
session. They are reached in order of what people actually use.

A channel the browser does not serve **rejects with its own name** rather than
resolving to nothing, so the gap is measurable from a real session instead of
estimated. `plexiiUnserved()` in the browser console lists what this session
asked for and did not get.

---

## How this page was produced

Not from memory. Each widget's row comes from reading which `window.api`
namespaces its component calls and comparing them against the handler table the
browser actually serves (`src/web/worker/handlers.ts`). Where a widget calls an
unserved namespace, the specific methods were read to decide whether the feature
is broken or only a secondary part of it — which is why `markdown` is ⚠️ rather
than ❌: it calls `exportDoc`, but only to export.

Regenerate the raw mapping with the query in this file's history, or check any
row by grepping the component for `api.<namespace>.`.
