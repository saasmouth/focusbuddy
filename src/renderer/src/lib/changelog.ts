// PlexiDesk changelog — newest first.
// Add a new entry every time a meaningful feature ships. Keep dates absolute (ISO).
// The footer's "What's new" button shows an indicator dot when the most recent
// entry's date is newer than the user's last-seen timestamp (localStorage).
//
// RELEASE DISCIPLINE: every release must add/refresh the top entry and set its
// `version` to the new package.json version. The release gate
// (scripts/verify-release-assets.sh) FAILS if the newest entry's `version` does
// not match the released version, so an out-of-date What's New blocks the
// release. The first-run "What's new in vX.Y.Z" modal reads the entry whose
// `version` equals the running app version.

// Base for per-feature support articles on the brochure help centre. Single
// source of truth lives in siteUrls.ts; re-exported here for the entries below.
import { HELP_BASE } from './siteUrls'
export { HELP_BASE }

export interface ChangelogLink {
  label: string
  href: string // a haptyx.app/help/<slug> support page (opened in the browser)
}

export interface ChangelogEntry {
  date: string // ISO yyyy-mm-dd (or full ISO datetime)
  title: string
  highlights: string[]
  tag?: 'feature' | 'polish' | 'fix' | 'design'
  // Set on every shipped release so the first-run modal can match the running
  // app version. Older historical entries may omit it.
  version?: string
  // One short paragraph shown at the top of the first-run modal. Plain prose.
  summary?: string
  // "Learn more" support links shown in the modal and the What's New panel.
  links?: ChangelogLink[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '4.3.1',
    date: '2026-09-24T18:00:00Z',
    title: 'PlexiDesk 4.3.1 \u2014 now runs on Intel Macs',
    tag: 'fix',
    summary:
      'PlexiDesk is now one universal build that runs on both Apple Silicon and Intel Macs. Every release up to and including 4.3.0 was built for Apple Silicon only, so an Intel Mac refused to open it at all \u2014 macOS rejects the architecture before any of the app runs, which is why the only thing you saw was "this application is not supported on the Mac", with nothing to explain it. Sequoia still supports Intel hardware, so this was a straightforward gap rather than an old-machine problem. Nothing changes on Apple Silicon beyond the download being larger, because the one file now carries both. The release gate checks the shipped binary really does carry both architectures, so this cannot quietly regress.',
    highlights: [
      'The mac download is a single universal build \u2014 one .dmg that installs on Apple Silicon and Intel alike.',
      'Fixes "You can\u2019t open the application PlexiDesk because this application is not supported on the Mac" on Intel Macs.',
      'The database, haptics, OCR and image addons are all built for both architectures, so nothing degrades on Intel.',
      'The release gate now verifies the .dmg exists and that the binary is genuinely universal before a release can pass.'
    ]
  },
  {
    version: '4.3.0',
    date: '2026-09-24T09:00:00Z',
    title: 'PlexiDesk 4.3.0 \u2014 a browser that works for you, and everything you have open in one strip',
    tag: 'feature',
    summary:
      'PlexiOffice gains a full web browser that does not need a desk \u2014 for looking something up, or keeping a reference open across several pieces of work. Plexii can drive it for you: ask it to summarise a page, gather the links or images, pull a listing into a table, or go and compare options, and watch each step as it happens. You can type new instructions to a run while it is still going, and it treats them as a change to the job rather than starting over. What it finds arrives on the desk you choose as a real table, with every row it found and the values exactly as they appeared on the page. Underneath all of that, a strip above the footer now lists everything you have open \u2014 desks, documents, chats, apps \u2014 so moving between them is one click instead of retracing your steps.',
    highlights: [
      'A browser in PlexiOffice that belongs to no desk, listed with the apps. Send any page to a desk when it turns out to matter.',
      'Ask Plexii to work on a page: Summarise, Links, Images, Extract data, Find similar or Research \u2014 one click each, or your own instruction.',
      'Guide a run while it works. What you type updates the task and keeps everything it has already found.',
      'Cookie and consent walls are cleared out of the way so a run can read the page. Plexii never answers them on your behalf.',
      'Results land on a desk you pick, as a table with every row \u2014 ratings become number columns, links stay clickable, nothing is invented.',
      'A tray above the footer holds every desk, document, chat and app you have open, across all four segments.',
      'Drag a document onto a desk in the tray to file it there \u2014 or right-click and choose the desk by name. It stays the same file, not a copy.',
      'Documents now open with the outline and comments panel out of the way, and remember your choice.'
    ]
  },
  {
    // No `version` yet: landed, not shipped.
    date: '2026-09-16T10:00:00Z',
    title: 'Claude can work in your workspace, without your data leaving the machine',
    tag: 'feature',
    summary:
      'Plexii now speaks MCP, so Claude Code and Claude Desktop can search and read your desks, work items, documents, tables, knowledge, calendar and meeting transcripts \u2014 and, if you give them a write token, add to them. The server runs on your own machine and is off until you switch it on; nothing is relayed through anyone else\u2019s cloud. What a token may do is decided by the token, not by asking the AI nicely: a read token cannot be talked into writing, because the write tools are not offered to it at all.',
    highlights: [
      'Turn it on under PlexiBrain \u2192 APIs and create a token: read to let Claude search and read, write to let it add things too.',
      'Claude Code connects with one line. Claude Desktop installs a small one-click extension, because it can only run local tools \u2014 both talk to the Plexii on your machine, never to a server of ours.',
      'A read token is structurally read-only. The write tools are hidden from it, and naming one anyway is refused before anything runs.',
      'Nothing on this surface deletes, sends email, or calls out to the internet \u2014 including through automations. A flow that would email someone or hit an external URL is refused, and says which step blocked it. Those flows still run normally inside Plexii.',
      'Everything Claude adds or changes is recorded as its work, not yours \u2014 every table, note, document and edit, with the tool that made it. Work items are additionally flagged AI-suggested in your Attention queue.'
    ]
  },
  {
    // No `version` yet: landed, not shipped.
    date: '2026-09-15T21:30:00Z',
    title: 'Browsing keeps what it finds \u2014 and costs a fraction of what it did',
    tag: 'feature',
    summary:
      'When you sent Plexii off to research something, it read every page properly and then threw the whole lot away: all you got back was one sentence, and a table you had asked it to fill stayed empty. It now records what it reads as it reads it, and hands you the result \u2014 ten businesses with their ratings and websites, say \u2014 as data you can put somewhere. One click puts it where the job intended: a table, contacts, a page, notes. Because it now remembers what it found, it also stops re-opening pages it has already read, which along with a rebuilt prompt makes a long research run cost a small fraction of what it used to.',
    highlights: [
      'A browsing run now returns structured results, not just a summary line. You see what it found before you decide what to do with it.',
      '\u201cUse these results\u201d puts the findings where the task meant them to go \u2014 filling the table you asked for, creating contacts, writing a page \u2014 and still shows you each step before it happens.',
      'A run that is stopped early, or that runs out of steps, now hands back everything it had found up to that point instead of losing all of it.',
      'Research runs cost far less. The agent used to re-send every page it had visited to the model on every single step, so a twenty-step run paid for the early pages twenty times over. It now sends the page in front of it plus a short record of what it has learned.',
      'Long pages no longer flood the model with hundreds of links and buttons; it sees the ones that matter and is told how many were left out.',
      'The browse step runs on a faster, cheaper model by default. If you want heavier reasoning on difficult sites, raise the model in Settings \u2192 AI.',
      'Every AI feature moved up to the current generation of models. Chat, documents and agents are now on a model that is both better and cheaper than the one they were using, and the heavier code-generation work moved to a stronger model at exactly the same price.',
      'The assistant can now read every widget on your desk. Thirteen kinds it could never see \u2014 voice notes, stat cards, metrics, maps, galleries, task lists, calendars, the inbox, contacts and PlexiDraw artwork \u2014 can now be pointed at with @ and read like any note or document.',
      'A voice note\u2019s transcript is now readable by the AI. It was sitting in the widget the whole time and no AI surface could see it.',
      'Cost figures across the app were wrong for some models \u2014 Opus work was billed on old rates and read about three times too high. Every rate now matches current pricing.'
    ]
  },
  {
    // No `version` yet: this has landed but not shipped. newestVersionedEntry()
    // deliberately skips unversioned entries, so the first-run modal still points
    // at the last real release until this one is cut.
    date: '2026-09-15T16:00:00Z',
    title: 'Three creative apps \u2014 and PlexiDesign becomes a real publishing editor',
    tag: 'feature',
    summary:
      'The drawing side of PlexiOffice was one app doing two jobs badly. It is now three that each do one properly. PlexiDraw\u2019s flowcharts became PlexiDiagrams under their own name; your existing diagrams open exactly as before. PlexiDraw is now a vector and painting studio with a real pen tool, pathfinder booleans and twelve brushes. And PlexiDesign is a free-form page designer you drive two ways: pour a document in and pick from live previews of your own words in five looks, then click into the page and type. The text flows across columns and pages as you write it.',
    highlights: [
      'PlexiDesign \u2014 click into a column and type. A real caret on the page, selection by dragging, arrow keys, Enter, Backspace, cut and paste, and the text reflows through every linked frame as you write.',
      'PlexiDesign \u2014 paste from Word or the web straight into the page and the headings, lists and quotes come with it.',
      'PlexiDesign \u2014 paste a document, pick a look, get a finished multi-page publication. Every preview is your real text laid out, so the page count you see is the one you get.',
      'PlexiDesign \u2014 five editorial looks (Editorial, Report, Magazine, Booklet, Newsletter), each with its own grid, type scale and rhythm. Import a .docx or pull the text out of a PlexiDoc.',
      'PlexiDesign \u2014 ask the AI to choose the layout. It only ever arranges your words: it picks the style, the columns and which of YOUR sentences to lift into a pull quote, and never writes copy. With no AI key the built-in planner does the same job offline.',
      'PlexiDesign \u2014 one story now carries headings, body, lists and quotes at their own sizes, with drop caps, bullets, heading rules, and widow and orphan control so a heading never strands at the foot of a column.',
      'PlexiDesign \u2014 master pages with automatic page numbers, text wrap around objects, margins, a column grid, ruler guides, named layers and facing-page spreads. A full frame shows the overset marker and offers to add a page.',
      'PlexiDiagrams \u2014 the flowchart, org-chart and process-map app, renamed. Nothing about your existing diagrams changes.',
      'PlexiDraw \u2014 a new vector and painting studio: bezier pen, editable anchors, Unite / Minus / Intersect / Exclude, and PNG / SVG / PDF export.',
      'PlexiDraw \u2014 twelve brushes covering real media: hard and soft round, airbrush, pencil, ink pen that tapers with speed, calligraphy nib, marker, charcoal, chalk, spray, watercolour and oil bristle. Size, opacity, flow, hardness, grain, scatter and spacing are all adjustable.',
      'PlexiDraw \u2014 the brush used to do nothing on a new artwork, because a fresh document had no paint layer. Picking a paint tool now makes the layer it needs.',
      'PlexiDraw \u2014 the type tool works: drag to size a box, click back into it to keep editing, and the words are drawn once rather than doubled.',
      'Resizing a multi-page design now scales every page, its master pages, margins and guides \u2014 it used to scale only the page you were looking at.',
      'PNG export is now exactly the size the document says it is. On a high-resolution screen it used to come out at double the pixel dimensions.'
    ]
  },
  {
    version: '4.2.2',
    date: '2026-09-01T18:00:00Z',
    title: 'PlexiDesk 4.2.2 \u2014 long tables and code blocks respect the page',
    tag: 'fix',
    summary:
      'A table or code block longer than a page used to run straight off the sheet \u2014 through the bottom margin, across the gap and over the pages below \u2014 which is what you saw when a long piece of pasted markdown landed in a document. Both now break properly: a table continues at the next row on the following page, and a code block continues at the next line. Tables can also repeat their header row on every page, so a long table keeps its column headings; right-click the table and turn it on, and the setting stays with the document and carries through to Word. An image taller than the page now fits the page instead of overflowing it.',
    highlights: [
      'A table longer than a page continues on the next page instead of running off the sheet.',
      'A long code block breaks across pages the same way.',
      'Right-click a table to repeat its header row on every page \u2014 it stays with the document and exports to Word.',
      'An image taller than the page is fitted to it rather than overflowing.'
    ]
  },
  {
    version: '4.2.1',
    date: '2026-09-01T14:00:00Z',
    title: 'PlexiDesk 4.2.1 \u2014 the mail list follows your selection',
    tag: 'fix',
    summary:
      'Moving through your inbox with j and k now scrolls the mail list to follow you. The conversations at the top could end up hidden above the fold, tucked under the header bar, with the reading pane showing a message whose row was nowhere on screen. PlexiOffice is also signed and notarised by Apple now, the same as PlexiDesk, so it opens without a security warning \u2014 the one update that moves you onto a signed build may need a manual reinstall.',
    highlights: [
      'j and k scroll the mail list so the highlighted conversation stays in view.',
      'The newest messages no longer sit hidden above the fold, underneath the header bar.',
      'PlexiOffice is signed and notarised by Apple, so it opens without a security warning.'
    ]
  },
  {
    version: '4.2.0',
    date: '2026-09-01T12:00:00Z',
    title: 'PlexiDesk 4.2.0 — Attention: everything you owe, in one place',
    tag: 'feature',
    summary:
      'Everything you have said you would do now lands in one place. Capture a task from anywhere \u2014 a note, a highlight on any surface, or the command palette \u2014 and it comes back written up as a finished item you can check before you keep it; highlight a list and it becomes several. The new Attention command centre puts your queue, the day ahead and your numbers on one screen, with rows that carry the anatomy you expect from a project tool: status, urgency, tags and sub-items, dragged to reorder or to reclassify. The calendar beside it is a real one now, with a rail you can page through, deadlines you drag straight onto the grid, and a Book time dialog for putting work into the day. Plexii can plan the day for you, and you review that plan before it is accepted, with a reason on every block you can check against your own calendar.',
    highlights: [
      'Capture from anywhere \u2014 notes, a highlight on any surface, or the command palette \u2014 and see the finished item before you keep it.',
      'Highlight a list and it becomes several items, tidied and written up.',
      'The Attention command centre: your queue, the day ahead and your numbers on one screen.',
      'Item rows with real project-tool anatomy \u2014 status, urgency, tags and sub-items, dragged to reorder or reclassify.',
      'A calendar you can page through, with deadline chips you drag onto the grid and a Book time dialog.',
      'Plexii plans your day and you review it first \u2014 every block states a reason you can check.',
      'Attention rides along as a widget on any desk, and items born in a meeting link back to it.'
    ]
  },
  {
    version: '4.1.1',
    date: '2026-08-26T12:00:00Z',
    title: 'PlexiDesk 4.1.1 — share and duplicate, Plexii included free, minimap fix',
    tag: 'feature',
    summary:
      'Share any desk as a public link that anyone can open in a browser, with no login or install, and duplicate into their own workspace in one click. Plexii is now included free when you sign in, with no API key to set up, and the assistant no longer asks signed-in people for a key. The minimap that could appear twice, or float in the middle of the canvas, is fixed, and the last few dialogs that used the old product name now say PlexiDesk.',
    highlights: [
      'Share a desk as a public link anyone can open, with no login or install, and duplicate in one click.',
      'Plexii is included free when you sign in, with no API key to set up.',
      'Fixed the minimap that could show twice or float in the middle of the desk.',
      'Renamed the last backup and restore dialogs from the old name to PlexiDesk.'
    ]
  },
  {
    version: '4.1.0',
    date: '2026-08-25T12:00:00Z',
    title: 'PlexiDesk 4.1.0 — meet Plexii, a new Home, and a system-wide design pass',
    tag: 'feature',
    summary:
      'The assistant is now Plexii, and it does far more than answer. It streams its replies as readable prose, shows its work as a trace you can trust with live web search and citations, and hands you each change as a preview card you can apply all at once or tick through one at a time. Plexii can now run real multi-step work on your behalf behind a consent gate, with a live run in the dock, a Stop button and a hard kill switch, and it remembers the conversation that built a desk so reopening it picks up where you left off. Alongside Plexii, the app gets a new canvas Home with a widget grid you arrange yourself, a true Back button and a clear way out of every full-screen view, and a system-wide design pass that moves the whole interface onto one consistent material and type system.',
    highlights: [
      'The assistant is now Plexii, with streaming prose answers and a trace that shows its sources.',
      'Plexii can run multi-step work behind a consent gate, with a live run, a Stop button and a kill switch.',
      'Proposal cards preview the real change, so you apply them all at once or pick per card.',
      'Live web search with citations, conversation modes, and a memory that reopens the conversation that built a desk.',
      'A new canvas Home with an arrangeable widget grid for shortcuts, focus, transcribe and meetings.',
      'A true Back button and a clear exit from every full-screen area, plus a system-wide material and type refresh.'
    ]
  },
  {
    version: '4.0.16',
    date: '2026-08-18T22:00:00Z',
    title: 'PlexiDesk 4.0.16 — share with several people at once',
    tag: 'feature',
    summary:
      'Sharing a desk, room or office file now lets you add several people in one go. The picker browses your whole organisation and narrows as you type by name, handle or email, shows each person with their handle and email so you pick the right one, and stages everyone as chips so you share with them all in a single step. Sharing an office file promotes it to a live document everyone edits together, and people outside your email domain can be added as organisation guests as part of sharing.',
    highlights: [
      'Add several people to a share at once, staged as chips.',
      'Browse the whole organisation and search by name, handle or email.',
      'Everyone shows with their handle and email so you pick the right person.',
      'Sharing an office file with people turns it into a live document you edit together.'
    ],
    links: [{ label: 'Sharing and collaboration', href: `${HELP_BASE}/real-time-collaboration` }]
  },
  {
    version: '4.0.15',
    date: '2026-08-18T18:00:00Z',
    title: 'PlexiDesk 4.0.15 — share from anywhere, full-width office',
    tag: 'polish',
    summary:
      'Sharing is now within reach wherever you are. There is a Share button in the canvas breadcrumb for the room or desk you have open, and one in the office editor toolbar so you can share a document, sheet, slides, drawing or design straight from the file. When you share a desk that sits in a room, you can now also share the room and everything in it in the same step, so people can open the desk in context. The office apps and the other full-screen areas also use the whole width of a large display now, instead of a narrow column with empty space beside it.',
    highlights: [
      'Share the current room or desk straight from the canvas breadcrumb.',
      'Share a document, sheet, slides, drawing or design from inside the office editor.',
      'Sharing a desk can also share its room and everything in it, in one step.',
      'Office apps and other full-screen views fill the whole width on large screens.'
    ],
    links: [{ label: 'Sharing and collaboration', href: `${HELP_BASE}/real-time-collaboration` }]
  },
  {
    version: '4.0.14',
    date: '2026-08-18T12:00:00Z',
    title: 'PlexiDesk 4.0.14 — free collaboration, reliable connect, clearer sharing',
    tag: 'feature',
    summary:
      'Real-time collaboration is now free on every plan, so anyone you work with can co-edit a shared desk, room or document without a paid seat. Connecting outside apps like GitHub is fixed: their sign-in pop-up now opens as a real window instead of being blocked, so the login no longer spins forever. Sharing is clearer too. You pick teammates from your organisation by name, or invite by email, or add someone on a different domain as a guest, which stops the old problem of a share that silently never reached the other person. On big screens Messages, the office home and the list pages now use the full width instead of a narrow centred column, and getting around is simpler with one way to open a room, a Back button, and a clear step back to a room from any desk.',
    highlights: [
      'Real-time collaboration is free on every plan.',
      'Connecting apps that sign in with a pop-up, like GitHub, works reliably again with no more spinning login.',
      'Share a desk or room by picking a teammate from your organisation, inviting by email, or adding an outside address as a guest.',
      'Messages, the office home and the list pages fill the whole screen on large displays.',
      'One clear way to open a room, plus Back and step-back-to-room from inside a desk.'
    ],
    links: [{ label: 'Sharing and collaboration', href: `${HELP_BASE}/real-time-collaboration` }]
  },
  {
    version: '4.0.13',
    date: '2026-08-16T12:00:00Z',
    title: 'PlexiDesk 4.0.13 — real-time collaboration, no more check-out',
    tag: 'feature',
    summary:
      'Shared desks, folders and canvases are now edited by everyone at once, live. The old check-out lock is gone: you no longer have to wait for a teammate to release a folder or canvas before you can touch it, and there is no more "locked by, request access". Everyone edits together and the changes merge automatically as they happen, the same way live documents already work. Connector wires between widgets now sync on a shared desk too. Under the hood this moves the whole workspace onto one conflict-free sync engine, so edits made offline queue up and reconcile cleanly when you reconnect.',
    highlights: [
      'Shared desks, folders and canvases are now fully concurrent — no check-out lock, no "request access", no waiting your turn.',
      'Changes from teammates appear live rather than on a slow refresh, and edits to different things (or different cells of the same row) all survive.',
      'Wires between widgets now sync across everyone on a shared desk.',
      'Edits made while offline queue locally and merge in when you reconnect.'
    ],
    links: [{ label: 'Collaborating in real time', href: `${HELP_BASE}/real-time-collaboration` }]
  },
  {
    version: '4.0.12',
    date: '2026-08-13T18:00:00Z',
    title: 'PlexiDesk 4.0.12 — one assistant, finished',
    tag: 'feature',
    summary:
      'The consolidation from 4.0.11 is done. There is now a single assistant everywhere. Inside a document the old separate AI tab is gone, and the document assistant control opens that one assistant, which can drop its answer straight into the page you are writing. When the assistant proposes something that is not a document, like a table, and you are not on a desk, it no longer stops with an error. It asks whether to make a new desk for it or add it to one you already have, then takes you there with the item in place. The assistant already reads across your whole workspace for context and lets you set it floating or docked to the right.',
    highlights: [
      'One assistant in documents too: the in-document AI tab is retired and the doc assistant control opens the single overlay.',
      'The assistant can insert its answer directly into the document you have open.',
      'Proposing a non-document thing like a table off a desk now offers to create a new desk or pick an existing one, then applies it there.'
    ]
  },
  {
    version: '4.0.11',
    date: '2026-08-13T12:00:00Z',
    title: 'PlexiDesk 4.0.11 — one assistant, taking shape',
    tag: 'polish',
    summary:
      'The AI assistant is being unified into a single surface across the whole app. This update gives the assistant panel a solid background on every tab, so it is never see-through, and the PlexiOffice "Ask AI" bar now opens that one assistant rather than a separate box. More of the consolidation is on the way: choosing whether it floats or docks to the right, a scope selector to ask about this page, other desks, or the whole workspace, and offering to place non-document things like tables on a desk.',
    highlights: [
      'The assistant panel now has a solid background on every tab, not just Chat.',
      'The PlexiOffice "Ask AI" bar opens the single assistant instead of a separate panel.'
    ]
  },
  {
    version: '4.0.1',
    date: '2026-08-12T00:00:00Z',
    title: 'PlexiDesk 4.0.1 — documents keep every edit and pages behave like real paper',
    tag: 'fix',
    summary:
      'A round of document-editor fixes. Switching quickly between documents no longer drops the last change in the one you were leaving, so nothing is lost as you move around your files. In page view, long and pasted text now flows onto discrete pages within the margins instead of running continuously through the page breaks, wide content like code blocks, long links, big tables and images stays inside the margins at any zoom, and every page is white paper with dark text in any theme, the way Word and Google Docs show it.',
    highlights: [
      'Documents no longer lose the last edit when you switch between them quickly.',
      'Pasted and long text paginates onto real pages: it breaks at line boundaries and stays in the content zone instead of overflowing the page breaks.',
      'Page view keeps wide content (code blocks, long links, tables, images) within the margins, at any zoom.',
      'Pages are always white paper with dark text, even when the app is in dark mode.',
      'A Word-style ruler with draggable markers on the top and left lets you set the left, right, top and bottom page margins yourself.'
    ]
  },
  {
    version: '4.0.0',
    date: '2026-08-11T00:00:00Z',
    title: 'PlexiDesk 4.0 — share a desk with people, live',
    tag: 'feature',
    summary:
      'You can now share a single desk with named people and everyone with access sees each other’s changes as they happen, both ways, without putting it in a whole organisation. Shared rooms and desks show their name and who shared them, and a desk that changed while you were away is framed so you can see what moved. The right-click "Add object" menu now matches the tool palette, and connected apps stay logged in when you switch desks.',
    highlights: [
      'Share a desk with specific people (by email) for live two-way updates — only the people you name can open it.',
      'A shared room or desk shows its name and a “Shared by” badge so you know what it is and who sent it.',
      'A desk changed by someone else while you were away is framed on your return, so you can see what moved.',
      'Right-click “Add object” now shows core tools first with an Advanced group, matching the tool palette.',
      'Connected apps (Google, Slack and the rest) stay signed in when you switch between desks.'
    ]
  },
  {
    version: '3.9.8',
    date: '2026-07-21T00:00:00Z',
    title: 'PlexiDesk 3.9.8 — screen share in meetings, Design on your desk, and the desk build wizard is back',
    tag: 'feature',
    summary:
      'Meetings can now share a screen, with a collaborative mode that docks the meeting to the side so you can keep moving around Plexii while you present. PlexiDesign joins Documents, Spreadsheets, Slides and Maps as something you can drop straight onto a desk. Starting a new desk opens the build wizard again, so you name it, describe it, and set importance and a due date up front. And the floating tool menu now stays put beside the assistant instead of hiding behind it.',
    highlights: [
      'Share your screen in a meeting, and keep navigating Plexii while you present in collaborative screen-share mode.',
      'PlexiDesign is now a desk tool alongside Documents, Spreadsheets, Slides and Maps.',
      'Starting a new desk opens the build wizard again: name, notes, room, urgency, importance, duration and due date.',
      'The floating tool menu stays visible beside the assistant panel instead of sliding under it.'
    ]
  },
  {
    version: '3.8.0',
    date: '2026-07-09T00:00:00Z',
    title: 'PlexiDesk 3.8.0 — shared docs co-edit, and a tidier Settings',
    tag: 'feature',
    summary:
      'Two things. When you and a teammate open the same document in a shared organisation, your edits now merge live instead of one of you quietly overwriting the other. And Settings is now organised into tabs (Appearance, Account, Organisation, AI, Templates, Data, Advanced) instead of one long scroll, so each area is easy to find.',
    highlights: [
      'Shared organisation documents co-edit live: two people editing at once both keep their changes, no more silent overwrites.',
      'Settings is tabbed now, with everything (including Organisation and Templates) grouped by area.',
      'Opening a shared document routes it into the live editor automatically; personal documents are unchanged.'
    ]
  },
  {
    version: '3.7.0',
    date: '2026-07-08T23:59:00Z',
    title: 'PlexiDesk 3.7.0 — shared org changes sync near-instantly',
    tag: 'feature',
    summary:
      'When you work in a shared organisation, changes a teammate makes now show up on your side within a second or two instead of waiting for the next background sync. Shared rooms, desks, calendar blocks, documents and tables all travel this faster path, and a room always arrives before the desks inside it, so nothing lands out of order. Your personal workspace is untouched and stays private as before.',
    highlights: [
      'Teammate changes to shared org data appear near-instantly, not on a 20-second delay.',
      'Shared rooms, desks, widgets, calendar blocks, documents and tables all sync between members.',
      'A room always applies before the desks nested inside it, so shared structure never lands broken.',
      'Personal (non-org) workspaces are unaffected and stay private.'
    ]
  },
  {
    version: '3.6.1',
    date: '2026-07-08T23:15:00Z',
    title: 'PlexiDesk 3.6.1 — tidier canvas chrome',
    tag: 'fix',
    summary:
      'Removed the small floating bar at the bottom of the canvas. It only offered a handful of shortcuts and duplicated better paths that already exist: the Add-widget button and the round add button on the desk open the full searchable palette of objects, and search now sits in the top bar. Nothing was lost. Body double and Smart Stack moved into the command palette, which still opens with the top-bar Search button or Cmd/Ctrl+K.',
    highlights: [
      'The redundant bottom floating bar is gone; the canvas is cleaner.',
      'Search moved to the top bar (and still opens with Cmd/Ctrl+K).',
      'Add objects from the Add-widget button or the round add button on the desk, which open the full searchable palette.',
      'Body double and Smart Stack are now in the command palette.'
    ]
  },
  {
    version: '3.6.0',
    date: '2026-07-08T22:00:00Z',
    title: 'PlexiDesk 3.6.0 — tours you can replay any time',
    tag: 'feature',
    summary:
      'Onboarding is now a set of short, replayable tours instead of a one-time welcome. Each tour jumps you to the real screen it is teaching and points at the actual controls, shows how long it takes, and lets you skip or go back at any step, so it stays quick and never gets in your way. You can replay any tour whenever you like from the command palette (Take a tour) or Settings, and new features arrive as their own optional mini-tour offered on launch. Two tours ship to start: Rooms, Desks and Plans, and Connected office files.',
    highlights: [
      'Onboarding is modular and replayable any time, from the command palette (Take a tour) or Settings, not just on first run.',
      'Tours are dynamic: each step opens the real screen and highlights the real control, with a time estimate and always-available Skip.',
      'New features arrive as their own short optional tour, offered as a dismissible card on launch.',
      'Two tours to start: Rooms, Desks and Plans, and Connected office files.'
    ]
  },
  {
    version: '3.5.2',
    date: '2026-07-08T20:30:00Z',
    title: 'PlexiDesk 3.5.2 — roomier plans and documents',
    tag: 'fix',
    summary:
      'The plan timeline now fills the width of the screen instead of stopping partway across, keeps a few weeks of empty runway after the last task so you can drag a bar into the future, and keeps each task bar lined up with its name even when the panel beside it is open. Documents in continuous view now use a wider, centred column so they make the most of the space instead of hugging the left edge.',
    highlights: [
      'The plan timeline fills the screen width and no longer stops mid-way for a short plan.',
      'Timeline keeps a few weeks of runway past the last task, so you can drag a task into the future; scroll for more.',
      'Task bars stay aligned with their names when the side panel is open.',
      'Documents use a wider, centred column in continuous view instead of hugging the left.'
    ]
  },
  {
    version: '3.5.1',
    date: '2026-07-08T19:30:00Z',
    title: 'PlexiDesk 3.5.1 — cleaner document pages',
    tag: 'fix',
    summary:
      'Fixes text spilling across the gap between pages in a document opened in Page view. Page breaks are now measured from the real page layout, so a paragraph that reaches the bottom of a page moves cleanly to the top margin of the next page, the way Word does, instead of running over the page break. Pages keep their standard one-inch margins, still adjustable from the Margins menu.',
    highlights: [
      'Text no longer runs across the gap between pages in Page view; blocks break to the next page cleanly.',
      'Page breaks are measured from the real layout, so long documents stay aligned to their sheets all the way down.',
      'Standard one-inch page margins, still adjustable from the Margins menu.'
    ]
  },
  {
    version: '3.5.0',
    date: '2026-07-08T18:00:00Z',
    title: 'PlexiDesk 3.5.0 — connected office files, clearer desks',
    tag: 'feature',
    summary:
      'Office files now connect to the rest of your work. A table cell can reference a PlexiOffice document with a new Office file column, and you can drag a document straight from the Documents list or Drive onto the cell. You can embed a document inside another document from the slash menu or the command palette. Every office file now says where it is filed and lets you file or move it in one click. Adding things to a desk is far more obvious: a solid Add widget button plus an always-visible round button on the canvas, both opening a searchable palette, with the keyboard shortcuts unchanged. The sidebar is simpler too: rooms and desks live on their own All rooms and All desks pages, shared items sit under a Shared entry, and the old inline trees are gone. Hovering a floating menu no longer nudges the desk.',
    highlights: [
      'Reference a PlexiOffice document from a table cell with the new Office file column, by picker or by dragging the file in.',
      'Embed a document inside another document from the slash menu or the command palette.',
      'Every office file shows where it is filed and can be filed or moved in one click.',
      'Adding to a desk is obvious: a solid Add widget button and an always-visible add button, both with a searchable palette; shortcuts unchanged.',
      'Simpler sidebar: All rooms / All desks / Shared pages replace the inline trees; hovering a floating menu no longer scrolls the desk.'
    ]
  },
  {
    version: '3.4.0',
    date: '2026-07-08T15:00:00Z',
    title: 'PlexiDesk 3.4.0 — Rooms, Desks and independent Plans',
    tag: 'feature',
    summary:
      'Folders are now Rooms and canvases are Desks, and the two are no longer tangled up with planning. A Desk is just a canvas that lives in a Room, and creating one no longer drops a task into your Plans. Plans are their own thing now: a Room becomes a Plan only when you say so, and you can promote or demote a Room to a Plan at any time from the Rooms page or the sidebar right-click menu. Your existing plans are preserved automatically. There are two new browsable index pages, All Rooms and All Desks, each with gallery, list, board, table and timeline views plus search, grouping, filtering and drag-to-reorder, and rooms and desks show live thumbnails of their contents.',
    highlights: [
      'Folders are Rooms and canvases are Desks; a Desk is a canvas that lives in a Room.',
      'Desks no longer auto-become planning tasks. Plans are independent, and a Room becomes a Plan only when you choose.',
      'Promote or demote a Room to a Plan in place, from the Rooms page or the sidebar menu; existing plans are kept.',
      'New All Rooms and All Desks pages with gallery, list, board, table and timeline views, plus search, group, filter and reorder.',
      'Rooms and Desks show live thumbnails: a Desk shows its canvas, a Room shows a composite of its desks.'
    ]
  },
  {
    version: '3.3.9',
    date: '2026-07-08T13:00:00Z',
    title: 'PlexiDesk 3.3.9 — floating, minimizable menus',
    tag: 'design',
    summary:
      'The side menu and the area menus are now rounded panels that float above the desk, and each can be minimized to a small handle to give the canvas the whole screen, which matters on smaller displays. Resizing the side menu no longer clips labels: names wrap to two lines and the menu has a sensible minimum width, so nothing disappears as you drag it narrower. Your menu width and minimized state are remembered.',
    highlights: [
      'Menus float above the desk as rounded panels and can be minimized to reclaim canvas space.',
      'Narrowing the side menu wraps labels instead of hiding them; a minimum width prevents clipping.',
      'Menu width and minimized state persist across restarts.'
    ]
  },
  {
    version: '3.3.8',
    date: '2026-07-08T12:00:00Z',
    title: 'PlexiDesk 3.3.8 — meeting transcription fix',
    tag: 'fix',
    summary:
      'Fixes meeting wrap-up failing to transcribe when the on-device (local) transcription provider is selected. The meeting and record-notes flows now prepare the audio correctly for whichever provider you use, so summaries and action items are produced at the end of a call on both cloud and on-device Whisper. Includes the sign-in connectivity fix from 3.3.7.',
    highlights: [
      'Meeting wrap-up transcribes correctly on the on-device (local) provider, not just cloud.',
      'Record-notes uses the same provider-aware path, so both flows behave consistently.'
    ]
  },
  {
    version: '3.3.7',
    date: '2026-07-08T11:00:00Z',
    title: 'PlexiDesk 3.3.7 — sign-in connectivity fix',
    tag: 'fix',
    summary:
      'Fixes a bug where some builds could not reach the server at sign-in, showing "Could not reach the PlexiDesk server" even though the server was up and the network was fine. The server address is now cleaned before use so a build glitch can never turn it into an unreachable value. If you saw that error, updating to this version resolves it.',
    highlights: [
      'Sign-in reliably reaches the server again; the "could not reach" error on a healthy connection is fixed.'
    ]
  },
  {
    version: '3.3.6',
    date: '2026-07-08T10:00:00Z',
    title: 'PlexiDesk 3.3.6 — directory sync for organisations',
    tag: 'feature',
    summary:
      'Organisations can now connect their identity provider for automatic user management. Alongside single sign-on, an organisation admin can turn on directory sync (SCIM) from the organisation settings, generate a token, and copy the base URL into Okta, Microsoft Entra or OneLogin. People are then added and removed from the organisation automatically as they join and leave, and removing someone takes away their access without ever deleting their work. This sits on the same tamper-evident audit trail, so every provisioning action is recorded. Directory sync is a Team and Enterprise feature.',
    highlights: [
      'Connect Okta, Microsoft Entra or OneLogin to provision and deprovision members automatically (SCIM).',
      'Set it up from Organisation settings: generate a token and copy the base URL into your identity provider.',
      'Deprovisioning removes access without deleting a person’s work, and every action is on the audit trail.'
    ]
  },
  {
    version: '3.3.5',
    date: '2026-07-07T19:30:00Z',
    title: 'PlexiDesk 3.3.5 — every feature respects your plan',
    tag: 'feature',
    summary:
      'Entitlements now apply consistently across the whole app, not just the app areas and the office editors. Every feature surface, from mail, chat and meetings to the vault, files, calendar, live collaboration and the People Map, honours what is configured for you at the plan, organisation and user level. A feature you are not entitled to is hidden from the menus and, if you reach it another way, shows a clear panel explaining why and how to get it. Creating a quick doc, sheet or note on a desk canvas stays available to everyone regardless of plan.',
    highlights: [
      'Every feature honours your plan, organisation and per-user settings, resolved centrally so nothing slips through.',
      'Locked features are hidden from menus and show an honest reason (upgrade, or restricted by your admin) if reached another way.',
      'Canvas docs, sheets, slides, drawings and designs remain creatable on a desk for everyone.'
    ]
  },
  {
    version: '3.3.4',
    date: '2026-07-07T18:00:00Z',
    title: 'PlexiDesk 3.3.4 — license the office editors individually',
    tag: 'feature',
    summary:
      'PlexiOffice can now be licensed editor by editor. Docs, Sheets, Slides, Draw and Design are each their own entitlement, so a person or organisation can be given just the ones they need rather than the whole suite, with PlexiOffice as the master switch. Writing a quick doc on a desk stays free of all of this: the Markdown and note widgets you drop on the canvas are part of PlexiDesk and are always available, even without PlexiOffice. A locked editor greys out with the same reason-aware tooltip as the app areas.',
    highlights: [
      'Docs, Sheets, Slides, Draw and Design are each licensable on their own, under the PlexiOffice master switch.',
      'Creating a doc on the desk canvas (Markdown / note widget) always works, with or without PlexiOffice.',
      'Locked editors grey out with an upgrade or a restriction reason, everywhere they can be created.'
    ]
  },
  {
    version: '3.3.3',
    date: '2026-07-07T16:30:00Z',
    title: 'PlexiDesk 3.3.3 — organisation licensing for apps',
    tag: 'feature',
    summary:
      'Entitlements now work at the organisation level as well as per user. An admin can license an organisation for exactly the apps it needs, and an app the active organisation is not licensed for now shows greyed with a tooltip rather than vanishing: owners and admins are offered an upgrade, members are told to ask an admin, and an app an admin has deliberately turned off for you is shown as restricted with no upsell. Entitlements resolve as plan, then organisation, then user, so a specific person can still be granted or denied on top. Switch organisations and the apps you can use update to match that organisation.',
    highlights: [
      'License an organisation for specific apps from the admin console.',
      'A locked app greys out with the reason: upgrade if it is a plan gap, or restricted if an admin turned it off.',
      'Entitlements layer as plan, then organisation, then user, and update when you switch organisations.'
    ]
  },
  {
    version: '3.3.2',
    date: '2026-07-07T15:00:00Z',
    title: 'PlexiDesk 3.3.2 — entitlements apply the moment they change',
    tag: 'fix',
    summary:
      'A fast follow to 3.3.1. The app switcher now reacts immediately when your app entitlements resolve or an admin changes them, so an area you are not entitled to is hidden right away rather than only after you happened to navigate elsewhere.',
    highlights: [
      'App areas hide and show live as entitlements change, no navigation needed.'
    ]
  },
  {
    version: '3.3.1',
    date: '2026-07-07T14:00:00Z',
    title: 'PlexiDesk 3.3.1 — per-user control over apps and features',
    tag: 'feature',
    summary:
      'Administrators can now decide exactly which apps, features and limits each person gets. PlexiDesk, PlexiOffice, PlexiBrain and PlexiTeam are each an entitlement an admin can switch on or off per user from the admin console, and any feature or numeric limit can be overridden for one person on top of their plan. The app honours it live: an area you are not entitled to simply does not appear in the switcher. Most people will see no change; this is the groundwork that lets a team hand out exactly the workspace each role needs.',
    highlights: [
      'Apps (Desk, Office, Brain, Team) can be turned on or off per user by an admin.',
      'Any feature or limit can be overridden for a single user, above their plan.',
      'The app enforces entitlements live: areas you lack are hidden from the switcher.'
    ]
  },
  {
    version: '3.3.0',
    date: '2026-07-07T12:00:00Z',
    title: 'PlexiDesk 3.3.0 — real names, meetings you can schedule, and a brain that builds',
    tag: 'feature',
    summary:
      'This release makes the product feel like it knows the people in it and does more of the work for you. You now appear by your real name everywhere, in chat, mentions, presence, meetings and across your team, instead of a username, and you set it at sign-up or in Settings. PlexiMeet gained a proper start-or-schedule dialog so you can put a meeting on the calendar and invite anyone by email, inside or outside your organisation, not just teammates who happen to be online. A meeting invite you receive can now be saved straight to Google, Outlook or Apple Calendar. The workspace brain no longer only answers, it offers to create what its answer implies, a document, spreadsheet, deck, diagram, task, table, saved note or calendar block, and builds it once you approve. And if you ever forget your password, there is finally a clear way to reset it from the sign-in screen.',
    highlights: [
      'You appear by your real first and last name across chat, mentions, presence and meetings, set at sign-up or in Settings.',
      'PlexiMeet can start or schedule a meeting and invite anyone by email, not only people online in your org.',
      'Save a received meeting invite to Google, Outlook or Apple Calendar.',
      'The workspace brain offers to create documents, sheets, decks, diagrams, tasks, tables, notes or calendar blocks from its answers, applied on your approval.',
      'Forgot your password? Reset it right from the sign-in screen.'
    ]
  },
  {
    version: '3.2.2',
    date: '2026-07-07T09:00:00Z',
    title: 'PlexiDesk 3.2.2 — the assistant, everywhere and sharper',
    tag: 'feature',
    summary:
      'The workspace assistant is now the same on every surface and better at its job. Ask your workspace lives at the top of the AI panel in Docs, Sheets, Slides and Design, so wherever you are you can ask a question grounded in everything across your desks. Answers now stream in as they are written, cite sources you can click to open, find facts buried deep in long documents rather than only their opening, and can be scoped to just the open document when you want a focused answer. Under the hood, AI token usage and an estimated spend are now measured and shown in Settings so you can see what the assistant costs. Sharing also now records who shared, groundwork for crediting the person who invited you.',
    highlights: [
      'Ask your workspace is now on every editor — Docs, Sheets, Slides and Design.',
      'Answers stream live, cite clickable sources, and search deep passages, not just the top of a document.',
      'Scope a question to the whole workspace or just the open document.',
      'AI usage and estimated spend are measured and shown in Settings → AI.'
    ]
  },
  {
    version: '3.2.1',
    date: '2026-07-07T06:00:00Z',
    title: 'PlexiDesk 3.2.1 — the assistant sees more, and plans your day',
    tag: 'feature',
    summary:
      'Two upgrades to the assistant. Ask your workspace now draws on more than documents: it also grounds its answers in your tasks, your database tables and the notes on your desks, so the brain reasons over your whole environment rather than just your files. And the Daily Brief no longer only advises, it acts: alongside the summary it proposes concrete time blocks for your most important unscheduled work, and you approve each with one click to drop a real calendar block linked to the task. The suggestions are computed from your actual tasks and existing calendar, so they work with or without an API key.',
    highlights: [
      'Ask your workspace now grounds answers in tasks, tables and canvas notes too, not just documents.',
      'The Daily Brief proposes time blocks for your top unscheduled tasks; one click schedules them.',
      'Scheduling suggestions are grounded in real tasks and your existing calendar, and work without an API key.'
    ]
  },
  {
    version: '3.2.0',
    date: '2026-07-06T20:30:00Z',
    title: 'PlexiDesk 3.2 — an assistant that knows your whole workspace',
    tag: 'feature',
    summary:
      'The assistant grows from a document helper into a brain for your whole workspace. Open any document and the AI panel now has Ask your workspace at the top: ask anything and it draws on every document, sheet and note across all your desks, answers grounded with citations, and inserts the result straight into your document. It is honest by design, it says plainly when it cannot find something rather than inventing an answer. And the dashboard gains a Daily Brief that, the moment you open the app, reads your real open tasks, your calendar for the week ahead and your recent documents, then tells you the single most important thing to do today and flags any deadline that is at risk or not yet scheduled. Both features run on your own Anthropic key, and both degrade gracefully without one.',
    highlights: [
      'Ask your workspace, in the document sidebar: grounded, cited answers drawn from every doc, sheet and note across all your desks, insertable into the page.',
      'Daily Brief on the dashboard: a proactive, prioritised summary built from your real tasks, calendar and recent documents.',
      'Grounded and honest: answers cite their sources and say when they do not know; an empty day is reported as clear, never fabricated.'
    ]
  },
  {
    version: '3.1.1',
    date: '2026-07-06T18:00:00Z',
    title: 'PlexiDesk 3.1.1 — spreadsheet feel and a way back from the browser',
    tag: 'fix',
    summary:
      'A quick follow-up with two things that were getting in the way. Spreadsheet cells now match Excel, a wide rectangle rather than a chunky square, and while you are typing a value each arrow key enters it and moves that direction the way Excel does. Pressing F2 or double-clicking a cell still lets the arrows move the cursor inside the text, and formula entry still lets you point at cells with the mouse or arrow keys. In the browser, opening something in a new tab now lands as a browser object on your desk with a clear way back to the canvas, instead of a separate window that left you stranded. Sign-in and other pop-ups that need their own window still open that way so logging in keeps working.',
    highlights: [
      'Sheets: Excel-sized cells (wide rectangles, not squares), and arrow keys commit the value and move while typing.',
      'Browser: "open in new tab" becomes a browser object on the desk with an Esc path back, not a stranded window.',
      'Sign-in / OAuth pop-ups still open as their own window so authentication keeps working.'
    ]
  },
  {
    version: '3.1.0',
    date: '2026-07-06T12:00:00Z',
    title: 'PlexiDesk 3.1 — your files open the way you saved them',
    tag: 'feature',
    summary:
      'This release is about fidelity and finishing touches across the office suite. Bringing files in and out keeps far more of what matters. A Word import now carries the page size, margins and the running header and footer, not just the body. A spreadsheet keeps its column widths, row heights, frozen panes, dropdown and number-range validations, conditional formatting and, at last, merged cells, all the way to Excel and back. A slide deck recovers its speaker notes, pictures, tables and charts instead of arriving as plain text, and you can import a Microsoft Visio diagram straight onto a Draw canvas. Docs gains real Track Changes, so edits can be suggested and then accepted or rejected, and comments now support at-mentions with a notification when a teammate names you. Sheets pivot tables gain interactive slicers, and Draw gains a full categorised shape library.',
    highlights: [
      'Import fidelity: Word header/footer and page setup, and Excel widths, heights, frozen panes, validations, conditional formatting and merged cells all round-trip.',
      'Slides import recovers speaker notes, images, tables and charts; Visio .vsdx imports into Draw.',
      'Docs: Track Changes (suggesting mode) with accept/reject, plus @mentions in comments and a notification when someone names you.',
      'Sheets: interactive pivot-table slicers, and merged cells you can create and that survive .xlsx.',
      'Draw: a categorised stencil library (flowchart, basic shapes, arrows, containers).'
    ]
  },
  {
    version: '3.0.0',
    date: '2026-07-05T11:00:00Z',
    title: 'PlexiDesk 3.0 — a full office suite on your canvas',
    tag: 'feature',
    summary:
      'The big one. PlexiOffice grows into a real Microsoft-Office alternative: Sheets gains LET and LAMBDA with MAP, REDUCE, SCAN and MAKEARRAY, area and scatter charts, a refreshable Power-Query-style data shaper and a macro runner; Slides gains charts sourced from live sheet data, native tables, element entrance animations and slide transitions including Morph; Draw can finally export to SVG, PNG, JPG and PDF and auto-arrange a diagram; and one chart engine is shared across Sheets and Slides. The assistant can now read a browser page, document or PDF open on your canvas and turn it into calendar events you approve. Browser widgets fix signing in to sites — menus, pop-ups and modals appear, and a sign-in no longer resets to the original page. Plus the 3.0 groundwork: restorable document Trash, version history everywhere, a keyboard-shortcuts reference on Cmd+/, and search across calendar blocks, meetings and signature requests.',
    highlights: [
      'Sheets: LET + LAMBDA (MAP/REDUCE/SCAN/MAKEARRAY), area & scatter charts, Power-Query data shaping and macros.',
      'Slides: charts from live sheet data, native tables, entrance animations and transitions including Morph.',
      'Draw: export to SVG / PNG / JPG / PDF and one-click auto-arrange.',
      'Assistant creates calendar events from a browser page, doc or PDF on your canvas.',
      'Signing in to sites in a browser widget works again — menus and pop-ups appear, no more reset to the original page.'
    ]
  },
  {
    version: '2.5.155',
    date: '2026-07-03T13:00:00Z',
    title: 'v2.5.155 — search and recents respect your organisation too',
    tag: 'fix',
    summary:
      'The last surfaces that still crossed organisations are now scoped. Semantic search only surfaces items from the organisation you are in, and the recent-activity, focus-session and browsing panels show only that organisation’s history rather than a mix. On the server, sending a connect request to someone who already has an account now requires that you share an organisation with them, so the contact list cannot be used to reach across organisations; inviting a brand-new person by email still works as before.',
    highlights: [
      'Semantic search results are scoped to the active organisation.',
      'Recent activity, focus sessions and browsing history are per-organisation.',
      'Contact requests to existing accounts require a shared organisation.'
    ]
  },
  {
    version: '2.5.154',
    date: '2026-07-03T12:00:00Z',
    title: 'v2.5.154 — every surface now switches with your organisation',
    tag: 'fix',
    summary:
      'We swept the whole app for anything that was not yet tied to the organisation you are in, and closed the gaps. Your automations, reports, no-code apps, forms, meeting notes, signature requests, saved file views and per-area dashboards now belong to the organisation they were made in, so switching organisation shows only that organisation’s items rather than everything mixed together. Scheduled automations and reports still run across organisations as before. On the server, teams are now scoped to one organisation too, so a team, and anything that flows from it like shared-document invites and who appears in presence, can no longer reach across organisation boundaries.',
    highlights: [
      'Automations, reports, apps, forms, meetings, signature requests, smart folders and dashboards are now per-organisation.',
      'Switching organisation shows only that organisation’s items; scheduled jobs still run across all.',
      'Teams are scoped to one organisation, so team-based sharing and presence stay within it.'
    ]
  },
  {
    version: '2.5.153',
    date: '2026-07-03T11:00:00Z',
    title: 'v2.5.153 — collaborate works the same in every app',
    tag: 'feature',
    summary:
      'Collaborating from a meeting now opens one shared, co-edited object no matter which app you started in. Documents, sheets and decks already did this; drawings and designs now do too, each opening in its own live editor, and a desk becomes a live canvas everyone works on together. To make that real, designs gained a live collaborative editor they were missing, so sharing a design for collaboration now actually opens it for co-editing rather than creating something that could not be opened. As before, people without an account get an editable copy, and when the meeting ends collaborators become read-only, are removed, or keep editing, whichever you chose.',
    highlights: [
      'Collaborate is consistent across docs, sheets, decks, drawings, designs and desks.',
      'Drawings and designs open in their own live editor; a desk becomes a live canvas.',
      'Designs gained the live collaborative editor they were missing.',
      'Non-users still get an editable copy; end-of-meeting access rules unchanged.'
    ]
  },
  {
    version: '2.5.152',
    date: '2026-07-03T10:00:00Z',
    title: 'v2.5.152 — collaborate means editing the same document together',
    tag: 'feature',
    summary:
      'Inviting people to collaborate from a meeting now opens one shared document that everyone edits together in real time, instead of handing each person their own copy. When you start a meeting from a document, sheet or deck and choose collaborate, a live version is created and each attendee who already has an account joins it as an editor; anyone without an account still gets an editable copy so they are not shut out. When the meeting ends the collaborators become read-only, are removed, or keep editing, whichever you picked, and read-only is now genuinely enforced on the server. View for this meeting is tightened too: that access ends the moment the meeting ends rather than on a timer.',
    highlights: [
      'Collaborate opens one shared, co-edited document rather than separate copies.',
      'Existing users join as live editors; others get an editable copy.',
      'Read-only after the meeting is enforced, not just a downgraded label.',
      'View-for-this-meeting access ends exactly when the meeting ends.'
    ]
  },
  {
    version: '2.5.151',
    date: '2026-07-03T09:00:00Z',
    title: 'v2.5.151 — a meeting leaves a tidy folder behind',
    tag: 'feature',
    summary:
      'When a meeting wraps up, its transcript is now saved as a real document rather than living only inside the meeting record, and it is filed in a folder for that meeting so everything stays together. Where the folder sits follows where the meeting began: a meeting started from a desk keeps its notes with that desk, and anything else gets a top-level meeting folder you can rename or move. The wrap-up review shows where the transcript went, and when you turn the AI suggestions into documents you can pick which folder they land in, defaulting to the meeting folder so related work does not scatter.',
    highlights: [
      'The transcript is saved as a document, not just kept inside the meeting.',
      'A meeting folder keeps the transcript and deliverables together.',
      'A desk-started meeting files its notes with that desk.',
      'Choose where the AI-suggested documents are filed, defaulting to the meeting folder.'
    ]
  },
  {
    version: '2.5.150',
    date: '2026-07-03T08:00:00Z',
    title: 'v2.5.150 — collaborate during the meeting, read-only after',
    tag: 'feature',
    summary:
      'When you invite people to collaborate on the artifact a meeting is about, that access is now meeting-scoped by default. Attendees can work on it while the meeting is live, and the moment the meeting ends it becomes read-only, so a working session does not quietly leave the door open afterward. You choose this when you start the meeting: make it read-only after, keep collaborate access, or revoke access entirely when the meeting ends. View access is unchanged, you can still grant a view just for the meeting or a lasting one.',
    highlights: [
      'Collaborate access is meeting-scoped: editable during, read-only after.',
      'Choose what happens when the meeting ends: read-only, keep, or revoke.',
      'The downgrade runs automatically the moment the meeting ends.'
    ]
  },
  {
    version: '2.5.149',
    date: '2026-07-03T07:00:00Z',
    title: 'v2.5.149 — meetings share their artifact with the people you invite',
    tag: 'feature',
    summary:
      'Starting a meeting from a document, sheet, deck, drawing, design or a desk now opens a short dialog where you add the people to invite and choose what access they get to that artifact. That access trickles down as the meeting opens: each attendee is shared the artifact and it lands in their inbox. You can allow view just for this meeting, which expires after it, allow view for good, or invite them to collaborate with an editable copy. Desks got a Meeting button too, so a meeting can start from the canvas the same way it does from an editor. When a notification email cannot be sent the person still gets access in the app, and the result says so rather than pretending an invite went out.',
    highlights: [
      'Start-meeting dialog to invite people and set their access to the source artifact.',
      'Three access levels: view for this meeting, always view, or collaborate.',
      'A Meeting button on the desk/canvas toolbar.',
      'Access is shared from the real artifact and lands in each attendee’s inbox.'
    ]
  },
  {
    version: '2.5.148',
    date: '2026-07-03T06:00:00Z',
    title: 'v2.5.148 — start a meeting from anywhere, and schedule one from the calendar',
    tag: 'feature',
    summary:
      'Meetings now start from wherever you already are. There is a Meeting item in the Insert menu of every editor, so you can jump straight into a call from a document, a spreadsheet, a presentation, a design or a drawing, and a start-meeting button sits in the chat composer too. On the calendar you can now schedule a meeting as a proper event: turn on Video meeting when you book time, add the people you want, and each of them gets an email with the time and a link that opens the meeting in PlexiDesk. The meeting block shows a Join button when the time comes, and clicking the emailed link drops you straight into the room. If no mailbox is connected the meeting is still saved and the join link is on the block, said plainly rather than pretending an invite went out.',
    highlights: [
      'A Meeting item in the Insert menu of the document, sheet, slides, design and draw editors.',
      'A start-meeting button in the chat composer.',
      'Schedule a meeting from the calendar with invitees who get an email and a one-click join link.',
      'Meeting blocks carry a Join button; the emailed haptyx://meet link opens the room directly.'
    ]
  },
  {
    version: '2.5.147',
    date: '2026-07-03T05:00:00Z',
    title: 'v2.5.147 — Whisper is opt-in and no longer errors after a meeting',
    tag: 'fix',
    summary:
      'Two fixes to meeting transcription. First, Whisper is now something you opt into rather than always-on: a meeting is only recorded, transcribed and summarised when you turn it on, and because the choice is remembered it becomes your default until you turn it off. Second, the error some people saw right after a meeting ended is gone. The wrap-up now handles every failure, a dropped connection, a provider hiccup, a missing key, as a clear message instead of letting it surface as an unhandled error.',
    highlights: [
      'Whisper is opt-in, off by default, and never forced; your choice sticks as your default.',
      'The end-of-meeting wrap-up no longer throws an unhandled error on a failed step.',
      'A toggle in PlexiMeet turns transcription on or off.'
    ]
  },
  {
    version: '2.5.146',
    date: '2026-07-03T03:00:00Z',
    title: 'v2.5.146 — a separate mailbox per organisation',
    tag: 'fix',
    summary:
      'Mail is now tied to the organisation you are in, not shared across all of them. Each organisation keeps its own mailbox on this device, so connecting an account in one organisation no longer shows it in the others, and switching organisation switches your mailbox with it. Your existing mailbox moves into your Personal space, and every organisation starts fresh so you can connect the right account for each one.',
    highlights: [
      'Each organisation has its own mailbox on this device, tied to you.',
      'Connecting mail in one org no longer leaks it into every other org.',
      'Your existing mailbox is kept in your Personal space.'
    ]
  },
  {
    version: '2.5.145',
    date: '2026-07-03T01:00:00Z',
    title: 'v2.5.145 — the org panel follows the org you are in',
    tag: 'fix',
    summary:
      'The Organizations panel now shows the organisation you are actually in rather than a list of all of them; you switch organisations from the switcher at the top of the side menu, and the admin and people view stays scoped to the active one. The app can also now open a shared item directly from an "Open in PlexiDesk" link, so when someone shares something with you it opens straight into your Shared with me. This is part of a larger piece of work making every part of the app respect the organisation you are working in.',
    highlights: [
      'The Organizations admin panel is scoped to the active organisation.',
      'Shared items can open directly in the app from an "Open in PlexiDesk" link.',
      'More organisation scoping across shares, chat, inbox and mail is on the way.'
    ]
  },
  {
    version: '2.5.144',
    date: '2026-07-02T23:00:00Z',
    title: 'v2.5.144 — organisations keep to themselves',
    tag: 'fix',
    summary:
      'Switching organisation now fully changes what you see. Before, some parts of the workspace stayed the same across organisations, so you could still see one organisation\'s things while working in another. Now the calendar, the vault, your knowledge, your tables and your files all belong to the organisation you are in, on top of the desks, documents and connected apps that already did. Switching also refreshes the file view straight away instead of holding on to the previous organisation\'s files, and the organisation admin and people view follow the organisation you have switched to. Your existing work stays in your Personal space exactly as it was.',
    highlights: [
      'Calendar, vault, knowledge, tables and files are now scoped to the active organisation.',
      'Switching org refreshes the file view immediately and the admin/people view follows the switch.',
      'Your existing data stays intact in your Personal space.'
    ]
  },
  {
    version: '2.5.143',
    date: '2026-07-02T21:00:00Z',
    title: 'v2.5.143 — a gallery of your desks',
    tag: 'feature',
    summary:
      'When no desk is open you now see a gallery of all the desks in the organisation you are working in, each shown as a live thumbnail of what is on it, instead of a single empty "your desk is clear" screen. A desk is simply a canvas, so the gallery is the natural home base: pick a desk to open its canvas, or start a new one from the New desk card. It clears up the odd feeling of a lone empty desk when you actually have several on the go.',
    highlights: [
      'The no-desk-open space is now a gallery of every desk in the current organisation.',
      'Each desk shows a real thumbnail of its contents; click to open its canvas.',
      'A New desk card is always there to start a fresh canvas.'
    ]
  },
  {
    version: '2.5.142',
    date: '2026-07-02T19:00:00Z',
    title: 'v2.5.142 — a calmer, reliable desk minimap',
    tag: 'fix',
    summary:
      'The desk minimap now gets out of your way while you work. When you click into a widget it folds down to a small button in the corner, and it reopens on its own whenever you pan or zoom around the canvas, or the moment you tap the button. It is there for finding your way around, not for sitting open while you are heads-down in a widget. This release also fixes a bug where the minimap could come unpinned and drift off with the canvas as you added more widgets; it now stays locked to the bottom-right corner no matter how big the canvas gets or how far you pan.',
    highlights: [
      'The minimap folds to a small button when you focus a widget, and reopens while you navigate.',
      'Fixed the minimap coming unpinned and drifting once the canvas grew past the screen.',
      'It now stays anchored to the bottom-right corner however large the canvas gets.'
    ]
  },
  {
    version: '2.5.141',
    date: '2026-07-02T17:00:00Z',
    title: 'v2.5.141 — real pages in Page view',
    tag: 'feature',
    summary:
      'Page view now shows your document as real, separate sheets. Each page is its own sheet at the exact paper size, orientation and margins you set, and there is a proper gap between one page and the next instead of a thin line drawn through one long sheet. Content flows cleanly onto each page and starts fresh on the next, the way a word processor should. Continuous view is unchanged for when you would rather write in one flowing column.',
    highlights: [
      'Pages render as discrete sheets at your real paper size, with a true gap between them.',
      'Content flows onto each page and continues on the next rather than crossing a page line.',
      'Continuous view still gives you one uninterrupted writing column.'
    ]
  },
  {
    version: '2.5.140',
    date: '2026-07-02T15:00:00Z',
    title: 'v2.5.140 — menu bars across the whole office',
    tag: 'feature',
    summary:
      'The menu bar that arrived on documents now lives on Sheets, Slides, Draw and Design too, so every office app has the same familiar File, Edit, Insert, Format and so on across the top. Each app gets the menus that fit it: Sheets has Data with sort and filter, number formats and charts; Slides has a Slide menu with new, delete and reorder plus Present; Design has shapes, images and Remove image background with export to PNG or PDF; Draw has shapes and fit-to-view. As with documents, every item runs the real action, and where an app genuinely cannot do something it simply is not shown rather than sitting there dead.',
    highlights: [
      'The same menu-bar experience now spans Docs, Sheets, Slides, Draw and Design.',
      'Each app shows the menus that match it: Sheets Data/charts, Slides Slide/Present, Design shapes/export.',
      'Every menu item performs a genuine action; nothing is a placeholder.'
    ]
  },
  {
    version: '2.5.139',
    date: '2026-07-02T13:00:00Z',
    title: 'v2.5.139 — a full menu bar for documents',
    tag: 'feature',
    summary:
      'PlexiDocs now has the familiar menu bar across the top, with File, Edit, View, Insert, Format, Tools and Help, each a dropdown just like the word processor you already know. File covers new document, make a copy, rename, download as Word, PDF or web page, and move to trash. Edit has undo, redo, cut, copy, paste, select all and find and replace. Insert adds images, tables, links and lines. Format carries text styles, headings, alignment, lists and clear formatting, and Tools has a live word count. Every item does the real thing, so there is nothing in the menus that does not work.',
    highlights: [
      'A real File / Edit / View / Insert / Format / Tools / Help menu bar on documents.',
      'Download as Word, PDF or web page, make a copy, find and replace, word count and more.',
      'Every menu item is wired to a genuine action, not a placeholder.'
    ]
  },
  {
    version: '2.5.138',
    date: '2026-07-02T11:00:00Z',
    title: 'v2.5.138 — switch between organisations',
    tag: 'feature',
    summary:
      'You can now switch organisations from the top of the side menu, right under the wordmark, and the whole workspace follows. Each organisation keeps its own separate files, documents, tasks and connected apps, and your own private work lives in a Personal space that is always there. Switching is instant and the menu reflects wherever you are. You reach an organisation by being invited to it, so you only ever see the organisations you belong to, and you can invite other people from Manage. This is the first step of a larger piece of work: the same-organisation data you and a colleague share will sync between you in a following update, and until then each device keeps its own copy of an organisation.',
    highlights: [
      'An organisation switcher at the top of every area menu (Desk, Office, People, Brain).',
      'Each organisation has its own files, documents, tasks and apps; Personal holds your private work.',
      'You only see organisations you are invited to; invite people from Manage.'
    ]
  },
  {
    version: '2.5.137',
    date: '2026-07-02T09:00:00Z',
    title: 'v2.5.137 — colourful menus everywhere',
    tag: 'design',
    summary:
      'Every menu now uses the same colourful style as the PlexiOffice app list, where each item is a rounded coloured square with a white icon. This is now consistent across all four areas. The Desk menu, the People menu and the Brain menu all match PlexiOffice, so Home, Plans, Tasks, Calendar and the rest each get their own colour, and the whole app reads as one place. Home is the same indigo everywhere so you always know where you are.',
    highlights: [
      'Colourful rounded-square icons on every menu item, matching the PlexiOffice app list.',
      'Consistent across all four areas: Desk, Office, People and Brain.',
      'Each place has its own colour, with Home the same indigo everywhere.'
    ]
  },
  {
    version: '2.5.136',
    date: '2026-07-02T07:00:00Z',
    title: 'v2.5.136 — the Desk menu now matches PlexiOffice',
    tag: 'polish',
    summary:
      'The Desk menu on the left now uses the exact same clean look as the PlexiOffice menu, so the whole app feels like one place instead of two. It has the same raised surface, the same wordmark, the same rounded nav rows that fill with a soft accent when active, the same quiet section labels and the same Pro card at the foot. The old heavier styling, with its tighter grey rows and stone headers, is gone. This is the menu style being standardised across every area.',
    highlights: [
      'The Desk menu is restyled to match the PlexiOffice menu exactly.',
      'Rounded accent-tinted nav rows, quiet section labels, one consistent chrome.',
      'The same clean menu now lives on every area, not just PlexiOffice.'
    ]
  },
  {
    version: '2.5.135',
    date: '2026-07-02T06:00:00Z',
    title: 'v2.5.135 — every desk is a canvas',
    tag: 'feature',
    summary:
      'Opening a folder-desk now gives you the same canvas you already get on a task, so every desk behaves the same way. There is one drop surface to arrange, and the "Add to desk" strip on the left lets you drag widgets and office things straight onto it. Folders used to open as a separate dashboard, which meant a desk felt different depending on where you clicked. That split is gone. A desk is a canvas, wherever you open it, and you drag things onto it.',
    highlights: [
      'Folder-desks open as a canvas, the same as a task.',
      'The "Add to desk" strip shows on any desk, so you drag widgets and office things onto it.',
      'One consistent desk experience instead of a canvas here and a dashboard there.'
    ]
  },
  {
    version: '2.5.134',
    date: '2026-07-02T05:00:00Z',
    title: 'v2.5.134 — drag docs and sheets onto your desk',
    tag: 'feature',
    summary:
      'When you open a desk, the sidebar now lets you drag office things onto the canvas as well as widgets. Alongside a sticky, note, timer, task, calculator, image, page or file, you can now grab a doc, sheet, slides deck or a drawing and drop it straight onto the desk. This sits in the "Add to desk" strip on the clean Desk menu that arrived in the last update, so a desk gives you the simple menu on the left and everything you can add to it right there.',
    highlights: [
      'Drag a doc, sheet, slides or drawing from the sidebar onto a desk, not just widgets.',
      'The office things spawn the same way they do everywhere else.',
      'It lives in the "Add to desk" strip on the clean Desk menu.'
    ]
  },
  {
    version: '2.5.133',
    date: '2026-07-02T03:00:00Z',
    title: 'v2.5.133 — the Desk menu is clean now too',
    tag: 'feature',
    summary:
      'The Desk menu now looks and works like the PlexiOffice menu the rest of the app uses, instead of the busy stack of sections it was. It is the PlexiDesk name, the area switcher, and one clean list of your key places, Home, Plans, Tasks, Calendar, Files and Vault, with your desks listed underneath and, when a desk is open, the widgets you can drag onto it. The extra labelled sections are gone, since everything in them is reachable from the areas the switcher opens or from the nav itself. So the navigation is the same simple menu everywhere.',
    highlights: [
      'The Desk menu matches the clean PlexiOffice-style menu used across the app.',
      'One clear nav list plus your desks, instead of many stacked sections.',
      'The same simple menu now, genuinely everywhere.'
    ]
  },
  {
    version: '2.5.132',
    date: '2026-07-02T01:00:00Z',
    title: 'v2.5.132 — the simple menu, everywhere',
    tag: 'feature',
    summary:
      'The clean, focused menu now shows on every screen. Until now it only appeared inside Office, People and Brain; the moment you opened All Tasks, a desk, your calendar or files, the old busy menu came back. That is gone. The main Desk menu is now the same simple menu, with the Desk / Office / People / Brain switcher at the top, so wherever you are the navigation looks and works the same and Docs and Sheets are always one click away. The crowded extra sections have been cleared out, since everything in them is reachable from the areas the switcher opens, leaving a short Desk menu with your key places, your desks and, on a desk, the widgets you can drag onto it.',
    highlights: [
      'The same simple menu and area switcher now appear on every view, not just inside the segments.',
      'Opening All Tasks, a desk, Calendar or Files no longer brings back the old crowded menu.',
      'The Desk menu is trimmed to what matters: your places, your desks and drag-on widgets.'
    ]
  },
  {
    version: '2.5.131',
    date: '2026-07-01T23:00:00Z',
    title: 'v2.5.131 — icons always load, and Docs are one click away',
    tag: 'fix',
    summary:
      'Fixes two problems. First, icons could show up as plain words like "checklist" or "folder" instead of the icon. That happened because the icons, and all the app fonts, were fetched from the internet, so anything blocking that connection broke them. The fonts now ship inside the app, so icons and text always appear, even with no connection at all. Second, from your desk it was not obvious how to get to Docs and Sheets, since each area shows only its own apps. Every menu now has a small row at the top to switch between Desk, Office, People and Brain, so Docs and Sheets are always a single click away without going back to a crowded menu.',
    highlights: [
      'Icons and fonts are bundled with the app, so they load with no internet and never show as raw text.',
      'A small switcher at the top of every menu jumps between Desk, Office, People and Brain in one click.',
      'Docs and Sheets are always one click from the desk.'
    ]
  },
  {
    version: '2.5.130',
    date: '2026-07-01T21:30:00Z',
    title: 'v2.5.130 — a simpler menu, and widgets you can drag',
    tag: 'feature',
    summary:
      'The side menu is simple again. A recent change had turned it into one dense menu that showed every area and every app at once, which was a lot to take in. Now each area shows its own short, focused menu, the way PlexiOffice always did, and the home menu is a clean switcher rather than everything expanded at once. On top of that, when you have a desk open the menu shows a small Widgets strip, so you can drag a sticky, note, timer, task, calculator, image, page or file straight onto the canvas. The widgets only appear while you are on a desk, so they never get in the way anywhere else. Your organisation and templates settings and your configurable dashboards are unchanged.',
    highlights: [
      'Each area has its own short, focused menu again, instead of one dense menu showing everything.',
      'Drag widgets straight from the menu onto the desk, shown only while a desk is open.',
      'Settings and configurable dashboards are unchanged.'
    ]
  },
  {
    version: '2.5.129',
    date: '2026-07-01T19:30:00Z',
    title: 'v2.5.129 — dashboards you can lay out your way',
    tag: 'feature',
    summary:
      'Your dashboards are now yours to arrange. You could already add, remove and drag the cards around; now you can also choose whether a dashboard runs in one, two or three columns, and set each card to small, medium or large so the things you care about take the space they deserve. Every area keeps its own layout, so your home, and each individual plan, can look exactly the way that area needs. Open a dashboard, hit Customize, and lay it out to suit you. Your existing dashboards carry over untouched.',
    highlights: [
      'Choose 1, 2 or 3 columns for any dashboard.',
      'Set each card to small, medium or large.',
      'Every area, including each plan, keeps its own layout, and existing dashboards carry over unchanged.'
    ]
  },
  {
    version: '2.5.128',
    date: '2026-07-01T18:00:00Z',
    title: 'v2.5.128 — Organisation and Templates move into Settings',
    tag: 'feature',
    summary:
      'Tidies the side menu by moving Organisation and Templates into Settings, where your account already lived, so the three things you configure rather than work in now sit together in one place. Open Settings and you will find your organisation, with a button through to manage members and roles, and your templates, ready to drop onto the desk you have open. The standalone Organisation and Templates entries are gone from the menu, which keeps it focused on the places you actually do your work.',
    highlights: [
      'Organisation and Templates now live in Settings, alongside your account.',
      'The Organisation panel shows your real org with a button to manage members and roles.',
      'The side menu is cleaner, focused on where you work rather than what you configure.'
    ]
  },
  {
    version: '2.5.127',
    date: '2026-07-01T16:30:00Z',
    title: 'v2.5.127 — drag apps from the menu onto your desk',
    tag: 'feature',
    summary:
      'You can now drag an app straight out of the side menu and drop it on your desk to place it there. Drag Docs, Sheets or Slides to drop a new document, sheet or deck onto the canvas, Draw for a sketch surface, Mail or Chat to pin a mail or conversation, or Brain Map and Agents to drop those in. It lands exactly where you drop it. Apps that do not have a canvas form yet, like Search or your calendar, stay as normal clicks, and clicking any app still just opens it as before.',
    highlights: [
      'Drag an app from the menu onto the desk canvas to place it as a widget.',
      'Docs, Sheets, Slides, Draw, Mail, Chat, Brain Map and Agents can all be dropped onto a desk.',
      'It drops where you release it, and a normal click still just opens the app.'
    ]
  },
  {
    version: '2.5.126',
    date: '2026-07-01T15:00:00Z',
    title: 'v2.5.126 — one menu, everywhere',
    tag: 'feature',
    summary:
      'The side menu no longer changes as you move around. Until now, opening PlexiOffice, PlexiPeople or any other area swapped the whole sidebar for that area\'s own smaller menu, so you lost sight of everything else. Now there is a single menu, always on the left, with every area and its apps laid out in labelled sections, and only the main panel changes when you pick something. It is the same clear, consistent navigation whether you are in a document, a plan, a chat or your desk, so nothing is ever more than one click away.',
    highlights: [
      'A single persistent side menu shown in every view, instead of a different menu per area.',
      'Choosing an app just changes the main panel; the menu stays put and highlights where you are.',
      'The same navigation everywhere, so every app is one click away from anywhere.'
    ]
  },
  {
    version: '2.5.125',
    date: '2026-07-01T13:00:00Z',
    title: 'v2.5.125 — your workspaces never look lost again',
    tag: 'fix',
    summary:
      'Fixes a scare where the workspace list in the sidebar could come up empty even though every desk, document and widget was safe on your device. The cause was the tree loader giving up after a single failed read at startup, which can happen if another copy of the app is briefly holding the database, and then showing "no projects yet" as if there were nothing there. The loader now retries, and if it genuinely cannot read right then it says so plainly, reassures you that your data is safe on this device, and gives you a Try again button, rather than showing an empty list. Restarting the app already reloads everything; this makes sure a momentary hiccup can never be mistaken for lost work.',
    highlights: [
      'The sidebar no longer shows an empty workspace list after a transient load failure.',
      'The tree loader retries, and on real failure shows an honest message with a Try again button.',
      'Your desks, documents and widgets were always safe on-device; this fixes only how a load failure was shown.'
    ]
  },
  {
    version: '2.5.124',
    date: '2026-07-01T11:30:00Z',
    title: 'v2.5.124 — a Plan is more than a timeline',
    tag: 'feature',
    summary:
      'Opening a plan now starts on a real Overview rather than dropping you straight into the Gantt. The Overview reads the plan you actually have: how far along it is, how many tasks are done, when it starts and finishes, your milestones and the next one coming up, anything that is running late or about to miss a deadline, and the length of the critical path. A brand-new plan simply shows zeros and invites you to add tasks. There is also a new Files view that gathers the documents and files you have filed under the plan, so the things that belong to a piece of work live with it. The timeline, board, grid, calendar and workload views are all still there, now sitting beside Overview and Files as different lenses on the same plan.',
    highlights: [
      'Plans open on a real Overview: progress, dates, milestones, late and at-risk counts, critical path.',
      'A new Files view shows the documents and files filed under the plan.',
      'Overview and Files join Timeline, Board, Grid, Calendar and Workload as views of one plan.'
    ]
  },
  {
    version: '2.5.123',
    date: '2026-07-01T10:00:00Z',
    title: 'v2.5.123 — the whole workspace in your sidebar',
    tag: 'feature',
    summary:
      'The sidebar now lays the whole workspace out the way the new design intends. Each of the four areas, PlexiDesk, PlexiOffice, PlexiPeople and PlexiBrain, is its own labelled, collapsible section, and every app inside it is right there as a row you can click. PlexiDesk holds Home, your Desk, Workspaces, Plans, Tasks, Calendar, Files and Recent. PlexiOffice holds Docs, Sheets, Slides, Draw, Mail, Inbox, Chat, Meet and Sign. PlexiPeople holds your people home, the directory and the organisation map. PlexiBrain holds Ask Brain, Search, Brain Map, Flows, Agents, Connect, APIs and Insights. Click any one and you land straight on it, no hunting through menus.',
    highlights: [
      'Four expandable sidebar sections, one per area, with every app listed as a direct link.',
      'Click an app to deep-link straight to it; click a section header to open that area.',
      'The same object-based structure across the whole app, now reflected in the navigation.'
    ]
  },
  {
    version: '2.5.122',
    date: '2026-07-01T08:30:00Z',
    title: 'v2.5.122 — a fuller PlexiOffice Home',
    tag: 'feature',
    summary:
      'The PlexiOffice home is now a proper starting point for your day. The app cards gain Meet alongside Docs, Sheets, Slides and Draw. Below them a recent table lets you flick between all your files or just docs, sheets, slides, drawings, mail or meetings, each row showing when you last opened it. A side rail brings together what is on your calendar today, quick actions to compose an email or start a new doc, sheet, deck or meeting, and a count of what is unread across your inbox, chat and mail. As always it is built on your real content, so it shows what is genuinely there and stays quiet and honest when something is empty.',
    highlights: [
      'PlexiOffice home gains a Meet card and a recent table you can filter by type.',
      'A side rail with today’s schedule, quick create actions, and real unread counts.',
      'Everything reads your real files, calendar and messages, with honest empty states.'
    ]
  },
  {
    version: '2.5.121',
    date: '2026-07-01T07:00:00Z',
    title: 'v2.5.121 — a real Home, and PlexiPeople',
    tag: 'feature',
    summary:
      'Two big steps toward the new PlexiDesk. The Home screen is rebuilt into a proper command centre. It greets you by name, shows what you can continue where you left off, lays out your desks, lists what is actually on your calendar for today and what has actually happened in your workspace recently, and gives you quick ways to create, plan, collaborate or automate, with an Ask PlexiBrain bar right there. Everything on it is real. Where a number is not yet measured, like a productivity score, it says so plainly rather than inventing one. Alongside it, PlexiPeople arrives as a new place in the sidebar, a home for your team with live presence, a searchable directory of the real people in your workspace and your organisation map. It shows the people who are genuinely there, and stays honest about what it does not yet track.',
    highlights: [
      'A rebuilt Home command centre: greeting, continue where you left off, your desks, today’s agenda, recent activity and quick actions, all from real data.',
      'Ask PlexiBrain and Focus Mode are right on the Home screen.',
      'New PlexiPeople segment: live team presence, a real member directory and your organisation map.',
      'Honest throughout: uninstrumented metrics and untracked details are omitted, not faked.'
    ]
  },
  {
    version: '2.5.120',
    date: '2026-07-01T05:30:00Z',
    title: 'v2.5.120 — every agent in one place',
    tag: 'feature',
    summary:
      'The Agents page in PlexiBrain is now real. Desk agents are the standing AI workers you place on a desk and wire your widgets into, and until now you could only see them one desk at a time. PlexiBrain now lists every agent across your whole workspace, each with its name and role, the desk it runs on, whether it is active and how it is triggered, and when it last ran. Click any agent to jump straight to its desk. If you have not placed an agent yet, the page says so honestly and points you to your desk to add one.',
    highlights: [
      'PlexiBrain Agents lists every desk agent across the workspace, not one desk at a time.',
      'Each agent shows its role, its desk, its active or paused status, and when it last ran.',
      'Click an agent to open the desk it lives on.'
    ]
  },
  {
    version: '2.5.119',
    date: '2026-07-01T04:00:00Z',
    title: 'v2.5.119 — a simpler, object-based PlexiDesk',
    tag: 'feature',
    summary:
      'PlexiDesk is reorganised around the work itself rather than a maze of modules. The top of the app is now three clear places. PlexiDesk is where you organise and navigate, with Home, your Desk, Workspaces, Plans, Tasks, Calendar, Files and Recent. PlexiOffice is where you create and discuss, with Docs, Sheets, Slides, Draw and Design alongside Mail, Inbox, Chat, Meet and Sign. PlexiBrain is where you find, understand and automate, with Ask Brain, Search, the new Brain Map, Flows, Agents, Connect, APIs and Insights. Everything you make is one universal object, a file is just a file and a task is just a task, that you can group by a workspace or a plan without the app inventing separate copies. The biggest change in language is that Projects are now Plans. A plan can be a project plan, a launch, a campaign, a hiring plan or a personal one, with all the same timeline and milestone power, so you get serious planning without being forced into project-management jargon.',
    highlights: [
      'Three top-level segments: PlexiDesk to organise, PlexiOffice to create, PlexiBrain to find and automate.',
      'Single-source objects with contextual views, no more duplicated Project Files or Project Tasks.',
      'Projects are now Plans, the same planning power for any kind of plan.',
      'New Brain Map shows your PlexiBrain knowledge as a linked graph.'
    ]
  },
  {
    version: '2.5.118',
    date: '2026-07-01T01:00:00Z',
    title: 'v2.5.118 — sparklines, a richer Slides editor, and AI for Design',
    tag: 'feature',
    summary:
      'Three upgrades across PlexiOffice. PlexiSheets gets sparklines, a tiny trend chart you draw right inside a cell with =SPARKLINE of a range, as a line or as bars, and a toolbar button puts one next to a row of numbers for you. PlexiSlides gets the side panel its mockup promised, an AI Assistant with ideas for the current slide alongside Slide and Layout tabs that show the real layout, background, theme colours and font, and a proper speaker-notes editor. PlexiDesign gets the same kind of AI Assistant as Docs and Sheets, able to improve your copy, shorten it, suggest a headline or write a caption from the text you actually have on the canvas. As everywhere in Plexii, the assistant works from your real content and shows an honest message when there is nothing to act on or when something goes wrong.',
    highlights: [
      'PlexiSheets: =SPARKLINE(range) draws a line or bar trend chart inside a cell, with a one-click insert button.',
      'PlexiSlides: a right-side panel with per-slide AI ideas, real Slide and Layout properties, and a speaker-notes editor.',
      'PlexiDesign: an AI Assistant panel that improves, shortens, and drafts copy from the text on your canvas.',
      'Every assistant runs on your real content; honest empty and error states throughout.'
    ]
  },
  {
    version: '2.5.117',
    date: '2026-06-30T23:00:00Z',
    title: 'v2.5.117 — an AI Assistant for PlexiSheets',
    tag: 'feature',
    summary:
      'PlexiSheets gains the same kind of side panel PlexiDocs just got, an AI Assistant on the right of the grid. It reads the data actually in your sheet and surfaces insights from it, and you can ask it a question about your data in plain language and get an answer grounded in the real numbers. It is honest by design. A sheet with no data simply invites you to add some rather than inventing a result, and any real error, such as a missing API key, is shown plainly. The panel also has space for recent activity and data connections, which show a truthful empty state until those are wired to a real source rather than displaying anything made up. The toolbar, grid, charts, conditional formatting and tabs are all unchanged.',
    highlights: [
      'A collapsible AI Assistant panel on the right of the PlexiSheets grid.',
      'Insights and answers are generated from the real data in your sheet, never hardcoded.',
      'Honest states throughout: an empty sheet asks for data, errors show plainly, and activity and connections stay empty until real sources exist.'
    ]
  },
  {
    version: '2.5.116',
    date: '2026-06-30T21:00:00Z',
    title: 'v2.5.116 — a proper side panel for PlexiDocs',
    tag: 'feature',
    summary:
      'PlexiDocs gains a persistent side panel on the right, the way a modern document editor should. It has three tabs. The AI Assistant greets you and offers quick actions, summarise the document, improve the writing, make it shorter, fix grammar, or translate it, alongside a free prompt box, and every action runs the real assistant and shows its result with Insert and Copy. The Comments tab lists the real comment threads on a shared document with a reply box on each, and shows a plain "no comments yet" state when there are none rather than inventing any. The Outline tab gives you the heading map of the document. The panel collapses when you want the page to yourself and stays out of the way in focus mode.',
    highlights: [
      'A persistent right-hand panel in PlexiDocs with AI Assistant, Comments and Outline tabs.',
      'AI quick actions: summarise, improve writing, make shorter, fix grammar, translate, plus a free prompt, each with Insert and Copy.',
      'Comments tab shows the real threads on a shared document, with replies, and an honest empty state otherwise.',
      'The panel collapses and stays hidden in focus mode.'
    ]
  },
  {
    version: '2.5.115',
    date: '2026-07-02T20:00:00Z',
    title: 'v2.5.115 — tidier navigation, bigger sheets, and a column-heading fix',
    tag: 'feature',
    summary:
      'The navigation is properly tidied now. The individual product entries that used to be scattered down the sidebar have been folded into their segments, so PlexiWork, PlexiConnect and PlexiFlow own Projects, Tasks, Reports, Chat, Meet, Flow, API, Build and Form, and the duplicate entries are gone. PlexiSheets also opens larger, a fresh spreadsheet now starts at 48 columns by 100 rows like a real one rather than a tiny starter grid. And a frustrating bug is fixed: you can rename a column heading again. Typing in a header used to get captured by the grid and start a cell edit instead.',
    highlights: [
      'The scattered product entries are folded into the PlexiWork / PlexiConnect / PlexiFlow segments; the duplicates are gone.',
      'A new spreadsheet opens at 48 columns by 100 rows.',
      'Fixed: renaming a column heading works again (keystrokes are no longer hijacked by the grid).',
      'PlexiConnect shows PlexiChat above PlexiMeet.'
    ]
  },
  {
    version: '2.5.114',
    date: '2026-07-02T16:00:00Z',
    title: 'v2.5.114 — PlexiWork, PlexiConnect and PlexiFlow, organised like PlexiOffice',
    tag: 'feature',
    summary:
      'The rest of the system now has the same calm, organised feel as PlexiOffice. PlexiWork brings your Projects, Tasks and Reports together; PlexiConnect holds Chat and Meet; and PlexiFlow gathers Flow, API, Build and Form. Open any of them and the space becomes a focused area with its own side menu and a clear home of app tiles, and you move between the apps inside it without losing the menu. Same tools as before, in a much tidier home.',
    highlights: [
      'PlexiWork: Projects, Tasks and Reports in one focused area.',
      'PlexiConnect: Chat and Meet together.',
      'PlexiFlow: Flow, API, Build and Form together.',
      'Each is its own segment with a dedicated side menu and a home, matching PlexiOffice.'
    ]
  },
  {
    version: '2.5.113',
    date: '2026-07-02T10:00:00Z',
    title: 'v2.5.113 — PlexiOffice, organised into its own place',
    tag: 'feature',
    summary:
      'PlexiOffice is now its own segment of the app, the home for everything you create and sign. Open it and the whole space changes to a dedicated office layout with its own side menu: Home, Recent, Starred, Shared, Templates and Trash up top, then your apps, PlexiDocs, PlexiSheets, PlexiSlides, PlexiDraw, PlexiDesign, PlexiForms and PlexiSign, and your workspaces below. The home gives you the app tiles, a template gallery, your recent files and a side rail with what is pinned and what is new. Opening a document keeps you inside PlexiOffice, with the side menu right there, and a clear way back. It is a calmer, more organised way to work than everything living in one long list.',
    highlights: [
      'PlexiOffice is its own segment with a dedicated side menu (Home, Recent, Starred, Templates, Trash + your apps + workspaces).',
      'A real office home: app tiles, a template gallery, recent files, and a Pinned / Storage / What’s-new rail.',
      'Docs, Sheets, Slides, Drawings and Designs open inside PlexiOffice so the side menu stays put; PlexiSign is right there for signing.'
    ]
  },
  {
    version: '2.5.112',
    date: '2026-07-01T16:00:00Z',
    title: 'v2.5.112 — PlexiDesign is its own studio, with a much better look',
    tag: 'feature',
    summary:
      'PlexiDesign is now its own place in the app, not a tab tucked inside Documents. There is a PlexiDesign entry in the sidebar and the command palette, and a proper home where you start a design at any size, begin from an on-brand template, or open one you already made. The designs themselves look far better too. Backgrounds are real gradients in your brand color, with soft depth, rounded pill buttons, a cleaner type hierarchy and a more considered layout, the kind of finish you expect from a design tool rather than a flat colored box with text on it.',
    highlights: [
      'PlexiDesign is its own module: a sidebar entry, a command-palette command, and its own start screen.',
      'Documents goes back to being the document surface; design lives on its own.',
      'Generated designs now use gradient backgrounds, depth, rounded buttons and a stronger type hierarchy.'
    ]
  },
  {
    version: '2.5.111',
    date: '2026-07-01T10:00:00Z',
    title: 'v2.5.111 — PlexiDesign AI template generator',
    tag: 'feature',
    summary:
      'Describe what you want and PlexiDesign generates a set of finished, on-brand designs to choose from. The AI writes six genuinely different concepts from one prompt, varying the angle, the wording, the mood and the layout, and lays each one out in your brand colors and fonts. You see them as a grid of real previews and click the one you like to drop it on the canvas. It is the answer to "I need a starting point" without hunting through a giant template gallery, the options are generated for your brief, every time.',
    highlights: [
      'Generate six distinct, on-brand design options from a single prompt.',
      'Six layout styles (left, centered, band, bold, split, minimal) keep the set genuinely varied.',
      'Pick from a grid of real previews; the single-design option is still there too.'
    ]
  },
  {
    version: '2.5.110',
    date: '2026-06-30T20:00:00Z',
    title: 'v2.5.110 — PlexiDesign: fonts, stock photos, background removal, magic resize',
    tag: 'feature',
    summary:
      'PlexiDesign closes the distance to a full design tool. There is a real font library now, around a hundred Google Fonts in the text picker and the brand kit, not a handful of system stacks. Search free stock photos right inside the studio and drop one onto the canvas, and remove the background from any image in a click. Resize a design to a different format and the whole layout reflows to fit instead of leaving everything stranded. And there are more building blocks, triangles, rounded rectangles and lines. Stock photos use a free Pexels key and background removal uses a remove.bg key, both added in Settings; without them those tools tell you what they need rather than pretending.',
    highlights: [
      'A real font library: around 100 Google Fonts in the text picker and the brand kit.',
      'Search and insert free stock photos (Pexels) without leaving the studio.',
      'One-click background removal on any image (remove.bg).',
      'Magic resize reflows a whole design to a new size; plus triangle, rounded-rectangle and line tools.'
    ]
  },
  {
    version: '2.5.109',
    date: '2026-06-30T16:00:00Z',
    title: 'v2.5.109 — PlexiDesign editor depth',
    tag: 'feature',
    summary:
      'PlexiDesign grows the editing fundamentals that make it feel like a real design tool. There is full undo and redo now, with keyboard shortcuts, plus duplicate and delete for whatever you have selected. Select more than one element and you can align, distribute and group them. Every element has opacity and rotation, text gets a proper font picker with alignment and bold, italic and underline, and you can set the canvas background. The template library more than doubled, with quote posts, big-stat posts, story covers, sale promos, business cards, section dividers, pull quotes and logo lockups across social, marketing, presentations and brand assets.',
    highlights: [
      'Undo and redo with keyboard shortcuts, plus duplicate (Cmd/Ctrl+D) and delete.',
      'Multi-select align, distribute and group; per-element opacity and rotation.',
      'A font picker, text alignment and bold/italic/underline, and a canvas background color.',
      'The template library expanded from 5 to 13 across every design family.'
    ]
  },
  {
    version: '2.5.108',
    date: '2026-06-30T10:00:00Z',
    title: 'v2.5.108 — Design export and a brand kit for the whole workspace',
    tag: 'feature',
    summary:
      'PlexiDesign can now get your work out: export any design to a high-resolution PNG or a PDF at its exact size, ready to post or print. And there is a proper Brand Kit. Set your logo, your colors and your fonts once and the studio uses them everywhere, in templates, in the AI layouts, when you Brandify a design, and with a one-click Logo drop. The brand editor checks contrast as you go so your text stays readable, and new documents now open already on-brand once a kit is set. This is the start of one brand running across everything you make in PlexiDesk.',
    highlights: [
      'Export a design to PNG or PDF at its exact pixel size.',
      'A Brand Kit: set your logo, colors and fonts once and PlexiDesign uses them throughout.',
      'Live contrast checks in the brand editor so brand colors never produce unreadable text.',
      'New documents open on-brand when a brand kit is set; existing documents are untouched.'
    ]
  },
  {
    version: '2.5.107',
    date: '2026-06-29T22:00:00Z',
    title: 'v2.5.107 — PlexiDesign, the on-platform design studio',
    tag: 'feature',
    summary:
      'PlexiDesign is a full design studio built right into PlexiDesk. Create a design at any size, from an Instagram post or story to a poster, a flyer, a business card, a presentation cover, a logo or a custom canvas, and lay it out on a real editing surface with drag, resize and snap guides. Start from a brand-aware template, then let AI do the heavy lifting: describe what you want and it writes the copy and composes a finished, on-brand layout in seconds, and it can generate images to drop straight onto the canvas. Add text, shapes and images yourself, restyle anything in the inspector, and snap a stray design back to your colors with one Brandify click. This is the first release of a studio that will keep growing.',
    highlights: [
      'Design at any size with presets for social, marketing, presentations and logos, plus custom dimensions.',
      'A real editing canvas with drag, resize and Figma-style snap guides, shared with the slides engine.',
      'AI writes on-brand copy and lays out a finished design from a prompt, and generates images for the canvas.',
      'Brand-aware templates and a one-click Brandify to standardize an existing design on your colors and fonts.'
    ]
  },
  {
    version: '2.5.106',
    date: '2026-06-29T18:00:00Z',
    title: 'v2.5.106 — Documents: real pages and margins',
    tag: 'feature',
    summary:
      'The document editor now treats pages and margins the way a real word processor does. Page size, orientation and margins belong to the document, not to your app, so two people opening the same file see the same pages, and a choice you make in one document never leaks into the next. Margins are properly configurable from a Margins menu, with the familiar Normal, Narrow, Moderate and Wide presets plus a custom setting for each of the four sides in inches. Best of all it is faithful on the way out: the .docx and PDF you export carry the same paper size, orientation and margins you set on screen, so what you see is what you hand over.',
    highlights: [
      'Page size, orientation and margins are saved with the document, not as a global app preference.',
      'A Margins menu with Word-style presets (Normal, Narrow, Moderate, Wide) and a custom per-side editor in inches.',
      'Exports are WYSIWYG: .docx and PDF use the document’s own paper size, orientation and margins.'
    ]
  },
  {
    version: '2.5.105',
    date: '2026-06-29T12:00:00Z',
    title: 'v2.5.105 — PlexiProjects: constraints, budgets, leveling, and Microsoft Project export',
    tag: 'feature',
    summary:
      'PlexiProjects gains the planning depth that separates a real tool from a task list. A task can now be pinned to a date with must-start-on, or given a finish-by deadline, and anything the schedule pushes past its deadline is flagged on the timeline and in the grid. Add a cost to tasks and the grid totals your budget. When one person ends up double-booked, the new Level action spreads their overlapping work out so nobody is on two things at once. And when you need to hand a plan to someone who lives in Microsoft Project, Export writes a Project XML file they can open directly, dependencies, resources and all.',
    highlights: [
      'Task constraints: must-start-on (pins the start) and a finish-by deadline, with a clear flag when the schedule blows past it.',
      'Cost and budget: give tasks a cost and the grid shows a per-task column and a project total.',
      'Resource leveling: one click spreads a person’s overlapping tasks so they are never scheduled on two at once.',
      'Export to Microsoft Project: save a standard Project XML with tasks, durations, dependencies and resources.'
    ]
  },
  {
    version: '2.5.104',
    date: '2026-07-20T12:00:00Z',
    title: 'v2.5.104 — PlexiProjects: baselines, calendars, and two new views',
    tag: 'feature',
    summary:
      'PlexiProjects gains the planning depth you expect from a serious tool. Set a baseline to freeze the current plan, and from then on the timeline shows a dashed baseline under each task and the editor tells you how many days ahead of or behind it you are. Give each project its own working calendar, choose the working weekdays and add holidays, and the schedule plans around them. There are two more ways to see the plan: a month Calendar that lays tasks out on their dates, and a Workload view that shows each person, what is on their plate and how loaded they are. And assigning work now suggests your teammates instead of relying on memory.',
    highlights: [
      'Baselines and variance: freeze a plan, then see a dashed baseline on the timeline and a days-ahead/behind readout per task.',
      'Per-project working calendar: pick working weekdays and add holidays, and the schedule plans around them.',
      'Two new views: a month Calendar of your tasks, and a Workload view of each person’s load.',
      'Assigning work suggests teammates who are online (and anyone already assigned), with free text still allowed.'
    ]
  },
  {
    version: '2.5.103',
    date: '2026-07-19T12:00:00Z',
    title: 'v2.5.103 — PlexiProjects comes alive',
    tag: 'design',
    summary:
      'A motion and polish pass that makes PlexiProjects feel alive. The critical path now glows and a current of light flows along it, so the chain that drives your finish date draws the eye. Progress fills animate, switching between the timeline, board and grid fades smoothly, cards lift as you hover and dim as you drag, and finishing something is celebrated with a quick spark, when a card lands in Done or a task crosses 100%. It is restrained on purpose, and it all respects your system reduce-motion setting.',
    highlights: [
      'A living critical path: a soft glow on its bars and a flowing current of light along its dependency links.',
      'Smooth everywhere: animated progress fills, fading view switches, and cards that lift on hover and dim while dragging.',
      'A small spark of celebration when work is genuinely finished, and full respect for reduce-motion.'
    ]
  },
  {
    version: '2.5.102',
    date: '2026-07-18T12:00:00Z',
    title: 'v2.5.102 — PlexiProjects, rebuilt to take on Microsoft Project',
    tag: 'feature',
    summary:
      'A serious project planner. The same plan is now three views you switch between: a timeline (Gantt) with a critical path, a board you drag tasks across by status, and a sortable grid. Dependencies are proper now, finish-to-start, start-to-start, finish-to-finish and start-to-finish, each with a lead or lag in working days, and the schedule skips weekends like a real working calendar. Every task can have an owner and a percent-complete that shows as a fill on its bar, and the portfolio home opens with live totals across all your projects. It is all computed from your real plan, with nothing invented.',
    highlights: [
      'Three views of one plan: Timeline (Gantt with critical path), Board (drag tasks across status columns), and a sortable Grid.',
      'Real dependencies: finish-to-start, start-to-start, finish-to-finish and start-to-finish, each with a working-day lead or lag.',
      'A working-day calendar that skips weekends, plus an owner and a percent-complete on every task, shown as a progress fill on the timeline.',
      'A portfolio home with live totals: projects, tasks done, average completion and how many are at risk.'
    ]
  },
  {
    version: '2.5.101',
    date: '2026-07-17T12:00:00Z',
    title: 'v2.5.101 — every module opens to a real dashboard',
    tag: 'feature',
    summary:
      'Reports, Flows, Forms, Build and Meet now open to a genuine, information-rich dashboard instead of a thin landing screen. Each shows live overview tiles with trends and sparklines, a chart of activity over time, a breakdown of what you have by type, and your recent items, with sections you can show or hide. Every figure is drawn from your real data, so an empty module honestly says there is nothing yet rather than drawing a fake chart.',
    highlights: [
      'A real dashboard for each module: overview tiles with trend arrows and sparklines, an activity-over-time chart, a by-type breakdown, and recent items.',
      'Consistent across the suite and built on the design system, so every module home reads as one product.',
      'Honest by design: every number and chart point comes from real data; an empty module shows a clear empty state, never an invented trend.'
    ]
  },
  {
    version: '2.5.100',
    date: '2026-07-16T12:00:00Z',
    title: 'v2.5.100 — the command palette learns your habits',
    tag: 'polish',
    summary:
      'The finishing touches on a run of usability work. The command palette (Cmd or Ctrl K) now remembers the modules you use most and floats them to the top when you open it, so your common destinations are right there without typing. And empty modules read cleaner: the "nothing here yet" message now appears once, in the module overview, instead of being repeated in the list beside it.',
    highlights: [
      'The command palette promotes the modules you visit most, so your everyday destinations are one keystroke away.',
      'Tidier empty states: the "nothing here yet" message shows once instead of twice.'
    ]
  },
  {
    version: '2.5.99',
    date: '2026-07-15T12:00:00Z',
    title: 'v2.5.99 — modules open to your work, and delete you can take back',
    tag: 'polish',
    summary:
      'Two fixes that take friction out of everyday use. Reports, Flows, Forms and Build now open straight to the thing you were last working on instead of an empty landing screen, so you are in your work in one move; the module overview is still one click away whenever you want it. And deleting a task in Projects now shows a clear "Undo" you can click to bring it straight back, the same safety net the sidebar already gives, so a delete is never a worry.',
    highlights: [
      'Modules open on your latest item, not an empty screen. Reports, Flows, Forms and Build land you in real work, with an Overview button to see the module dashboard when you want it.',
      'Visible undo when you delete a task in Projects: a clear "Undo" appears so a delete is always reversible, not a hidden keyboard trick.'
    ]
  },
  {
    version: '2.5.98',
    date: '2026-07-14T12:00:00Z',
    title: 'v2.5.98 — every meeting ends with a summary and the things to make next',
    tag: 'feature',
    summary:
      'When a meeting or call ends, PlexiDesk now offers you a summary of the conversation and the deliverables that came out of it, ready to create with one click. It records the call, writes a grounded summary, and proposes the tasks, documents, spreadsheets, decks and research notes that the conversation actually called for, so the work that was agreed turns into real things in your workspace instead of slipping away. The summary and every suggestion are drawn only from what was said, never invented, and if there is no AI key set it tells you plainly rather than guessing.',
    highlights: [
      'A summary at the end of every meeting and call, written from the actual conversation.',
      'One-click deliverables: turn what was agreed into tasks, documents, spreadsheets, slide decks and research notes without retyping it.',
      'Honest by design: nothing is summarised or proposed that was not said, and a missing key or empty call shows a clear message instead of a made-up result.'
    ]
  },
  {
    version: '2.5.97',
    date: '2026-07-13T12:00:00Z',
    title: 'v2.5.97 — video messages',
    tag: 'feature',
    summary:
      'Video messages are now a first-class attachment in chat. Drop a video file into a conversation and it plays inline rather than downloading as a generic file, and in PlexiMeet the "record a message for a teammate who is away" option now records a short video, like a quick Loom, falling back to a voice note only when there is no camera. The message streams from your own server with nothing sent to a third party.',
    highlights: [
      'Send and play video in chat: video files attach as a video message and play inline, alongside the existing photo, voice note, GIF and file attachments.',
      'PlexiMeet record-a-message is now video: leave a short video for a teammate who is away, with an automatic fall back to a voice note when no camera is available.'
    ]
  },
  {
    version: '2.5.96',
    date: '2026-07-12T12:00:00Z',
    title: 'v2.5.96 — real projects, live meetings, and create anything from anywhere',
    tag: 'feature',
    summary:
      'A big one for getting work done. Projects is now a proper planner you can run, not just look at: add and manage tasks, drag them on the timeline to reschedule, set what blocks what in both directions, and open a task to its files. PlexiMeet becomes a live meeting tool, start a meeting and invite teammates who are online, with recording kept as one option, including leaving a quick voice message for someone who is away, rather than the whole feature. And every module now opens to a real home with your recent items instead of a blank screen, while a new quick-create lets you make a project, report, flow, form, app or meeting straight from the command palette without hunting for a New button.',
    highlights: [
      'Projects you can actually run: add, rename and delete tasks, drag a bar to reschedule it, set predecessors and successors, and jump from a task to its files. Built on the existing critical-path engine.',
      'PlexiMeet live meetings: start a meeting and invite teammates who are online, like a quick Meet or Zoom call. Recording is now one option, including recording a short message to send to someone who is away.',
      'Module home dashboards: Reports, Flows, Forms, Build and Meet open to overview tiles and your recent items, with sections you can show or hide, instead of an empty create-only screen.',
      'Create anything from anywhere: the command palette now has New project, report, flow, form, app and Start a meeting, which create and open the item in one step.'
    ]
  },
  {
    version: '2.5.95',
    date: '2026-07-05T12:00:00Z',
    title: 'v2.5.95 — readable at any size, an honest privacy switch, and help where you can find it',
    tag: 'polish',
    summary:
      'Accessibility and trust. You can now set the text size for the whole app, the same way your browser zooms, so the menus, lists and buttons are comfortable to read rather than squinting at tiny grey text. The privacy switch is now honest and real: you can turn off anonymous usage sharing and it genuinely stops, and the sign-in screen now describes plainly what is and is not collected. And there is now a Help and support section in Settings with the guides and pricing, so help is findable instead of hidden.',
    highlights: [
      'Text size for the whole app: choose Small through Largest in Settings under Appearance, and every menu, list, label and button scales together, like your browser’s zoom. Your choice is remembered.',
      'An honest, working privacy switch: turn off "Share anonymous usage data" in Settings and it actually stops. We collect only anonymous, aggregate usage, never the contents of your documents or messages, and no third-party trackers.',
      'Help where you can find it: a Help and support section in Settings links to the guides and to plans and pricing, with a plain note on what stays on your device and what does not.'
    ]
  },
  {
    version: '2.5.94',
    date: '2026-07-04T12:00:00Z',
    title: 'v2.5.94 — single sign-on, and groundwork for running at scale',
    tag: 'feature',
    summary:
      'Enterprise sign-on and the plumbing to grow. Organizations can now connect single sign-on through WorkOS: an admin sets their connection and email domain in the admin console, and their team signs in with the company identity provider straight from the sign-in screen. Until a workspace turns it on, the option simply says it is not enabled rather than getting in the way. Under the hood this release also lays the groundwork for running the service across multiple servers, so presence and real-time messaging stay correct as the user base grows; that is invisible today and switches on when the backing services are provisioned.',
    highlights: [
      'Sign in with SSO: from the sign-in screen, enter your work email and authenticate with your company identity provider (via WorkOS). New people are placed into the right organization automatically.',
      'SSO admin setup: organization owners and admins configure their WorkOS connection and email domain in the admin console, with a clear status showing whether SSO is active.',
      'Scale groundwork: the real-time layer (presence and message delivery) can now run across multiple server instances. This is invisible in normal use and activates when the backing infrastructure is in place.'
    ]
  },
  {
    version: '2.5.93',
    date: '2026-07-03T12:00:00Z',
    title: 'v2.5.93 — your spreadsheets, slides and documents survive the trip to Office',
    tag: 'feature',
    summary:
      'Export fidelity, so a file you send to someone on real Microsoft Office looks the way you made it. Spreadsheets now keep their visual formatting on export, bold cells, fills, text colour, alignment, number formats like currency and percent, frozen panes and column widths, not just the raw numbers. Slides keep element rotation, drop shadows and rounded corners. And Word exports come out as a proper document with a real font, one-inch margins, page numbers and visible table borders. The earlier loss of formatting when a file left Plexii was the fastest way to look unprofessional; this fixes it.',
    highlights: [
      'Spreadsheets export with their formatting intact: bold, fills, text colour and alignment, number formats (currency, percent, dates), frozen panes and column widths all carry into Excel, where before only the values came across.',
      'Slides keep their design on export: an element that is rotated, has a drop shadow, or has rounded corners now exports to PowerPoint that way instead of flattening to a plain box.',
      'Word exports look like real documents: a proper base font and margins, page numbers in the footer, and visible table borders so a table is not an invisible grid.'
    ]
  },
  {
    version: '2.5.92',
    date: '2026-07-02T12:00:00Z',
    title: 'v2.5.92 — your workspace follows you, an audit log you can read, and flows that talk to the world',
    tag: 'feature',
    summary:
      'Three foundations for working across devices and with other tools. Your own tasks and canvas widgets now sync across the devices you sign in on, so a second machine no longer starts empty. Organization admins get a readable audit log, including who signed in and who changed roles, the record an auditor asks for. And PlexiFlow can now reach outside Plexii: a flow can call any webhook or API, and an incoming webhook can trigger a flow, so a completed task can post to Slack and an outside event can start an automation.',
    highlights: [
      'Multi-device sync: the tasks and canvas widgets in your personal workspace now follow you across the devices you sign in on, syncing in the background. Changes merge with last-write-wins and deletes propagate, so your second machine stays in step instead of starting blank.',
      'A readable audit log: the organization admin console now shows the audit trail, membership and role changes plus sign-in, sign-out, password-reset and two-factor activity, each as a clear "when, who, what" line for admins.',
      'Flows that talk to the world: a new "call a webhook / API" step lets a flow POST to Slack, Stripe, or any service (with headers and a JSON body), and a new webhook trigger runs a flow when its URL is called. A failed call shows the real HTTP status rather than a fake success.'
    ]
  },
  {
    version: '2.5.91',
    date: '2026-06-30T12:00:00Z',
    title: 'v2.5.91 — a richer chat: attachments, voice notes, emoji, GIFs, edits, and pin-to-desk',
    tag: 'feature',
    summary:
      'PlexiChat grows up. You can now attach a file or image to a message, record and send a voice note, drop in an emoji from a built-in picker, and search for a GIF. Sent the wrong thing or made a typo? Edit or delete your own messages, with edits and deletions showing up live for everyone. Start a meeting straight from a conversation with the new Meet button, and pin a conversation to your desk as a live widget so an important thread sits right next to your work. Attachments are private to the conversation they are shared in.',
    highlights: [
      'Attachments, voice notes, emoji and GIFs: attach a file or image, record a voice note, add an emoji, or search a GIF, all from the message composer. Images and GIFs show inline, files as a download chip, voice notes as a player. Attachments are scoped to their conversation so only its members can open them.',
      'Edit and delete your messages: fix a typo or remove a message you sent. Edited messages show an "edited" marker and deletions leave a quiet "message was deleted" placeholder, both updating live for everyone in the conversation.',
      'Meet and pin from a conversation: the Meet button opens PlexiMeet in one click, and the pin button drops the conversation onto your current desk as a live widget that shows the latest messages with a one-click Open.',
      'GIF search uses Google Tenor and needs a free API key, added in Settings under API keys. Without a key the GIF picker says so plainly rather than showing anything fake.'
    ]
  },
  {
    version: '2.5.90',
    date: '2026-06-29T12:00:00Z',
    title: 'v2.5.90 — two-factor sign-in, desktop alerts, an assistant that acts, and real automation',
    tag: 'feature',
    summary:
      'Five things land together. You can turn on two-factor authentication for your account, so a new sign-in needs a code from your authenticator app, with recovery codes if you lose it. The app now raises desktop notifications for a new message, a knock, or an incoming call, so you no longer miss them when the window is in the background. The assistant can now act on your work, not just create new things: it can mark a task done, change its due date or title, and save a fact to PlexiBrain, all through the same approve-each-card flow. PlexiFlow gained event triggers so a flow can run automatically when a task is completed or a row is added, and scheduled flows and reports now run on their own in the background instead of only when you have that screen open.',
    highlights: [
      'Two-factor authentication: turn it on from Settings, confirm a code from your authenticator app, and keep the one-time recovery codes. After that a new sign-in asks for a code. It is your choice and off by default.',
      'Desktop notifications: a new message, a knock, or an incoming call now raises an OS notification when the app is in the background, and clicking it brings the app forward and opens the right place. You never get a banner for the conversation you are already reading.',
      'An assistant that acts: ask it to mark the current task done, push its due date, rename it, or remember a fact, and it proposes the change as a card you approve. Saved knowledge always comes from what was actually said, never invented.',
      'Real automation: PlexiFlow can now trigger when a task is completed or a table row is added, not just manually or on a schedule, and scheduled flows and reports run in the background so a daily digest actually fires whether or not you have the Flow screen open.'
    ]
  },
  {
    version: '2.5.89',
    date: '2026-06-28T12:00:00Z',
    title: 'v2.5.89 — appear offline, a roomier workspace, and a calmer home',
    tag: 'feature',
    summary:
      'A privacy control and a design pass. You can now appear offline from the Team panel: your team sees you as offline while you still see everyone, no admin can override it, and a hidden session is not logged. The workspace also got roomier and calmer: a slimmer side menu grouped into clear sections, a wider canvas, calmer product icons, and a clearer split between Build (which makes tools for you) and the Assistant (which helps you think through a task).',
    highlights: [
      'Appear offline: one toggle in the Team panel hides you from the People Map and team presence while you stay connected and can still reach and be reached by everyone. It is your call, no admin can override it, and while hidden nothing about your session is recorded.',
      'A roomier workspace: the side menu is slimmer by default and grouped into labelled sections (Workspace, Knowledge, Create and meet, Work, Files, Team and more) so it is scannable instead of one long list, and the main canvas is wider. Long labels wrap instead of being cut off.',
      'A calmer, clearer home: product icons are unified and quieter so the grid reads as one set, the assistant panel opens with starter suggestions instead of empty space, and the AI builder is now clearly labelled "Build" so it is no longer confused with the task Assistant.'
    ]
  },
  {
    version: '2.5.88',
    date: '2026-06-27T22:00:00Z',
    title: 'v2.5.88 — PlexiPeople: reach anyone in a click, and edit your org chart',
    tag: 'feature',
    summary:
      'The People Map becomes the live front door to your organization. Knock to reach a teammate, message or call them from wherever you see them, and read the room with a new Collaboration view that shows who is reachable now, follow-the-sun handoffs and people isolated by time zone. The world map is now interactive, and admins can edit the org chart directly: drag to change reporting lines, add dotted-line relationships, and give people a photo.',
    highlights: [
      'Reach anyone in a click: a message, knock and call cluster on every teammate across the map, with an after-hours warning so you think twice before knocking someone at 2am. A knock lands as a notification they can answer by replying or calling back.',
      'Collaboration view: a new People Map tab with real team-rhythm insights computed from working hours, time zones and live presence. Who is reachable right now, follow-the-sun handoffs between someone wrapping up and a teammate just starting, suggested cross-team connections, and a supportive nudge for anyone isolated by time zone.',
      'Edit your org chart: owners and admins can drag a person onto another to change who they report to (loops are blocked), add dotted-line relationships for oversight, matrix, stakeholder and vendor links, and upload a profile photo. Click a world-map pin to open a person card with all the same actions.'
    ]
  },
  {
    version: '2.5.87',
    date: '2026-06-27T18:00:00Z',
    title: 'v2.5.87 — a real communication suite: live calls, Slack-class chat, threaded mail',
    tag: 'feature',
    summary:
      'PlexiDesk now talks. PlexiCam brings live video and audio calls you can start from a conversation or straight from a teammate on the People Map. PlexiChat grows into a full team chat with organization channels, emoji reactions, typing indicators and threaded replies, all in real time. And PlexiMail groups your inbox into conversations the way the best mail clients do, so a reply collapses into its thread instead of cluttering the list.',
    highlights: [
      'PlexiCam live calls: start a one-to-one video or audio call from a direct message or by clicking a teammate on the People Map. The call connects peer to peer and shows an honest status if your network cannot connect, rather than pretending it did.',
      'PlexiChat is now Slack-class: create and join named channels for your organization, react to messages with emoji, see when someone is typing, and reply in threads that keep the main conversation clean. Everything updates live across everyone in the conversation.',
      'PlexiMail conversations: the inbox groups related messages into threads using the mail reference graph and subject, with a count on each conversation, so a long back-and-forth reads as one row instead of twenty.'
    ]
  },
  {
    version: '2.5.86',
    date: '2026-06-27T12:00:00Z',
    title: 'v2.5.86 — PlexiSearch, PlexiProjects, and search that understands you',
    tag: 'feature',
    summary:
      'Two new products and a smarter search across the suite. PlexiSearch puts one box over your whole workspace and answers in plain language as well as links. PlexiProjects rolls your tasks up into a real Gantt plan with a critical path. And search now finds things by meaning, not just matching words, across PlexiBrain and your documents.',
    highlights: [
      'PlexiSearch: one search across your tasks, documents, tables, files and knowledge, ranked by meaning, with a grounded plain-language answer above the links. Keyboard-first, so up and down move through results, Enter opens, and Cmd or Ctrl plus Enter asks for an answer.',
      'PlexiProjects: roll the tasks you already work in up into a project with dependencies, milestones and a Gantt timeline. A critical-path engine finds the chain that drives the finish date, flags work that has slipped, and reschedules the whole plan from real progress in one click.',
      'Meaning-based search everywhere: PlexiBrain and your documents now rank by semantic similarity blended with keywords, so "time off" finds an entry titled "annual leave". With no embedding key set it falls back to plain keyword search, so nothing breaks and nothing is faked.'
    ]
  },
  {
    version: '2.5.85',
    date: '2026-06-26T23:00:00Z',
    title: 'v2.5.85 — PlexiBrain search that understands what you mean',
    tag: 'feature',
    summary:
      'PlexiBrain now finds knowledge by meaning, not just matching words. Search for "time off" and an entry titled "annual leave policy" comes up, and the assistant grounds its answers in the same meaning-aware results. With no embedding key set it falls back to plain keyword search, so nothing breaks and nothing is faked.',
    highlights: [
      'Meaning-based search: PlexiBrain ranks entries by semantic similarity to your query, blended with keyword relevance, so related ideas surface even when the words differ. Set an embedding key in Settings and your knowledge is indexed in the background automatically.',
      'Better-grounded AI: when you ask your workspace a question, the assistant now retrieves the most relevant knowledge by meaning before answering, so its grounding is tighter and less literal.',
      'Honest fallback: with no embedding key configured, search and grounding stay on keyword matching exactly as before. No invented matches, no silent degradation, just the strongest signal available.'
    ]
  },
  {
    version: '2.5.84',
    date: '2026-06-26T22:00:00Z',
    title: 'v2.5.84 — PlexiSign, and one consistent look across the suite',
    tag: 'feature',
    summary:
      'Sign documents without leaving your workspace, and watch the whole suite settle into one design. PlexiSign collects signatures with a real audit trail, and PlexiBrain, PlexiMeet, PlexiBuild and PlexiForms now share the same look and adapt to every theme.',
    highlights: [
      'PlexiSign: create an agreement, collect typed or drawn signatures from a set of signers in order, and keep an append-only audit trail with a tamper-evident completion certificate. No per-envelope DocuSign bill, and it is now live in the launcher.',
      'One consistent look: PlexiBrain, PlexiMeet, PlexiBuild and PlexiForms were rebuilt onto the shared Plexii design system, so they feel like one product and read correctly in light, dark and the futuristic themes rather than each carrying its own colours.',
      'PlexiForms is live in the launcher too: design a form, fill it, and every response lands as a row in a real table you can chart in PlexiDash.'
    ]
  },
  {
    version: '2.5.83',
    date: '2026-06-26T18:00:00Z',
    title: 'v2.5.83 — People Map, live presence and the org directory',
    tag: 'feature',
    summary:
      'See your whole team on a living map. PlexiTeam places everyone by office and reporting line, shows their real local day and whether they are around right now, and is backed by a proper organization directory you set up once. PlexiMeet, PlexiBuild and PlexiForms also join the suite.',
    highlights: [
      'People Map: a new view that maps everyone in your organization three ways — by office, on a live world map with a real day/night line, and as a reporting hierarchy. Each person shows their local time, working-hours band and whether they are online, away, in focus or busy right now.',
      'Live presence: open PlexiDesk and the people you share an organization or team with can see you are around, and you see them. A Team button in the header shows who is online at a glance.',
      'Organization setup: define your company working hours, add offices and locations each with their own hours and time zone, and give each person a title, department, office and who they report to. The People Map reads all of it, so a London office on 9 to 5 and a remote teammate light up at the right local time.',
      'PlexiMeet, PlexiBuild and PlexiForms are now live in the suite.'
    ]
  },
  {
    version: '2.5.82',
    date: '2026-06-26T12:00:00Z',
    title: 'v2.5.82 — PlexiSuite home, PlexiDash charts, and PlexiBrain',
    tag: 'feature',
    summary:
      'A new home screen for the whole suite, charts and dashboards from your data, and a company knowledge base that grounds the AI in your own truth.',
    highlights: [
      'PlexiSuite home: a new launcher, now your default landing, that shows every product in the suite grouped and clearly marked. What is live is full colour and opens its own page; what is on the way is greyed with a badge you can upvote to push up the queue.',
      'PlexiDash: chart widgets (bar, line, area, pie and KPI) that read a table and update as its data does. Drop a few on a desk and you have a live dashboard, no exports, no separate BI tool.',
      'PlexiBrain: a company knowledge base where you curate what your team and your AI should remember, with tags, pinning and search. The assistant now grounds its answers in your knowledge as well as your documents.'
    ]
  },
  {
    version: '2.5.81',
    date: '2026-06-25T20:00:00Z',
    title: 'v2.5.81 — Tables feel like a real spreadsheet',
    tag: 'feature',
    summary:
      'Reorder columns and rows by dragging a grip handle, move between cells with the keyboard, and change a column\'s type after the fact. Plus a fix so the AI assistant text is readable on the dark and futuristic themes.',
    highlights: [
      'Drag to reorder: grab the grip on a column header to reorder columns, or the grip on a row to reorder rows. Column reordering used to silently fail on the canvas; it works now.',
      'Keyboard navigation: arrow keys move between cells, Tab and Shift+Tab step across and wrap to the next or previous row, Enter starts editing then commits and drops down, and Escape leaves editing and then clears the selection.',
      'Change a column\'s field type after you\'ve created it, with existing values carried across where they make sense (text, number and date) and reset cleanly where they don\'t.',
      'Fixed: the table AI assistant input showed black, near-invisible text on the dark and futuristic themes. It now uses a readable colour in every theme.'
    ]
  },
  {
    version: '2.5.80',
    date: '2026-06-25T12:00:00Z',
    title: 'v2.5.80 — Real-time co-editing, comments, and organizations',
    tag: 'feature',
    summary:
      'Documents, spreadsheets and slides now edit together live, with cursors and comments. Ask your workspace became a conversation. And a new Organization console lets you manage your team and share a document with everyone in it.',
    highlights: [
      'Real-time co-editing: open a shared document, spreadsheet or slide deck with someone and edit it at the same time, with each person\'s coloured cursor, automatic reconnect, and no more single-writer lock. Two people on different cells or different slides both keep their edits.',
      'Comments: select text in a shared document and start a thread, with replies, resolve, and a click-to-jump between the highlight and the panel.',
      'Ask your workspace is now a conversation: ask a follow-up and it remembers the thread, still answering only from your own documents with clickable sources, and can turn an answer into a real document or deck.',
      'Organizations: a new Organization area in the sidebar to create a company, invite people by email, and manage their roles, plus the ability to share a document with a whole organization so every member can open it.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.79',
    date: '2026-06-23T21:00:00Z',
    title: 'v2.5.79 — Ask your workspace',
    tag: 'feature',
    summary:
      'Ask a question and get an answer grounded in your own documents, with clickable sources, then turn it into a real document or deck. And every document now shows the others related to it.',
    highlights: [
      'Ask your workspace: the new Ask pill in PlexiOffice answers questions using only your own documents, shows the sources it drew from so you can check them, and says when it cannot find something rather than guessing.',
      'Turn an answer into a real, editable Document or Deck in one click, instead of a dead export.',
      'Related documents: open any document and the Related control surfaces the others that overlap it in content, found automatically with nothing to set up.',
      'Ask and create run on your own Anthropic key (add it in the office Settings gear); Related works without a key.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.78',
    date: '2026-06-23T20:00:00Z',
    title: 'v2.5.78 — Set your AI key in PlexiOffice',
    tag: 'fix',
    summary:
      'The standalone office app now has a settings gear for your Anthropic API key, so slides generation and the other AI features work even when shared credits are unavailable. Adding a document to a desk also lets you place an existing one.',
    highlights: [
      'PlexiOffice now has a Settings gear at the top of the sidebar for AI · API keys. Paste an Anthropic key from console.anthropic.com to turn on slides generation, document rewrites and Drive auto-filing. The office app keeps its own settings, separate from PlexiDesk.',
      'When AI credits are temporarily unavailable, the message now tells you to add your own key, instead of a cryptic "Credit mode is not available right now".',
      'Adding a Document, Spreadsheet or Slides to a desk from the palette now opens a chooser, so you can create a new one, import a real Office file, or search for and place an existing document, instead of always starting blank.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.77',
    date: '2026-06-23T18:00:00Z',
    title: 'v2.5.77 — Smart folders can search too',
    tag: 'feature',
    summary:
      'A smart folder can now combine tags with a search term, so a folder like "Acme invoices from Q2" filters by both the tags and the words at once.',
    highlights: [
      'Smart folders take an optional search term alongside their tags. A folder shows files that carry all of its tags and whose name or title matches the search, so you can pin a precise view like Acme invoices that mention a quarter. Either part can stand alone, a pure tag combination or a pure search.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.76',
    date: '2026-06-23T12:00:00Z',
    title: 'v2.5.76 — A Drive that files itself',
    tag: 'feature',
    summary:
      'The Drive stops being a filing cabinet. Tag anything, or let the AI read a file and suggest where it belongs, and a file can live in every place it relates to at once. Smart folders gather the right files automatically, and dragging a file onto a tag or a folder files it.',
    highlights: [
      'Tags that span the Drive: give a document or file a tag and it appears in that tag’s view alongside everything else that shares it, wherever each one physically sits. A file can carry several tags, because a thing relates to several things, so you stop having to pick one folder.',
      'AI auto-filing: open an item’s tags and the assistant reads it and proposes where it belongs, often several tags at once, each with a reason. It is suggest-only, so nothing is applied until you accept, and it proposes nothing rather than guessing when it cannot tell. Needs an Anthropic key in Settings.',
      'Smart folders: save a combination of tags as a folder that always shows every file carrying all of them, with nothing to refile.',
      'Drag to file: drop a file on a folder to move it, or on a tag or a smart folder to file it by meaning. The thing you drop onto decides what happens.',
      'The Drive notices unfiled items: when something is not filed yet, the Drive offers to suggest where it belongs, so the help comes to you. And dragging a file into a folder, which had stopped working, works again.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.75',
    date: '2026-06-22T12:00:00Z',
    title: 'v2.5.75 — A big editor upgrade across Docs, Slides, Sheets and Drive',
    tag: 'feature',
    summary:
      'A broad step toward an enterprise-grade office suite: the command palette now drives the editors, Docs gains a page view and a focus mode, Slides becomes Figma-grade with snapping, grouping, framing and cropping, spreadsheets gain dynamic array formulas and named ranges, Drive gets a Trash and search, and shared documents show who is collaborating.',
    highlights: [
      'Command palette everywhere: press Cmd+K inside a document or slide deck to run any formatting, layout or AI action by name. Docs also gain a focus mode that dims everything but the line you are writing, a live outline, a reading-time meter, regular-expression find and replace, and a page view with portrait and landscape.',
      'Slides, Figma-grade: drag elements and they snap to smart alignment guides; select several with a marquee, then group, align and distribute them; give shapes and images rounded corners, shadows and borders; crop an image with a real drag-handle editor; and let the AI redesign a slide in your theme with one click.',
      'Spreadsheets keep closing the gap with Google Sheets: 24 more functions including XLOOKUP, IFS, SWITCH, INDIRECT and regex; dynamic array formulas that spill across cells (UNIQUE, SORT, FILTER, SEQUENCE, TRANSPOSE); and named ranges, so a formula can read =SUM(Revenue) instead of a cell range.',
      'Drive gets safer and faster: deleting now moves items to a Trash you can restore from, and a search box finds files, folders and documents across every folder.',
      'See who you are working with: a shared document now shows a row of collaborator avatars in its header, with the person currently editing highlighted.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.74',
    date: '2026-06-21T18:30:00Z',
    title: 'v2.5.74 — PlexiOffice gets a Drive, sharing, and live collaboration',
    tag: 'feature',
    summary:
      'PlexiOffice now organises your work in folders and lets you share and collaborate: share a document or a whole folder by link, view shared work in a browser, import a shared folder, edit together live with check-out, and group people into teams.',
    highlights: [
      'Drive: PlexiOffice now has folders. Organise your documents, spreadsheets, slides, and maps into folders with breadcrumbs, and drag items to move them.',
      'Share by link: share a single document, or a whole folder, with a link (and an optional email invite). Anyone with the link can view it read-only in their browser, no sign-up needed.',
      'Import a shared folder: when a folder is shared so you can copy it, paste the link in your Drive to import an editable copy of the folder and its documents.',
      'Live collaboration: turn a document into a shared one and edit together. One person checks it out to edit while others see it live and read-only, with a one-click request to take over.',
      'Teams: create a team, add people by handle, and invite a whole team to a document at once.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.73',
    date: '2026-06-21T16:40:00Z',
    title: 'v2.5.73 — Readability fix in voice command proposals',
    tag: 'fix',
    summary:
      'The before/after diff on a voice command proposal now uses plain words instead of cryptic symbols, so an empty value reads as "(empty)" rather than a special character that could look broken.',
    highlights: [
      'Voice command proposal diffs show "(empty)" for an empty value, "x" between width and height, and "..." for trimmed text, instead of symbols that could render as a broken character or garble when copied.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.72',
    date: '2026-06-21T16:00:00Z',
    title: 'v2.5.72 — Spreadsheet filters, and PlexiOffice updates itself',
    tag: 'feature',
    summary:
      'Spreadsheets gain column filters, and the standalone PlexiOffice app now shows its version and updates itself the same way PlexiDesk does.',
    highlights: [
      'Column filters: turn on the filter from the toolbar to put funnels on your headers, then tick or untick values to hide and show rows. Hidden rows are only hidden from view; your data and every formula are untouched.',
      'PlexiOffice now has a version pill and update banner in its footer, so it checks for and installs updates just like PlexiDesk. Clicking the version checks for an update on demand.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.71',
    date: '2026-06-21T09:00:00Z',
    title: 'v2.5.71 — PlexiMaps diagrams + big spreadsheet upgrades',
    tag: 'feature',
    summary:
      'A new diagram and workflow tool called PlexiMaps joins your documents, sheets, and slides, and the spreadsheet takes a big step toward Google Sheets: conditional formatting, data validation with dropdowns, dozens of new functions including VLOOKUP, and references across tabs.',
    highlights: [
      'PlexiMaps: a Draw.io-style diagram and workflow editor. Build flowcharts, org charts, and mind maps with seven shapes, connectors you drag from any side, labels, colours, a minimap, and starter templates. Or describe a process in plain words and the AI lays out the whole diagram for you. It opens on its own, embeds on a desk, and syncs like any other document.',
      'Conditional formatting: paint cells by their value (greater than, between, contains, and more) over any range, with the true value left untouched.',
      'Data validation: restrict a range to a list (with an in-cell dropdown), a number rule, or non-empty text, and optionally reject invalid entries on the spot.',
      'About 35 new spreadsheet functions: VLOOKUP, HLOOKUP, INDEX, MATCH, SUMIFS, COUNTIFS, AVERAGEIFS, SUMPRODUCT, MEDIAN, STDEV, FIND, SUBSTITUTE, TEXTJOIN, YEAR/MONTH/DAY, and more. A lookup that misses shows #ERR, never a made-up value.',
      'Cross-sheet references: a formula can read another tab, e.g. =’Sheet 2’!A1 or =SUM(Data!B1:B20), and autofill keeps the tab name as it shifts the cells.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.70',
    date: '2026-06-20T09:00:00Z',
    title: 'v2.5.70 — Spreadsheet power editing: fill handle, bulk paste, AI formulas',
    tag: 'feature',
    summary:
      'The spreadsheet now works the way Excel and Google Sheets do: drag the fill handle to extend series and formulas, double-click it to fill to the end of your data, paste across a whole selection, and ask the AI to write a formula for you. Tables gain the same bulk paste across selected cells.',
    highlights: [
      'Fill handle: drag the small square at the selection corner to copy a value, continue a series (numbers, dates, months, weekdays, "Item 1, Item 2"), or fill a formula with its references shifting per row. Double-click it to fill down to the end of the neighbouring data.',
      'Bulk apply: paste one value across a whole highlighted range, or a block that tiles to fit. Ctrl+Enter fills the selection from the active cell; Ctrl+D and Ctrl+R fill down and right. Copied formulas adjust their references; absolute $refs stay pinned.',
      'After a numeric fill, a Copy/Series toggle lets you switch how it filled, just like Excel.',
      'AI formulas: click the AI button on the formula bar, describe what you want in plain words, and it writes the formula, explains it, and can add the columns or tabs the calculation needs, all previewed before it touches the sheet. A formula it can’t actually run is never inserted.',
      'Tables: drag to highlight cells, copy them, and bulk-paste a value or a block across the selection, coerced to each column’s type.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.69',
    date: '2026-06-20T05:00:00Z',
    title: 'v2.5.69 — Build spreadsheets with AI in two steps',
    tag: 'feature',
    summary:
      'Spreadsheet AI now works like the tables assistant: it designs your columns first, then fills the rows to fit them. There is no longer a cap on how many columns or rows it can add, so big sheets just work.',
    highlights: [
      'Two-step AI build: describe your data, the AI proposes columns you can rename, add, or remove, then it generates rows that match those exact columns.',
      'No row or column limit. Large sheets are generated in batches behind the scenes, so a big request no longer fails partway with an error.',
      'Already have headers? Use them and skip straight to row generation. Every result is previewed before it writes, and formulas still compute for real.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.68',
    date: '2026-06-20T03:00:00Z',
    title: 'v2.5.68 — Spreadsheet AI fill fix',
    tag: 'fix',
    summary:
      'Filling a spreadsheet range with AI no longer fails with a “no JSON object” error, and large fills give a clear message instead of breaking.',
    highlights: [
      'AI spreadsheet fill now reads the result reliably however the model returns it, fixing the “AI generation error: No JSON object in response”.',
      'If a requested range is too large to fill in one go, you get a plain “try fewer rows” message instead of an error.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.67',
    date: '2026-06-20T01:00:00Z',
    title: 'v2.5.67 — Tidy canvases and focus insights',
    tag: 'feature',
    summary:
      'Line up and space out widgets neatly, optionally snap them to a grid, and see an honest picture of when and where you actually focus.',
    highlights: [
      'Select two or more widgets and the toolbar gains Align (left/centre/right/top/middle/bottom); select three or more and you can Distribute them with equal gaps — each in a single undo.',
      'Optional snap-to-grid rounds a dragged widget to a neat 8px grid; toggle it from Cmd-K → “Snap to grid”.',
      'A new Insights view in the sidebar shows your real focus sessions — focused time, your best hours of the day, where your focus went, and what to work on now based on your energy. Nothing is made up; it fills in as you use focus sessions.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.66',
    date: '2026-06-19T23:00:00Z',
    title: 'v2.5.66 — Find anything, and start from a template',
    tag: 'feature',
    summary:
      'Press Cmd-K to search the contents of your whole workspace, and start a new desk from a ready-made template instead of a blank canvas.',
    highlights: [
      'Cmd-K now searches everything — the words inside your notes, pages, documents, table rows and file names, not just titles — and jumps you straight to the match.',
      'Creating a task now offers built-in starters (Daily Focus, Project Hub, Research, Writing, Weekly Plan, Brainstorm) that drop in a ready-to-use desk in one click; your own saved templates sit alongside them.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.65',
    date: '2026-06-19T21:30:00Z',
    title: 'v2.5.65 — A home for your Collaborations',
    tag: 'feature',
    summary:
      'Everything shared live with you now has its own place in the sidebar, the way PlexiInbox and Documents do.',
    highlights: [
      'New Collaborations section in the sidebar lists every desk, folder and document shared live with you, newest first, showing its type and whether someone is editing it right now.',
      'Click any of them to jump straight into the shared editor; the section stays highlighted while you work inside a live item.',
      'Live shares no longer also appear inside Documents, so each shared thing has exactly one home.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.64',
    date: '2026-06-19T20:00:00Z',
    title: 'v2.5.64 — Two-way chat, openable shared items, and tidier widgets',
    tag: 'fix',
    summary:
      'Replies now work both ways in chat, shared items in PlexiInbox open when you click them, widgets are created at sensible sizes and scroll instead of clipping, and a few overlapping controls were cleaned up.',
    highlights: [
      'Chat works both ways now — when you open a conversation from PlexiInbox you can reply straight away.',
      'Shared folders, tasks and tools in PlexiInbox open when you click them instead of doing nothing.',
      'New widgets start at a size that suits them (calculator, colour and timer are smaller, notes roomier) and scroll rather than clip when content outgrows them; Tidy now keeps linked tools side by side so connector lines stay short.',
      'Cleaned up overlapping controls: the widget toolbar and the voice button no longer sit on top of other things, and on Mac the window buttons no longer cover the sidebar toggle.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.63',
    date: '2026-06-19T18:00:00Z',
    title: 'v2.5.63 — Command palette, canvas panning and widget shortcuts',
    tag: 'feature',
    summary:
      'Press Cmd-K to search and run anything, pan the canvas with the space bar or middle mouse, drag to select, and add common widgets with a single key.',
    highlights: [
      'Cmd-K opens a command palette that lists everything — jump to any desk, document or view, and add any widget — with its keyboard shortcut shown; start typing to filter, or scroll the full list.',
      'Hold the space bar and drag, or drag with the middle mouse button, to pan the canvas; drag on empty space to rubber-band select widgets.',
      'Add the common widgets with one key on a desk: S sticky, N note, P page, M markdown, T table, B browser, C calculator, I timer, O colour, R section, G shape, D card.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.62',
    date: '2026-06-19T16:00:00Z',
    title: 'v2.5.62 — Collaborate live on desks and folders',
    tag: 'feature',
    summary:
      'Live collaboration now covers whole desks and whole folders, not just documents. Share a desk or a folder and the same check-out model keeps everyone out of each other’s way while you work together.',
    highlights: [
      'Right-click a desk and choose Collaborate live to share the whole board — widgets, their connector links, sections and table data.',
      'Right-click a folder in Files and choose Collaborate live to share it — its files travel to the people you share with, and documents come across ready to open.',
      'Whoever checks something out edits it live; everyone else sees who is editing and can request access, and the takeover hands editing over without losing work.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.61',
    date: '2026-06-19T14:00:00Z',
    title: 'v2.5.61 — Undo for table rows',
    tag: 'feature',
    summary:
      'Adding, deleting and importing table rows can now be undone with Cmd-Z, and a whole import is a single undo step.',
    highlights: [
      'Add or delete a row and Cmd-Z reverses it; deleting a row offers an Undo on the toast.',
      'Importing a spreadsheet or letting AI fill a table is one undo step, not one per row.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.60',
    date: '2026-06-19T13:00:00Z',
    title: 'v2.5.60 — Undo a whole AI change at once',
    tag: 'feature',
    summary:
      'When the AI applies a batch of changes, one Cmd-Z (or one Undo) now reverses the whole batch, and bulk deletes ask first.',
    highlights: [
      'Apply all from an AI suggestion is now a single undo step instead of undoing each change one by one.',
      'If an AI batch would delete things, it asks for confirmation first, and you can still undo afterwards.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.59',
    date: '2026-06-19T11:30:00Z',
    title: 'v2.5.59 — Undo on the canvas',
    tag: 'feature',
    summary:
      'Cmd-Z now reverses canvas actions too — adding, moving, resizing, recolouring and deleting widgets.',
    highlights: [
      'Undo and redo widget changes with Cmd-Z / Cmd-Shift-Z, including a one-step undo for moving a whole selection.',
      'Deleting a widget is recoverable now: it comes back with its connector lines intact, and there is an Undo on the toast.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.58',
    date: '2026-06-19T10:30:00Z',
    title: 'v2.5.58 — Undo for tasks and folders',
    tag: 'feature',
    summary:
      'Press Cmd-Z to undo creating, renaming, moving or deleting a task or folder — and a deleted folder comes back with everything inside it.',
    highlights: [
      'Cmd-Z (and Cmd-Shift-Z to redo) now reverse task and folder changes, with an Undo button on the toast after a delete.',
      'Deleting is now recoverable: a removed folder restores with all its tasks and their contents intact, not gone for good.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.57',
    date: '2026-06-19T09:00:00Z',
    title: 'v2.5.57 — Cleaner document adds on the canvas',
    tag: 'fix',
    summary:
      'Adding a document, spreadsheet or slides to a workspace now offers the real built-in editors, grouped together.',
    highlights: [
      'The right-click Add menu and the + Widget palette now list Document, Spreadsheet and Slides together under Files, using the built-in editors.',
      'Removed the leftover Google Docs/Sheets/Slides add entries that had been showing by mistake; pasting a Google link still works.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.56',
    date: '2026-06-19T08:00:00Z',
    title: 'v2.5.56 — Work on a document together, safely',
    tag: 'feature',
    summary:
      'Share a document live and edit it as a team, with a clear check-out so two people never clobber each other.',
    highlights: [
      'Use Collaborate on a document to share it live; whoever opens it checks it out and edits, while others see "Editing — locked by …" and can keep reading along as changes appear.',
      'Need it yourself? Request access and the current editor gets a note in PlexiInbox to hand over or decline, so editing passes cleanly from one person to the next.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.55',
    date: '2026-06-19T05:30:00Z',
    title: 'v2.5.55 — PlexiInbox separates notifications from email',
    tag: 'polish',
    summary:
      'Your Inbox is now PlexiInbox, just your PlexiDesk notifications, with email kept in Mail.',
    highlights: [
      'PlexiInbox shows only internal notifications: chat messages, items shared with you (folders, files, canvases and widgets), and contact requests.',
      'Email no longer mixes into it and stays in Mail, so the two are cleanly separated.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.54',
    date: '2026-06-19T04:30:00Z',
    title: 'v2.5.54 — A friendlier welcome and more undo',
    tag: 'polish',
    summary:
      'New users get a quick tour of every area, and undo reaches more places.',
    highlights: [
      'First-run onboarding now shows a short map of the app: Home and tasks, Documents, Files, Calendar, Mail and Vault.',
      'Slides gain proper redo with toolbar buttons, and the Files area gets full undo and redo — including a recoverable delete, so nothing disappears by accident.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.53',
    date: '2026-06-19T03:00:00Z',
    title: 'v2.5.53 — A real file and folder manager',
    tag: 'feature',
    summary:
      'A new Files area to organise everything in folders, with several view modes and proper sorting.',
    highlights: [
      'Create and nest folders, drag things between them, and import files of any kind alongside your own documents, sheets and slides.',
      'Switch between list and three icon views, see thumbnails where the system can make them, and sort by name, type, size or date with a click.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.52',
    date: '2026-06-19T01:30:00Z',
    title: 'v2.5.52 — Apply a style across a whole document',
    tag: 'feature',
    summary:
      'Format one piece of text, then push that exact style to the entire document in one step.',
    highlights: [
      'Select styled text and use the new paint-roller in the formatting bubble to apply its bold, colour, font, size and more across the whole document.',
      'A confirmation lists exactly what will change first, and the whole thing undoes in a single step.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.51',
    date: '2026-06-19T00:30:00Z',
    title: 'v2.5.51 — Slide templates and better image handling',
    tag: 'feature',
    summary:
      'Build slides faster with a gallery of starter templates, and place images that keep their shape.',
    highlights: [
      'Adding a slide opens a gallery of ready-made templates (cover, agenda, comparison, big number, quote, image and caption, closing and more), each shown as a live preview in your theme.',
      'Images now arrive at their true proportions, show resize handles like a shape, can keep their aspect ratio while resizing, and offer fit options to show all, crop or stretch.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.50',
    date: '2026-06-18T23:30:00Z',
    title: 'v2.5.50 — Spreadsheet formulas the easy way',
    tag: 'feature',
    summary:
      'Typing = in a cell now suggests functions, and you can click cells to build references instead of typing them.',
    highlights: [
      'Type = and a function menu appears with SUM, AVERAGE, IF and more, each with a short hint; filter as you type and pick it with a click or the keyboard.',
      'While writing a formula, click a cell to drop its reference, or drag across a range to insert something like A1:A3, then carry on typing.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.49',
    date: '2026-06-18T22:00:00Z',
    title: 'v2.5.49 — Turn an email into a real task',
    tag: 'feature',
    summary:
      'Making a task from an email now asks where it should go, when it is due, and how urgent it is, and files it properly.',
    highlights: [
      'The Make a task button on an email opens a quick dialog: choose All Tasks, an existing folder or task, or create a new folder on the spot.',
      'Set a due date and an urgency, and the task is created for real, showing in All Tasks and inside the folder you picked, with the sender and a snippet kept.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.48',
    date: '2026-06-18T20:00:00Z',
    title: 'v2.5.48 — Lists that work, one Styles menu, and Google Fonts',
    tag: 'feature',
    summary:
      'Bulleted and numbered lists now render properly in documents, document styles live in one clear menu, and you can choose from the full Google Fonts library across documents, spreadsheets and slides.',
    highlights: [
      'Fixed bulleted and numbered lists in documents, which were not showing their markers or indentation. Headings, quotes and code blocks also render correctly now.',
      'One Styles menu in the document toolbar: apply Normal text, Title, Headings, bulleted / numbered / checklist, quote, code or a hyperlink, and customise each heading level in the same place.',
      'A searchable Google Fonts picker in documents, spreadsheets (per cell) and slides, with fonts loaded on demand.',
      'Slides: turn a text box into a bulleted or numbered list. Documents, spreadsheets and slides placed on a canvas now keep their own right-click menus.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.47',
    date: '2026-06-18T18:00:00Z',
    title: 'v2.5.47 — Heading styles you can actually control',
    tag: 'feature',
    summary:
      'A clear Styles panel for documents. Define what each heading level looks like in one place, and every heading of that level follows.',
    highlights: [
      'A new Styles button in the document toolbar opens a panel with Normal text and Heading 1, 2 and 3. Click a name to apply it, and set its bold, italic, size and colour right there.',
      'Change a level once, for example Heading 2 to bold blue at 18, and every Heading 2 in the document updates to match. The level style now wins even on headings you had already tweaked by hand.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.46',
    date: '2026-06-18T16:00:00Z',
    title: 'v2.5.46 — Documents on the canvas, better sheets and headings',
    tag: 'feature',
    summary:
      'Documents, spreadsheets and slides can now live right on a canvas, spreadsheets got real formula fixes, and headings can be styled once and applied everywhere.',
    highlights: [
      'Put a document, spreadsheet or slide deck on any canvas as a native widget. Adding one lets you create a new one, import a real Word/Excel/PowerPoint file with its formatting and formulas kept, or place an existing one. The same file opens both on the canvas and in the Documents view.',
      'Spreadsheets: fixed a bug where the first keystroke in a cell was doubled, which also quietly broke formulas. Formulas now work as you expect, type = and go. Select the whole sheet with Cmd/Ctrl+A to format every cell at once, and right-click a column header to insert or delete columns.',
      'Documents: set a heading style once, for example Heading 2 at a certain size and colour, and every Heading 2 in the document updates to match.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.45',
    date: '2026-06-18T10:00:00Z',
    title: 'v2.5.45 — Documents reliability fix',
    tag: 'fix',
    summary:
      'A packaging fix for the new Office editors. The 2.5.44 build could fail to start on some installs because a document-export library was missing a dependency; that library now loads only when you actually export, so the app always starts, and the export dependency ships correctly.',
    highlights: [
      'Fixed an app-start crash introduced with the new Word/Excel/PowerPoint editors.',
      'Document, spreadsheet and slide export libraries now load on demand, so an export problem can never stop the app from opening.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.44',
    date: '2026-06-18T08:00:00Z',
    title: 'v2.5.44 — Documents, drastically upgraded',
    tag: 'feature',
    summary:
      'The document, spreadsheet and slide editors grew up. Each is now a real, fully formatted editor with AI that inserts formatted content, and you can open and save genuine Word, Excel and PowerPoint files.',
    highlights: [
      'Documents are now Word-class: headings, colour, highlight, fonts and sizes, alignment, lists, links, images, tables, code blocks, find and replace, a selection menu and a slash menu. Ask AI drafts formatted content at your cursor and can rewrite a selection. Open .docx files and export to .docx or PDF.',
      'Spreadsheets are now Excel-class: cell formatting and number formats, multi-cell selection, copy and paste with real Excel, undo, sort, charts, multiple sheets, and a much bigger formula library (IF, COUNTIF, SUMIF, text functions and more) that still shows a clear #ERR instead of a wrong number. Import and export .xlsx and .csv, and let AI fill a range.',
      'Slides are now PowerPoint-class: a free canvas with movable text boxes, images and shapes, deck themes and layouts, a presenter view with notes and a timer, and AI that builds or redesigns a deck. Export to .pptx or PDF.',
      'Everything you already made still opens unchanged. Office file round-trips are best-effort, not pixel-perfect, and we say so in the app.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.43',
    date: '2026-06-17T00:30:00Z',
    title: 'v2.5.43 — Documents: create with AI, then make it yours',
    tag: 'feature',
    summary:
      'PlexiDesk now makes documents, spreadsheets and slides, and AI is how you start. Describe what you want and who it is for, and you get a real first draft already open for editing. No blank page to stare at.',
    highlights: [
      'Create with AI: in the new Documents area, pick a document, spreadsheet or deck, say what it is about and who it is for, and get a finished first draft you can edit straight away.',
      'A real editor for each: rich-text documents with formatting and an inline Ask AI, spreadsheets with live formulas (=SUM, =AVERAGE, cell references and ranges, with a clear #ERR rather than a wrong number), and slide decks with a present mode.',
      'Everything autosaves and lives in your workspace next to your tasks. Turn any of it into work, and start blank whenever you prefer the empty page.',
      'This is the first step of making AI the way you start, continue and finish work, not a bolt-on. More inline AI for sheets and slides, and sharing, are coming next.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.42',
    date: '2026-06-16T23:30:00Z',
    title: 'v2.5.42 — Your email, inside your workspace',
    tag: 'feature',
    summary:
      'PlexiDesk now has Mail. Connect any email account over IMAP and read your inbox right next to your work. No Google or Microsoft sign-in to set up; just your address and an app password, and your mail stays on your machine.',
    highlights: [
      'Connect in a minute: pick Gmail, Outlook, iCloud, Fastmail or Yahoo and the server settings fill in for you, or enter any IMAP host yourself. Your password is encrypted on this device with your OS keychain and never leaves it.',
      'A real inbox: read your messages in a clean two-pane view, with unread mail also flowing into the unified Inbox alongside your PlexiDesk messages and shared items.',
      'Turn an email into work: one click makes any message a task in All Tasks, with the sender and a snippet already filled in.',
      'This is plain IMAP for now. Connecting Gmail and Outlook with one-click sign-in is coming later; today it works with the app password those providers give you.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.41',
    date: '2026-06-16T22:30:00Z',
    title: 'v2.5.41 — Add people by email, and chat with anyone you share with',
    tag: 'feature',
    summary:
      'Connecting on PlexiDesk is now easy. Add someone by their email address, and chat appears with everyone you share a folder or task with once they accept.',
    highlights: [
      'Add by email: in Messages, enter an email instead of a handle. If they already use PlexiDesk it arrives as a request to accept in their inbox; if they don\'t, they get an invite to join, and once they sign up your request is waiting for them.',
      'Share, then chat: anyone you share a folder or task with shows up in your chat list after they accept, plus a shared conversation around that item so you can collaborate on it.',
      'Accept or decline contact requests right from your Inbox, and a direct message opens as soon as you accept.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.40',
    date: '2026-06-16T20:00:00Z',
    title: 'v2.5.40 — Messages and a unified Inbox',
    tag: 'feature',
    summary:
      'PlexiDesk can now talk to other people. Sign in and message anyone by their handle, share a folder or task into a conversation to work on it together, and see everything that needs you — messages and shared items — in one Inbox.',
    highlights: [
      'Messages: find someone by @handle and start a direct message. Conversations sync in real time and keep their history, so you can pick up where you left off.',
      'Shared-space chat: when you accept a shared folder or task, everyone on it gets a conversation around it, so collaborating has a place to happen.',
      'Unified Inbox: a single feed of your messages and shared items, with unread counts in the sidebar. Email will join this same Inbox once you connect Gmail or Outlook.',
      'You need to be signed in to use messaging; everything else in PlexiDesk still works fully offline.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.39',
    date: '2026-06-16T16:00:00Z',
    title: 'v2.5.39 — Say hello to PlexiDesk',
    tag: 'feature',
    summary:
      'The app has a new name: PlexiDesk. Same product, same data, nothing for you to do. This release also makes the built-in browser work with far more sites, and lets you drag tasks straight onto the calendar.',
    highlights: [
      'New name, your data intact: FocusBuddy / Haptyx is now PlexiDesk. Your existing tasks, vault and settings carry over exactly as they were, and updates keep working as normal.',
      'The browser handles more of the web: it runs on a much newer engine, so you hit far fewer "verify you are human" checks, and menus that open a new tab — like Google Docs "open a file" — now work instead of doing nothing.',
      'Plan your day on the calendar: drag any task or folder onto the Week view to book time for it, and jump straight back to the task or folder from its calendar block.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.38',
    date: '2026-06-16T09:00:00Z',
    title: 'v2.5.38 — Book time to focus, and a warmer first run',
    tag: 'feature',
    summary:
      'The calendar can now run your day. Switch it to Week and book stretches of time to focus, tied to your tasks. New installs also get a short welcome that helps you connect AI and start with something on the canvas instead of a blank screen.',
    highlights: [
      'Calendar time-blocking: a new Week view with an hour grid. Click a slot to book a block, attach it to a task or leave it as focus time, drag to reschedule, drag the edge to change its length, and press the bolt to start a focus session for that block.',
      'First-run welcome: a brand-new install now gets a short, skippable setup — connect your AI key (with a one-tap test that it works) and optionally start with a small example workspace so the canvas isn’t empty.',
      'This is the groundwork for connecting your real calendar and email next, so PlexiDesk becomes the one place your day runs from.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.37',
    date: '2026-06-15T23:45:00Z',
    title: 'v2.5.37 — Back up your work, and change your vault password',
    tag: 'feature',
    summary:
      'Two pieces of peace of mind. You can now export a portable backup of everything and restore it later or on another machine, and the app quietly keeps automatic snapshots. The vault also gains a way to change your master password.',
    highlights: [
      'Backup and restore: export a single portable snapshot of all your work from Settings, and restore it later or on another machine. The app also keeps automatic snapshots in the background and rotates the last seven, so a mishap is recoverable.',
      'Restoring is careful: it snapshots your current data first, so even a restore you regret can be undone, and it asks before replacing anything.',
      'Vault: change your master password whenever you like. Every stored entry is safely re-encrypted under the new password in one step.',
      'A note on keys: API keys live in your system keychain, not in the backup file, so re-enter them after restoring on a new machine.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.36',
    date: '2026-06-15T23:30:00Z',
    title: 'v2.5.36 — The AI command bar understands you again',
    tag: 'fix',
    summary:
      'The "Ask AI" command bar was quietly sending your request down the wrong path, so it often missed your intent and fell back to a generic answer. It now classifies what you asked for reliably and routes you to the right build.',
    highlights: [
      'Typing a request into the command bar now correctly recognises whether you want a whole workspace, a few objects added to the current task, or a plain answer, instead of degrading to a generic reply.',
      'The classification runs on a fast, low-cost model so the command bar responds quickly.',
      'No change to how you use it: open with the header button, the canvas Ask AI button, or Cmd+Shift+K, type what you want, and confirm what it proposes.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.35',
    date: '2026-06-15T22:00:00Z',
    title: 'v2.5.35 — Gemstone theme, and clearer updates',
    tag: 'design',
    summary:
      'A new Gemstone theme inspired by emerald, ruby, sapphire, onyx and diamond. An onyx-black room with faceted glass, a soft drifting sparkle and prismatic light along every edge, all re-tinting to your chosen accent. This release also makes update problems explain themselves instead of failing silently.',
    highlights: [
      'Gemstone joins the base themes in the Theme studio: deep onyx ground, faceted surfaces, a whisper-soft sparkle and travelling spectral refraction on the header, sidebar and every widget.',
      'Two new gem accents, Ruby and Sapphire, sit beside Emerald. Gemstone re-tints its glow and refraction to whichever accent you pick, so the room recolours without changing shape.',
      'When an update cannot complete it now shows the real reason on screen rather than a bare failure, and always offers a one-click manual download so you are never stuck retrying the same error.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.34',
    date: '2026-06-15T20:00:00Z',
    title: 'v2.5.34 — More widgets grow to fit their content',
    tag: 'feature',
    summary:
      'Continuing the auto-sizing work, field widgets and task links now grow to fit their content too, alongside stickies and cards. The widgets that genuinely manage their own size keep doing so on purpose.',
    highlights: [
      'Field widgets and task links join stickies and cards in growing to fit their content rather than hiding it behind a scrollbar.',
      'The widgets that should keep a fixed size and scroll or pan are left that way deliberately: long-form notes, pages and markdown, the browser and embedded documents, media, tables, mind maps, diagrams and the agent chat.',
      'All of this runs on the one shared sizing mechanism, so a widget either grows consistently or keeps its own size — never a different behaviour in different places.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.33',
    date: '2026-06-15T18:00:00Z',
    title: 'v2.5.33 — Widgets grow to fit their content',
    tag: 'feature',
    summary:
      'Widgets now size themselves to their content instead of hiding it behind a scrollbar. This release turns it on for stickies and cards, built on a shared mechanism the other content widgets will adopt next. Long-form text (notes, pages, markdown) and the browser keep a fixed size and scroll, as before.',
    highlights: [
      'Stickies and cards grow taller as you add content and shrink back as you remove it, so you are not constantly resizing them by hand.',
      'Built on one shared sizing mechanism in the widget frame, so the remaining content widgets can adopt it consistently rather than each behaving differently.',
      'Notes, pages and markdown keep a fixed size and scroll their content, and browsers keep their chosen viewport — these are deliberately not auto-grown.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.32',
    date: '2026-06-15T14:00:00Z',
    title: 'v2.5.32 — Menu, camera and browser fixes',
    tag: 'fix',
    summary:
      'A batch of interaction fixes: right-click menus now close when you click away and no longer stack copies, clicking a widget no longer makes the canvas drift, double-clicking centres it again, and new browsers open at a sensible laptop size.',
    highlights: [
      'Right-click menus close when you click elsewhere, instead of needing the Esc key, and a second right-click repositions the one menu rather than stacking duplicates.',
      'Clicking a widget no longer shifts the canvas under you. To centre on a widget, double-click it; for a browser, double-click its title bar.',
      'New browser widgets open at laptop size (1366 × 768) so sites show their full desktop layout instead of a cramped mobile one. You can still snap to other sizes from the browser\'s size menu.',
      'Note, page and markdown widgets keep a fixed size and scroll when their content runs long.'
    ],
    links: [{ label: 'Right-click menus', href: `${HELP_BASE}/right-click-menus` }]
  },
  {
    version: '2.5.31',
    date: '2026-06-15T09:00:00Z',
    title: 'v2.5.31 — Set up with AI on empty widgets',
    tag: 'feature',
    summary:
      'Every empty widget now offers to set itself up. Drop a page, a browser, a sticky or a mind map and a quiet "Set up with AI" appears on it; click it and PlexiDesk proposes what that widget should become based on the task you are working on, for you to approve. This is the first step of a system that will cover every widget kind.',
    highlights: [
      'A "Set up with AI" prompt appears on an empty widget and disappears the moment it has real content.',
      'It is task-aware: it reads what you are working on and the other objects on your desk to propose something genuinely useful, which you approve before anything is written.',
      'Empty pages get a drafted document outline, and empty browsers get the most useful address to open. Empty stickies, notes, cards, mind maps and diagrams get their existing AI draft, now reachable without the right-click menu.',
      'Built on one shared setup framework so the remaining widget kinds (tables, sections and more) can join it next.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.30',
    date: '2026-06-14T23:30:00Z',
    title: 'v2.5.30 — One "Ask AI"',
    tag: 'design',
    summary:
      'There is now a single "Ask AI" everywhere — the header, the canvas toolbar, and Cmd+Shift+K all open the same command bar. Describing what you want now builds it on your desk in one flow, instead of preparing objects and then asking you to open a separate builder.',
    highlights: [
      'The canvas "Build with AI" button is now "Ask AI", and opens the same command bar as the header button and Cmd+Shift+K.',
      'Asking AI to add objects now hands them straight to the builder preview on your desk to pick and place, rather than a message telling you to open another builder.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.29',
    date: '2026-06-14T22:00:00Z',
    title: 'v2.5.29 — A clearer, more consistent interface',
    tag: 'design',
    summary:
      'First step of a UX clean-up. The create action is now an obvious accent "+ Widget" button, the two near-identical AI build buttons are merged into one, AI uses a single icon throughout, and collapsed side panels show a labelled tab instead of a bare arrow so you can tell what is hidden.',
    highlights: [
      'The toolbar\'s create action is now a clearly highlighted "+ Widget" button, in every theme, instead of a faint "+ Add".',
      'The two similar "Build with AI" and "AI Setup" buttons on the canvas are merged into a single "Build with AI". The task-scoped setup suggestions are still available from each task in the sidebar.',
      'AI is now shown with one consistent icon across the toolbar and AI controls.',
      'When the workspace or assistant panel is collapsed, the toggle now reads "Workspace" or "Assistant" instead of an ambiguous arrow.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.28',
    date: '2026-06-14T20:00:00Z',
    title: 'v2.5.28 — Working help links + recent improvements',
    tag: 'polish',
    summary:
      'The in-app Help and Support links now open the live help centre, and the recent improvements are gathered here in case you are coming from an older version. Hover the toolbar to learn the controls, and updating on Mac is now reliable.',
    highlights: [
      'The Help and Support link and the "Learn more" links now open the live help centre, instead of a web address that was not connected yet.',
      'Mac updates are reliable: updating prompts for your administrator password when needed and completes, and never loops on the old version.',
      'Hover tooltips on the top toolbar and AI controls explain what each one does, and a short What\'s new summary appears after each update.',
      'Right-click menus are contextual per object, and Build with AI works across more of them.'
    ],
    links: [
      { label: 'Finding your way around', href: `${HELP_BASE}/getting-around` },
      { label: 'Right-click menus', href: `${HELP_BASE}/right-click-menus` },
      { label: 'Sharing and invites', href: `${HELP_BASE}/sharing-and-invites` }
    ]
  },
  {
    version: '2.5.27',
    date: '2026-06-14T18:00:00Z',
    title: 'v2.5.27 — More reliable updates on Mac',
    tag: 'fix',
    summary:
      'Fixes a Mac update loop where the app would download an update, ask for permission, then reopen on the same old version and offer the update again. Updating now asks for your administrator password when it needs to, and if it still cannot replace the app in place, it sends you to the download page to install manually instead of looping.',
    highlights: [
      'Mac updates that need elevated permission now prompt for your administrator password and complete, instead of silently failing and reopening the old version.',
      'If PlexiDesk is running from a read-only or quarantined location (for example launched from Downloads), it now tells you to move it into Applications rather than trying an update that can never succeed.',
      'When an in-place update genuinely cannot be applied, the app opens the download page so you can install the new version by hand, rather than looping on the same version.'
    ],
    links: [{ label: 'Finding your way around', href: `${HELP_BASE}/getting-around` }]
  },
  {
    version: '2.5.26',
    date: '2026-06-14T12:00:00Z',
    title: 'v2.5.26 — In-app help, tooltips, and recent UX upgrades',
    tag: 'feature',
    summary:
      'This update makes PlexiDesk easier to learn as you go. Hover the toolbar and AI controls to see what each one does, get a short summary like this one after every update, and open the new help centre for step-by-step guides. It also gathers up the interface improvements from the last few releases so they are easy to find.',
    highlights: [
      'New: hover tooltips on the top toolbar and the AI controls explain what each button does, so you no longer have to guess from an icon.',
      'New: after every update, a short "What\'s new" summary like this one appears on first open, with links through to help articles.',
      'New: a help centre with guides for the features below, reachable from the footer\'s Help and Support link.',
      'Right-click menus are now genuinely contextual per object — a file offers Open and Copy URL, a colour offers Copy hex, a table offers Add row, and a section offers a layout choice, instead of one generic menu.',
      'Build with AI works on more objects — describe what you want and PlexiDesk drafts the contents for you to approve.',
      'Sharing a folder or task by email now tracks who you invited and whether they have opened it, visible to your admin.',
      'Updating on Mac is now a reliable one-click install from the footer.'
    ],
    links: [
      { label: 'Finding your way around', href: `${HELP_BASE}/getting-around` },
      { label: 'Right-click menus', href: `${HELP_BASE}/right-click-menus` },
      { label: 'Build with AI', href: `${HELP_BASE}/ai-assistant` },
      { label: 'Sharing and invites', href: `${HELP_BASE}/sharing-and-invites` }
    ]
  },
  {
    date: '2026-06-06T12:00:00Z',
    title: 'v2.5 — Shapes, Cards, Custom Blocks & multi-select',
    tag: 'feature',
    highlights: [
      'New widget — Custom Block: a WYSIWYG form/record designer. In Design mode, drop typed fields (text, paragraph, number, date, email, URL, dropdown, checkbox, heading, divider) and drag/resize each one where you want. In Use mode the same block is a live data-entry form. Save any layout as a personal Template reusable across every folder/task/canvas.',
      'New widget — Shapes: rectangle, rounded, ellipse, diamond, triangle, hexagon, star, line and arrow with fill, stroke, line weight and an optional centred label. Stretches as you resize.',
      'New widget — Cards: a titled callout with an accent bar, bold title and body + colour picker.',
      'Multi-select: Shift-click an object header or Shift-drag a marquee box to select many at once. Drag any selected object and the whole group moves together. Group the selection into a section, or duplicate / delete the lot. ⌘/Ctrl+A selects all, Esc clears.',
      'Browser windows get size presets — Mobile / Tablet / Tablet (landscape) / Laptop / Desktop — and resize instantly (no refresh).',
      '⌘/Ctrl-click any object while zoomed out dives straight to it at 100%, centred — now works for objects inside sections too. Drag an object out of a section to pop it back onto the desk.',
      'Duplicating now asks: keep the copy in sync (edits mirror) or make an independent copy.',
      'Fixes: the + Add toolbar and its menus no longer run off the edge on smaller / non-fullscreen windows; the right-click "Add object" menu scrolls and flips so every widget (incl. Diagram & Scratchpad) is reachable.'
    ]
  },
  {
    date: '2026-05-27T18:00:00Z',
    title: 'Build with AI — natural-language workspace builder',
    tag: 'feature',
    highlights: [
      'New ✨ "Build with AI" button on the canvas. Click → describe what you want to achieve in plain English ("Track my freelance clients", "Plan a podcast launch", "Run a book club") and Claude returns a set of suggested widgets, pre-configured.',
      'Each suggestion shows a "What I heard" interpretation banner so you can spot misunderstandings before spawning anything. Suggestion cards preview their contents — table columns appear as chips with their types, pages show their heading titles, fields show their type.',
      'Tick the suggestions you want, "Add N to canvas" → they land below your existing widgets, fully wired. Tables come with their schema pre-built (including single-select options with hex colors). Pages come with starter sections + a paragraph or todo list. Field widgets come typed and labeled.',
      'Knows every widget kind in the catalog — sticky, note, markdown, page, table, field (11 types: short/long/rich text, number, checkbox, single/multi-select, date, attachment, button, relation), file, webview, timer, calculator. Defensive filter in main drops any unknown kinds before they hit the renderer.',
      'Bottom bar: 5 example chips to seed your prompt if you don\'t know where to start.'
    ]
  },
  {
    date: '2026-05-27T17:00:00Z',
    title: 'Bug fixes — pages render, file previews, PDF page nav',
    tag: 'fix',
    highlights: [
      'Pages were a blank screen because the Tiptap editor used Tailwind `prose` classes that aren\'t styled in our build (no @tailwindcss/typography plugin). Swapped to the hand-rolled `md-rendered tiptap-editor` styles that MarkdownWidget already uses — same look, no missing plugin.',
      'File preview thumbnails weren\'t showing. Replaced the IPC + Blob URL pipeline with a custom `fb-file://` protocol registered in main: privileged scheme, supports Range requests, streams from disk. `<img>`, `<video>`, `<audio>`, `<iframe>` all just take a `fb-file://<id>` URL directly.',
      'Multi-page PDFs now have full page navigation. Swapped `<object>` to `<iframe>` — Chromium\'s built-in PDF viewer only exposes its toolbar (page nav, zoom, rotate, print) when loaded as a top-level frame document.',
      'New "Related records" field type — link rows from one table to rows of another. Pick the target table, pick which column to display on chips, toggle single-vs-multi. Lazily loads target rows on first picker open so cross-table relations don\'t fetch every canvas mount.',
      'Self-references prevented — a Tasks table\'s relation column won\'t list Tasks itself in the dropdown.'
    ]
  },
  {
    date: '2026-05-27T15:30:00Z',
    title: 'Rich widget suite — files, pages, tables, field widgets',
    tag: 'feature',
    highlights: [
      'Drop any file from Finder onto the canvas and it spawns a File widget with native preview: images (object-contain), PDFs (Chromium PDF viewer with page nav, zoom, print), video (`<video controls>`), audio (player + filename), generic files (download button). Files copy into PlexiDesk\'s userData so they survive moves of the original.',
      'New Page widget — Notion-style document on the canvas. Built on Tiptap (StarterKit + TaskList + Link). Type `/` anywhere for a slash menu with H1, H2, bullet list, numbered list, todo list, code block, quote, divider, and inline AI prompt. The AI prompt opens a small textarea; Cmd+Enter sends to Claude, the response inserts at your cursor.',
      'New Table widget — Airtable-style database. Add/delete rows, add/delete columns, rename inline. Column types: short text, long text, number, checkbox, single-select (with editable options + hex colors), multi-select, date, attachment (drops file into vault automatically), button (runs AI prompt or shell command — shell deferred until security review), relation. Auto-provisions its backing fb_tables row on first render so there\'s no "create table" step.',
      'New Field widget — drop a single typed field on the canvas. Same 11 types as table columns. Edit the label, the value, and per-type config (select options inline, button payload + action, relation target). Same renderer as table cells via the shared `FieldEditor` component — add a new field type in `shared/fields.ts` and it shows up everywhere automatically.',
      'New `fb_tables` + `fb_rows` + `fb_files` tables in SQLite. Schemas stored as JSON so we can add column types without DB migrations. All persisted locally, no cloud anything.'
    ]
  },
  {
    date: '2026-05-27T12:00:00Z',
    title: 'Local apps — launcher tiles for Mac apps',
    tag: 'feature',
    highlights: [
      'Connected Apps now supports local Mac apps, not just web URLs. Click + Add app → Local app tab → Choose app → pick anything from /Applications. The picker shows the app\'s real macOS icon, bundle id, and lets you set a display name.',
      'Each local app appears in the sidebar with its native icon (extracted via `nativeImage.createThumbnailFromPath` — bypasses an Electron 33 + macOS Sonoma crash in `app.getFileIcon`).',
      'Drag a local Connected App onto any task canvas → spawns a launcher tile bound to that app. Click the tile → launches if not running, focuses if running, unminimizes if dock-minimized, unhides if Cmd+H-hidden. Always brings you back to the app.',
      'The tile persists on the canvas regardless of the app\'s state — quit the real app, the tile stays so you can re-launch later. Survives PlexiDesk restarts.',
      'Tried full punch-through window mirroring first (transparent BrowserWindow + AppleScript window positioning + mix-blend-mode click-through to embed the real app live inside the canvas). It worked but was too brittle for MVP — pulled it for the simpler tile.'
    ]
  },
  {
    date: '2026-05-27T09:00:00Z',
    title: 'Connected Apps — drag-to-canvas, vault auto-fill, Favourites',
    tag: 'feature',
    highlights: [
      'Drag any Connected App row from the sidebar onto a task canvas → spawns a browser widget bound to that app. The widget shares the app\'s session partition with the full-pane view, so logging in once persists everywhere.',
      'Pin a freeform browser widget back to Connected Apps with one click — the "Pin to apps" button in the widget header. Hostname-dedups: if you already have GitHub pinned, hitting Pin on a `github.com/issues/123` widget reuses the existing app instead of creating a duplicate.',
      'Vault auto-fill — bind a vault entry to any Connected App (key icon in the toolbar opens the binding popover). On did-finish-load, PlexiDesk injects credentials into the page\'s username/password fields using React-compatible value setters so React-built login pages accept them. Idempotent — won\'t stomp values you typed.',
      'Sidebar Connected Apps section now splits into Favourites + a collapsible "More apps (N)" accordion. Apps rank by recency × frequency (log-scaled use count × 1-week recency decay). Pin any app to lock it to the top.',
      'Touch counter — every full-pane open, drag-to-canvas, and bound-widget focus bumps the usage count. Apps you actually use rise to Favourites; ones you stop using sink to More apps.'
    ]
  },
  {
    date: '2026-05-26T15:00:00Z',
    title: 'OAuth popups + automated test harness',
    tag: 'fix',
    highlights: [
      'OAuth flows in Connected Apps work again. Root cause: the webview\'s webContents had no `setWindowOpenHandler` in main, so popups died or opened without sharing the webview session — killing `window.opener` and breaking the OAuth callback.',
      'New popup router in main: window.open() with features OR disposition=\'new-window\' opens as a real native popup window sharing the parent session (cookies + auth state preserved). target=_blank link clicks forward to the renderer via IPC so they spawn as canvas widgets, keeping the click-to-add-widget UX.',
      'Two-axis defense against the original bug: rejects javascript:/data: URLs from the forward path so they can\'t spawn malicious widgets in our shared session.',
      'New automated test suite — Vitest for pure-logic unit tests (sort formulas, autofill script builders, popup router decisions) + Playwright Electron for E2E (app boot, drag-drop, IPC roundtrip, vault crypto round-trip, schema migrations). 39 tests covering the major surfaces, runs in ~16s.',
      'The OAuth router has explicit regression guards — the unit suite includes "does NOT route target=_blank as a native popup" and "does NOT route OAuth popups through the renderer" tests so the original bug can\'t silently come back.'
    ]
  },
  {
    date: '2026-05-26T09:15:00Z',
    title: 'WebView URL persistence + Mac haptics',
    tag: 'polish',
    highlights: [
      'Browser widgets now remember where you were. As you navigate inside any webview, the latest URL is debounced-saved back into the widget. Close the focus mode (or even the widget — until you remove it) and re-open later: it lands on the last page you were on, not the original.',
      'Live header preview during navigation — the widget header updates to the new page title/host the moment you navigate, before the debounce-save commits. No more stale tab labels.',
      'Force-flush on unmount: if you close the focus mode mid-typing on a page, the latest URL is committed immediately rather than waiting on the debounce timer.',
      'Mac haptics — new ⚡ tactile feedback layer. Tries the optional native-mac-haptics bridge (NSHapticFeedbackPerformer) first; falls back to a near-subliminal audio-tactile click via the existing AudioContext when the native module isn\'t available.',
      'Wired into the highest-value moments: 5-Minute Promise start (medium tap), session complete (success double-tap), task marked done (success), vault unlock (medium), vault unlock failed (warning triple).',
      'Native haptics activate automatically if you run `npm install node-mac-haptics && npx electron-rebuild`. Until then, the audio fallback gives every haptic call something to feel.'
    ]
  },
  {
    date: '2026-05-26T08:30:00Z',
    title: 'Energy-Aware Scheduling + Calendar + drag-task-to-canvas',
    tag: 'feature',
    highlights: [
      'Energy-Aware Scheduling — new ⚡ chip in the app header. Click → log your current energy (🪫 Low / 🔋 Steady / ⚡ High) in two taps. The chip glows the colour of your current state.',
      'New "Energy fit" sort in the All Tasks view — when you\'ve logged energy, this ranks tasks by how well their lift matches your state (heavy tasks for high energy, light admin for low). Falls back to Smart sort if you haven\'t logged yet.',
      'New Energy dashboard card — add it via Customize on any dashboard. Three-tap entry plus a strip of your last 72h.',
      'New Calendar view under WORKSPACE — month grid with tasks placed by due date. Each day cell sorts its tasks by urgency × importance + due-date boost (the three-axis sort). Today is ringed. Click a task chip → open it. Hover → ⚡5 min on the chip.',
      'Drag any task from the sidebar onto the canvas → spawns a "Task link" widget that references that task. Click the widget to open the linked task; hover for an inline 5-min start. Survives task switches like any other widget.',
      'Native Mac haptics is deferred — needs a native node addon. The renderer-side hooks are easy when the bridge lands.'
    ]
  },
  {
    date: '2026-05-25T17:10:00Z',
    title: 'OS Phase 7 — Vault (encrypted credentials + TOTP)',
    tag: 'feature',
    highlights: [
      'New Vault entry under WORKSPACE in the sidebar. First click → set a master password. Subsequent clicks while locked → unlock prompt. While unlocked → list of credential entries with copy / reveal / TOTP.',
      'Crypto: AES-256-GCM for entry payloads, PBKDF2-SHA256 with 600,000 iterations (OWASP 2023) for key derivation from your master password, fresh 16-byte salt per vault, fresh 12-byte IV per entry. Master key lives only in main-process memory; lock zeroes it out.',
      'Each entry stores title / url / username in plaintext (for search and display) and an encrypted blob containing password + TOTP secret + notes.',
      'Built-in RFC 6238 TOTP generator — paste a base32 secret, the entry shows a live 6-digit code with countdown ring. One click copies the current code; clipboard auto-clears in 30 seconds.',
      'Auto-clearing clipboard on every password / TOTP copy (30s). The "Lock" button in the vault header clears the master key from memory immediately.',
      'No recovery. No sync. No backend. If you lose the master password the vault is unrecoverable — that\'s the price of local-first encryption.'
    ]
  },
  {
    date: '2026-05-25T16:30:00Z',
    title: 'OS Phase 6 — Customizable dashboards',
    tag: 'feature',
    highlights: [
      'Click "Customize" in the top-right of any dashboard (Home or any project) to enter edit mode. Each card grows a drag handle + remove button.',
      'Drag cards by their colored handle to reorder. Accent-colored drop indicator shows where the card will land. Drop on the bottom strip to push a card to the end.',
      'Add removed cards back from the dashed palette at the bottom — each option shows the card name and a one-line description of what it does.',
      '"Reset" button restores the default layout for this dashboard. "Done" exits edit mode.',
      'Layouts are persisted per dashboard — the Home dashboard and every Project dashboard have independent custom layouts. Stored in a new dashboard_layouts table keyed by dashboard.'
    ]
  },
  {
    date: '2026-05-25T15:10:00Z',
    title: 'OS Phase 5 — Connected Apps',
    tag: 'feature',
    highlights: [
      'New CONNECTED APPS section in the sidebar — pin Spotify, Gmail, Slack, ChatGPT, Claude, Notion, Linear, GitHub, Figma and 11 others as persistent app-level browsers.',
      'Click "+" next to the section header to open the picker: tabbed view with 20 curated standard apps (grouped by Productivity / Comms / Dev / AI / Media / Design) and a Custom URL tab for anything else. Apps you\'ve already added show a green check so you don\'t duplicate.',
      'Each app gets its own persistent Electron partition (cookies, local storage, login state survive app restarts). Click a Connected App in the sidebar → full-pane render in the main area with a slim toolbar (back / forward / reload / open in OS browser / remove).',
      'External links opened from inside a Connected App go to your system browser, not as new in-app widgets — keeps the OS-level vs task-level distinction clean.',
      'Phase 6 will let you reorder Connected Apps and add custom colors / icons. Today they appear in the order you add them.'
    ]
  },
  {
    date: '2026-05-25T14:25:00Z',
    title: 'OS Phase 3 — All Tasks view',
    tag: 'feature',
    highlights: [
      'New consolidated All Tasks view in the sidebar — every task across every project, flat. Click "All Tasks" under WORKSPACE.',
      'Five filter chips with live counts: Today / Overdue / Upcoming / All open / Done. Today is the default and includes overdue + in-progress + due-today.',
      'Search box filters by task title and description. Sort dropdown: Smart (overdue → due → priority), Due date, Recently updated, Alphabetical.',
      'Each row: round checkbox (one tap to mark done — triumph chime fires), task title (click → opens the task canvas), project breadcrumb (click parent → opens that project\'s dashboard), due-date chip, urgency + importance dots, inline "Just 5 min" on hover.',
      'Empty states per filter — "Nothing overdue — sweet" / "You\'re caught up" / etc. — affirming, not punishing.'
    ]
  },
  {
    date: '2026-05-25T14:00:00Z',
    title: 'OS Phase 2+4 — Home Dashboard + Project Dashboards (same component)',
    tag: 'feature',
    highlights: [
      'New Home Dashboard at the top of the sidebar — your at-a-glance landing surface. Click on Home from the WORKSPACE section.',
      'Every project now has its own dashboard — click any project name in the sidebar to open it. Same component as Home, just scoped to that project\'s subtree (including all sub-projects + their tasks).',
      'Cards: Quick Start (top-priority task + one-click 5-min), Today stats (sessions / focused minutes / done), 30-day Habit Garden, Open tasks list (overdue → today → upcoming → priority-ranked, with inline 5-min trigger on hover), Recent activity from the Trail.',
      'Project dashboards filter every card to that project\'s scope automatically — sessions, tasks, activity, garden density, top-priority task all narrow to what matters for that project.',
      'Each dashboard is a launchpad first, a report second — the Quick Start at the top picks the highest-priority task for you (urgency × importance + due-date boost + in-progress bonus) so you can start the day without deciding what to start.'
    ]
  },
  {
    date: '2026-05-25T13:50:00Z',
    title: 'Sidebar drag-and-drop — reorder, reparent, nest',
    tag: 'feature',
    highlights: [
      'Drag any project or task in the sidebar to reorder it within its current parent, or to drop it into a different project, or to nest one project inside another.',
      'Drop indicators: a thin accent-coloured line shows where the item will land between siblings; folders highlight with an inset accent ring when you\'re about to drop INTO them.',
      'Cycle-safe: dropping a project into one of its own descendants is silently rejected (no broken trees possible).',
      'Atomic move on the backend — single transaction that reparents and renumbers all destination siblings; the sidebar refreshes from the server so sort order stays correct across multiple drags.',
      'Soft chime confirms each drop. Destination project auto-expands so the moved item is immediately visible.'
    ]
  },
  {
    date: '2026-05-25T13:35:00Z',
    title: 'OS Phase 1 — Sidebar restructure into a workspace OS',
    tag: 'design',
    highlights: [
      'Sidebar rebuilt into three collapsible sections: WORKSPACE (Home + All Tasks), PROJECTS (the folder/task tree, now labeled "Projects"), and CONNECTED APPS (placeholder shell for the persistent apps pane shipping in a later phase).',
      'New view router — the main pane now switches between Home Dashboard, All Tasks, Project Dashboard, individual Task canvas, and Connected App views. Persists last view across app restarts.',
      'Click a project name → opens that project\'s dashboard (placeholder for now). Click a task → opens the existing canvas workflow, unchanged.',
      '"Folder" is now "Project" in all user-facing copy (database kind stays as folder; pure label change). Edit dialog, sidebar tooltips, new-node dialog all updated.',
      'Home / All Tasks / Project Dashboard / Connected App views ship as labeled placeholders — the OS skeleton is in place; the dashboards themselves land in Phases 2–6.'
    ]
  },
  {
    date: '2026-05-25T08:55:00Z',
    title: 'Smart Stacking — semantic widget grouping',
    tag: 'feature',
    highlights: [
      'New hub icon in the app header (next to Settings) — click to ask AI to group your unsectioned widgets into related sections based on what they relate to, not what kind they are.',
      'Proposal modal lists 2–5 named groups with reasons and member widgets. Defaults to all-checked, ADHD-style — uncheck what you don\'t want.',
      'Auto-picks section colors from the rotation, skipping any already in use on the canvas so each section is visually distinct.',
      'Caches the proposal in memory — re-clicking with the same widget set opens instantly (a "cached" badge appears); the refresh icon forces a fresh AI call.',
      'Only operates on widgets that aren\'t already in a section — respects existing manual organization.'
    ]
  },
  {
    date: '2026-05-25T07:35:00Z',
    title: 'Pre-Task Mood Bridge',
    tag: 'feature',
    highlights: [
      'When you open a task that\'s likely to feel hard (low interest 1-2, or high stakes 4-5, while still in "open" status), a 🌱 bridge modal appears first.',
      'Three personalized friction-reducers: "Just 5 minutes" (starts a focus session + marks in-progress), "Body double me" (turns on quiet AI presence), "Have AI suggest the first step" (proactive welcome).',
      'Auto-opens in 15 seconds if you do nothing — never traps you. "Just open it" escape hatch always visible.',
      'Shown once per task per session. Addresses the EMOTIONAL entrance to a task, which is what actually blocks ADHD starts more than complexity.'
    ]
  },
  {
    date: '2026-05-25T07:25:00Z',
    title: 'Hyperfocus Guardian',
    tag: 'feature',
    highlights: [
      'New amber banner appears at the top of the canvas when you\'ve been continuously focused for 90+ minutes (no 5-min break in that window). "You\'re on fire — 92 min straight."',
      'Two choices: "3-min stretch" (emerald button — opens a small countdown banner that returns you with a chime) or "keep going" (snoozes for 30 min).',
      'The inverse of a focus timer. Doesn\'t nag, doesn\'t interrupt — affirms first, offers second. Protects you from yourself.',
      'Resets automatically the moment you take a 5+ minute break, so a normal Pomodoro rhythm never triggers it.'
    ]
  },
  {
    date: '2026-05-25T07:15:00Z',
    title: 'Event sound design pass',
    tag: 'polish',
    highlights: [
      'Adding a new widget plays a soft single tap (different chime for sections — a warm low→fifth two-note "settled" tone).',
      'Marking a task done plays a triumphant 4-note ascending arpeggio (C-E-G-C). Earned dopamine.',
      'All event sounds respect your master sound prefs (volume, master enable, quiet-while-widget-active).'
    ]
  },
  {
    date: '2026-05-25T07:05:00Z',
    title: 'One-Tap Reboot — "Welcome back"',
    tag: 'feature',
    highlights: [
      'When you come back to the app after being away (window blurred 3+ min, document hidden, or 10+ min of no input while visible), a soft "Welcome back — you were away N min" pill appears near the bottom of the canvas.',
      'One tap "Bring me back" → Claude summarizes the last 30 minutes from the Trail directly into your chat, refocuses the most recently-touched widget on the active task, and plays the focus chime. The 60-second re-entry tax killer.',
      'Auto-dismisses the moment you do anything (click, key, scroll). Close button if you don\'t want it.',
      'Reuses the External Brain summarizer — no extra cost beyond what you\'d pay for a manual "What was I doing?"'
    ]
  },
  {
    date: '2026-05-25T06:55:00Z',
    title: 'Body Double Mode — quiet AI presence',
    tag: 'feature',
    highlights: [
      'New people-icon toggle in the assistant panel header — turn on Body Double for a quiet AI co-worker that sits beside you while you work.',
      'Every ~10 minutes, the assistant drops a short observation (≤15 words) based on what you\'ve been doing — names specific docs, URLs, or session counts so you feel seen.',
      'When you go idle 10-20 min: a warm low-key check-in ("Coffee break? No rush"). When you\'re deeply away (20+ min): silence — no spam.',
      'Pure presence: no questions back at you, no coaching, no sycophancy. The killer ADHD productivity hack ("body doubling") finally first-class in software.',
      'Runs on Haiku 4.5 — ~$0.0001 per tick. Persists across app restarts if left enabled.'
    ]
  },
  {
    date: '2026-05-25T06:40:00Z',
    title: 'Cognitive Load Meter + Park-the-rest',
    tag: 'feature',
    highlights: [
      'New load gauge in the canvas title bar — a coloured dot + count showing how heavy your current canvas feels (Light / Comfortable / Heavy / Overloaded). Browsers weigh more than stickies; widgets parked in sections don\'t count.',
      'When you cross "Overloaded", the dot pulses red. Click it to open the popover and hit "Park everything except the active widget" — single tap to clear the desk while keeping work in flight.',
      'Parked widgets are hidden from the canvas but persist (new archived flag on widgets). The popover shows them in a scroll-list — click any to restore. The +N badge on the gauge counts what\'s parked.',
      'Soft chime on park / restore so the action has weight.'
    ]
  },
  {
    date: '2026-05-25T06:25:00Z',
    title: 'Streak-Proof Habit Garden',
    tag: 'feature',
    highlights: [
      'New focus garden in the canvas title bar — a 7-day inline strip of accent dots showing your recent focus sessions, with today\'s count next to a flower icon.',
      'Click the strip to open the full 30-day garden popover: 6×5 grid of bloom intensities, today highlighted with a ring, plus stats (today / days active / total).',
      'Crucially: no streak counter. Missed days are gaps; the rest of the garden stays bloomed. "No streak to break. Gaps are fine — the bloom stays."',
      'Driven by the focus_sessions table — every "Just 5 min" you finish (or "Keep going") feeds the garden. Bloom intensity saturates at 4+ sessions/day, so a hyperfocus burst doesn\'t dwarf a normal day.'
    ]
  },
  {
    date: '2026-05-25T06:15:00Z',
    title: 'Assistant model picker — Auto / Haiku / Sonnet / Opus',
    tag: 'feature',
    highlights: [
      'New AI Model section in Settings. Pick Auto for smart per-action routing, or lock to a specific model (Haiku $ / Sonnet $$ / Opus $$$).',
      'Auto mode: chat, welcome, setup, and resume use Sonnet 4.6; trail summaries use Haiku 4.5. Visible breakdown below the picker.',
      'Tiny mode chip in the assistant panel header shows the active mode (auto/haiku/sonnet/opus). Hover for routing details.',
      'Cost transparency: each model option shows its tier ($, $$, $$$) so you can predict spend before locking in.'
    ]
  },
  {
    date: '2026-05-25T06:00:00Z',
    title: 'External Brain — "What was I doing?"',
    tag: 'feature',
    highlights: [
      'New replay button in the assistant panel header (↻ icon, next to clear chat). One click → Claude reads the last 30 minutes of your activity and writes a 3-5 sentence narrative of where you were and what you were doing.',
      'Every meaningful action now flows to an append-only activity log: task switches, widget adds, browser navigations, chat sends, focus sessions started/ended. Privacy: 100% local, in your SQLite DB.',
      'Uses the fast model (Claude Haiku 4.5) for summarization — ~10× cheaper than the chat model, and faster too. Costs roughly $0.0001 per "What was I doing?" call.',
      'Designed for the "I came back from making coffee and forgot what I was doing" moment — the external hippocampus the ADHD brain has been waiting for.'
    ]
  },
  {
    date: '2026-05-23T20:45:00Z',
    title: 'The 5-Minute Promise',
    tag: 'feature',
    highlights: [
      'New accent-coloured "Just 5 min" button in every active task — start a 5-minute focus session in one click. The most-evidence-backed ADHD initiation technique, finally a first-class primitive.',
      'While a session runs: the rest of the app dims to 35% opacity, the canvas gets a pulsing accent ring, and a floating timer pill sits at the top of the desk. The world hushes around the work.',
      'When 5 minutes are up: a soft alarm + a guilt-free choice modal — "Done for now" (real win, no streak to break), "Keep going · 5 more", or "15 min / 25 min (pomodoro)". Sessions chain so you can keep adding fives.',
      'Every session is logged to the new focus_sessions table — substrate for the upcoming Habit Garden + Trail features. "Done for now" and "Keep going" both count as wins.',
      'Close button (×) on the timer pill ends the session early without judgement — logged as abandoned so the system learns, not as failure.'
    ]
  },
  {
    date: '2026-05-23T20:10:00Z',
    title: 'Markdown widget upgraded to true WYSIWYG (Tiptap)',
    tag: 'polish',
    highlights: [
      'Markdown widget now renders as you type — bold text looks bold, headings look like headings, no syntax characters in the way. No more edit/preview mode toggle.',
      'Paste raw markdown anywhere in the editor and it converts to rich formatting on the fly',
      'Live formatting toolbar: highlights the active mark/block, click to toggle. Adds task lists, blockquotes, dividers, and a code-block mode.',
      'Click anywhere in the editor to place your cursor exactly where you clicked — no more "always opens at the top" issue.'
    ]
  },
  {
    date: '2026-05-23T19:15:00Z',
    title: 'Markdown widget + ambient keyboard click profiles',
    tag: 'feature',
    highlights: [
      'New Markdown widget — paste markdown, view it rendered as rich text. (Upgraded later the same day to a true WYSIWYG editor — see next entry.)',
      'Five new keyboard click sound styles in the Ambient family: Whisper (breathy hush), Vapor (air drift + pad bloom), Stardust (sparkle ping), Crystal (bell shimmer), Halo (pillowy swell) — all low-impact and dopamine-coded',
      'Settings panel now groups click sounds by Tactile (physical key feel) and Ambient (spacey, breathy)'
    ]
  },
  {
    date: '2026-05-23T18:30:00Z',
    title: 'Keyboard click profiles + footer with What\'s New',
    tag: 'polish',
    highlights: [
      'Five keyboard click sound styles: Soft, Mechanical, Typewriter, Bubble, Marimba — click any one in Settings to preview',
      'New app footer with copyright, Terms of Use, and a What\'s New panel that lights up when fresh updates ship',
      'Right-click in the assistant panel to save selected text as a sticky or full note on the canvas'
    ]
  },
  {
    date: '2026-05-23T17:30:00Z',
    title: 'Editable tasks/folders + Recent Pages + AI Setup in dialogs',
    tag: 'feature',
    highlights: [
      'Pencil icon on any sidebar row opens the edit dialog — change title, notes, urgency, interest, importance, duration, and a new due date field',
      'Sidebar rows now show a colored due-date chip: "today", "tomorrow", "3d", "2d late"',
      'New "Recent pages" chip strip in the create dialog, populated by browser webview visits — one click adds a URL to the task setup',
      '"Have AI suggest the setup" checkbox on create, "Suggest more setup" button on edit — the AI now sees your most-visited pages and prefers them when picking widgets'
    ]
  },
  {
    date: '2026-05-23T16:30:00Z',
    title: 'Time-Blindness Anchoring — feel the day, don\'t watch the clock',
    tag: 'feature',
    highlights: [
      'Ambient time-of-day overlay on the canvas: soft hue shift from dawn-cool through midday-warm to dusk-amber to night-indigo',
      'A "sun" glow that travels left-to-right across the top of the desk during daylight, peaking at noon',
      'Every widget grows a subtle warm halo the longer it sits on the desk — externalizes time without numbers'
    ]
  },
  {
    date: '2026-05-23T15:00:00Z',
    title: 'AI Setup + sound preferences',
    tag: 'feature',
    highlights: [
      'AI Setup button in the canvas title bar — Claude reads the active task and suggests 4–7 widgets, browsers and notes to spawn',
      'Sound preferences in Settings: master toggle, volume slider, keyboard click toggle, "Quiet while widget active" mode',
      'All sounds respect prefs everywhere — chimes, focus tones, click feedback'
    ]
  },
  {
    date: '2026-05-22T22:00:00Z',
    title: 'Futuristic theme mode',
    tag: 'design',
    highlights: [
      'Fully dark canvas in dark mode (no more cream paper)',
      'New Futuristic theme: aurora gradient background, flowing accent beam, pulsing widget glow, scanline overlay, power-on chime'
    ]
  },
  {
    date: '2026-05-22T19:00:00Z',
    title: 'Theme system v1',
    tag: 'design',
    highlights: [
      'Light / Dark / Auto / Futuristic theme modes — picker in Settings (gear icon in titlebar)',
      'Opera-inspired accent picker: Violet, Blue, Emerald, Rose — affects buttons, active states, and widget glow at runtime'
    ]
  },
  {
    date: '2026-05-21T20:00:00Z',
    title: 'Velocity, Workspace Resume, AI Pair-Worker',
    tag: 'feature',
    highlights: [
      'Task duration estimates with personal velocity tracking — predicts real time based on your history',
      'Workspace Resume — assistant drafts a "where you left off" markdown summary you can pin to a task',
      'AI chat panel knows the active task and its widgets, so questions become contextual immediately'
    ]
  },
  {
    date: '2026-05-20T18:00:00Z',
    title: 'Sections widget',
    tag: 'feature',
    highlights: [
      'Group widgets visually with the Section container',
      'Five layout modes per section: Free, Grid, Stacks, Icons, List — switch on the fly',
      'Drag-and-drop into/out of sections with hover targeting and eject button'
    ]
  },
  {
    date: '2026-05-19T12:00:00Z',
    title: 'Foundation',
    tag: 'feature',
    highlights: [
      'Three-panel layout: workspace tree, canvas desk, assistant chat',
      'Widgets: sticky, note, webview browser, PDF, Google Docs/Sheets/Slides, Gmail, calculator, color picker, image, video, timer',
      'Pin-to-screen for keep-it-visible widgets, zoom & pan canvas, widget palette and floating toolbar'
    ]
  }
]

const LAST_SEEN_KEY = 'fb.changelog.lastSeenAt'

export function getLastSeenAt(): number {
  if (typeof localStorage === 'undefined') return 0
  const raw = localStorage.getItem(LAST_SEEN_KEY)
  return raw ? parseInt(raw, 10) : 0
}

export function markChangelogSeen(): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(LAST_SEEN_KEY, String(Date.now()))
}

export function hasUnseenChanges(): boolean {
  const lastSeen = getLastSeenAt()
  if (CHANGELOG.length === 0) return false
  const newestMs = new Date(CHANGELOG[0].date).getTime()
  return newestMs > lastSeen
}

// ── First-run "What's new in vX.Y.Z" release modal ──────────────────────────
// Distinct from the timestamp-based unseen dot above: this fires ONCE per app
// version, on the first launch after an update, and shows that version's
// summary + highlights + support links. Keyed by version so it survives a
// localStorage clock change and never re-shows for a version already seen.

const RELEASE_SEEN_KEY = 'fb.app.releaseModalVersion' // version whose modal was shown
const LAST_RUN_KEY = 'fb.app.lastRunVersion' // version the app last booted as

// The running app version, injected at build time. 'dev' in unpackaged dev.
declare const __APP_VERSION__: string | undefined
export function getAppVersion(): string {
  return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'
}

export function getReleaseEntryForVersion(version: string): ChangelogEntry | null {
  return CHANGELOG.find((e) => e.version === version) ?? null
}

// The newest entry that declares a version — used by the release gate to assert
// the changelog was updated for the release.
export function newestVersionedEntry(): ChangelogEntry | null {
  return CHANGELOG.find((e) => !!e.version) ?? null
}

function getReleaseSeenVersion(): string | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(RELEASE_SEEN_KEY)
}

// The release entry to auto-show now, or null. "After an update" is decided two
// ways, either is sufficient: the main process reports wasUpdated (authoritative
// — it persists the last-run version in userData), or the renderer's own
// last-run-version marker differs from the current version (covers every update
// after the first, and is what the e2e/unit tests drive). A fresh install has
// neither, so it shows nothing. The release-seen marker prevents re-showing on a
// reload within the same version. Pure (no writes); caller then advances the
// run version via advanceRunVersion().
export function getPendingReleaseEntry(opts?: { wasUpdated?: boolean }): ChangelogEntry | null {
  const cur = getAppVersion()
  if (cur === 'dev') return null
  if (getReleaseSeenVersion() === cur) return null
  const entry = getReleaseEntryForVersion(cur)
  if (!entry) return null
  const lastRun = typeof localStorage !== 'undefined' ? localStorage.getItem(LAST_RUN_KEY) : null
  const updatedByHistory = lastRun !== null && lastRun !== cur
  if (!(opts?.wasUpdated || updatedByHistory)) return null
  return entry
}

// Record the current version as seen so the modal does not fire again for it.
export function markReleaseSeen(version?: string): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(RELEASE_SEEN_KEY, version ?? getAppVersion())
}

// Record the current version as the last one booted. Call once per launch after
// deciding whether to show the modal, so the NEXT update is detected.
export function advanceRunVersion(): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(LAST_RUN_KEY, getAppVersion())
}

export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  const now = Date.now()
  const diffMs = now - then
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay === 1) return 'yesterday'
  if (diffDay < 7) return `${diffDay}d ago`
  if (diffDay < 30) return `${Math.floor(diffDay / 7)}w ago`
  if (diffDay < 365) return `${Math.floor(diffDay / 30)}mo ago`
  return `${Math.floor(diffDay / 365)}y ago`
}

export function formatAbsoluteDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}
