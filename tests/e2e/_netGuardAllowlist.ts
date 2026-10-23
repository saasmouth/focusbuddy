// Specs allowed to reach a PRODUCTION host (see _netGuardHosts.ts) in an e2e
// run. Everything else that touches one is aborted and failed by the net guard
// in _netGuard.ts.
//
// An entry is a spec FILE NAME (e.g. 'someLiveProbe.spec.ts'), exactly as it
// sits in tests/e2e, with a comment saying why it needs the real server. Keep
// it explicit and short: an entry is a decision that this spec may talk to the
// service every user signs in through.
//
// ONE ENTRY; EVERY LIVE SPEC IS LOCAL. Every live spec in the tree follows
// the live-e2e recipe, which points a purpose-built bundle at a LOCAL signal server behind a
// local TLS proxy (https://localhost:<port>, set by VITE_SIGNAL_HTTP_URL at
// build time and CRDT_LIVE_PROXY_BASE / DESKSHARE_LIVE_PROXY_BASE /
// ORGSYNC_LIVE_PROXY_BASE / ORGDOC_ROUTE_PROXY_BASE / COMMENT_LIVE_BASE /
// E2E_SIGNAL_BASE at run time). localhost is not a production host, so the
// guard lets them run without an entry. None of them needs production, and a
// spec that does should have to argue for it here.
export const PRODUCTION_ALLOWED_SPECS: ReadonlyArray<string> = [
  // The runtime check of docs/network-inventory.md. Its whole job is to record
  // which hosts the REAL app contacts (Chromium net-log + _netAuditHook.cjs)
  // and fail on one the doc does not list — so it must see the app's real
  // attempts, production included. It never signs in or creates an account
  // (no token is ever sent), and it is an `_` sweep: never part of
  // `npm run test:e2e`, only run by name.
  '_networkInventory.spec.ts'
]
