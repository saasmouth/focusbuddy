// Node's `path`, as the shared data layer uses it.
//
// Only the three pure string functions are here, because those are the only
// ones anything in the browser graph calls -- db/files.ts wants extname to
// derive a stored name from an original filename. Nothing that manipulates real
// filesystem paths runs in a tab; the functions that do were moved to
// db/filesFromDisk.ts for exactly that reason.
//
// These follow POSIX semantics, which is what the callers assume and what
// matters here: the "paths" being parsed are user-supplied filenames, not
// locations on any disk.

/** The extension including the dot, or '' when there is none. */
export function extname(p: string): string {
  const base = basename(p)
  // A leading dot is a hidden file, not an extension: '.gitignore' has none.
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot)
}

/** The last path segment, with any trailing separators ignored. */
export function basename(p: string, ext?: string): string {
  const trimmed = p.replace(/[/\\]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const base = cut === -1 ? trimmed : trimmed.slice(cut + 1)
  return ext && base.endsWith(ext) && base !== ext ? base.slice(0, -ext.length) : base
}

/** Join segments with '/', collapsing repeats and dropping empties. */
export function join(...parts: string[]): string {
  const joined = parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/')
  return joined || '.'
}

export default { extname, basename, join }
