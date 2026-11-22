/** Tests for the atlas-labeling contract and its mock: catalog, parsers, requests. */

import { describe, expect, it } from 'vitest'
import {
  ATLAS_CACHE_VIEWER_FILES,
  ATLAS_LABELING_REQUEST_FIELDS,
  ATLAS_RECIPE_IDS,
  ATLAS_RECIPES,
  ATLAS_SOURCES,
  BUILT_IN_ATLASES,
  atlasSourcePage,
  atlasSourceUrl,
  expandAtlasFile,
  labelsInputSource,
  parseAtlasCatalog,
  parseAtlasDownloadCancelResult,
  parseAtlasDownloadStartResult,
  parseAtlasDownloadStatus,
  parseAtlasImportResult,
  parseAtlasLabelCancelResult,
  parseAtlasLabelStartResult,
  parseAtlasLabelStatus,
  parseAtlasLabelsCleared,
  parseAtlasLabelsImportResult,
  parseAtlasSourcesList,
  validateAtlasLabelingRequest,
} from '../../shared/atlas-labeling'
import { ATLAS_ID, parseMeasureId } from '../../shared/group-analysis'
import {
  MOCK_LABELING_PROGRESS,
  MOCK_DOWNLOAD_POLLS,
  createMockAtlasSources,
  createMockLabeling,
  mockAtlasCatalog,
  mockAtlasMachine,
} from './mock-analysis-v2'

const PROJECT = {
  projectId: 'analysis-project',
  root: '/data/study',
  configPath: '/data/study/supraspina.project.json',
  epoch: 1,
}

describe('atlas catalog constants', () => {
  it('gives every recipe one entry and a viewer allowlist', () => {
    expect(ATLAS_RECIPES.map((recipe) => recipe.recipeId)).toEqual([
      ...ATLAS_RECIPE_IDS,
    ])
    expect(Object.keys(ATLAS_CACHE_VIEWER_FILES).sort()).toEqual(
      [...ATLAS_RECIPE_IDS].sort(),
    )
  })

  it('names built-in atlases the measure grammar accepts', () => {
    for (const atlas of BUILT_IN_ATLASES) {
      expect(ATLAS_ID.test(atlas.atlasId)).toBe(true)
      if (atlas.namespace === 'parc') {
        expect(atlas.metrics.length).toBeGreaterThan(0)
        expect(
          parseMeasureId(`parc:${atlas.atlasId}:lh:region:${atlas.metrics[0]}`),
        ).not.toBeNull()
      }
      if (atlas.namespace === 'vol') {
        expect(
          parseMeasureId(`vol:${atlas.atlasId}:mid:Medulla`),
        ).not.toBeNull()
      }
      expect(
        atlas.recipeId === null || ATLAS_RECIPE_IDS.includes(atlas.recipeId),
      ).toBe(true)
    }
  })

  it('expands recipe file patterns', () => {
    expect(expandAtlasFile('{hemi}.{atlas}.annot', 'yeo7')).toEqual([
      'lh.yeo7.annot',
      'rh.yeo7.annot',
    ])
    expect(expandAtlasFile('{atlas}.stats', 'user-0a1b2c3d')).toEqual([
      'user-0a1b2c3d.stats',
    ])
    expect(labelsInputSource('brainstem-ss')).toBe('labels:brainstem-ss')
    expect(() => labelsInputSource('../x')).toThrow(TypeError)
  })

  it('pins only the verified Schaefer files and opens only listed https pages', () => {
    for (const source of ATLAS_SOURCES) {
      if (source.sourceId === 'schaefer2018') {
        expect(source.version).toBe('cbig-35b5664')
        expect(source.files).toHaveLength(13)
        for (const file of source.files) {
          expect(file.url).toMatch(
            /^https:\/\/raw\.githubusercontent\.com\/ThomasYeoLab\/CBIG\/35b5664bec8822e2f77da5e090e96f91d0095be6\//,
          )
          expect(file.url.endsWith(`/${file.relpath.split('/').at(-1)}`)).toBe(
            true,
          )
        }
      } else {
        expect(source.files).toEqual([])
      }
      expect(atlasSourcePage(source.sourceId)).toBe(source.pageUrl)
      expect(source.pageUrl.startsWith('https://')).toBe(true)
    }
    expect(atlasSourcePage('elsewhere')).toBeNull()
    for (const source of ATLAS_SOURCES) {
      expect(atlasSourceUrl(source.sourceId, 'page')).toBe(source.pageUrl)
      expect(atlasSourceUrl(source.sourceId, 'license')).toBe(
        source.license.url,
      )
    }
    expect(atlasSourceUrl('schaefer2018', 'citation')).toBeNull()
    expect(atlasSourceUrl('elsewhere', 'license')).toBeNull()
    expect(atlasSourcePage({ sourceId: 'schaefer2018' })).toBeNull()
  })
})

