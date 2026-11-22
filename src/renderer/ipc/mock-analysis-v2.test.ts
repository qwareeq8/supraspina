/** Tests for the Analysis v2 mock fixture and the v2 result parsers. */

import { describe, expect, it } from 'vitest'
import {
  GROUP_ANALYSIS_TERM_PAGE_ROWS,
  parseGroupAnalysisCatalog,
  parseGroupAnalysisInputs,
  parseGroupAnalysisList,
  parseGroupAnalysisMeasureDetail,
  parseGroupAnalysisResult,
  parseGroupAnalysisTermRows,
} from '../../shared/group-analysis'
import {
  MOCK_BATTERY_RESULT,
  MOCK_BATTERY_SPEC,
  MOCK_OMNIBUS_RESULT,
  MOCK_OMNIBUS_SPEC,
  MOCK_STRATIFIED_RESULT,
  MOCK_VARIABLE_TABLE,
  mockTermRows,
  mockMeasureDetailV2,
} from './mock-analysis-v2'
import { createMockGroupAnalysis } from './mock-group-analysis'

describe('result v2 and term rows', () => {
  it('parses the battery and omnibus fixtures', () => {
    for (const result of [
      MOCK_BATTERY_RESULT,
      MOCK_OMNIBUS_RESULT,
      MOCK_STRATIFIED_RESULT,
    ]) {
      const parsed = parseGroupAnalysisResult(
        JSON.parse(JSON.stringify(result)),
      )
      expect(parsed.schemaVersion).toBe(2)
    }
    expect(MOCK_OMNIBUS_RESULT.terms.map((t) => [t.kind, t.role])).toEqual([
      ['F', 'effect'],
      ['t', 'pairwise'],
      ['t', 'pairwise'],
      ['t', 'pairwise'],
    ])
  })

  it('refuses first-term rows from another term', () => {
    const broken = structuredClone(MOCK_OMNIBUS_RESULT)
    broken.rows[0]!.termId = broken.terms[1]!.termId
    expect(() => parseGroupAnalysisResult(broken)).toThrow(TypeError)
  })

  it('pages term rows with a consistent next offset', () => {
    const term = MOCK_OMNIBUS_RESULT.terms[2]!
    const page = parseGroupAnalysisTermRows(
      mockTermRows(MOCK_OMNIBUS_RESULT.resultId, term.termId, 0),
    )
    expect(page.total).toBe(term.rowCount)
    expect(page.nextOffset).toBeNull()
    expect(page.rows.length).toBeLessThanOrEqual(GROUP_ANALYSIS_TERM_PAGE_ROWS)
    expect(() =>
      parseGroupAnalysisTermRows({ ...page, nextOffset: page.total + 1 }),
    ).toThrow(TypeError)
  })

  it('parses a v2 measure detail with fitted lines', () => {
    const term = MOCK_BATTERY_RESULT.terms[1]!
    const detail = mockMeasureDetailV2(
      MOCK_BATTERY_RESULT.resultId,
      MOCK_BATTERY_RESULT.spec.measures[0]!,
      term.termId,
    )!
    const parsed = parseGroupAnalysisMeasureDetail(
      JSON.parse(JSON.stringify(detail)),
    )
    expect('termId' in parsed && parsed.fit.length).toBe(1)
  })
})

describe('the mock group-analysis domain v2', () => {
  const project = {
    projectId: 'mock',
    root: '/p',
    configPath: '/p/supraspina.project.json',
    epoch: 1,
  }

  it('lists v2 results only when asked and serves their terms', async () => {
    const plain = createMockGroupAnalysis(() => '/p').groupAnalysis
    expect((await plain.list({ project })).results).toHaveLength(1)
    const { groupAnalysis } = createMockGroupAnalysis(() => '/p', {
      listV2Results: true,
    })
    const listed = parseGroupAnalysisList(await groupAnalysis.list({ project }))
    expect(listed.results.map((r) => r.schemaVersion)).toEqual([1, 2, 2, 2])
    const result = await groupAnalysis.result({
      project,
      resultId: MOCK_OMNIBUS_RESULT.resultId,
    })
    expect(result.schemaVersion).toBe(2)
    const page = await groupAnalysis.termRows({
      project,
      resultId: MOCK_OMNIBUS_RESULT.resultId,
      termId: 'term-2',
      offset: 0,
    })
    const omnibus = new Map(
      MOCK_OMNIBUS_RESULT.rows.map((row) => [row.measureId, row.significant]),
    )
    for (const row of page.rows) {
      expect(row.gated).toBe(!omnibus.get(row.measureId))
    }
  })

  it('resolves a v2 draft with a design check and imports a table', async () => {
    const { groupAnalysis } = createMockGroupAnalysis(() => '/p')
    const inputs = parseGroupAnalysisInputs(
      await groupAnalysis.inputs({ project, spec: MOCK_BATTERY_SPEC }),
    )
    expect(inputs.included).toBe(34)
    expect(inputs.designCheck?.tests).toHaveLength(5)
    expect(inputs.subjects.find((s) => !s.included)?.reason).toBe(
      'not-in-population',
    )
    const omnibus = await groupAnalysis.inputs({
      project,
      spec: MOCK_OMNIBUS_SPEC,
    })
    expect(omnibus.designCheck?.issues).toEqual([])
    expect(
      await groupAnalysis.removeVariables({
        project,
        tableId: MOCK_VARIABLE_TABLE.tableId,
      }),
    ).toBe(true)
    expect((await groupAnalysis.catalog({ project })).variableTables).toEqual(
      [],
    )
    expect(await groupAnalysis.chooseVariablesCsv({ project })).toEqual(
      MOCK_VARIABLE_TABLE,
    )
    expect(
      parseGroupAnalysisCatalog(await groupAnalysis.catalog({ project }))
        .variableTables,
    ).toHaveLength(1)
  })
})
