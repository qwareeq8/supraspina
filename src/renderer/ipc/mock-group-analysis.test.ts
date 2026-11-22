/**
 * Binds the synthetic analysis fixture to the shared result parsers, so the
 * mock the panel is built against stays inside the sidecar contract.
 */

import { describe, expect, it } from 'vitest'
import {
  parseGroupAnalysisCancelResult,
  parseGroupAnalysisCatalog,
  parseGroupAnalysisExportData,
  parseGroupAnalysisExportResult,
  parseGroupAnalysisInputs,
  parseGroupAnalysisLibrary,
  parseGroupAnalysisList,
  parseGroupAnalysisMeasureDetail,
  parseGroupAnalysisResult,
  parseGroupAnalysisSpec,
  parseGroupAnalysisStartResult,
  parseGroupAnalysisStatus,
} from '../../shared/group-analysis'
import {
  MOCK_ANALYSIS_RESULT,
  MOCK_ANALYSIS_SPEC,
  MOCK_COMPUTE_POLLS,
  createMockGroupAnalysis,
  mockAnalysisCatalog,
  mockInclusion,
} from './mock-group-analysis'

const PROJECT = {
  projectId: 'analysis-project',
  root: '/data/study',
  configPath: '/data/study/supraspina.project.json',
  epoch: 1,
}

