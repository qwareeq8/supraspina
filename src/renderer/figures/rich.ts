/** Figure text runs with italic statistical symbols, such as "d" and "p". */

import { textWidth } from './style'

/** One run of figure text: plain, italic, or bold. */
export type RichRun = string | { i: string } | { b: string }
/** A line of figure text. */
export type Rich = readonly RichRun[]

/** Give the plain text of a rich line, for accessible names and measuring. */
export function richText(rich: Rich): string {
  return rich
    .map((run) => (typeof run === 'string' ? run : 'i' in run ? run.i : run.b))
    .join('')
}

/**
 * Estimate a rich line's width in points.
 *
 * @param size - The type size in points.
 */
export function richWidth(rich: Rich, size: number): number {
  return textWidth(richText(rich), size)
}
