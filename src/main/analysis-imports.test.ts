import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_ATLAS_IMPORT_FILE_BYTES,
  MAX_VARIABLES_CSV_BYTES,
  checkChosenAtlasFiles,
  checkChosenFile,
  checkChosenFolder,
} from './analysis-imports'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'supraspina-analysis-imports-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const csvRule = {
  what: 'a variables table',
  extensions: ['.csv'],
  maxBytes: MAX_VARIABLES_CSV_BYTES,
}

describe('chosen files', () => {
  it('accepts a regular file of an offered kind within its cap', async () => {
    const path = join(root, 'Clinical.CSV')
    await writeFile(path, 'subject_id,UEMS\nsub-01,50\n')
    await expect(checkChosenFile(path, csvRule)).resolves.toBeUndefined()
  })

  it('refuses malformed paths, other kinds, links, folders, and big files', async () => {
    await expect(checkChosenFile('clinical.csv', csvRule)).rejects.toThrow(
      'Choose a variables table by its absolute path.',
    )
    await expect(
      checkChosenFile(join(root, 'a\nb.csv'), csvRule),
    ).rejects.toThrow(/absolute path/)
    await writeFile(join(root, 'clinical.xlsx'), 'x')
    await expect(
      checkChosenFile(join(root, 'clinical.xlsx'), csvRule),
    ).rejects.toThrow('Choose a variables table ending in .csv.')
    await expect(
      checkChosenFile(join(root, 'missing.csv'), csvRule),
    ).rejects.toThrow(/that exists/)
    await writeFile(join(root, 'real.csv'), 'x')
    await symlink(join(root, 'real.csv'), join(root, 'link.csv'))
    await expect(
      checkChosenFile(join(root, 'link.csv'), csvRule),
    ).rejects.toThrow(/itself, not a link/)
    await mkdir(join(root, 'folder.csv'))
    await expect(
      checkChosenFile(join(root, 'folder.csv'), csvRule),
    ).rejects.toThrow(/as a file/)
    await writeFile(join(root, 'big.csv'), '')
    await truncate(join(root, 'big.csv'), MAX_VARIABLES_CSV_BYTES + 1)
    await expect(
      checkChosenFile(join(root, 'big.csv'), csvRule),
    ).rejects.toThrow('Choose a variables table of at most 4 MiB.')
  })
})

describe('chosen atlas files', () => {
  it('allows each recipe its kinds, once each', async () => {
    for (const name of ['lh.a.gcs', 'rh.a.gcs', 'labels.nii.gz', 'lut.txt']) {
      await writeFile(join(root, name), 'x')
    }
    await expect(
      checkChosenAtlasFiles(
        [join(root, 'lh.a.gcs'), join(root, 'rh.a.gcs')],
        'user-gcs',
      ),
    ).resolves.toBeUndefined()
    await expect(
      checkChosenAtlasFiles(
        [join(root, 'labels.nii.gz'), join(root, 'lut.txt')],
        'user-volume',
      ),
    ).resolves.toBeUndefined()
    await expect(
      checkChosenAtlasFiles([join(root, 'lh.a.gcs')], 'user-annot'),
    ).rejects.toThrow('Choose an atlas file ending in .annot.')
    await mkdir(join(root, 'other'))
    await writeFile(join(root, 'other', 'lh.a.gcs'), 'x')
    await expect(
      checkChosenAtlasFiles(
        [join(root, 'lh.a.gcs'), join(root, 'other', 'lh.a.gcs')],
        'user-gcs',
      ),
    ).rejects.toThrow(/each atlas file once/)
    await writeFile(join(root, 'huge.mgz'), '')
    await truncate(join(root, 'huge.mgz'), MAX_ATLAS_IMPORT_FILE_BYTES + 1)
    await expect(
      checkChosenAtlasFiles([join(root, 'huge.mgz')], 'user-volume'),
    ).rejects.toThrow(/at most 256 MiB/)
  })
})

describe('chosen folders', () => {
  it('accepts a real folder and refuses files, links, and missing paths', async () => {
    await mkdir(join(root, 'outputs'))
    await expect(
      checkChosenFolder(join(root, 'outputs')),
    ).resolves.toBeUndefined()
    await symlink(join(root, 'outputs'), join(root, 'linked'))
    await expect(checkChosenFolder(join(root, 'linked'))).rejects.toThrow(
      /itself, not a link/,
    )
    await writeFile(join(root, 'file'), 'x')
    await expect(checkChosenFolder(join(root, 'file'))).rejects.toThrow(
      /not a file/,
    )
    await expect(checkChosenFolder(join(root, 'missing'))).rejects.toThrow(
      /that exists/,
    )
    await expect(checkChosenFolder('outputs')).rejects.toThrow(/absolute path/)
  })
})
