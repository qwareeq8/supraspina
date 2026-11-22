import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FSAVERAGE_ASSET_IDS,
  MAX_BRAIN_ASSET_BYTES,
  SUBJECT_ASSET_IDS,
  TEMPLATE_ATLAS_ASSET_IDS,
  type BrainAssetId,
} from '../shared/brain-atlas'
import { DEFAULT_PROJECT_CONFIG } from '../shared/project-schema'
import {
  atlasViewerFiles,
  listBrainAssets,
  readBrainAsset,
  resolveFreesurferHome,
  type BrainAssetContext,
} from './brain-assets'

const hooks = vi.hoisted(() => ({
  /** Run once just before the next open, to swap the file in a race. */
  beforeOpen: null as ((path: string) => Promise<void>) | null,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const open = vi.fn(async (...args: Parameters<typeof actual.open>) => {
    const hook = hooks.beforeOpen
    hooks.beforeOpen = null
    if (hook) await hook(String(args[0]))
    return actual.open(...args)
  })
  return { ...actual, default: { ...actual, open }, open }
})

/** The default FreeSurfer 8.2.0 install; tests that read it skip without it. */
const REAL_FREESURFER_HOME = '/usr/local/freesurfer/8.2.0'

let root: string
let home: string
let derivatives: string

function configWithHome(value: string) {
  const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
  cfg.tools.freesurferHome = value
  return cfg
}

function context(
  overrides: Partial<BrainAssetContext> = {},
): BrainAssetContext {
  return {
    cfg: configWithHome(home),
    projectRoot: join(root, 'project'),
    env: {},
    derivativesDir: derivatives,
    confineSubjectPath: async (path) => {
      const info = await lstat(path)
      if (info.isSymbolicLink()) {
        throw new Error('Open the artifact through a non-symlink path.')
      }
      return { path, info: await stat(path) }
    },
    ...overrides,
  }
}

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'supraspina-brain-assets-'))
  home = join(root, 'freesurfer')
  derivatives = join(root, 'project', 'derivatives')
  for (const id of FSAVERAGE_ASSET_IDS) {
    await put(join(home, 'subjects', id), `template ${id}`)
  }
  for (const subject of ['sub-01']) {
    for (const id of SUBJECT_ASSET_IDS) {
      await put(
        join(derivatives, 'freesurfer', subject, 'mri', id.split('/').pop()!),
        `${subject} ${id}`,
      )
    }
  }
})

afterEach(async () => {
  hooks.beforeOpen = null
  await rm(root, { recursive: true, force: true })
})

describe('FreeSurfer home resolution', () => {
  it('prefers the saved setting, then FREESURFER_HOME, and ignores relative paths', () => {
    expect(
      resolveFreesurferHome(configWithHome(' /opt/fs '), {
        FREESURFER_HOME: '/env/fs',
      }),
    ).toBe('/opt/fs')
    expect(
      resolveFreesurferHome(configWithHome(''), { FREESURFER_HOME: '/env/fs' }),
    ).toBe('/env/fs')
    expect(
      resolveFreesurferHome(configWithHome('relative/fs'), {
        FREESURFER_HOME: 'also/relative',
      }),
    ).toBeNull()
    expect(resolveFreesurferHome(configWithHome(''), {})).toBeNull()
  })
})

