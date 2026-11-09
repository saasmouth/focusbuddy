// The app's custom URL scheme, named once.
//
// Three places need it and they must agree: the OS registration and URL parsing
// in main/authProtocol.ts, and the links the renderer puts into meeting invite
// emails and calendar entries. It was a literal in each, which is how
// `haptyx://` ended up in outgoing email long after the app was renamed.
//
// WHY BOTH. A deep link is not ours to expire once it is sent. A haptyx://auth
// handoff can be sitting in an inbox, and a meeting invite sent by an older
// build names the old scheme. So the app REGISTERS and ACCEPTS both, and
// GENERATES only the current one.
//
// The asymmetry is the whole design: accepting an extra scheme costs nothing
// and protects every link already in the world, while generating the old one
// would keep putting a retired brand in front of people indefinitely.
//
// The one consequence, stated plainly: a link generated here opens in a build
// that registered `plexii://`, which means this release onward. A recipient
// still on an older build needs to update before a newly generated meeting
// link will open for them. Links they were sent earlier keep working.

/** The scheme this app registers, advertises and generates. */
export const DEEP_LINK_SCHEME = 'plexii'

/** Schemes still answered, for links sent before the rename. Never generated. */
export const LEGACY_DEEP_LINK_SCHEMES = ['haptyx'] as const

/** Every scheme the app responds to. */
export const ALL_DEEP_LINK_SCHEMES: readonly string[] = [
  DEEP_LINK_SCHEME,
  ...LEGACY_DEEP_LINK_SCHEMES
]

/** True if a URL's `protocol` (e.g. "plexii:") is one the app answers. */
export function isKnownDeepLinkProtocol(protocol: string): boolean {
  return ALL_DEEP_LINK_SCHEMES.some((s) => protocol === `${s}:`)
}

/**
 * Whether this copy of the app asks the OS to send it plexii:// (and haptyx://)
 * links. Only an installed Plexii: two apps can't both own a scheme, and the one
 * that registers last takes every link.
 *
 *   - PlexiOffice and the preview never do (they did not before this rule).
 *   - The e2e harness never does (NODE_ENV=test, a throwaway FB_TEST_USER_DATA):
 *     a spec run on the owner's Mac would otherwise point plexii:// at the test
 *     Electron, and every link the owner clicks (sign-in, shares, meetings,
 *     "Open This Room in Plexii") would stop reaching the real app.
 *   - An unpackaged run on macOS doesn't either: there the registration names the
 *     bundle that is running, the bare Electron.app, so it steals the installed
 *     Plexii's links. A developer testing deep links in dev can set
 *     PLEXII_DEV_CLAIM_LINKS=1, knowing the installed app loses them until it is
 *     next opened (it registers again at every launch).
 */
export function claimsDeepLinks(o: { office: boolean; preview: boolean; packaged: boolean; platform: string; env: Record<string, string | undefined> }): boolean {
  if (o.office || o.preview) return false
  if (o.env.NODE_ENV === 'test' || o.env.FB_TEST_USER_DATA) return false
  if (!o.packaged && o.platform === 'darwin') return o.env.PLEXII_DEV_CLAIM_LINKS === '1'
  return true
}

/** True if a raw argv entry is a deep link the app answers. */
export function isDeepLinkArg(arg: string): boolean {
  return ALL_DEEP_LINK_SCHEMES.some((s) => arg.startsWith(`${s}://`))
}

/** The deep link that opens a meeting room. */
export function meetingDeepLink(roomId: string): string {
  return `${DEEP_LINK_SCHEME}://meet?room=${encodeURIComponent(roomId)}`
}
