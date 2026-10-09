// Arithmetic for the calculator widget, without eval.
//
// The widget used to evaluate its expression with `new Function`. The renderer's
// Content-Security-Policy is `script-src 'self'` with no 'unsafe-eval', so
// Chromium refuses that call: one evaluation can slip through early, and every
// one after it throws an EvalError, which the widget showed as "error" for any
// expression at all. This is a small recursive-descent parser over exactly the
// grammar the keypad can produce, with the same results JavaScript gives:
//
//   expr   = term (("+" | "-") term)*
//   term   = unary (("*" | "/" | "%") unary)*      — % is remainder, as in JS
//   unary  = ("+" | "-") unary | primary
//   primary = number | "(" expr ")"
//   number = digits ["." digits] | "." digits
//
// Returns the value, or null for anything malformed or not finite (1/0, 0/0).

export function evaluateArithmetic(input: string): number | null {
  const s = input
  let i = 0
  const skip = (): void => {
    while (i < s.length && /\s/.test(s[i])) i++
  }

  function number(): number | null {
    skip()
    const start = i
    while (i < s.length && /[0-9]/.test(s[i])) i++
    if (s[i] === '.') {
      i++
      while (i < s.length && /[0-9]/.test(s[i])) i++
    }
    const text = s.slice(start, i)
    if (text === '' || text === '.') return null
    return Number(text)
  }

  function primary(): number | null {
    skip()
    if (s[i] === '(') {
      i++
      const v = expr()
      skip()
      if (v === null || s[i] !== ')') return null
      i++
      return v
    }
    return number()
  }

  function unary(): number | null {
    skip()
    if (s[i] === '-' || s[i] === '+') {
      const neg = s[i] === '-'
      i++
      const v = unary()
      return v === null ? null : neg ? -v : v
    }
    return primary()
  }

  function term(): number | null {
    let v = unary()
    for (;;) {
      if (v === null) return null
      skip()
      const op = s[i]
      if (op !== '*' && op !== '/' && op !== '%') return v
      i++
      const r = unary()
      if (r === null) return null
      v = op === '*' ? v * r : op === '/' ? v / r : v % r
    }
  }

  function expr(): number | null {
    let v = term()
    for (;;) {
      if (v === null) return null
      skip()
      const op = s[i]
      if (op !== '+' && op !== '-') return v
      i++
      const r = term()
      if (r === null) return null
      v = op === '+' ? v + r : v - r
    }
  }

  const v = expr()
  skip()
  if (v === null || i !== s.length || !Number.isFinite(v)) return null
  return v
}