describe('listing viewer assets', () => {
  it('lists every template asset with its size', async () => {
    const report = await listBrainAssets(context(), {})
    expect(report).toMatchObject({
      available: true,
      unavailableReason: null,
      subjectId: null,
    })
    expect(report.assets.map((a) => a.assetId)).toEqual([
      ...FSAVERAGE_ASSET_IDS,
    ])
    expect(report.assets[0]!.bytes).toBe(
      `template ${FSAVERAGE_ASSET_IDS[0]}`.length,
    )
  })

  it('reports an unset or unreadable home as a fact', async () => {
    await expect(
      listBrainAssets(context({ cfg: configWithHome('') }), {}),
    ).resolves.toEqual({
      available: false,
      unavailableReason: 'FreeSurfer home is not set.',
      subjectId: null,
      assets: [],
    })
    const report = await listBrainAssets(
      context({ cfg: configWithHome(join(root, 'missing')) }),
      {},
    )
    expect(report.available).toBe(false)
    expect(report.unavailableReason).toMatch(/no readable subjects folder/)
  })

  it('uses FREESURFER_HOME when nothing is saved', async () => {
    const report = await listBrainAssets(
      context({ cfg: configWithHome(''), env: { FREESURFER_HOME: home } }),
      {},
    )
    expect(report.available).toBe(true)
  })

  it('marks the template unavailable when a file is missing or oversized', async () => {
    await rm(join(home, 'subjects', 'fsaverage5/surf/lh.sulc'))
    await truncate(
      join(home, 'subjects', 'fsaverage/mri/brain.mgz'),
      MAX_BRAIN_ASSET_BYTES + 1,
    )
    const report = await listBrainAssets(context(), {})
    expect(report.available).toBe(false)
    expect(report.unavailableReason).toMatch(/lacks readable fsaverage5/)
    expect(report.assets.map((a) => a.assetId)).not.toContain(
      'fsaverage5/surf/lh.sulc',
    )
    expect(report.assets.map((a) => a.assetId)).not.toContain(
      'fsaverage/mri/brain.mgz',
    )
  })

  it('lists a subject volume only when confinement accepts it', async () => {
    const confine = vi.fn(context().confineSubjectPath)
    const report = await listBrainAssets(
      context({ confineSubjectPath: confine }),
      { subjectId: 'sub-01' },
    )
    expect(report.subjectId).toBe('sub-01')
    expect(report.assets.map((a) => a.assetId)).toEqual([
      ...FSAVERAGE_ASSET_IDS,
      ...SUBJECT_ASSET_IDS,
    ])
    expect(confine).toHaveBeenCalledWith(
      join(derivatives, 'freesurfer', 'sub-01', 'mri', 'aparc+aseg.mgz'),
    )
    const refused = await listBrainAssets(
      context({
        confineSubjectPath: async () => {
          throw new Error('Keep the artifact real path within roots.')
        },
      }),
      { subjectId: 'sub-01' },
    )
    expect(refused.assets.map((a) => a.assetId)).toEqual([
      ...FSAVERAGE_ASSET_IDS,
    ])
  })

  it.each(['fsaverage', 'fsaverage5', '../sub-01', 'sub/01', '.hidden'])(
    'refuses the subject ID %j',
    async (subjectId) => {
      await expect(listBrainAssets(context(), { subjectId })).rejects.toThrow(
        /valid subject ID/,
      )
    },
  )
})

