// @vitest-environment node
// The checksums compiled into the app are the integrity anchor for downloads;
// they must equal the manifest the upload script publishes.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { LOCAL_MODEL_TIERS, LOCAL_EMBED_MODEL } from '../../src/shared/localModelCatalog'
import { recommendTier, modelDownloadUrl, modelManifestUrl } from '../../src/shared/localAi'

const root = join(__dirname, '..', '..')
const manifest = JSON.parse(readFileSync(join(root, 'resources', 'local-models.json'), 'utf8'))

describe('local model catalog', () => {
  it('equals the published manifest, field by field', () => {
    expect(LOCAL_MODEL_TIERS.length).toBe(manifest.models.length)
    for (const m of manifest.models) {
      const t = LOCAL_MODEL_TIERS.find((x) => x.id === m.id)!
      expect(t, m.id).toBeTruthy()
      for (const k of ['bundleId', 'name', 'file', 'version', 'sizeBytes', 'sha256', 'license', 'licenseUrl', 'sourceUrl', 'contextSize', 'kvCache', 'minRamGB', 'recommendedRamGB']) {
        expect((t as Record<string, unknown>)[k], `${m.id}.${k}`).toEqual(m[k])
      }
    }
    for (const k of ['bundleId', 'name', 'file', 'version', 'sizeBytes', 'sha256', 'license', 'sourceUrl']) {
      expect((LOCAL_EMBED_MODEL as Record<string, unknown>)[k], `embed.${k}`).toEqual(manifest.embedding[k])
    }
  })

  it('ships a licence text for every model, and only permissive licences', () => {
    for (const m of [...manifest.models, manifest.embedding]) {
      expect(['Apache-2.0', 'MIT']).toContain(m.license)
      expect(existsSync(join(root, 'resources', 'local-model-licenses', m.licenseFile)), m.licenseFile).toBe(true)
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('downloads only from Plexii’s own host, laid out like the bundled folder: models/<bundleId>/<version>/', () => {
    for (const t of LOCAL_MODEL_TIERS) {
      expect(modelDownloadUrl(t)).toBe(`https://dl.plexiidesk.com/models/${t.bundleId}/${t.version}/${t.file}`)
      expect(modelManifestUrl(t)).toBe(`https://dl.plexiidesk.com/models/${t.bundleId}/${t.version}/manifest.sha256`)
    }
  })

  it('recommends by RAM and refuses machines below every tier', () => {
    const tiers = [
      { id: 'compact' as const, minRamGB: 8, recommendedRamGB: 8 },
      { id: 'standard' as const, minRamGB: 16, recommendedRamGB: 16 }
    ]
    expect(recommendTier(tiers, 8)?.id).toBe('compact')
    expect(recommendTier(tiers, 16)?.id).toBe('standard')
    expect(recommendTier(tiers, 64)?.id).toBe('standard')
    expect(recommendTier(tiers, 4)).toBeNull()
  })
})
