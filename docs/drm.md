# Protected video (DRM) in desk web pages

Netflix and most paid streaming need Widevine, Google's DRM module (the CDM).
Stock Electron has none. Netflix in a desk page showed error **M7701-1003**,
which means "Widevine missing".

From 4.3.49, PlexiiDesk runs on **castLabs' Electron for Content Security (ECS)**,
`v45.2.1+wvcus`. ECS is Electron 45 plus the Widevine CDM, which Chromium's
component updater installs. Netflix needs one more thing, a **production VMP
signature**. Without it, Widevine works for test streams and Netflix refuses
the app. See [VMP signing](#vmp-signing-castlabs-evs).

## How it works

| Piece | Where | What it does |
|---|---|---|
| Runtime | `package.json` `electron: github:castlabs/electron-releases#v45.2.1+wvcus`; `electron-builder.cjs` `electronDownload.mirror` | Electron with the `components` API. The packager downloads castLabs' zips for both architectures. |
| CDM | `src/main/widevine.ts` `startWidevine()` | Calls `components.whenReady([WIDEVINE_CDM_ID])` at `ready` **without waiting**, so start-up is never delayed. On a first launch the CDM (~19 MB) downloads into `userData/WidevineCdm`, which took about 3–8 s in testing. |
| Every web page | `installDrmProbe()` registers `src/preload/drmProbe.ts` as a **session preload** on every non-default session (`persist:webview-default`, `persist:connectedapp-*`, …), for http(s) pages only. | Covers desk widgets, the web panel, Office's browser, connected apps and desk pop-ups. It is not a `<webview>` preload: `will-attach-webview` still strips those. No `plugins` flag is needed, because the CDM is not a plugin (`widevine.spec.ts` WV-1 proves it). |
| Wait | `src/shared/drmMainWorldProbe.ts` | A Widevine `requestMediaKeySystemAccess` waits until the CDM has settled (up to 30 s), then goes to the real function. A page opened during the first download plays once the CDM lands. |
| Notice | `src/shared/drm.ts` (decision), `components/browser/DrmNotice.tsx` (UI) | When protected video can't play, a calm bar above the page says **why** and offers **Open in your browser**. It never covers or blocks the page. |

**What counts as "can't play"** (`classifyDrm`):

- **Widevine missing.** `requestMediaKeySystemAccess('com.widevine.alpha')` is rejected while the CDM isn't ready. That covers no CDM (stock Electron), still downloading, and a failed download. The notice text names which.
- **The site refuses this build's DRM signature (VMP).** A Widevine licence fails (none arrives within 15 s, it's rejected, or every key is unusable) and this build has no production VMP signature. Netflix's own screen also counts: **M7121**, which castLabs' development-signed build gets (castlabs/electron-releases#122), or **M7701/M7702/M7703** while the CDM is present.
- **Licence error.** The same evidence on a production-signed build.

A rejected request while the CDM **is** ready is not reported. Sites probe several configurations and keep the one that works. Other Netflix codes are also not reported: VPN, region and bad-link errors are the site's own business.

The build records its VMP state in `Resources/vmp.json` (`production` or `none`). The notice reads it to choose between "VMP refused" and "licence error".

## VMP signing (castLabs EVS)

Widevine asks for a Verified Media Path: a binary castLabs has signed. There are two kinds of signature:

- ECS's own binaries carry a **development** signature. Widevine's test servers accept it; commercial services don't.
- castLabs' **EVS** service issues the **production** signature. It is free but needs an account. The **owner** signs up. No agent may.

### Sign up (once, on the build Mac)

The EVS client (castlabs-evs 1.3.3) is already installed on the build Mac, in a
virtualenv at `~/.castlabs-evs`. Homebrew's `python3` is "externally managed",
so `pip install` into it fails. Sign up with:

```sh
~/.castlabs-evs/bin/python -m castlabs_evs.account signup
```

On another Mac, create the virtualenv first:

```sh
python3 -m venv ~/.castlabs-evs
~/.castlabs-evs/bin/python -m pip install --upgrade castlabs-evs
```

`signup` asks for an email, your name, an organisation, an account name and a
password. It then asks for the confirmation code castLabs emails you. The
account token is saved in `~/.config/evs/config.json`.

The token expires after about a month. Before a build after a long gap, refresh it:

```sh
~/.castlabs-evs/bin/python -m castlabs_evs.account reauth
```

### What the build does

- **macOS:** `build/harden.cjs` (afterPack) runs these steps in order:
  1. Flips the fuses, once per architecture slice.
  2. Deletes castLabs' per-slice development `Electron Framework.sig`. The fuses invalidated it, and the two slices' copies differ, which `@electron/universal` refuses to merge.
  3. `@electron/universal` merges the slices.
  4. On the merged app, checks the asar integrity.
  5. Runs `castlabs_evs.vmp sign-pkg` then `verify-pkg` (`build/vmp.cjs`).
  6. electron-builder then signs with Apple and notarises.

  castLabs requires VMP **before** Apple signing on macOS, and EVS signs the fat (universal) framework binary as one.
- **Windows:** `build/vmp-after-sign.cjs` (afterSign) signs **after** Authenticode, as castLabs requires there. It is written for the Windows CI build but **has not been run yet**. CI needs Python with `castlabs-evs`, plus `EVS_ACCOUNT_NAME` / `EVS_PASSWD` as secrets.
- **No account:** the build continues and logs
  `[vmp] SKIPPED VMP signing: no castLabs EVS account on this machine …`.
  The app is still Apple-signed, with `vmp.json` = `none`.
- `PLEXII_VMP=require` fails the build instead of skipping; use it for releases once the account exists. `PLEXII_VMP=off` never signs. The EVS client's Python is found from `EVS_PYTHON`, then `~/.castlabs-evs/bin/python`, then `python3`.
- `verify-pkg` is local and needs no account. It rejects castLabs' development certificate, so a build that says "signed" really has a production signature.

### Rebuild after signing up

Build in the drm worktree, using the Apple signing lock shared with the other build agents:

```sh
cd /Users/mymac/plexii-work/drm-desk
mkdir /Users/mymac/plexii-work/.apple-signing.lock   # wait if it exists
PLEXII_VMP=require node scripts/release-env.mjs npm run dist:mac:universal:signed
rmdir /Users/mymac/plexii-work/.apple-signing.lock
SKIP_WARMUP=1 npm run install:local -- --no-build
```

The build log must show `[vmp] production VMP signature applied and verified`.
`Contents/Resources/vmp.json` must say `"vmp": "production"`.

## The fuse wire changed (one-way for cookies)

EVS signs only castLabs' release binary with one of two fuse wires: the
default, or one fixed set (castlabs/electron-releases#152). The old three-fuse
wire was neither, so EVS would refuse it. `build/fuses.cjs` is now castLabs'
set exactly, and `tests/unit/fuses.test.ts` pins it. The changes:

- RunAsNode, NODE_OPTIONS and `--inspect` stay **off**, as before.
- **New, cookie encryption:** cookies are encrypted with the `plexii Safe Storage` keychain key. This is **one-way**. If an older build (4.3.48 or earlier) opens the same profile afterwards, it can't read cookies this build wrote, so sites whose cookies changed will ask you to sign in again. To try a build without touching your everyday profile, launch it on a separate one:
  `open -n "/Applications/PlexiiDesk 4.3.49-drm.1.app" --env FB_TEST_USER_DATA="$HOME/plexii-drm-profile"`
  That profile has its own sign-in and its own single-instance lock, so it runs beside your everyday copy.
- **New, embedded asar integrity:** `harden.cjs` checks the Info.plist hash against the asar before signing.
- **New, only load the app from the asar.**

## Tests

- **Unit:**
  - `tests/unit/drm.test.ts`: the decision and the notice copy.
  - `tests/unit/drmMainWorldProbe.test.ts`: the injected script, run from its source text.
  - `tests/unit/vmpSign.test.ts`: sign, skip or fail, with the exact EVS commands.
  - `tests/unit/fuses.test.ts`: the fuse wire.
- **e2e:** `tests/e2e/widevine.spec.ts`, on the built app, in the background.
  - **WV-1:** Widevine resolves in a desk page, and a public Widevine stream plays. Shaka's demo asset is licensed by Widevine's test proxy; the test checks that `currentTime` advances and frames are decoded.
  - **WV-2:** with Widevine refused, the notice appears and "Open in your browser" works.
  - **WV-3:** Netflix's M7121 screen, served locally, gives the VMP notice.
- **Playwright switches the component updater off** for every app it launches (`--disable-component-update` in its loader). Specs that need the CDM load `tests/e2e/_componentUpdates.cjs` to turn it back on.
- **Mutation proof:** WV-1 must fail when run either of these ways:
  - `ELECTRON_OVERRIDE_DIST_PATH=<stock Electron dist> npx playwright test tests/e2e/widevine.spec.ts -g WV-1`
  - `E2E_WIDEVINE_MUTANT=no-cdm npx playwright test tests/e2e/widevine.spec.ts -g WV-1`

## Not covered by tests

- **Netflix itself.** There is no test account here, and no production VMP signature yet.
- **The Windows VMP hook.** It has never run.

## Upgrading ECS

```sh
npm install --save-dev "https://github.com/castlabs/electron-releases#v<version>+wvcus"
node node_modules/electron/install.js       # ECS 45 downloads its binary lazily
npm run rebuild && npm run natives:x64 && npm run natives:universal && npm run natives:check
```

Pick a release from castLabs' **supported** list
(<https://github.com/castlabs/electron-releases/wiki#supported-versions>).
From 46.0 the CDM is installed only once the app calls
`components.whenReady()` or `components.start()`. `startWidevine()` already
does the first. Re-run `widevine.spec.ts` after any upgrade.