describe('atlas result parsers', () => {
  it('accepts the fixture catalog and a running labeling', () => {
    const catalog = parseAtlasCatalog(
      JSON.parse(JSON.stringify(mockAtlasCatalog(MOCK_LABELING_PROGRESS))),
    )
    expect(catalog.labeling?.state).toBe('running')
    expect(catalog.atlases.some((atlas) => atlas.tier === 'B')).toBe(true)
  })

  it('refuses unknown keys, bad IDs, and non-https license links', () => {
    const catalog = mockAtlasCatalog()
    expect(() => parseAtlasCatalog({ ...catalog, extra: 1 })).toThrow(TypeError)
    const badAtlas = structuredClone(catalog)
    badAtlas.atlases[0]!.atlasId = 'Bad Atlas'
    expect(() => parseAtlasCatalog(badAtlas)).toThrow(/field atlases/)
    const badLicense = structuredClone(catalog)
    badLicense.atlases.at(-1)!.license!.url = 'http://example.org'
    expect(() => parseAtlasCatalog(badLicense)).toThrow(TypeError)
  })

  it('validates the labeling operation results', async () => {
    const labeling = createMockLabeling()
    const started = parseAtlasLabelStartResult(
      await labeling.labelStart({
        project: PROJECT,
        atlasId: 'brainstem-ss',
        subjects: 'missing',
        jobs: 2,
        stageCurrency: { aggregate: 'current', pybrainage: 'current' },
      }),
    )
    expect(started.started).toBe(true)
    const again = await labeling.labelStart({
      project: PROJECT,
      atlasId: 'brainstem-ss',
      subjects: 'missing',
      jobs: 2,
      stageCurrency: { aggregate: 'current', pybrainage: 'current' },
    })
    expect(again.started).toBe(false)
    const status = parseAtlasLabelStatus(
      await labeling.labelStatus({ project: PROJECT, atlasId: null }),
    )
    expect(status.atlasId).toBe('brainstem-ss')
    expect(status.subjects.filter((row) => row.state === 'stale')).toHaveLength(
      2,
    )
    const cancelled = parseAtlasLabelCancelResult(
      await labeling.labelCancel({
        project: PROJECT,
        operationId: started.operation.operationId,
      }),
    )
    expect(cancelled.stopped).toBe(true)
    const cleared = parseAtlasLabelsCleared(
      await labeling.clearLabels({
        project: PROJECT,
        atlasId: 'brainstem-ss',
        subjects: 'all',
        expectedRevision: 3,
      }),
    )
    expect(cleared.revision).toBe(4)
    await expect(
      labeling.clearLabels({
        project: PROJECT,
        atlasId: 'brainstem-ss',
        subjects: 'all',
        expectedRevision: 3,
      }),
    ).rejects.toThrow(/labels changed/)
    expect(() =>
      parseAtlasLabelStatus({ ...status, subjects: [{ subjectId: '../x' }] }),
    ).toThrow(TypeError)
  })

  it('finishes a mock labeling after its status reads', async () => {
    const labeling = createMockLabeling()
    await labeling.labelStart({
      project: PROJECT,
      atlasId: 'thalamic',
      subjects: ['sub-101'],
      jobs: 1,
      stageCurrency: { aggregate: 'current', pybrainage: 'current' },
    })
    let state = 'running'
    for (let read = 0; read < 3; read += 1) {
      const status = await labeling.labelStatus({
        project: PROJECT,
        atlasId: 'thalamic',
      })
      state = status.operation!.state
    }
    expect(state).toBe('done')
  })

  it('validates imports and the atlas source results', async () => {
    const atlas = mockAtlasCatalog().atlases.at(-1)!
    expect(parseAtlasImportResult({ atlas }).atlas.atlasId).toBe(atlas.atlasId)
    expect(
      parseAtlasLabelsImportResult({
        atlasId: 'brainstem-ss',
        imported: 3,
        unrecognized: ['sub-104'],
      }).imported,
    ).toBe(3)
    const sources = createMockAtlasSources()
    const listed = parseAtlasSourcesList(await sources.list())
    expect(listed.sources.map((item) => item.source.sourceId)).toEqual(
      ATLAS_SOURCES.map((source) => source.sourceId),
    )
    expect(
      parseAtlasDownloadStatus(await sources.status()).operation,
    ).toBeNull()
    await expect(
      sources.download({ sourceId: 'brainnetome', licenseAcknowledged: true }),
    ).rejects.toThrow(/no verified download/)
    const operation = {
      operationId: 'adl-0123456789abcdef',
      sourceId: 'schaefer2018',
      state: 'running',
      receivedBytes: 10,
      totalBytes: 100,
      file: 'lh.Schaefer2018_400Parcels_7Networks_order.annot',
      startedAt: '2026-09-30T09:30:00.000Z',
      finishedAt: null,
      message: null,
    }
    expect(
      parseAtlasDownloadStartResult({ operation, started: true }).started,
    ).toBe(true)
    expect(() =>
      parseAtlasDownloadStatus({
        operation: { ...operation, file: '../escape' },
      }),
    ).toThrow(TypeError)
    expect(
      parseAtlasDownloadCancelResult({
        operationId: 'adl-0123456789abcdef',
        stopped: false,
      }).stopped,
    ).toBe(false)
  })
})