describe('reading viewer assets', () => {
  it('returns the exact bytes in their own buffer with the SHA-256', async () => {
    const id: BrainAssetId = 'fsaverage5/label/lh.aparc.annot'
    const asset = await readBrainAsset(context(), { assetId: id })
    const text = `template ${id}`
    expect(asset.assetId).toBe(id)
    expect(asset.sha256).toBe(sha(text))
    expect(Buffer.from(asset.data).toString()).toBe(text)
    // Structured clone sends the whole backing buffer.
    expect(asset.data.byteOffset).toBe(0)
    expect(asset.data.buffer.byteLength).toBe(text.length)
  })

  it('reads the v2 template labels from the subjects folder', async () => {
    const id: BrainAssetId = 'fsaverage/label/lh.BA3a_exvivo.label'
    await put(join(home, 'subjects', id), 'label')
    const asset = await readBrainAsset(context(), { assetId: id })
    expect(Buffer.from(asset.data).toString()).toBe('label')
  })

  it('refuses IDs outside the allowlist, including traversal and other extensions', async () => {
    for (const assetId of [
      '../../etc/passwd',
      'fsaverage/mri/brain.nii',
      'fsaverage/mri/T1.mgz',
      '/usr/local/freesurfer/subjects/fsaverage/mri/brain.mgz',
      'fsaverage5/surf/../../fsaverage/mri/brain.mgz',
    ]) {
      await expect(
        readBrainAsset(context(), { assetId: assetId as BrainAssetId }),
      ).rejects.toThrow(/allowlisted brain asset/)
    }
  })

  it('refuses a template symlink that escapes the subjects folder', async () => {
    const outside = join(root, 'secret.txt')
    await writeFile(outside, 'secret')
    const target = join(home, 'subjects', 'fsaverage5/surf/lh.pial')
    await rm(target)
    await symlink(outside, target)
    await expect(
      readBrainAsset(context(), { assetId: 'fsaverage5/surf/lh.pial' }),
    ).rejects.toThrow(/inside the FreeSurfer subjects folder/)
    const report = await listBrainAssets(context(), {})
    expect(report.available).toBe(false)
  })

  it('follows a template symlink that stays inside the subjects folder', async () => {
    const target = join(home, 'subjects', 'fsaverage5/surf/lh.pial')
    await rm(target)
    await put(`${target}.T1`, 'pial T1')
    await symlink('lh.pial.T1', target)
    const asset = await readBrainAsset(context(), {
      assetId: 'fsaverage5/surf/lh.pial',
    })
    expect(Buffer.from(asset.data).toString()).toBe('pial T1')
  })

  it('refuses a volume link that resolves to another file kind', async () => {
    const target = join(home, 'subjects', 'fsaverage/mri/brain.mgz')
    await rm(target)
    await put(join(home, 'subjects', 'README'), 'readme')
    await symlink('../../README', target)
    await expect(
      readBrainAsset(context(), { assetId: 'fsaverage/mri/brain.mgz' }),
    ).rejects.toThrow(/inside the FreeSurfer subjects folder/)
  })

  it('refuses oversized and non-regular files', async () => {
    await truncate(
      join(home, 'subjects', 'fsaverage/mri/aparc+aseg.mgz'),
      MAX_BRAIN_ASSET_BYTES + 1,
    )
    await expect(
      readBrainAsset(context(), { assetId: 'fsaverage/mri/aparc+aseg.mgz' }),
    ).rejects.toThrow(/16 MiB/)
    const brain = join(home, 'subjects', 'fsaverage/mri/brain.mgz')
    await rm(brain)
    await mkdir(brain)
    await expect(
      readBrainAsset(context(), { assetId: 'fsaverage/mri/brain.mgz' }),
    ).rejects.toThrow(/regular files/)
  })

  it('reports a missing home when reading', async () => {
    await expect(
      readBrainAsset(context({ cfg: configWithHome('') }), {
        assetId: 'fsaverage/mri/brain.mgz',
      }),
    ).rejects.toThrow('FreeSurfer home is not set.')
    await expect(
      readBrainAsset(context(), {
        assetId: 'fsaverage/mri/brain.mgz',
        subjectId: 'sub-01',
      }),
    ).rejects.toThrow(/subject volumes only/)
  })

  it('reads subject volumes through the derivatives folder and main confinement', async () => {
    const confine = vi.fn(context().confineSubjectPath)
    const asset = await readBrainAsset(
      context({ confineSubjectPath: confine }),
      {
        assetId: 'subject/mri/brain.mgz',
        subjectId: 'sub-01',
      },
    )
    expect(confine).toHaveBeenCalledWith(
      join(derivatives, 'freesurfer', 'sub-01', 'mri', 'brain.mgz'),
    )
    expect(Buffer.from(asset.data).toString()).toBe(
      'sub-01 subject/mri/brain.mgz',
    )
    expect(asset.sha256).toBe(sha('sub-01 subject/mri/brain.mgz'))
  })

  it('refuses subject reads without a subject, a derivatives folder, or confinement', async () => {
    await expect(
      readBrainAsset(context(), { assetId: 'subject/mri/brain.mgz' }),
    ).rejects.toThrow(/valid subject ID/)
    await expect(
      readBrainAsset(context(), {
        assetId: 'subject/mri/brain.mgz',
        subjectId: 'fsaverage',
      }),
    ).rejects.toThrow(/valid subject ID/)
    await expect(
      readBrainAsset(context({ derivativesDir: null }), {
        assetId: 'subject/mri/brain.mgz',
        subjectId: 'sub-01',
      }),
    ).rejects.toThrow(/derivatives folder/)
    await expect(
      readBrainAsset(
        context({
          confineSubjectPath: async () => {
            throw new Error('Keep the artifact real path within roots.')
          },
        }),
        { assetId: 'subject/mri/brain.mgz', subjectId: 'sub-01' },
      ),
    ).rejects.toThrow(/within roots/)
  })

  it('refuses a template file swapped after confinement', async () => {
    const id: BrainAssetId = 'fsaverage/mri/brain.mgz'
    hooks.beforeOpen = async (path) => {
      // A new inode renamed over the confined path between check and open.
      await writeFile(`${path}.new`, 'swapped')
      await rename(`${path}.new`, path)
    }
    await expect(readBrainAsset(context(), { assetId: id })).rejects.toThrow(
      /changed while it was being opened/,
    )
    expect(hooks.beforeOpen).toBeNull()
  })

  it('refuses a subject volume swapped after confinement', async () => {
    const other = join(root, 'other.mgz')
    await writeFile(other, 'other')
    await expect(
      readBrainAsset(
        context({
          confineSubjectPath: async (path) => ({
            path,
            info: await stat(other),
          }),
        }),
        { assetId: 'subject/mri/aparc+aseg.mgz', subjectId: 'sub-01' },
      ),
    ).rejects.toThrow(/changed while it was being opened/)
  })
})

