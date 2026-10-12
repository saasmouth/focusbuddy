import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const assets = 'out/renderer/assets'
const files = readdirSync(assets).map((name) => ({ name, bytes: statSync(join(assets, name)).size }))
const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`
const limits = [
  { label: 'desktop entry', match: /^index-.*\.js$/, max: 3.5 * 1024 * 1024 },
  { label: 'shared app chunk', match: /^globals-.*\.js$/, max: 1.4 * 1024 * 1024 },
  { label: 'editor vendor chunk', match: /^vendor-editor-.*\.js$/, max: 0.9 * 1024 * 1024 },
  { label: 'renderer stylesheet', match: /^globals-.*\.css$/, max: 0.3 * 1024 * 1024 }
]

const failures = []
for (const limit of limits) {
  const matching = files.filter((file) => limit.match.test(file.name))
  if (matching.length === 0) {
    failures.push(`${limit.label}: expected output was not found`)
    continue
  }
  for (const file of matching) {
    if (file.bytes > limit.max) {
      failures.push(`${limit.label}: ${file.name} is ${mib(file.bytes)} (budget ${mib(limit.max)})`)
    }
  }
}

if (failures.length > 0) {
  console.error(`Bundle budget failed:\n${failures.map((failure) => `  ${failure}`).join('\n')}`)
  process.exit(1)
}
console.log('Bundle budget passed:')
for (const limit of limits) {
  for (const file of files.filter((candidate) => limit.match.test(candidate.name))) {
    console.log(`  ${limit.label}: ${mib(file.bytes)} / ${mib(limit.max)}`)
  }
}
