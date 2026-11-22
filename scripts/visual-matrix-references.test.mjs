/** Tests for renderer build-reference discovery. */

import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { extractRendererReferences } from './visual-matrix-references.cjs'

/**
 * Renderer copy that the screenshot contracts in shot.cjs wait for or require
 * in the rendered text. A copy change that leaves shot.cjs on the old sentence
 * fails only when a capture runs, so each one is tied to the source here.
 */
const RENDERED_COPY_CONTRACTS = [
  // The QC Review montage panel tallies.
  '12/12 panels verified and drawn.',
  '4/4 panels verified and drawn.',
  // The Pipeline blocking and blocked fixtures.
  'Runtime resources and automatic choices appear during exact plan review.',
  // The Input QC crop approval tally.
  '0/1 crops approved',
  // The environment loading fixture, and the QC panel loading line that the
  // documentation capture waits out.
  'Checking the environment...',
  'Loading the panels...',
]

/**
 * Read the renderer and shared source with whitespace runs collapsed, so JSX
 * text broken across lines reads as one sentence.
 *
 * @returns {Promise<string>} The non-test TypeScript source, joined.
 */
async function rendererCopySource() {
  const sources = []
  for (const directory of ['../src/renderer/', '../src/shared/']) {
    const root = fileURLToPath(new URL(directory, import.meta.url))
    for (const entry of await readdir(root, { recursive: true })) {
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue
      sources.push(await readFile(join(root, entry), 'utf8'))
    }
  }
  return sources.join('\n').replace(/\s+/g, ' ')
}

/**
 * Match copy as the source spells it: a number in the rendered text may come
 * from a template expression such as `${loaded}`.
 *
 * @param {string} text - The rendered copy.
 * @returns {RegExp}
 */
function sourcePattern(text) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(escaped.replace(/\d+/g, '(?:\\d+|\\$\\{[^}]+\\})'))
}

test('finds module references without treating identifier prefixes as imports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'supraspina-visual-references-'))
  const bundle = join(root, 'bundle.js')
  try {
    await writeFile(
      bundle,
      [
        'const importOffline = (sourcePath) => sourcePath;',
        'const exportDebugBundle = (definition) => definition;',
        'const message = cause instanceof Error ? cause.message : "unavailable";',
        'import "./side-effect.js";',
        'export { value } from "./exported.js";',
        'const lazy = import("./lazy.js");',
        'const asset = new URL("./icon.svg", import.meta.url);',
      ].join('\n'),
    )

    assert.deepEqual(extractRendererReferences(bundle), [
      './icon.svg',
      './lazy.js',
      './exported.js',
      './side-effect.js',
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the visual matrix references every workspace, including populated Input QC', async () => {
  const matrixSource = await readFile(
    new URL('./visual-matrix.cjs', import.meta.url),
    'utf8',
  )
  const shotSource = await readFile(
    new URL('./shot.cjs', import.meta.url),
    'utf8',
  )
  const captures = [
    ...matrixSource.matchAll(/^\s{2}\[\n\s{4}'([^']+)',\n\s{4}'([^']+)',/gm),
  ].map(([, screen, name]) => ({ screen, name }))

  assert.equal(captures.length, 29)
  assert.equal(
    new Set(captures.map(({ name }) => name)).size,
    captures.length,
    'Keep visual-matrix output names unique.',
  )
  assert.deepEqual(
    captures.find(({ screen }) => screen === 'Input QC'),
    {
      screen: 'Input QC',
      name: 'unreviewed-light-cozy-115',
    },
  )
  // Treat the native ENIGMA montage as a captured workspace of its own, so its
  // fixture and its assertions have to stay wired to the matrix. Keep the
  // minimum-size capture as well, because the QC protocol control has the least
  // room there.
  assert.deepEqual(
    captures.filter(({ screen }) => screen === 'QC Review'),
    [
      { screen: 'QC Review', name: 'populated-dark-compact' },
      { screen: 'QC Review', name: 'montage-light-comfortable-135' },
      { screen: 'QC Review', name: 'montage-hc-cozy-115' },
      { screen: 'QC Review', name: 'minimum-light-comfortable-135' },
    ],
  )
  // The Analysis panel must fit 1214 by 768 at 135% text, its target size.
  assert.deepEqual(
    captures.filter(({ screen }) => screen === 'Analysis'),
    [
      { screen: 'Analysis', name: 'forest-light-cozy-135' },
      { screen: 'Analysis', name: 'forest-dark-compact-100' },
    ],
  )
  for (const fixtureReference of [
    'api.inputFov.list = async',
    'api.artifact.previewImage = async',
    "'Input QC': /^Input QC$/",
    "case 'Input QC':",
    'Brain FOV QC montage for sub-001',
    '0/1 crops approved',
    "case 'QC Review':",
    'Analysis: /^Analysis$/',
    "case 'Analysis':",
    'Subcortical montage for sub-001',
    '12/12 panels verified and drawn.',
    'Axial 20%, sub-001, panel 1 of 12',
    'assertFirstRunKeyboardTraversal',
    "surface: 'first-run-dialog'",
    'wrappedBackward',
    'wrappedForward',
  ]) {
    assert.equal(
      shotSource.includes(fixtureReference),
      true,
      `Include this fixture in the screenshot source: ${fixtureReference}.`,
    )
  }
  assert.doesNotMatch(
    shotSource,
    /if \(!firstrun\) \{\s*keyboardEvidence = await assertSequentialKeyboardTraversal/,
    'Keep first-run keyboard evidence in the visual matrix.',
  )
})

test('the screenshot contracts wait for copy the renderer still renders', async () => {
  const shotSource = await readFile(
    new URL('./shot.cjs', import.meta.url),
    'utf8',
  )
  const renderer = await rendererCopySource()
  for (const text of RENDERED_COPY_CONTRACTS) {
    assert.equal(
      shotSource.includes(`'${text}'`),
      true,
      `Require this copy in the screenshot source: ${text}`,
    )
    assert.match(
      renderer,
      sourcePattern(text),
      `Render this screenshot-contract copy in the renderer: ${text}`,
    )
  }
  // The QC review capture fails when the missing-gallery state shows instead
  // of the panels; a stale pattern would never fire.
  assert.equal(
    shotSource.includes('.getByText(/gallery is produced yet\\./'),
    true,
    'Detect the missing-gallery state by its current copy.',
  )
  assert.equal(renderer.includes('gallery is produced yet.'), true)
})
