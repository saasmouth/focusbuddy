# Calculator, SME doc (master of destiny)

Tier: Sufficient. This widget does not have to beat best of breed at launch, it
has to do its small job cleanly and feel native to the canvas, so the bar is
"reliable, fast, and obviously good enough that nobody reaches for the macOS
calculator instead."

## The use case

Someone is mid-task on the canvas and needs a number now. They are pricing a
quote sitting next to a notes widget, splitting a bill, working out how many
hours a sprint estimate adds up to, or sanity checking a figure before it goes
into a table or a message. They do not want to alt-tab to the system calculator,
lose their place, and lose the result the moment they close it. They want a
small, dependable keypad that sits on the desk next to the work it serves, holds
its last expression, and is there again tomorrow. The moment of use is "I need a
quick number without leaving what I am doing."

## Current state

The widget is a single self-contained component at
`src/renderer/src/components/widgets/CalculatorWidget.tsx`. It is registered in
`src/renderer/src/lib/widgetCatalog.ts` under kind `calculator` (label "Calc",
category Tools, default 200x300), wired into the canvas renderer in
`src/renderer/src/components/Canvas.tsx`, supported as an inline render in
`src/renderer/src/components/WidgetFocusMode.tsx`, declared in the widget-kind
union in `src/shared/types.ts`, and offered as a creatable kind by the voice and
AI command path in `src/main/ai/voiceCommand.ts`.

What works today:
- A four-column keypad with digits, the four operators, percent, decimal point,
  clear, backspace, and equals. Operators show pretty glyphs but map to real
  symbols, so the times key inserts `*` and the divide key inserts `/`.
- A live preview. As you build the expression the result is evaluated on every
  keystroke and shown under the raw expression, so you see the answer before you
  press equals.
- Evaluation is guarded. The input must match a strict allowlist regex
  (`/^[0-9+\-*/%.()\s]+$/`) before it is ever evaluated, the result must be a
  finite number, and the value is rounded to ten decimal places to hide float
  noise. Anything else renders "error" rather than throwing.
- The expression persists. The current expression is stored in `widget.content`
  with a 400ms debounced save through the widget store, so the calculator
  remembers what you typed across reloads and rides along in canvas snapshots
  like any other widget.
- It renders both as a framed canvas widget and inline in focus mode, scaling
  the type and padding up for the larger inline view.

Rough edges, honestly:
- Evaluation is `new Function("return (" + expr + ")")`. The allowlist regex is
  the only thing standing between a stored expression and arbitrary code, and a
  raw JS eval is the wrong long-term engine. It cannot do anything the
  competitors below treat as table stakes, and it is a smell worth removing.
- There is no history and no tape. Once you press equals or clear, the previous
  result is gone. Soulver, PCalc, and Apple all keep a running record, this keeps
  one line.
- No memory keys, no variables, no named values. You cannot store a subtotal and
  reuse it.
- No scientific functions at all. No powers, roots, trig, logs, or constants, so
  the percent and four operators are the entire vocabulary.
- No units, no currency, no dates. "42 meters + 143 feet" or "$20 - 5%" is
  meaningless here, and those are exactly the phrases the modern apps sell on.
- No keyboard input wiring. The buttons are click-only. You cannot type digits or
  operators from the hardware keyboard while the widget is focused, which is the
  first thing anyone tries.
- No natural language. It is a symbol keypad, not a notepad, so it shares nothing
  with the category that currently defines a good desktop calculator.
- The result does not flow anywhere. There is no way to send the answer into a
  table cell, a field, a note, or down a wire to another widget. The number lives
  and dies inside the widget.
- No copy button on the result, so getting the answer out means selecting text in
  a tiny display.

## Best-of-breed landscape

- **Soulver 3** owns the notepad-calculator idea. You write in plain language
  across many lines, every line evaluates live, lines reference each other like a
  spreadsheet, and it carries variables, conditional "if" expressions, more than
  three hundred units, currency, dates and times, time zones, and financial
  functions like compound interest and mortgage repayments. It is the product
  people mean when they say a calculator should feel like thinking on paper.
- **Numi** is the same idea with a cleaner, more minimal face, on Mac, Windows
  and Linux. Plain-language input, a right-hand column of results with a running
  total, variables, currency and unit and timezone conversion, date arithmetic,
  and JavaScript extensions for custom units and functions.
- **Apple Calculator with Math Notes** is now the default everyone has for free.
  Beyond the basic and scientific and programmer modes it keeps a history,
  converts hundreds of units and live currency inline, lets you define and reuse
  variables, and will even plot an equation. A free, preinstalled app that does
  variables, history, and unit conversion is the floor we are measured against.
- **PCalc** owns the serious-tool end. RPN mode, programmer and scientific
  functions, hex, octal and binary, engineering and scientific notation, a deep
  set of unit conversions, a paper tape, and heavy layout customization. It is
  what an engineer reaches for.