describe('result parsers', () => {
  it('accept the export folder main chose, suffixed when taken', async () => {
    const { groupAnalysis } = createMockGroupAnalysis(() => '/data/study')
    const request = {
      project: PROJECT,
      destinationId: 'mock-analysis-export',
      resultId: MOCK_ANALYSIS_RESULT.resultId,
      folderName: 'figure-2',
      subjectCsv: false,
      figures: [],
    }
    const first = parseGroupAnalysisExportResult(
      await groupAnalysis.writeExport(request),
    )
    const second = parseGroupAnalysisExportResult(
      await groupAnalysis.writeExport(request),
    )
    expect([first.folderName, second.folderName]).toEqual([
      'figure-2',
      'figure-2-2',
    ])
    expect(() =>
      parseGroupAnalysisExportResult({ ...first, folderName: 'Figure 2' }),
    ).toThrow(TypeError)
  })

  it('accept every synthetic fixture payload', async () => {
    const { groupAnalysis } = createMockGroupAnalysis(() => '/data/study')
    const project = PROJECT
    parseGroupAnalysisCatalog(mockAnalysisCatalog())
    parseGroupAnalysisResult(MOCK_ANALYSIS_RESULT)
    parseGroupAnalysisSpec(MOCK_ANALYSIS_SPEC)
    parseGroupAnalysisInputs(
      await groupAnalysis.inputs({ project, spec: MOCK_ANALYSIS_SPEC }),
    )
    parseGroupAnalysisStatus(await groupAnalysis.status({ project }))
    const started = parseGroupAnalysisStartResult(
      await groupAnalysis.start({
        project,
        spec: MOCK_ANALYSIS_SPEC,
        stageCurrency: { aggregate: 'current', pybrainage: 'current' },
      }),
    )
    parseGroupAnalysisStatus(await groupAnalysis.status({ project }))
    parseGroupAnalysisCancelResult(
      await groupAnalysis.cancel({
        project,
        operationId: started.operation.operationId,
      }),
    )
    const list = parseGroupAnalysisList(await groupAnalysis.list({ project }))
    parseGroupAnalysisMeasureDetail(
      await groupAnalysis.measureDetail({
        project,
        resultId: MOCK_ANALYSIS_RESULT.resultId,
        measureId: 'aseg:Brain-Stem',
      }),
    )
    parseGroupAnalysisLibrary(
      await groupAnalysis.saveSet({
        project,
        setId: null,
        name: 'Motor regions',
        measures: ['dk:bi:precentral:ThickAvg'],
        expectedRevision: list.revision,
      }),
    )
    parseGroupAnalysisExportData({
      resultId: MOCK_ANALYSIS_RESULT.resultId,
      name: 'SCI vs controls',
      provisional: false,
      files: [{ name: 'results.csv', text: 'measure\n' }],
    })
  })

  it('shows the fixture shape the panel is designed around', () => {
    expect(MOCK_ANALYSIS_RESULT.sample.groups).toEqual([
      { label: 'SCI', n: 34 },
      { label: 'CTRL', n: 48 },
    ])
    expect(MOCK_ANALYSIS_RESULT.rows).toHaveLength(20)
    expect(
      MOCK_ANALYSIS_RESULT.rows
        .filter((row) => row.significant)
        .map((row) => row.measureId)
        .sort(),
    ).toEqual(['dk:bi:precentral:ThickAvg'])
  })

  it('names the first failing field', () => {
    expect(() =>
      parseGroupAnalysisStatus({ operation: { operationId: 'x' } }),
    ).toThrow(/group-analysis status \(field operation/)
    expect(() =>
      parseGroupAnalysisResult({ ...MOCK_ANALYSIS_RESULT, extra: true }),
    ).toThrow(/group-analysis result/)
  })
})

describe('brain viewer mock', () => {
  it('reports the missing FreeSurfer home', async () => {
    const { brainViewer } = createMockGroupAnalysis(() => '/data/study')
    await expect(brainViewer.assets({ project: PROJECT })).resolves.toEqual({
      available: false,
      unavailableReason: 'FreeSurfer home is not set.',
      subjectId: null,
      assets: [],
    })
    await expect(
      brainViewer.readAsset({
        project: PROJECT,
        assetId: 'fsaverage/mri/brain.mgz',
      }),
    ).rejects.toThrow('FreeSurfer home is not set.')
  })
})

describe('compute mock', () => {
  const stageCurrency = { aggregate: 'current', pybrainage: 'current' } as const

  it('runs for a few status reads, then returns the fixture result', async () => {
    const { groupAnalysis } = createMockGroupAnalysis(() => '/data/study')
    const project = PROJECT
    const { operation } = await groupAnalysis.start({
      project,
      spec: MOCK_ANALYSIS_SPEC,
      stageCurrency,
    })
    expect(operation).toMatchObject({ state: 'running', total: 5000 })
    const states: string[] = []
    for (let poll = 0; poll < MOCK_COMPUTE_POLLS; poll += 1) {
      const status = parseGroupAnalysisStatus(
        await groupAnalysis.status({ project }),
      )
      states.push(status.operation!.state)
    }
    expect(states).toEqual(['running', 'running', 'running', 'done'])
    const done = (await groupAnalysis.status({ project })).operation!
    expect(done).toMatchObject({
      completed: 5000,
      resultId: MOCK_ANALYSIS_RESULT.resultId,
    })
    await expect(
      groupAnalysis.cancel({ project, operationId: done.operationId }),
    ).resolves.toEqual({ operationId: done.operationId, stopped: false })
  })

  it('cancels a running compute', async () => {
    const { groupAnalysis } = createMockGroupAnalysis(() => '/data/study')
    const project = PROJECT
    const { operation } = await groupAnalysis.start({
      project,
      spec: MOCK_ANALYSIS_SPEC,
      stageCurrency,
    })
    await expect(
      groupAnalysis.cancel({ project, operationId: operation.operationId }),
    ).resolves.toEqual({ operationId: operation.operationId, stopped: true })
    expect((await groupAnalysis.status({ project })).operation?.state).toBe(
      'cancelled',
    )
  })

  it('resolves the sample from the draft groups and rules', () => {
    expect(
      mockInclusion(MOCK_ANALYSIS_SPEC).filter((s) => s.included),
    ).toHaveLength(82)
    const passed = mockInclusion({
      ...MOCK_ANALYSIS_SPEC,
      inclusion: { ...MOCK_ANALYSIS_SPEC.inclusion, qc: 'passed' },
    })
    expect(passed.filter((s) => s.reason === 'qc-not-passed')).toHaveLength(7)
    const contrast = MOCK_ANALYSIS_SPEC.contrast
    if (contrast.type !== 'groups') throw new Error('Use a group contrast.')
    const withoutNnp = mockInclusion({
      ...MOCK_ANALYSIS_SPEC,
      contrast: {
        ...contrast,
        model: 'compared-groups',
        grouping: {
          ...contrast.grouping,
          groups: [
            { label: 'SCI', levels: ['SCI_P'] },
            { label: 'CTRL', levels: ['CTRL'] },
            { label: 'Other', levels: ['SCI_nNP'] },
          ],
        },
      },
    })
    expect(withoutNnp.filter((s) => s.reason === 'not-compared')).toHaveLength(
      12,
    )
  })
})

describe('spec v1 site check mock', () => {
  it('checks a spec v1 for site alone, as the sidecar does', async () => {
    const sited = createMockGroupAnalysis(() => '/data/study', {
      sites: true,
    }).groupAnalysis
    const check = parseGroupAnalysisInputs(
      await sited.inputs({ project: PROJECT, spec: MOCK_ANALYSIS_SPEC }),
    ).designCheck
    expect(check).not.toBeNull()
    expect(check!.ok).toBe(false)
    expect(check!.issues.map((issue) => issue.code)).toEqual([
      'site-confounded',
    ])
    expect(check!.issues[0]!.testId).toBe('t1')
    expect(check!.issues[0]!.fixes?.map((fix) => fix.kind)).toEqual([
      'drop-level',
      'add-covariate',
    ])
    expect(check!.cells).toEqual([])
    expect(check!.crosstabs.map((row) => row.columnVariable)).toEqual(['site'])

    const plain = createMockGroupAnalysis(() => '/data/study').groupAnalysis
    expect(
      (await plain.inputs({ project: PROJECT, spec: MOCK_ANALYSIS_SPEC }))
        .designCheck,
    ).toBeNull()
  })
})
