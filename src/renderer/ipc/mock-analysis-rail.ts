/**
 * The synthetic fixtures the Analysis v2 rail needs beyond the v1 catalog:
 * a registry `site` (site B holds only controls, which the design check
 * flags with its two fixes), tier A and tier B measures (Destrieux,
 * wmparc, brainstem subfields, Yeo 7, sTIV; no SynthSeg TIV), and a design
 * check with cells, sex per cell, VIFs, crosstabs, and findings that
 * follow the draft. None of it is study data.
 */

import {
  isExtensiveMeasure,
  measureFamily,
  parseMeasureId,
  type AnalysisMeasure,
  type AnalysisSubjectInclusion,
  type AnalysisVariable,
  type DesignCell,
  type DesignCheck,
  type DesignCrosstab,
  type DesignIssue,
  type DesignVif,
  type GroupAnalysisSpecV2,
  type VariableRefV2,
} from '../../shared/group-analysis'

/** The fields of a fixture subject the rail fixtures read. */
export interface RailSubject {
  subjectId: string
  sourceLabel: string
  sex: 'M' | 'F'
}

/** The site of fixture subject `index`: the last eleven controls scan at B. */
export function mockSite(subject: RailSubject, index: number): string {
  return subject.sourceLabel === 'CTRL' && index >= 37 ? 'B' : 'A'
}

/** The registry `site` variable of the fixture. */
export function mockSiteVariable(
  subjects: readonly RailSubject[],
): AnalysisVariable {
  const b = subjects.filter((s, i) => mockSite(s, i) === 'B').length
  return {
    ref: { source: 'registry', column: 'site' },
    kind: 'categorical',
    n: subjects.length,
    levels: [
      { value: 'A', n: subjects.length - b },
      { value: 'B', n: b },
    ],
  }
}

const A2009S_REGIONS = [
  'G_precentral',
  'G_postcentral',
  'S_central',
  'G_front_sup',
  'G_insular_short',
  'Pole_occipital',
]
const WMPARC = ['wm-precentral', 'wm-postcentral', 'wm-superiorfrontal']
const BRAINSTEM = ['Medulla', 'Pons', 'Midbrain', 'SCP']
const YEO7 = [
  '7Networks_1',
  '7Networks_2',
  '7Networks_3',
  '7Networks_4',
  '7Networks_5',
  '7Networks_6',
  '7Networks_7',
]

function measure(
  measureId: string,
  stage: AnalysisMeasure['stage'],
): AnalysisMeasure {
  return {
    measureId,
    source: parseMeasureId(measureId)!.source,
    family: measureFamily(measureId),
    extensive: isExtensiveMeasure(measureId),
    stage,
    available: true,
    unavailableReason: null,
  }
}

/** The tier A and tier B measures of the fixture catalog. */
export function mockRailMeasures(): AnalysisMeasure[] {
  const out: AnalysisMeasure[] = []
  for (const region of A2009S_REGIONS) {
    for (const hemi of ['lh', 'rh', 'bi']) {
      for (const metric of ['ThickAvg', 'SurfArea', 'GrayVol', 'MeanCurv']) {
        out.push(measure(`parc:a2009s:${hemi}:${region}:${metric}`, 'recon'))
      }
    }
  }
  for (const region of WMPARC) {
    for (const hemi of ['lh', 'rh', 'bi']) {
      out.push(measure(`vol:wmparc:${hemi}:${region}`, 'recon'))
    }
  }
  for (const structure of BRAINSTEM) {
    out.push(measure(`vol:brainstem-ss:mid:${structure}`, 'labeling'))
  }
  for (const network of YEO7) {
    for (const hemi of ['lh', 'rh', 'bi']) {
      out.push(measure(`parc:yeo7:${hemi}:${network}:ThickAvg`, 'labeling'))
      out.push(measure(`parc:yeo7:${hemi}:${network}:SurfArea`, 'labeling'))
    }
  }
  out.push(measure('global:sTIV', 'recon'))
  out.push(measure('global:SurfaceHoles', 'recon'))
  out.push({
    ...measure('global:synthsegTIV', 'recon'),
    available: false,
    unavailableReason: 'No subject has synthseg.tiv.dat.',
  })
  return out
}

const SITE: VariableRefV2 = { source: 'registry', column: 'site' }

function isSite(ref: VariableRefV2 | null | undefined): boolean {
  return ref?.source === 'registry' && ref.column === 'site'
}

/**
 * The fixture design check of a spec v2 draft: each test's sample and
 * cells (sex per cell), VIFs, a crosstab of the first two grouped tests,
 * the smallest-cell rule, and the site check for a between-groups comparison
 * while site B (controls only) is in the sample and site is not a covariate.
 */
