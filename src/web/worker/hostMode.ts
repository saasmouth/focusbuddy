// Which database a Worker opens, decided by the name it was started with.
//
// The share app's Worker opens the workspace: one SQLite database in OPFS
// (plexii.db), held by one tab per origin. The widget host's Worker must not:
// a widget host page shows ONE file that PlexiiLite owns on disk, so its rows
// live in memory and die with the page (F2 item 3). Two tiles from the same
// origin would otherwise share one database and mix their rows, and the
// browser's storage would keep a copy of every file ever opened.
//
// The Worker's name is the channel because it is the only thing a Worker can
// read synchronously at load, before its first message -- and the database is
// opened at load, so a message would arrive too late.

export const WIDGET_HOST_WORKER_NAME = 'plexii-widget-host'

export function storageForWorker(name: string | undefined): 'memory' | 'workspace' {
  return name === WIDGET_HOST_WORKER_NAME ? 'memory' : 'workspace'
}
