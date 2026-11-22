/**
 * Copies text and shows a transient "Copied" marker on success. One timer is
 * shared across calls and cleared during unmount. Returns `true` after a
 * successful copy and `false` after a clipboard failure so each caller can
 * handle the result.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

/** The shared copy-feedback API returned by {@link useCopyFeedback}. */
export interface CopyFeedback {
  /** Identify the key whose "Copied" marker is visible, or use null. */
  copiedKey: string | null
  /** Copy `text`; flash the marker for `key` on success. Resolve to success. */
  copy: (key: string, text: string) => Promise<boolean>
}

/**
 * Manage a transient "Copied" marker for clipboard copies.
 *
 * @param resetMs - The marker visible for this many milliseconds.
 * @returns The current `copiedKey` and a `copy` action.
 */
export function useCopyFeedback(resetMs = 1500): CopyFeedback {
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const copy = useCallback(
    async (key: string, text: string): Promise<boolean> => {
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        return false
      }
      setCopiedKey(key)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopiedKey(null), resetMs)
      return true
    },
    [resetMs],
  )

  return { copiedKey, copy }
}
