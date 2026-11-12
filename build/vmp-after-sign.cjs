// electron-builder afterSign hook: VMP-sign the WINDOWS app with castLabs EVS.
//
// On Windows the VMP signature must come AFTER Authenticode signing: Windows'
// VMP check rejects any change to a signed executable, so signing the .exe
// after it was VMP-signed would break it (castLabs EVS wiki). electron-builder
// Authenticode-signs while packing and calls afterSign before it builds the
// NSIS installer, which is the one point that satisfies both.
//
// macOS is the other way round (VMP before Apple signing) and is handled in
// build/harden.cjs, so this hook does nothing there.
//
// Written for the Windows CI build (.github/workflows/build-windows.yml); it
// has not been run on a Windows machine yet. CI needs Python with
// castlabs-evs installed and EVS_ACCOUNT_NAME / EVS_PASSWD as secrets; without
// them it skips with the same log line as a Mac build (see build/vmp.cjs).
'use strict'

const { join } = require('node:path')
const { vmpSignPackage } = require('./vmp.cjs')

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'win32') return
  vmpSignPackage({
    platform: 'win32',
    pkgDir: context.appOutDir,
    nameHint: context.packager.appInfo.productFilename,
    resourcesDir: join(context.appOutDir, 'resources')
  })
}
