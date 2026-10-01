// Which product is this binary — PlexiDesk or the standalone PlexiOffice app?
//
// Both apps are built from this one codebase and are meant to run AT THE SAME
// TIME. The packaged bundle embeds package.json `name: "focusbuddy"` with no
// `productName`, so Electron's app.getName() returns "focusbuddy" for BOTH builds.
// If we relied on that, PlexiOffice would default to PlexiDesk's userData
// directory and therefore share its single-instance lock, which makes PlexiOffice
// quit on launch whenever PlexiDesk is already open. So office detection must not
// depend on app.getName() alone.
//
// We detect the office build from, in order: the PLEXI_APP env var (dev: the
// dev:office script sets it), the executable path (packaged: the bundle is
// PlexiOffice.app on macOS / PlexiOffice.exe on Windows, so the path contains
// "plexioffice"), and finally app.getName() as a best-effort fallback (works once
// app.setName('PlexiOffice') has been applied). This is a pure function so the
// detection rules are unit-tested independently of the Electron runtime.
export function detectOfficeBuild(opts: {
  plexiAppEnv?: string | undefined
  execPath: string
  appName: string
}): boolean {
  return (
    opts.plexiAppEnv === 'office' ||
    opts.execPath.toLowerCase().includes('plexioffice') ||
    opts.appName.toLowerCase().includes('office')
  )
}

// Is this binary the side-by-side "PlexiDesk 3 Preview" build? Same detection
// strategy as detectOfficeBuild and for the same reason: the packaged bundle's
// app.getName() is "focusbuddy" until setName runs, so we look at the PLEXI_APP
// env var (dev), then the executable path (packaged: the bundle is
// "PlexiDesk 3 Preview.app" / "PlexiDesk 3 Preview.exe"), then the app name.
// The preview runs the full PlexiDesk renderer but with its OWN userData
// directory, its own single-instance lock, no claim on the haptyx:// protocol,
// and the auto-updater disabled — so it can be tested end to end alongside a
// production install without touching its data or being "updated" back to the
// release channel.
export function detectPreviewBuild(opts: {
  plexiAppEnv?: string | undefined
  execPath: string
  appName: string
}): boolean {
  const path = opts.execPath.toLowerCase()
  // Both generations match. The preview was renamed 3 -> 4 with the product, and
  // the old names stay recognised on purpose: an installed "PlexiDesk 3 Preview"
  // that stops being detected as a preview build would silently fall through to
  // the production userData directory and open the real database -- the exact
  // accident this whole detector exists to prevent.
  return (
    opts.plexiAppEnv === 'preview3' ||
    opts.plexiAppEnv === 'preview4' ||
    path.includes('plexidesk 3 preview') ||
    path.includes('plexidesk3preview') ||
    path.includes('plexidesk 4 preview') ||
    path.includes('plexidesk4preview') ||
    opts.appName.toLowerCase().includes('preview')
  )
}