describe('the mock atlas machine', () => {
  it('shares the interpreter, downloads, and added atlases with the catalog', async () => {
    const labeling = createMockLabeling()
    const sources = createMockAtlasSources()
    const read = async (ids: string[] = []) =>
      parseAtlasCatalog(
        await labeling.atlases({
          project: PROJECT,
          reconOutdatedSubjectIds: ids,
        }),
      )
    let catalog = await read(['sub-002', 'sub-003'])
    expect(
      catalog.atlases.find((atlas) => atlas.atlasId === 'brainstem-ss')!.counts
        .reconOutdated,
    ).toBe(3)
    expect(
      catalog.tools.find((fact) => fact.toolId === 'subregions-python')!.state,
    ).toBe('missing')
    await sources.chooseSubregionsPython()
    catalog = await read()
    expect(catalog.subregionsPython).toBe('/opt/py312/bin/python')
    expect(
      catalog.tools.find((fact) => fact.toolId === 'segment-subregions')!.state,
    ).toBe('ok')
    await sources.clearSubregionsPython()
    expect((await read()).subregionsPython).toBeNull()

    const started = await sources.download({
      sourceId: 'schaefer2018',
      licenseAcknowledged: true,
    })
    expect(started.started).toBe(true)
    expect(
      (
        await sources.download({
          sourceId: 'schaefer2018',
          licenseAcknowledged: true,
        })
      ).started,
    ).toBe(false)
    let status = await sources.status()
    for (let poll = 1; poll < MOCK_DOWNLOAD_POLLS; poll += 1) {
      expect(status.operation!.state).toBe('running')
      status = await sources.status()
    }
    expect(parseAtlasDownloadStatus(status).operation!.state).toBe('done')
    const listed = await sources.list()
    expect(
      listed.sources.find((item) => item.source.sourceId === 'schaefer2018')!
        .state,
    ).toBe('present')
    catalog = await read()
    expect(
      catalog.atlases.find((atlas) => atlas.atlasId === 'schaefer400-7'),
    ).toMatchObject({ origin: 'added', externalSourceId: 'schaefer2018' })

    const added = await labeling.chooseAtlasFiles({
      project: PROJECT,
      recipeId: 'user-volume',
      label: 'Brainstem nuclei',
      license: { name: 'Lab terms', url: null },
      externalSourceId: 'brainstem-navigator',
    })
    expect(parseAtlasImportResult(added!).atlas).toMatchObject({
      label: 'Brainstem nuclei',
      kind: 'volume',
      namespace: 'vol',
    })
    expect(
      (await read()).atlases.some(
        (atlas) => atlas.label === 'Brainstem nuclei',
      ),
    ).toBe(true)
    expect(
      parseAtlasLabelsImportResult(
        (await labeling.chooseLabelsFolder({
          project: PROJECT,
          atlasId: 'brainstem-ss',
        }))!,
      ).imported,
    ).toBe(4)
  })

  it('cancels a running mock download', async () => {
    const sources = createMockAtlasSources(mockAtlasMachine())
    const { operation } = await sources.download({
      sourceId: 'schaefer2018',
      licenseAcknowledged: true,
    })
    expect(
      (await sources.cancel({ operationId: operation.operationId })).stopped,
    ).toBe(true)
    expect((await sources.status()).operation!.state).toBe('cancelled')
    expect(
      (await sources.cancel({ operationId: operation.operationId })).stopped,
    ).toBe(false)
  })
})

