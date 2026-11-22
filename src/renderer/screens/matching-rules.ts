/** Validates the subject folder and T1 file matching patterns. */

import { safeRelativeSegment } from '../../shared/project-schema'

/**
 * Explain why one matching pattern is invalid.
 *
 * @returns The validation message, or null when the pattern is valid.
 */
export function patternError(value: string): string | null {
  return safeRelativeSegment(value)
    ? null
    : 'Use a non-empty name pattern without slashes, "..", or control characters.'
}
