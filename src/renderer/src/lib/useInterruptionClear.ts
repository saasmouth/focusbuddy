import { useEffect, useState } from 'react'

/**
 * An interruption owner normally wraps the modal it coordinates. Resolve from
 * the modal itself OR its nearest wrapper so a presentational inner dialog
 * cannot accidentally classify its own prompt as a competing interruption.
 */
export function interruptionOwnerOf(element: HTMLElement): string | undefined {
  return element.closest<HTMLElement>('[data-interruption-owner]')?.dataset.interruptionOwner
}

/**
 * Lets low-priority prompts wait until the app has had a quiet, modal-free
 * window. The nearest owner attribute prevents a prompt from detecting itself
 * after it mounts and oscillating open/closed.
 */
export function useInterruptionClear(owner: string, quietMs = 500): boolean {
  const [clear, setClear] = useState(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const check = (): void => {
      const blocked = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]')).some(
        (element) => interruptionOwnerOf(element) !== owner
      )
      if (blocked) {
        if (timer) clearTimeout(timer)
        timer = null
        setClear(false)
        return
      }
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        setClear(true)
      }, quietMs)
    }

    check()
    const observer = new MutationObserver(check)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-modal']
    })
    return () => {
      observer.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [owner, quietMs])

  return clear
}
