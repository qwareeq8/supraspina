/** Tests for the screenshot harness's usage comment. */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

/**
 * Read shot.cjs and split it into its leading usage comment and the flags
 * its arg() helper parses.
 */
async function harnessUsage() {
  const source = await readFile(new URL('./shot.cjs', import.meta.url), 'utf8')
  const usage = source.slice(0, source.indexOf('*/') + 2)
  const parsed = [...source.matchAll(/\barg\('([a-z0-9-]+)'/g)].map(
    (match) => match[1],
  )
  return { usage, parsed: [...new Set(parsed)] }
}

test('the usage comment names every flag the harness parses', async () => {
  // capture-documentation-screenshots.cjs passes theme flags such as --dark,
  // so each parsed flag must appear in the usage comment.
  const { usage, parsed } = await harnessUsage()
  assert.ok(parsed.includes('dark'), 'shot.cjs no longer parses --dark')
  const undocumented = parsed.filter(
    (name) => !new RegExp(`--${name}(?![a-z-])`).test(usage),
  )
  assert.deepEqual(undocumented, [])
})