What we already do better, or uniquely could. None of those four live on an
infinite canvas next to the table, the notes, and the browser tab for the same
piece of work. None can have their result wired into another widget. None sit
inside a system where an AI on the same surface can read the desk and drop a
calculator preloaded with the figures from a nearby note. None keep every
keystroke local by default as a consequence of the whole app being local-first.
Our calculator is weaker than all of them at being a calculator, and better
positioned than all of them at being part of a workspace.

## Gap analysis (ranked, each tied to a competitor + a user moment)

1. **No keyboard input (Apple, every calculator ever).** "I clicked the widget
   and started typing and nothing happened." This is the most basic expectation
   and the fastest way to feel broken. It should be the first fix.
2. **No history or tape (Apple Math Notes, PCalc, Soulver).** "What was that
   subtotal I worked out a minute ago." Pressing equals erases the prior line, so
   the widget cannot support a chain of related sums, which is most real use.
3. **No copy-the-result and no send-the-result (all four, plus our own canvas).**
   "I worked out the total, now I have to retype it into the table." The answer
   should be one click to clipboard and, uniquely for us, sendable into a field
   or table cell.
4. **No variables or memory (Soulver, Numi, Apple).** "Store this margin, reuse
   it three times." Without named or stored values every multi-step calculation
   restarts from scratch.
5. **No scientific functions (PCalc, Apple scientific mode).** "I need a square
   root or a power." For anyone past arithmetic the vocabulary simply runs out.
6. **No units, currency, or dates (Soulver, Numi, Apple).** "$20 minus 5 percent"
   or "today plus two weeks." The defining feature of the modern category is
   entirely absent.
7. **A raw JS eval as the engine (correctness and safety).** Not a user-visible
   gap on day one, but it caps every feature above and is the wrong foundation to
   build history, variables, units, or functions on.

## The supersonic plan

### Launch-blocking (must ship to clear "Sufficient")
- **Hardware keyboard input.** When the widget is focused, digits, operators,
  decimal, Enter for equals, Backspace, and Escape for clear all drive the same
  `press` path the buttons use. Acceptance: a user can complete a full
  calculation without touching the mouse, matching the baseline every other
  calculator meets.
- **Copy the result.** A copy affordance on the result line, plus Cmd-C copying
  the evaluated answer when the widget is focused. Acceptance: the answer reaches
  the clipboard in one action, so it is no longer faster to retype it than to copy
  it, closing the most common friction against Apple's calculator.
- **A real expression engine, not `new Function`.** Replace the JS eval with a
  small dedicated arithmetic parser and evaluator (shunting-yard or equivalent)
  that handles the four operators, percent, parentheses, and unary minus
  correctly, with no code execution path. Acceptance: the same inputs produce the
  same answers, the stored-expression eval can no longer run arbitrary JS, and the
  engine is ready to grow functions and units onto.

### Launch-polish
- **Running tape with history.** Keep the last several expressions and results in
  `widget.content` as structured lines rather than one string, show them scrolling
  above the keypad, and let a tap on a past result reuse it. Acceptance: a user can
  chain three related sums and refer back to the first, parity with Apple's history
  and a step toward Soulver's notepad feel.
- **Scientific row.** An optional second key row, revealed when the widget is wide
  enough or via a toggle, with power, square root, parentheses already typeable,
  and the common constants. Acceptance: a square root and a power both evaluate
  correctly, covering the everyday slice of PCalc and Apple scientific mode.
- **Stored value and one named variable.** Memory-plus and memory-recall, and the
  ability to label the current result and reference it on a later line.
  Acceptance: a user stores a margin once and reuses it, the entry point into the
  Soulver and Numi variable story.

### Post-launch (pull ahead)
- **Send the result down a wire.** Let the evaluated number be an output the
  ghost-line wiring can carry, so a calculator can feed a field, a table cell, or
  a desk agent. Acceptance: a wire from the calculator updates a target widget
  with the answer, something none of the four competitors can do because none live
  on a wired canvas.
- **Natural-language line input.** A text mode where "$20 in eur minus 5 percent"
  or "today plus two weeks" evaluates, built on the new engine with a units and
  currency and dates layer. Acceptance: a representative Soulver or Numi phrase
  returns the right answer, moving us from keypad into the notepad category.
- **AI-seeded calculator.** When the in-place AI creates a calculator it can
  preload the expression from numbers in nearby widgets, for example summing the
  line items in an adjacent note. Acceptance: "add up these figures" on the canvas
  drops a calculator already showing the total, which no standalone calculator can
  do because none can read the surrounding desk.

## The unfair advantage

Two things are ours alone. The first is wiring. Our calculator sits on a canvas
where widgets connect with ghost-line wires, so its result can stop being a dead
number trapped in a display and become a live output that drives a field, a table
cell, or a desk agent. No standalone calculator, however powerful, can do that
because none of them live next to the things the answer is for. The second is the
in-place AI on the same local surface. The AI can see the desk, so it can create a
calculator already loaded with the figures from a nearby note and hand back the
total, and it does all of this without a single keystroke leaving the machine.
The plan above first makes the widget a calculator people trust, then turns it
into the only calculator that is genuinely part of the work around it.

## Implementation log

- 2026-06-09, SME doc created; no implementation started yet.
