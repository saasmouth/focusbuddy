// What the native right-click menu on a web page asks the renderer to do
// (main/webContextMenu.ts → preload webMenu.onCommand → WebMenuCommandHost).

/** What an "Add … to desk" item puts on the desk. */
export type DeskTarget = 'selection' | 'image' | 'video' | 'link' | 'page'

/**
 * An Add to desk, PlexiiAssist or AI Assist item. The page's own address and
 * title ride along so a note can say where its text came from.
 */
export type WebMenuCommand =
  | {
      command: 'add-to-desk'
      target: DeskTarget
      /** A desk id, 'new' (ask for a name) or 'choose' (the searchable picker). */
      desk: string
      text?: string
      url?: string
      pageUrl: string
      pageTitle: string
    }
  | { command: 'ai'; ai: string; text: string; pageUrl: string; pageTitle: string }
  | { command: 'ask-assist'; text: string; pageUrl: string; pageTitle: string }
