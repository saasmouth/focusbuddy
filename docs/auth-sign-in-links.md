# Sign-in links (`haptyx://auth`)

How Plexii signs in from the website or SSO. Two steps:

1. **4.3.53: the guard.** A link carrying a session is adopted silently only
   when it brings back the one-time `state` of a sign-in this app started.
2. **Step 2: one-time codes (PKCE).** A link carries a short-lived code, never a
   session token. Only this app, holding the PKCE verifier, can redeem the code.

The server and website halves are in haptyx-ecosystem: signal
`signal-desk-auth-codes`, and the website `web-desk-auth-codes`.

## The links

`shared/authLink.ts` parses each link. Plexii answers both `haptyx://` and
`plexii://`.

| Link | What it is | What Plexii does |
|---|---|---|
| `haptyx://auth?code=<code>&state=<state>` | A one-time code for a sign-in this app started. | Main finds the state. If it has it, main redeems the code once and adopts the session with no question. If not, the link is refused and never sent to the server. |
| `haptyx://auth?error=access_denied&state=<state>` | The person pressed Cancel on the website. | Spends the state. Says nothing. |
| `haptyx://auth/start` | The website's cold "Open in PlexiiDesk" button. | With nobody signed in, begins a sign-in in the browser. With someone signed in, says who is signed in and switches nobody. At most once per 30 s. |
| `haptyx://auth?token=<session>&…[&state=]` | The legacy link, kept while older builds are common. | Silent with this app's state; otherwise Plexii asks, naming the account the server says the token is. |

Precedence: `/start`, then an error, then a code, then a token. An error never
signs anyone in, and a code never falls back to a token in the same link.

## A sign-in this app starts

`main/signInNonce.ts` mints three things in `createSignIn`:

- a `state`: 24 random bytes, base64url;
- a PKCE `verifier`: 32 random bytes, base64url, 43 characters;
- the `codeChallenge`: S256 of the verifier.

The state and the verifier live in main's memory: 10 minutes, used once, at most
8 at a time. `auth:begin-sign-in` gives the renderer only the state and the
challenge. `lib/authHandoff.ts signInUrl` adds them to the URL it opens:

- **Website** (`/account/login`, `/account/signup`): `state`, `code_challenge`,
  `code_challenge_method=S256` and `client_id=plexiidesk`.
- **SSO** (`/auth/sso/start`): `state`, `code_challenge` and
  `code_challenge_method=S256`.

The verifier never leaves main: not to the renderer, and not into a URL.

## Redeeming a code

Only main redeems (`main/authCodeRedeem.ts`), using Electron's `net.fetch`.
That is Chromium's network stack, so it uses the system's certificates and proxy:

```
POST <signal>/auth/app/token   application/json
{ "grant_type": "authorization_code", "code": "…", "code_verifier": "…",
  "redirect_uri": "haptyx://auth", "client_id": "plexiidesk" }
200 { "sessionToken", "tokenType": "session", "expiresAt", "account": { "id", "email", "handle" } }
400 { "error": "invalid_grant" | "invalid_request" | "invalid_client" | "unsupported_grant_type", "message" }
429, 5xx
```

- `<signal>` is `productDomains ACTIVE.api`, unless `FB_SIGNAL_URL` or
  `SIGNAL_HTTP_URL` name another (the e2e harness, a developer). Plain http is
  allowed only to this machine.
- **Exactly one attempt.** A code is spent by its first try, and a second use of
  a used code ends the session it bought. There is no retry: after any failure
  the person signs in again.
- The session is a fresh desktop session, not the website's.

## What the person is told

`lib/authHandoff.ts receiveAuthNotice` shows one alert at a time:

| Why | Alert |
|---|---|
| No verifier for the state (another app's link, expired, or after a relaunch) | "This sign-in link has expired or wasn't started from this Plexii". Sign in again from Plexii. |
| The server said no | "This sign-in link has expired". Sign in again from Plexii. |
| The server couldn't be reached, was rate-limited or failed | "Plexii couldn't finish signing in". Check your connection, then sign in again. |

Each press of Continue on the website sends a fresh code. A second code link
for a state whose sign-in just finished (within 10 minutes) is quiet. It is not
redeemed, and no alert is shown on top of a sign-in that worked.

## Tests

- Units:
  - `signInNonce.test.ts`: the state, the verifier and S256;
  - `authLink.test.ts`: the link shapes;
  - `authCodeRedeem.test.ts`: the request, one attempt, refused or unreachable,
    and the timeout;
  - `authProtocolLinks.test.ts`: main's handling of every link;
  - `authHandoff.test.ts`: the URL and the notices.
- e2e `authCodeLink.spec.ts` AC-1..4 runs against a stand-in signal written to
  the contract. With `PLEXII_JOINT_SIGNAL=http://127.0.0.1:<port>`, pointing at
  a real signal on loopback, the stand-in becomes a recording proxy to it. Each
  test then signs a fresh account up there.

  Run the real signal from its repo with a throwaway database:

  ```
  DB_PATH=<tmp>/app.db DATA_DIR=<tmp> PORT=<p> HOST=127.0.0.1 RESEND_API_KEY= STRIPE_SECRET_KEY= DISABLE_SCHEDULER=1 node dist/server.js
  ```

  Never point it at a real host: the spec refuses anything but `127.0.0.1`.
- The guard's specs (`authLinkGuard.spec.ts`, `authDeepLinkConfirm.spec.ts`) still
  cover the legacy token link.