describe('labeling requests', () => {
  it.each([
    ['groupAnalysis.atlases', { reconOutdatedSubjectIds: [] }],
    ['groupAnalysis.atlases', { reconOutdatedSubjectIds: ['sub-101'] }],
    [
      'groupAnalysis.labelStart',
      {
        atlasId: 'brainstem-ss',
        subjects: 'stale',
        jobs: 8,
        stageCurrency: { aggregate: 'current', pybrainage: 'current' },
      },
    ],
    ['groupAnalysis.labelStatus', { atlasId: null }],
    ['groupAnalysis.labelCancel', { operationId: 'alb-0123456789abcdef' }],
    [
      'groupAnalysis.clearLabels',
      { atlasId: 'brainstem-ss', subjects: ['sub-101'], expectedRevision: 2 },
    ],
  ])('accepts %s', (method, fields) => {
    expect(() =>
      validateAtlasLabelingRequest(method, { project: PROJECT, ...fields }),
    ).not.toThrow()
  })

  it.each([
    ['groupAnalysis.atlases', { extra: 1 }, /invalid fields/],
    ['groupAnalysis.atlases', {}, /invalid fields/],
    [
      'groupAnalysis.atlases',
      { reconOutdatedSubjectIds: ['../sub'] },
      /out-of-date subjects/,
    ],
    [
      'groupAnalysis.atlases',
      { reconOutdatedSubjectIds: 'sub-101' },
      /out-of-date subjects/,
    ],
    [
      'groupAnalysis.labelStart',
      { atlasId: null, subjects: 'missing', jobs: 1, stageCurrency: {} },
      /atlas ID/,
    ],
    [
      'groupAnalysis.labelStart',
      { atlasId: 'yeo7', subjects: 'all', jobs: 1, stageCurrency: {} },
      /each once/,
    ],
    [
      'groupAnalysis.labelStart',
      { atlasId: 'yeo7', subjects: [], jobs: 1, stageCurrency: {} },
      /each once/,
    ],
    [
      'groupAnalysis.labelStart',
      { atlasId: 'yeo7', subjects: 'missing', jobs: 0, stageCurrency: {} },
      /parallel/,
    ],
    [
      'groupAnalysis.labelCancel',
      { operationId: 'gan-0123456789abcdef' },
      /labeling operation ID/,
    ],
    [
      'groupAnalysis.clearLabels',
      { atlasId: 'yeo7', subjects: 'all', expectedRevision: -1 },
      /cache revision/,
    ],
    ['groupAnalysis.unknown', {}, /allowlisted/],
  ])('refuses %s %j', (method, fields, message) => {
    expect(() =>
      validateAtlasLabelingRequest(method, { project: PROJECT, ...fields }),
    ).toThrow(message)
  })

  it('names every labeling method once', () => {
    expect(Object.keys(ATLAS_LABELING_REQUEST_FIELDS)).toHaveLength(5)
  })
})