describe('the color table', () => {
  it('reads FreeSurferColorLUT.txt at the home root and lists it', async () => {
    await put(join(home, 'FreeSurferColorLUT.txt'), '175 Medulla 1 2 3 0')
    const asset = await readBrainAsset(context(), {
      assetId: 'FreeSurferColorLUT.txt',
    })
    expect(Buffer.from(asset.data).toString()).toBe('175 Medulla 1 2 3 0')
    expect(asset.sha256).toBe(sha('175 Medulla 1 2 3 0'))
    const report = await listBrainAssets(context(), {})
    expect(report.assets.at(-1)).toEqual({
      assetId: 'FreeSurferColorLUT.txt',
      bytes: 19,
    })
  })

  it('refuses a missing table, a subject, and a link out of the home', async () => {
    await expect(
      readBrainAsset(context(), { assetId: 'FreeSurferColorLUT.txt' }),
    ).rejects.toThrow(/lacks FreeSurferColorLUT.txt/)
    await put(join(home, 'FreeSurferColorLUT.txt'), 'table')
    await expect(
      readBrainAsset(context(), {
        assetId: 'FreeSurferColorLUT.txt',
        subjectId: 'sub-01',
      }),
    ).rejects.toThrow(/subject volumes only/)
    await rm(join(home, 'FreeSurferColorLUT.txt'))
    await put(join(root, 'elsewhere.txt'), 'outside')
    await symlink(
      join(root, 'elsewhere.txt'),
      join(home, 'FreeSurferColorLUT.txt'),
    )
    await expect(
      readBrainAsset(context(), { assetId: 'FreeSurferColorLUT.txt' }),
    ).rejects.toThrow(/inside the FreeSurfer home folder/)
    const report = await listBrainAssets(context(), {})
    expect(report.assets.map((a) => a.assetId)).not.toContain(
      'FreeSurferColorLUT.txt',
    )
  })

  it('lists the optional template atlases that exist', async () => {
    const first = TEMPLATE_ATLAS_ASSET_IDS[0]!
    const second = TEMPLATE_ATLAS_ASSET_IDS[1]!
    await put(join(home, 'subjects', first), 'destrieux')
    await put(join(home, 'subjects', second), 'yeo')
    const report = await listBrainAssets(context(), {})
    expect(report.available).toBe(true)
    expect(report.assets.map((a) => a.assetId)).toEqual([
      ...FSAVERAGE_ASSET_IDS,
      first,
      second,
    ])
  })
})

