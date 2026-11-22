import assert from 'node:assert/strict'
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { stageSidecarResources } from './stage-sidecar-resources.mjs'

test('stages only redistribution-approved resources and reviewed metadata', async () => {
  const output = await mkdtemp(join(tmpdir(), 'supraspina-stage-'))
  const result = await stageSidecarResources(output)

  assert.deepEqual(result, {
    staged: 16,
    excluded: 231,
    firstPartyHelpers: 1,
  })
  const provenance = JSON.parse(
    await readFile(
      join(output, 'metadata', 'THIRD_PARTY_PROVENANCE.json'),
      'utf8',
    ),
  )
  assert.equal(Object.keys(provenance.resourceFiles).length, 247)
  assert.match(
    await readFile(
      join(output, 'resources', 'braincharts', 'braincharts_run.py'),
      'utf8',
    ),
    /BrainCharts/,
  )
  await assert.rejects(
    readFile(join(output, 'resources', 'enigma', 'compiled', 'FS_external_QC')),
    /ENOENT/,
  )
  assert.match(
    await readFile(
      join(output, 'resources', 'step7', 'brainpadstats.py'),
      'utf8',
    ),
    /Brain-PAD/,
  )
  assert.match(
    await readFile(
      join(output, 'resources', 'brainfov', 'brainfov_helper.py'),
      'utf8',
    ),
    /Fail-closed brain-FOV preparation primitives/,
  )
  const pins = JSON.parse(
    await readFile(
      join(output, 'metadata', 'SCIENTIFIC_RESOURCE_PINS.json'),
      'utf8',
    ),
  )
  assert.equal(pins.resources.synthstrip.version, '1.8')
  assert.equal(pins.resources.fastsurfer.version, '2.5.4')
})

test('rejects nonempty and symlink staging destinations', async () => {
  const nonempty = await mkdtemp(join(tmpdir(), 'supraspina-stage-nonempty-'))
  await writeFile(join(nonempty, 'unexpected'), 'x')
  await assert.rejects(
    stageSidecarResources(nonempty),
    /Empty the staging output/,
  )

  const parent = await mkdtemp(join(tmpdir(), 'supraspina-stage-link-'))
  const target = await mkdtemp(join(tmpdir(), 'supraspina-stage-target-'))
  const link = join(parent, 'link')
  await symlink(target, link, 'dir')
  await assert.rejects(
    stageSidecarResources(link),
    /Provide the staging output as a real directory/,
  )
})
