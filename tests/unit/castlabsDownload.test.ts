// @vitest-environment node
// The packager must download castLabs' Electron (ECS), not stock Electron, for
// both architectures of the universal build (electron-builder.cjs
// electronDownload). The URL is composed by the same @electron/get that
// electron-builder uses, so this asks THAT code what it would fetch.
//
// Why it exists: castLabs' wiki gives the mirror as ".../releases/download/v"
// (for an older downloader), and with electron-builder 26 that produced
// ".../download/vv45.2.1+wvcus/…", a 404, at the first signed build.
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = join(__dirname, '..', '..')

const config = require(join(ROOT, 'electron-builder.cjs')) as { electronDownload?: { mirror?: string } }
const ecsVersion = (require(join(ROOT, 'node_modules', 'electron', 'package.json')) as { version: string }).version
const electronGet = require(
  require.resolve('@electron/get/dist/cjs/artifact-utils.js', {
    paths: [dirname(require.resolve('app-builder-lib/package.json', { paths: [ROOT] }))]
  })
) as {
  getArtifactVersion: (d: { version: string }) => string
  getArtifactRemoteURL: (d: Record<string, unknown>) => Promise<string>
}

describe("the packager downloads castLabs' Electron", () => {
  it('node_modules holds an ECS (+wvcus) release', () => {
    expect(ecsVersion).toMatch(/^\d+\.\d+\.\d+\+wvcus$/)
  })

  for (const arch of ['x64', 'arm64']) {
    it(`asks castLabs' release for the darwin-${arch} zip, at the right address`, async () => {
      const version = electronGet.getArtifactVersion({ version: ecsVersion })
      const url = await electronGet.getArtifactRemoteURL({
        version,
        platform: 'darwin',
        arch,
        artifactName: 'electron',
        mirrorOptions: { mirror: config.electronDownload?.mirror }
      })
      expect(url).toBe(
        `https://github.com/castlabs/electron-releases/releases/download/v${ecsVersion}/electron-v${ecsVersion}-darwin-${arch}.zip`
      )
    })
  }
})
