import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const patterns = [
  { name: 'Anthropic API key', re: /sk-ant-api03-[A-Za-z0-9_-]{20,}/g },
  { name: 'OpenAI project key', re: /sk-proj-[A-Za-z0-9_-]{20,}/g },
  { name: 'GitHub personal access token', re: /ghp_[A-Za-z0-9]{30,}/g },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'private key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g }
]
const binaryExtensions = /\.(?:png|jpe?g|gif|webp|ico|icns|woff2?|ttf|zip|dmg|exe|pdf|mp[34]|mov)$/i
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
const findings = []

for (const file of files) {
  if (binaryExtensions.test(file) || file === 'package-lock.json') continue
  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  for (const pattern of patterns) {
    pattern.re.lastIndex = 0
    for (const match of source.matchAll(pattern.re)) {
      // Deliberately invalid value used to exercise the encrypted settings IPC.
      if (match[0].includes('DUMMYKEYFORPIPELINETEST')) continue
      const line = source.slice(0, match.index).split('\n').length
      findings.push(`${file}:${line} — ${pattern.name}`)
    }
  }
}

if (findings.length > 0) {
  console.error(`Potential committed secrets found:\n${findings.map((item) => `  ${item}`).join('\n')}`)
  process.exit(1)
}
console.log(`Secret scan passed (${files.length} tracked files checked).`)
