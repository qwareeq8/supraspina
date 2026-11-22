/**
 * Keeps loading, busy and wait states phrased as facts.
 *
 * A state the operator only waits through says what Supraspina is doing, such
 * as "Loading the cohort..." or "Saving...", not an order such as "Wait while
 * the cohort loads...". Remedies that ask the operator to wait before
 * retrying ("Wait for the scientific runtime to stop.") are orders by design;
 * each one is listed in {@link WAIT_REMEDIES}, so any other "Wait for" text
 * fails the scan.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * The "Wait for" texts kept as orders: each is an error that refuses a
 * request while an earlier operation settles and tells the operator what to
 * wait for before trying again.
 */
const WAIT_REMEDIES = new Set([
  'main/lifecycle.ts: Wait for the current boundary response to settle.',
  'main/sidecar.ts: Wait for the scientific runtime to become ready.',
  'main/sidecar.ts: Wait for the scientific runtime to stop.',
])

/** Collect every non-test `.ts` and `.tsx` source under a directory. */
function collectSources(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'test') found.push(...collectSources(full))
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      found.push(full)
    }
  }
  return found
}

/**
 * List each match of `pattern` in the source tree as `path: text`.
 *
 * @param pattern - A global pattern for the phrase to list.
 * @returns Every match, prefixed by its source path.
 */
function phrases(pattern: RegExp): string[] {
  return collectSources(SRC_DIR).flatMap((file) => {
    const path = relative(SRC_DIR, file).split('\\').join('/')
    const matches = readFileSync(file, 'utf8').match(pattern)
    return (matches ?? []).map((text) => `${path}: ${text.trimEnd()}`)
  })
}

describe('wait-state copy', () => {
  it('the scan reads the renderer, main and shared sources', () => {
    const files = collectSources(SRC_DIR).map((file) =>
      relative(SRC_DIR, file).split('\\').join('/'),
    )
    expect(files).toContain('renderer/App.tsx')
    expect(files).toContain('main/sidecar.ts')
    expect(files).toContain('shared/contract.ts')
  })

  it('states every loading, busy and wait state as a fact', () => {
    expect(phrases(/Wait while[^'"`\n]*/g)).toEqual([])
  })

  it('keeps "Wait for" only in the remedies listed by design', () => {
    // A string literal or JSX text, not a code comment.
    const waits = phrases(/(?<=['"`>]\s*)Wait for\b[^'"`<\n]*/g)
    expect(waits.filter((entry) => !WAIT_REMEDIES.has(entry))).toEqual([])
    // Every listed remedy still exists; drop one whose text is gone.
    expect(
      [...WAIT_REMEDIES].filter((entry) => !waits.includes(entry)),
    ).toEqual([])
  })
})
