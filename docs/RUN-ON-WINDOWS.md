# Running Haptyx in dev mode on Windows

This is the local-testing path: run the app from source on a Windows machine with
hot reload, no installer, no code signing. macOS-only features degrade rather
than crash (see the end of this doc for exactly what is limited).

The app runs under Electron, so the one native dependency, `better-sqlite3`, has
to be compiled against Electron's ABI. That is the only step that needs a C++
toolchain; everything else is plain `npm`.

## 1. Install the prerequisites

1. **Node.js 20 LTS** from <https://nodejs.org> — specifically the **20.x**
   line, not the "Current"/latest button. The repo pins Node 20 in `.nvmrc`
   and `package.json` `engines`. This matters: Node 22+ changed the native-module
   ABI, and a too-new Node is the most common "conflicting node version" failure
   when `better-sqlite3` is rebuilt. If you already installed Node 22/24, either
   switch to 20 (use `nvm-windows`: `nvm install 20 && nvm use 20`) or accept
   that you may need the newer build toolchain — Node 20 is the path of least
   resistance. During the installer, tick "Automatically install the necessary
   tools (native modules)" — that pulls in the Visual Studio Build Tools (the
   C++ compiler) and Python, which is what `better-sqlite3` needs to build.
2. **Git** from <https://git-scm.com>, if it isn't already installed.

If you skipped the build-tools checkbox, install them afterwards from an
**Administrator PowerShell**:

```powershell
npm install --global windows-build-tools
```

(or install "Desktop development with C++" from the Visual Studio Build Tools
installer, plus Python 3 — same result).

## 2. Get the code

Open **PowerShell** (or Windows Terminal) and clone the repo, then switch to the
working branch:

```powershell
git clone https://github.com/saasmouth/focusbuddy.git
cd plexii
git checkout rebrand/archeon
```

The repo root *is* the app — `package.json`, `electron-vite`, and `src/` are all
right here, no subfolder to descend into.

## 3. Install dependencies

```powershell
npm install
```

`node-mac-haptics` is a macOS-only optional dependency; npm will note that it
failed to build and carry on. That is expected and harmless on Windows.

## 4. Build the native module for Electron

`npm install` built `better-sqlite3` for plain Node, but the app loads it inside
Electron, which has a different ABI. If you skip this step the app starts and
then dies with a "was compiled against a different Node.js version" /
NODE_MODULE_VERSION error. Rebuild it against Electron's ABI:

```powershell
npm run rebuild:win
```

That runs `electron-rebuild -f -w better-sqlite3`, which rebuilds exactly that
one module for the installed Electron version. It either downloads a prebuilt
Electron binary or compiles one (which is why you installed the C++ tools in
step 1). It takes a minute the first time, and you only need to re-run it after
changing the Electron version or reinstalling `node_modules`.

Use `rebuild:win`, not `npm run rebuild`. The latter (`electron-builder
install-app-deps`) tries to rebuild *every* native dependency and can hang on
the optional macOS haptics module. The targeted command avoids that entirely.

## 5. (Optional) Add an API key for the AI features

The app runs without a key, but the AI features (desk agents, the command bar,
living pages, mind-map expand) need one. Create a file named `.env` in the repo
root:

```
ANTHROPIC_API_KEY=sk-ant-...
```

The app reads `.env` from the project root in dev. Do not commit this file — it
is already gitignored. You can also paste the key into the app's settings later
instead of using `.env`.

## 6. Run it

```powershell
npm run dev
```

electron-vite builds the main and preload processes, starts the renderer dev
server, and launches the Electron window. Leave this terminal open; it is the
live dev server.

That's it — the app is now running locally on Windows.

## Day-to-day dev loop

- **Renderer changes** (anything under `src/renderer`) hot-reload instantly.
- **Main or preload changes** (`src/main`, `src/preload`) do NOT hot-reload. Stop
  the dev server (Ctrl+C in the terminal) and run `npm run dev` again. A plain
  in-window reload is not enough — this is the single most common "why didn't my
  change show up" gotcha.
- **Dev tools** open automatically (detached) in dev.
- The **performance overlay** toggles with **Ctrl+Shift+M** (the Mac Cmd+Shift+M
  equivalent). Each browser widget is its own renderer process; the overlay now
  labels each process with the widget that owns it.
- Your data (the SQLite DB, cookies, settings) lives under
  `%APPDATA%\Haptyx` (or `\plexii` depending on the build's product name).
  Delete that folder for a clean slate.

## What's limited on Windows vs macOS

These features are macOS-native and degrade on Windows; nothing else is affected:

- **Haptics** fall back to the existing audio cue.
- **Native app launching** is launcher-only: clicking a connected-app tile opens
  the app via the OS shell, but the live "mirror" punch-through view and the
  unhide/unminimise/foreground choreography are macOS-only.
- **Stream-deck media keys / volume** actions are disabled (they drive macOS via
  AppleScript).
- **Foreground-app activity tracking** is off (also AppleScript-based).
- The **title bar** uses the standard Windows chrome instead of the macOS
  hidden-inset style.

Everything else is cross-platform and works the same: the `<webview>` browser
widgets, encrypted key storage (via Windows DPAPI), SQLite, the agent browser
control, file import, and the entire widget set.

## Troubleshooting

- **`'env' is not recognized` (running `npm run dev`)** — you're on an old
  checkout from before the cross-platform fix. Run `git pull` on
  `rebrand/archeon`; the dev scripts now go through `scripts/dev.cjs`. This is
  the "Mac-specific thing in the config" — the old `dev` script literally began
  with the Unix-only `env -u` command.
- **"conflicting node version" / node-gyp build failure during `npm install` or
  rebuild** — you're on Node 22+ with the older `node-gyp`. `git pull` (the
  `node-gyp` override is now v11, which supports newer Node), delete
  `node_modules` and `package-lock.json` is NOT needed, just re-run
  `npm install`. The surest fix is still to run Node 20 to match `.nvmrc`.
- **`better-sqlite3` fails to load / "was compiled against a different Node.js
  version"** — re-run `npm run rebuild:win`. If it fails to compile, the C++
  build tools from step 1 aren't installed.
- **A blank window or the app exits immediately as Node** — an inherited
  `ELECTRON_RUN_AS_NODE` env var. The dev launcher strips it; make sure you're
  starting with `npm run dev`, not by invoking Electron directly.
- **Native module build errors mentioning Python or `node-gyp`** — the build
  toolchain is missing or partial. Reinstall Node 20 with the native-modules
  checkbox ticked, or install the VS Build Tools "Desktop development with C++"
  workload plus Python 3.