describe('the labeling cache', () => {
  let cache: string

  beforeEach(async () => {
    cache = join(root, 'project', '.supraspina', 'analysis', 'atlases')
    await put(
      join(
        cache,
        'brainstem-ss',
        'sub-01',
        'brainstemSsLabels.FSvoxelSpace.mgz',
      ),
      'brainstem labels',
    )
    await put(
      join(cache, 'brainstem-ss', 'sub-01', 'brainstemSsLabels.volumes.txt'),
      'volumes',
    )
    await put(join(cache, 'templates', 'fsaverage5', 'lh.dkt.annot'), 'dkt')
    await put(
      join(cache, 'templates', 'fsaverage5', 'rh.user-0123abcd.annot'),
      'added',
    )
    await put(
      join(cache, 'user-0123abcd', 'sub-01', 'user-0123abcd.mgz'),
      'added volume',
    )
    await put(
      join(cache, 'user-0123abcd', 'sub-01', 'user-0123abcd.ctab'),
      '1 Nucleus_L 1 2 3 0',
    )
  })

  it('allows each atlas only its recipe viewer files', () => {
    expect(atlasViewerFiles('brainstem-ss')).toEqual({
      subject: ['brainstemSsLabels.FSvoxelSpace.mgz'],
      template: [],
    })
    expect(atlasViewerFiles('hippo-amygdala')?.subject).toEqual([
      'lh.hippoAmygLabels.FSvoxelSpace.mgz',
      'rh.hippoAmygLabels.FSvoxelSpace.mgz',
    ])
    expect(atlasViewerFiles('dkt')).toEqual({
      subject: [],
      template: ['lh.dkt.annot', 'rh.dkt.annot'],
    })
    expect(atlasViewerFiles('user-0123abcd')).toEqual({
      subject: ['user-0123abcd.mgz', 'user-0123abcd.ctab'],
      template: ['lh.user-0123abcd.annot', 'rh.user-0123abcd.annot'],
    })
    expect(atlasViewerFiles('yeo7')).toEqual({ subject: [], template: [] })
    for (const atlasId of ['aseg', 'templates', '_work', 'user-xyz', 'other']) {
      expect(atlasViewerFiles(atlasId)).toBeNull()
    }
  })

  it('reads a subject label map and template labels', async () => {
    const subject = await readBrainAsset(context(), {
      assetId: 'atlas/brainstem-ss/subject/brainstemSsLabels.FSvoxelSpace.mgz',
      subjectId: 'sub-01',
    })
    expect(Buffer.from(subject.data).toString()).toBe('brainstem labels')
    expect(subject.sha256).toBe(sha('brainstem labels'))
    const template = await readBrainAsset(context(), {
      assetId: 'atlas/dkt/templates-fsaverage5/lh.dkt.annot',
    })
    expect(Buffer.from(template.data).toString()).toBe('dkt')
    const added = await readBrainAsset(context(), {
      assetId: 'atlas/user-0123abcd/subject/user-0123abcd.mgz',
      subjectId: 'sub-01',
    })
    expect(Buffer.from(added.data).toString()).toBe('added volume')
    const table = await readBrainAsset(context(), {
      assetId: 'atlas/user-0123abcd/subject/user-0123abcd.ctab',
      subjectId: 'sub-01',
    })
    expect(Buffer.from(table.data).toString()).toBe('1 Nucleus_L 1 2 3 0')
  })

  it('refuses files outside the recipe allowlist', async () => {
    for (const [assetId, subjectId] of [
      ['atlas/brainstem-ss/subject/brainstemSsLabels.volumes.txt', 'sub-01'],
      ['atlas/yeo7/templates-fsaverage5/lh.yeo7.annot', undefined],
      ['atlas/dkt/templates-fsaverage5/lh.user-0123abcd.annot', undefined],
      [
        'atlas/user-0123abcd/subject/brainstemSsLabels.FSvoxelSpace.mgz',
        'sub-01',
      ],
      ['atlas/templates/templates-fsaverage5/lh.dkt.annot', undefined],
    ] as const) {
      await expect(
        readBrainAsset(context(), {
          assetId: assetId as BrainAssetId,
          ...(subjectId ? { subjectId } : {}),
        }),
      ).rejects.toThrow(/labeling lets the viewer read/)
    }
  })

  it('requires the subject for subject labels only', async () => {
    await expect(
      readBrainAsset(context(), {
        assetId:
          'atlas/brainstem-ss/subject/brainstemSsLabels.FSvoxelSpace.mgz',
      }),
    ).rejects.toThrow(/valid subject ID/)
    await expect(
      readBrainAsset(context(), {
        assetId: 'atlas/dkt/templates-fsaverage5/lh.dkt.annot',
        subjectId: 'sub-01',
      }),
    ).rejects.toThrow(/subject labels only/)
    await expect(
      readBrainAsset(context(), {
        assetId:
          'atlas/brainstem-ss/subject/brainstemSsLabels.FSvoxelSpace.mgz',
        subjectId: 'fsaverage5',
      }),
    ).rejects.toThrow(/valid subject ID/)
  })

  it('refuses a symlinked file, a linked folder, and a cache outside the project', async () => {
    const file = join(cache, 'templates', 'fsaverage5', 'rh.dkt.annot')
    await symlink(join(cache, 'templates', 'fsaverage5', 'lh.dkt.annot'), file)
    await expect(
      readBrainAsset(context(), {
        assetId: 'atlas/dkt/templates-fsaverage5/rh.dkt.annot',
      }),
    ).rejects.toThrow(/through real files/)

    const other = join(root, 'other-subject')
    await put(join(other, 'brainstemSsLabels.FSvoxelSpace.mgz'), 'elsewhere')
    await symlink(other, join(cache, 'brainstem-ss', 'sub-02'))
    await expect(
      readBrainAsset(context(), {
        assetId:
          'atlas/brainstem-ss/subject/brainstemSsLabels.FSvoxelSpace.mgz',
        subjectId: 'sub-02',
      }),
    ).rejects.toThrow(/inside the labeling cache/)

    const moved = join(root, 'moved-atlases')
    await rename(cache, moved)
    await symlink(moved, cache)
    await expect(
      readBrainAsset(context(), {
        assetId: 'atlas/dkt/templates-fsaverage5/lh.dkt.annot',
      }),
    ).rejects.toThrow(/inside the project folder/)
    const report = await listBrainAssets(context(), { subjectId: 'sub-01' })
    expect(
      report.assets.some((asset) => asset.assetId.startsWith('atlas/')),
    ).toBe(false)
  })

  it('refuses a missing cache or file, oversized files, and folders', async () => {
    await expect(
      readBrainAsset(context(), {
        assetId: 'atlas/dkt/templates-fsaverage5/rh.dkt.annot',
      }),
    ).rejects.toThrow(/lacks this file/)
    const big = join(cache, 'templates', 'fsaverage5', 'rh.dkt.annot')
    await put(big, '')
    await truncate(big, MAX_BRAIN_ASSET_BYTES + 1)
    await expect(
      readBrainAsset(context(), {
        assetId: 'atlas/dkt/templates-fsaverage5/rh.dkt.annot',
      }),
    ).rejects.toThrow(/16 MiB/)
    await mkdir(
      join(cache, 'thalamic', 'sub-01', 'ThalamicNuclei.FSvoxelSpace.mgz'),
      {
        recursive: true,
      },
    )
    await expect(
      readBrainAsset(context(), {
        assetId: 'atlas/thalamic/subject/ThalamicNuclei.FSvoxelSpace.mgz',
        subjectId: 'sub-01',
      }),
    ).rejects.toThrow(/regular files/)
    await rm(join(root, 'project', '.supraspina'), { recursive: true })
    await expect(
      readBrainAsset(context(), {
        assetId: 'atlas/dkt/templates-fsaverage5/lh.dkt.annot',
      }),
    ).rejects.toThrow(/no labeling cache/)
  })

  it('lists the template labels and the subject label maps present', async () => {
    const template = await listBrainAssets(context(), {})
    expect(
      template.assets.filter((a) => a.assetId.startsWith('atlas/')),
    ).toEqual([
      { assetId: 'atlas/dkt/templates-fsaverage5/lh.dkt.annot', bytes: 3 },
      {
        assetId:
          'atlas/user-0123abcd/templates-fsaverage5/rh.user-0123abcd.annot',
        bytes: 5,
      },
    ])
    const subject = await listBrainAssets(context(), { subjectId: 'sub-01' })
    expect(
      subject.assets
        .filter((a) => a.assetId.startsWith('atlas/'))
        .map((a) => a.assetId),
    ).toEqual([
      'atlas/brainstem-ss/subject/brainstemSsLabels.FSvoxelSpace.mgz',
      'atlas/dkt/templates-fsaverage5/lh.dkt.annot',
      'atlas/user-0123abcd/templates-fsaverage5/rh.user-0123abcd.annot',
      'atlas/user-0123abcd/subject/user-0123abcd.mgz',
      'atlas/user-0123abcd/subject/user-0123abcd.ctab',
    ])
  })
})

