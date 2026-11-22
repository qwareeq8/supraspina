import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  checkProvenanceInventory,
  writeProvenanceInventory,
} from './generate-third-party-provenance.mjs'

const resource = 'resources/step7/example_helper.py'
const acquired = 'resources/enigma/ENIGMA_QC/example.m'
const acquiredSha256 = 'b'.repeat(64)

/**
 * Build a minimal tracked resource tree with a reviewed provenance fixture.
 *
 * @param {{exact?: object}} [options] - `exact` adds acquired upstream
 *   fixture entries.
 * @returns {Promise<string>} The root of the prepared tree.
 */
async function provenanceTree({ exact = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'supraspina-provenance-'))
  for (const directory of [
    'licenses',
    'resources/step7',
    'sidecar/tests/fixtures',
    'src/renderer/assets/fonts',
  ]) {
    await mkdir(join(root, directory), { recursive: true })
  }
  await writeFile(join(root, resource), 'print("reviewed helper")\n', 'utf8')
  await writeFile(
    join(root, 'licenses/MANIFEST-LM-Roman-Supraspina.txt'),
    'Latin Modern Roman 10 derivative manifest.\n',
    'utf8',
  )
  await writeFile(
    join(root, 'SCIENTIFIC_RESOURCE_PINS.json'),
    '{\n  "resources": {}\n}\n',
    'utf8',
  )
  await writeFile(
    join(root, 'sidecar/tests/fixtures/upstream-resource-blobs.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        evidenceMethod:
          'Git blob SHA-1 over the canonical blob header and bytes',
        exactLocalToUpstreamBlobs: exact,
        wrapperAdaptations: {},
        localOnlyOrReimplemented: {
          [resource]: {
            classification: 'first_party_original',
            localStartBlob: 'a'.repeat(40),
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  execFileSync('git', ['init', '--quiet'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return root
}

test('verifies a committed inventory that matches the resource tree', async () => {
  const root = await provenanceTree()
  const written = await writeProvenanceInventory({ root })

  assert.deepEqual(Object.keys(written.resourceFiles), [resource])
  const verified = await checkProvenanceInventory({ root })
  assert.deepEqual(verified, written)
  assert.deepEqual(verified.resourceFiles[resource], {
    delivery: 'bundled',
    kind: 'pipeline-support',
    license: 'MIT-First-Party',
    mode: '0600',
    provenance: {
      classification: 'first_party_original',
      localStartBlob: 'a'.repeat(40),
    },
    sha256: 'cb1c305d3a6a966a7f356d6e4dd25fafe9f16dc3d450485cd5902a0456798323',
  })
  assert.deepEqual(verified.rendererFonts, [])
  assert.equal(
    JSON.parse(
      await readFile(join(root, 'THIRD_PARTY_PROVENANCE.json'), 'utf8'),
    ).schemaVersion,
    1,
  )
})

test('rejects a resource file that drifted from the committed inventory', async () => {
  const root = await provenanceTree()
  await writeProvenanceInventory({ root })
  await writeFile(join(root, resource), 'print("edited helper")\n', 'utf8')

  await assert.rejects(
    checkProvenanceInventory({ root }),
    /Regenerate THIRD_PARTY_PROVENANCE\.json by running npm run provenance:write\./,
  )
})

const acquiredEntry = {
  [acquired]: {
    blob: 'c'.repeat(40),
    sha256: acquiredSha256,
    upstreamPath: 'Step_2_QA_ENIGMA/ENIGMA_QC/example.m',
  },
}

test('records acquired upstream files from the reviewed fixture alone', async () => {
  const root = await provenanceTree({ exact: acquiredEntry })
  const written = await writeProvenanceInventory({ root })

  assert.deepEqual(Object.keys(written.resourceFiles), [acquired, resource])
  assert.deepEqual(written.resourceFiles[acquired], {
    delivery: 'checksum-pinned-user-acquisition',
    kind: 'scientific-source',
    license: 'NOASSERTION',
    mode: '0600',
    provenance: {
      classification: 'byte-identical-upstream',
      upstreamBlob: 'c'.repeat(40),
      upstreamPath: 'Step_2_QA_ENIGMA/ENIGMA_QC/example.m',
    },
    sha256: acquiredSha256,
  })
})

test('rejects an acquired upstream file committed to the repository', async () => {
  const root = await provenanceTree({ exact: acquiredEntry })
  await mkdir(join(root, 'resources/enigma/ENIGMA_QC'), { recursive: true })
  await writeFile(join(root, acquired), '% upstream bytes\n', 'utf8')

  await assert.rejects(
    writeProvenanceInventory({ root }),
    /Remove this upstream file, which Supraspina acquires at run time: resources\/enigma\/ENIGMA_QC\/example\.m\./,
  )
})

test('rejects an acquired upstream file without an installed digest', async () => {
  const root = await provenanceTree({
    exact: { [acquired]: { ...acquiredEntry[acquired], sha256: undefined } },
  })

  await assert.rejects(
    writeProvenanceInventory({ root }),
    /Record the installed SHA-256 of this upstream file/,
  )
})

test('requires the ENIGMA checksum manifest to match the inventory', async () => {
  const root = await provenanceTree({ exact: acquiredEntry })
  const manifest = join(root, 'resources/enigma/CHECKSUMS.sha256')
  await mkdir(join(root, 'resources/enigma'), { recursive: true })
  await writeFile(manifest, `${acquiredSha256}  ENIGMA_QC/example.m\n`, 'utf8')
  const fixturePath = join(
    root,
    'sidecar/tests/fixtures/upstream-resource-blobs.json',
  )
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
  fixture.localOnlyOrReimplemented['resources/enigma/CHECKSUMS.sha256'] = {
    classification: 'provenance_manifest',
    localStartBlob: 'd'.repeat(40),
  }
  await writeFile(fixturePath, JSON.stringify(fixture), 'utf8')

  await writeProvenanceInventory({ root })
  await writeFile(manifest, `${'e'.repeat(64)}  ENIGMA_QC/example.m\n`, 'utf8')
  await assert.rejects(
    writeProvenanceInventory({ root }),
    /Match resources\/enigma\/CHECKSUMS\.sha256 to the reviewed ENIGMA digests\./,
  )
})
