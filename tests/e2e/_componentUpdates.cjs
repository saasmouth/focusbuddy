// Give an e2e app its component updater back (tests/e2e/widevine.spec.ts).
//
// Playwright's Electron loader appends its standard Chromium test switches to
// every app it launches, `--disable-component-update` among them
// (playwright-core lib/server/electron/loader.js, chromiumSwitches). The
// Widevine CDM IS a component: with that switch ECS never registers it, and
// components.whenReady rejects with "Unsupported component". A real launch of
// PlexiiDesk has no such switch.
//
// Loaded with `-r` after Playwright's loader (launchApp preArgs), this takes
// that one switch back out before Chromium reads it at start-up. Nothing else
// changes, and only specs that pass it get it.
'use strict'
const { app } = require('electron')

app.commandLine.removeSwitch('disable-component-update')