describe.skipIf(!existsSync(join(REAL_FREESURFER_HOME, 'subjects')))(
  'the installed FreeSurfer 8.2.0 home',
  () => {
    it('provides every allowlisted template file and the color table under the size cap', async () => {
      const report = await listBrainAssets(
        context({ cfg: configWithHome(REAL_FREESURFER_HOME) }),
        {},
      )
      expect(report.available).toBe(true)
      expect(report.assets.map((a) => a.assetId)).toEqual([
        ...FSAVERAGE_ASSET_IDS,
        ...TEMPLATE_ATLAS_ASSET_IDS,
        'FreeSurferColorLUT.txt',
      ])
      for (const asset of report.assets) {
        expect(asset.bytes).toBeGreaterThan(0)
        expect(asset.bytes).toBeLessThanOrEqual(MAX_BRAIN_ASSET_BYTES)
      }
      const volume = await readBrainAsset(
        context({ cfg: configWithHome(REAL_FREESURFER_HOME) }),
        { assetId: 'fsaverage/mri/aparc+aseg.mgz' },
      )
      // MGZ is gzip.
      expect([volume.data[0], volume.data[1]]).toEqual([0x1f, 0x8b])
      const table = await readBrainAsset(
        context({ cfg: configWithHome(REAL_FREESURFER_HOME) }),
        { assetId: 'FreeSurferColorLUT.txt' },
      )
      expect(Buffer.from(table.data).toString()).toMatch(/^175\s+Medulla\s/m)
    })
  },
)
