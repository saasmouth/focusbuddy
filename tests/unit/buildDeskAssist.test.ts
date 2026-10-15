// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The build-desk modal's AI assist: on by default, uncapped, fully configured,
// and previewable before you commit.
//
// What was wrong, in the operator's words: it shipped "a shell of a widget".
// Literally so — the new-desk path had its own prompt asking for "4–7
// suggestions" in a shape with NO configuration fields, and the spawn next to
// it wrote `s.content ?? ''`. A suggested table therefore arrived with no
// columns and a suggested page with no content, and you could not tell until it
// was already on your desk.

const ROOT = join(__dirname, '..', '..', 'src')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const anthropic = read('main/ai/anthropic.ts')
const newNode = read('renderer/src/components/NewNodeDialog.tsx')
const setupDialog = read('renderer/src/components/AISetupDialog.tsx')
const builder = read('renderer/src/components/AiBuilderDialog.tsx')
const preview = read('renderer/src/components/ai/SuggestionPreview.tsx')
const materialize = read('renderer/src/lib/materializeSuggestion.ts')
const canvas = read('renderer/src/components/Canvas.tsx')
const sidebar = read('renderer/src/components/Sidebar.tsx')
const types = read('shared/types.ts')

describe('AI assist is on by default', () => {
  it('starts enabled rather than off', () => {
    expect(newNode).toContain('useState(aiSetupEnabled)')
    expect(newNode).not.toContain('const [autoSuggestAI, setAutoSuggestAI] = useState(false)')
  })

  it('is seeded from the capability, not from a bare true', () => {
    // The checkbox only renders when ai_task_setup is entitled, so `true` would
    // leave it on for someone who can neither see nor clear it.
    expect(newNode).toContain('if (!touchedAutoSuggest.current) setAutoSuggestAI(aiSetupEnabled)')
  })

  it('still refuses to open a surface the user is not entitled to', () => {
    expect(newNode).toContain('if (autoSuggestAI && aiSetupEnabled && onRequestAISetup) {')
  })

  it('stops following the capability once the user decides for themselves', () => {
    expect(newNode).toContain('touchedAutoSuggest.current = true')
  })
})

describe('as many suggestions as the desk needs', () => {
  it('no numeric cap survives in the build prompt', () => {
    expect(anthropic).not.toContain('4-8 suggestions')
    expect(anthropic).not.toContain('4–7 suggestions')
    expect(anthropic).not.toContain('Aim for 4')
  })

  it('asks for a comprehensive setup instead of a count', () => {
    expect(anthropic).toContain('SUGGEST AS MANY AS THE WORK GENUINELY NEEDS')
    expect(anthropic).toContain('no target count and no')
  })

  it('still demands each one earn its place, so this is not licence to pad', () => {
    expect(anthropic).toContain('padding is worse than brevity')
  })
})

describe('nothing arrives as a shell', () => {
  it('the prompt makes configuration mandatory, per kind', () => {
    expect(anthropic).toContain('NEVER SHIP A SHELL')
    expect(anthropic).toContain('tableSchema.columns is REQUIRED')
    expect(anthropic).toContain('pageContent is REQUIRED')
    expect(anthropic).toContain('fieldDef is REQUIRED')
    // Selects with no options are the common half-configured case.
    expect(anthropic).toContain('config.options with labels AND hex colours')
  })

  it('and says plainly that an unconfigurable suggestion should not be made', () => {
    expect(anthropic).toContain('A suggestion you cannot configure is a suggestion you should not make')
  })

  it('the new-desk path uses the rich suggestion shape', () => {
    // It used to be WidgetSuggestion: kind/title/content/reason and nothing
    // that could carry a table's columns.
    const resp = types.slice(types.indexOf('export interface SetupSuggestResponse'))
    expect(resp).toContain('suggestions?: AiBuildSuggestion[]')
  })

  it('there is ONE suggestion engine, not two prompts to drift apart', () => {
    const fn = anthropic.slice(
      anthropic.indexOf('export async function suggestSetupWidgets'),
      anthropic.indexOf('export async function generateResume')
    )
    expect(fn).toContain('await buildFromPrompt({ prompt, taskId })')
    // And it keeps the desk signals the old prompt had.
    expect(fn).toContain('node.title')
    expect(fn).toContain('most-visited pages')
  })

  it('every accept path materialises the configuration', () => {
    // Shared, because it was inline in the builder's handler only — which is
    // exactly why the new-desk path next to it spawned empty containers.
    expect(materialize).toContain('window.api.tables.create')
    expect(materialize).toContain('JSON.stringify(s.pageContent)')
    expect(materialize).toContain("JSON.stringify({ def: s.fieldDef, value: null })")
    expect((canvas.match(/materializeSuggestion\(/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(sidebar).toContain('materializeSuggestion(')
  })

  it('a missing id cannot make two cards toggle together', () => {
    expect(anthropic).toContain('`s${i + 1}`')
  })
})

describe('you can see it before you commit to it', () => {
  it('both dialogs render the preview', () => {
    expect(setupDialog).toContain('<SuggestionPreview s={s} />')
    expect(builder).toContain('<SuggestionPreview s={suggestion} />')
  })

  it('there is only ONE preview implementation', () => {
    // The builder had its own; a second copy is how the two end up showing
    // different things for the same suggestion.
    expect(builder).not.toContain('function SuggestionPreview')
    expect(preview).toContain('export default function SuggestionPreview')
  })

  it('a table previews its real columns and their types', () => {
    expect(preview).toContain('data-testid="preview-table"')
    expect(preview).toContain('c.label')
    expect(preview).toContain('c.type')
  })

  it('a page previews its actual headings and tasks', () => {
    expect(preview).toContain('data-testid="preview-page"')
    expect(preview).toContain('pageOutline')
  })

  it('a link previews where it actually goes', () => {
    expect(preview).toContain('data-testid="preview-link"')
    expect(preview).toContain('new URL(s.content)')
  })

  it('select options are shown, since they are otherwise invisible until opened', () => {
    expect(preview).toContain('options')
    expect(preview).toContain('backgroundColor: `${o.color}22`')
  })
})

describe('the preview is honest', () => {
  it('says so when something arrived unconfigured instead of looking fine', () => {
    expect(preview).toContain('No columns configured')
    expect(preview).toContain('No content configured')
    expect(preview).toContain('No URL configured')
  })

  it('does not invent table rows to pad the grid', () => {
    expect(preview).toContain('They are\n                  blank on purpose')
  })

  it('renders nothing rather than an empty box pretending to be a preview', () => {
    expect(preview).toContain('Nothing to show rather than an empty box')
    expect(preview.trimEnd().endsWith('return null\n}')).toBe(true)
  })
})