export function mockRailDesignCheck(
  spec: GroupAnalysisSpecV2,
  rows: readonly AnalysisSubjectInclusion[],
  siteOf: (subjectId: string) => string,
): DesignCheck {
  const included = rows.filter((row) => row.included)
  const issues: DesignIssue[] = []
  const cells: DesignCell[] = []
  const vif: DesignVif[] = []
  const crosstabs: DesignCrosstab[] = []
  const covariates = [
    spec.covariates.age,
    spec.covariates.sex,
    ...spec.covariates.extra,
  ].filter((ref): ref is VariableRefV2 => ref !== null)
  const siteKept =
    spec.design.subset.find((filter) => isSite(filter.variable))?.keep ?? null
  const siteBIn =
    siteKept === null ||
    !('levels' in siteKept) ||
    siteKept.levels.includes('B')
  const grouped = spec.tests.filter((test) => test.factor)
  const tests = spec.tests.map((test, index) => {
    // An imported or derived tested variable misses a subject or two.
    const missing =
      test.variable?.ref.source === 'imported' ||
      test.variable?.ref.source === 'derived'
        ? 1 + (index % 2)
        : 0
    const n = Math.max(0, included.length - missing)
    const parameters =
      2 +
      covariates.length +
      test.extraCovariates.length +
      (test.factor ? test.factor.grouping.groups.length - 1 : 0) +
      (spec.covariates.headSize.source === 'none' ? 0 : 1)
    return {
      testId: test.id,
      n,
      residualDf: n > parameters ? n - parameters : null,
      missing,
    }
  })
  for (const test of grouped) {
    const groups = test.factor!.grouping.groups
    const share = Math.max(1, included.length)
    groups.forEach((group, g) => {
      // The population or source label decides the cell when it can.
      const members = included.filter((row) =>
        group.levels.includes(row.sourceLabel ?? ''),
      )
      const n =
        members.length > 0
          ? members.length
          : Math.max(1, Math.round((share / groups.length) * (1 - g * 0.35)))
      const female =
        members.length > 0
          ? Math.round(n * 0.3)
          : Math.max(0, Math.round(n * (g === 0 ? 0.2 : 0.4)))
      cells.push({
        testId: test.id,
        stratum: null,
        label: group.label,
        n,
        female,
        male: n - female,
      })
    })
  }
  for (const test of spec.tests) {
    if (spec.covariates.age) {
      vif.push({ testId: test.id, term: 'age', vif: 1.3 })
    }
    for (const ref of test.extraCovariates) {
      vif.push({ testId: test.id, term: ref.column, vif: 6.2 })
    }
  }
  if (grouped.length >= 2) {
    const [a, b] = grouped
    const rowsA = a!.factor!.grouping.groups.map((group) => group.label)
    const colsB = b!.factor!.grouping.groups.map((group) => group.label)
    crosstabs.push({
      testId: null,
      rowVariable: a!.label,
      columnVariable: b!.label,
      rows: rowsA,
      columns: colsB,
      counts: rowsA.map((_, r) =>
        colsB.map((__, c) => 3 + ((r * 5 + c * 3) % 9)),
      ),
      cramersV: 0.41,
    })
  }
  const smallest = cells.reduce<DesignCell | null>(
    (low, cell) => (low === null || cell.n < low.n ? cell : low),
    null,
  )
  if (smallest && smallest.n < spec.inclusion.minCellN) {
    issues.push({
      code: 'min-cell',
      severity: 'blocking',
      testId: smallest.testId,
      message: `${smallest.label} has ${smallest.n} subjects, fewer than the smallest cell of ${spec.inclusion.minCellN}.`,
    })
  } else if (smallest && smallest.n < 10) {
    issues.push({
      code: 'small-cell',
      severity: 'warning',
      testId: smallest.testId,
      message: `${smallest.label} has ${smallest.n} subjects; estimates for it are imprecise.`,
    })
  }
  const comparison = spec.tests.find(
    (test) => test.factor && test.kind !== 'association',
  )
  if (spec.design.scope === 'between' && comparison && siteBIn) {
    const siteRows = included.map((row) => siteOf(row.subjectId))
    const bRows = siteRows.filter((site) => site === 'B').length
    if (bRows > 0) {
      crosstabs.push({
        testId: comparison.id,
        rowVariable: comparison.label,
        columnVariable: 'site',
        rows: comparison.factor!.grouping.groups.map((group) => group.label),
        columns: ['A', 'B'],
        counts: comparison.factor!.grouping.groups.map((group) => {
          const members = included.filter((row) =>
            group.levels.includes(row.sourceLabel ?? ''),
          )
          const atB = members.filter((row) => siteOf(row.subjectId) === 'B')
          return [members.length - atB.length, atB.length]
        }),
        cramersV: 0.38,
      })
      const adjusted =
        covariates.some(isSite) || comparison.extraCovariates.some(isSite)
      issues.push(
        adjusted
          ? {
              code: 'site-confounded',
              severity: 'warning',
              testId: comparison.id,
              message:
                'Site B holds only CTRL subjects; with site as a covariate they inform the other covariates and the residual variance, not the group difference.',
            }
          : {
              code: 'site-confounded',
              severity: 'blocking',
              testId: comparison.id,
              message:
                'Site B holds only CTRL subjects in this test, so its group difference cannot be separated from the scanner. Leave out site B or adjust for site.',
              fixes: [
                { kind: 'drop-level', variable: SITE, level: 'B' },
                { kind: 'add-covariate', variable: SITE },
              ],
            },
      )
    }
  }
  if (spec.tests.some((test) => test.extraCovariates.length > 0)) {
    issues.push({
      code: 'vif',
      severity: 'warning',
      testId:
        spec.tests.find((test) => test.extraCovariates.length > 0)?.id ?? null,
      message:
        'A covariate has a variance inflation factor of 6.2 (5 or more).',
    })
  }
  return {
    ok: !issues.some((issue) => issue.severity === 'blocking'),
    issues,
    tests,
    cells,
    vif,
    crosstabs,
  }
}
