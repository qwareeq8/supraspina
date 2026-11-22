/** Resolves one reduced-motion policy for every animated renderer surface. */

import { useEffect, useState } from 'react'
import { useApp } from './context'

/** The OS preference that global.css mirrors as its motion baseline. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/**
 * Read the OS reduced-motion preference outside React.
 *
 * @returns True when the OS asks for reduced motion.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  )
}

/**
 * Resolve reduced motion from the OS preference and the in-app tweak.
 *
 * Either source alone reduces motion, which is the additive policy
 * `global.css` applies to animations and transitions. Follow live OS changes so
 * a running ticker degrades without a reload.
 *
 * @returns True while motion must stay reduced.
 */
export function useReducedMotion(): boolean {
  const { tweaks } = useApp()
  const [systemReduced, setSystemReduced] = useState(prefersReducedMotion)
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    if (typeof window.matchMedia !== 'function') return undefined
    const query = window.matchMedia(REDUCED_MOTION_QUERY)
    const sync = (): void => setSystemReduced(query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])
  return tweaks.reducedMotion || systemReduced
}
