import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'

import { validateVersionAgreement } from './check-release.mjs'
import {
  VERSION_FIELDS,
  readVersionField,
  readVersionFields,
  stampVersion,
  writeVersionField,
} from './stamp-version.mjs'

const repository = new URL('../', import.meta.url)

/** Copy every stamped file of this checkout into a new temporary root. */
async function copyStampedFiles() {
  const directory = await mkdtemp(join(tmpdir(), 'supraspina-stamp-'))
  for (const path of new Set(VERSION_FIELDS.map((field) => field.path))) {
    const target = join(directory, path)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(new URL(path, repository), target)
  }
  return { directory, url: pathToFileURL(`${directory}/`) }
}

describe('stampVersion', () => {
  it('stamps one version and its date into every field', async () => {
    const { url } = await copyStampedFiles()
    const version = await stampVersion({
      now: new Date('2027-01-02T03:04:30Z'),
      repository: url,
    })
    assert.equal(version, '20270102.304.0')
    const fields = await readVersionFields(url)
    assert.equal(validateVersionAgreement(fields), version)
    assert.deepEqual(
      fields.filter((field) => field.kind === 'date').map((f) => f.value),
      ['2027-01-02', '2027-01-02'],
    )
  })

  it('changes no file when one field is missing', async () => {
    const { directory, url } = await copyStampedFiles()
    const before = await readFile(join(directory, 'package.json'), 'utf8')
    await writeFile(join(directory, 'CITATION.cff'), 'cff-version: 1.2.0\n')
    await assert.rejects(
      stampVersion({ now: new Date('2027-01-02T03:04:00Z'), repository: url }),
      /Write the version in CITATION\.cff exactly once/,
    )
    assert.equal(
      await readFile(join(directory, 'package.json'), 'utf8'),
      before,
    )
  })

  it('keeps the committed files in agreement', async () => {
    const fields = await readVersionFields()
    assert.equal(fields.length, VERSION_FIELDS.length)
    validateVersionAgreement(fields)
  })
})

describe('version fields', () => {
  it('reads and writes one exact field', () => {
    const field = VERSION_FIELDS.find(
      (candidate) => candidate.path === 'electron-builder.yml',
    )
    const source = "releaseInfo:\n  releaseDate: '2026-09-20'\n"
    assert.equal(readVersionField(source, field), '2026-09-20')
    assert.equal(
      writeVersionField(source, field, '20261121.1830.0'),
      "releaseInfo:\n  releaseDate: '2026-11-21'\n",
    )
  })

  it('rejects a duplicated field', () => {
    const field = VERSION_FIELDS.find(
      (candidate) =>
        candidate.path === 'sidecar/supraspina_sidecar/__init__.py',
    )
    assert.throws(
      () => readVersionField('__version__ = "1"\n__version__ = "2"\n', field),
      /exactly once/,
    )
  })
})
