/**
 * Keeps the TypeScript source tree within printable ASCII plus tab and line
 * breaks.
 *
 * Non-ASCII bytes and unsafe ASCII controls are rejected before they enter
 * strings or comments. Encode required display glyphs with ASCII `\uXXXX`
 * escape sequences.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC_DIR = dirname(fileURLToPath(import.meta.url))

/** Collect every `.ts` and `.tsx` file under a directory recursively. */
function collectSources(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...collectSources(full))
    else if (/\.tsx?$/.test(entry.name)) found.push(full)
  }
  return found
}

/** Report the first disallowed source byte, or return `null` when none exists. */
function firstDisallowedSourceByte(source: Buffer): string | null {
  let line = 1
  for (const byte of source) {
    const allowed =
      byte === 0x09 ||
      byte === 0x0a ||
      byte === 0x0d ||
      (byte >= 0x20 && byte <= 0x7e)
    if (!allowed) {
      const hex = byte.toString(16).toUpperCase().padStart(2, '0')
      return `line ${line}: byte 0x${hex}`
    }
    if (byte === 0x0a) line += 1
  }
  return null
}

describe('the source-byte invariant', () => {
  it('the scan covers a non-empty set of source files', () => {
    expect(collectSources(SRC_DIR).length).toBeGreaterThan(0)
  })

  it('rejects non-ASCII and unsafe control bytes from every TypeScript source', () => {
    const offenders = collectSources(SRC_DIR)
      .map((file) => {
        const offender = firstDisallowedSourceByte(readFileSync(file))
        return offender ? `${relative(SRC_DIR, file)}: ${offender}` : null
      })
      .filter((entry): entry is string => entry !== null)
    expect(offenders).toEqual([])
  })

  it('allows only tab, LF, CR, and printable ASCII bytes', () => {
    expect(
      firstDisallowedSourceByte(Buffer.from([0x09, 0x0a, 0x0d, 0x20, 0x7e])),
    ).toBeNull()
    for (const byte of [
      ...Array.from({ length: 9 }, (_, index) => index),
      0x0b,
      0x0c,
      ...Array.from({ length: 18 }, (_, index) => 0x0e + index),
      0x7f,
      0x80,
      0xff,
    ]) {
      expect(firstDisallowedSourceByte(Buffer.from([byte]))).toBe(
        `line 1: byte 0x${byte.toString(16).toUpperCase().padStart(2, '0')}`,
      )
    }
  })
})
