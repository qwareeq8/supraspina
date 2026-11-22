/** Tests for the group-analysis contract: grammar, spec v1, requests. */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  canonicalSpecJson,
  GROUP_ANALYSIS_REQUEST_FIELDS,
  isExtensiveMeasure,
  measureFamily,
  parseGroupAnalysisSpec,
  parseMeasureId,
  validateGroupAnalysisRequest,
  validateGroupAnalysisSpec,
  type GroupAnalysisSpec,
} from './group-analysis'
import surface from './ipc-surface.json'
import { ATLAS_LABELING_REQUEST_FIELDS } from './atlas-labeling'

const FIXTURE = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      '../../sidecar/tests/fixtures/group_analysis/spec-v1-example.json',
    ),
    'utf8',
  ),
) as { spec: GroupAnalysisSpec; specDigest: string }

const PROJECT = {
  projectId: 'analysis-project',
  root: '/data/study',
  configPath: '/data/study/supraspina.project.json',
  epoch: 1,
}

function mutated(change: (spec: GroupAnalysisSpec) => void): unknown {
  const spec = structuredClone(FIXTURE.spec)
  change(spec)
  return spec
}

describe('measure ID grammar', () => {
  it.each([
    ['dk:lh:precentral:ThickAvg', 'dk:ThickAvg', false],
    ['dk:bi:insula:GrayVol', 'dk:GrayVol', true],
    ['aseg:Brain-Stem', 'aseg', true],
    ['aseg:bi:Thalamus', 'aseg', true],
    ['global:eTIV', 'global', true],
    ['global:meanThickness', 'global', false],
    ['brainage:BrainPAD', 'brainage', false],
  ])('accepts %s', (id, family, extensive) => {
    expect(parseMeasureId(id)).not.toBeNull()
    expect(measureFamily(id)).toBe(family)
    expect(isExtensiveMeasure(id)).toBe(extensive)
  })

  it.each([
    'dk:xh:precentral:ThickAvg',
    'dk:lh:precentral:thickness',
    'aseg:bi:Left-Thalamus',
    'aseg:bi',
    'global:TotalGreyVol',
    'brainage:BrainAge',
    'dk:lh:precentral:ThickAvg\n',
  ])('rejects %j', (id) => {
    expect(parseMeasureId(id)).toBeNull()
  })

  it('splits the parts', () => {
    expect(parseMeasureId('dk:rh:superiorfrontal:SurfArea')).toEqual({
      source: 'dk',
      hemisphere: 'rh',
      region: 'superiorfrontal',
      metric: 'SurfArea',
    })
    expect(parseMeasureId('aseg:bi:Cerebellum-Cortex')).toEqual({
      source: 'aseg',
      hemisphere: 'bi',
      structure: 'Cerebellum-Cortex',
    })
    expect(() => measureFamily('dk:lh')).toThrow(/valid measure ID/)
  })
})

describe('spec v1', () => {
  it('shares the canonical form and digest with the sidecar', () => {
    const spec = parseGroupAnalysisSpec(FIXTURE.spec)
    const digest = createHash('sha256')
      .update(canonicalSpecJson(spec), 'utf8')
      .digest('hex')
    expect(digest).toBe(FIXTURE.specDigest)
    const reordered = mutated((draft) => {
      draft.measures.reverse()
      if (draft.contrast.type === 'groups') {
        draft.contrast.grouping.groups[0]!.levels.reverse()
      }
    }) as GroupAnalysisSpec
    expect(canonicalSpecJson(reordered)).toBe(canonicalSpecJson(spec))
  })

  it('reports the same first problem as the sidecar', () => {
    const cases: [unknown, string][] = [
      [
        mutated((s) => {
          if (s.contrast.type === 'groups') s.contrast.focal = 'CTRL'
        }),
        'Choose two different groups to compare.',
      ],
      [
        mutated((s) => {
          s.measures = ['aseg:Brain-Stem', 'aseg:Brain-Stem']
        }),
        'List each measure once.',
      ],
      [
        mutated((s) => {
          s.measures = ['dk:lh:nowhere']
        }),
        'Use valid measure IDs.',
      ],
      [
        mutated((s) => {
          s.analysis = 'brain-age'
        }),
        'Use Brain-PAD as the only brain-age measure.',
      ],
      [
        mutated((s) => {
          s.inference.permutations = 0
        }),
        'Choose a permutation count for max-T correction.',
      ],
      [
        mutated((s) => {
          s.covariates.sex = { source: 'registry', column: 'sourceCohortLabel' }
        }),
        'Do not adjust for the tested variable.',
      ],
      [
        mutated((s) => {
          s.covariates.age = { source: 'registry', column: 'qc' }
        }),
        'Choose a registry field the analysis can use.',
      ],
      [
        mutated((s) => {
          s.inference.alpha = 0.5
        }),
        'Correct the analysis field inference.alpha.',
      ],
    ]
    for (const [value, message] of cases) {
      expect(() => parseGroupAnalysisSpec(value)).toThrow(message)
    }
    const all = validateGroupAnalysisSpec(
      mutated((s) => {
        s.measures = ['aseg:Brain-Stem', 'aseg:Brain-Stem']
        s.inference.permutations = 0
      }),
    )
    expect(all).toEqual({
      ok: false,
      errors: [
        'List each measure once.',
        'Choose a permutation count for max-T correction.',
      ],
    })
  })

  it('accepts an association over every subject', () => {
    const spec = mutated((s) => {
      s.analysis = 'association'
      s.contrast = {
        type: 'association',
        variable: { source: 'clinical-csv', column: 'pain_nrs' },
        grouping: null,
        includedGroups: [],
        adjustForGroup: false,
      }
    })
    expect(parseGroupAnalysisSpec(spec).contrast.type).toBe('association')
  })
})

describe('request validation', () => {
  it('lists exactly the renderer-visible sidecar methods', () => {
    expect(
      [
        ...Object.keys(GROUP_ANALYSIS_REQUEST_FIELDS),
        ...Object.keys(ATLAS_LABELING_REQUEST_FIELDS),
      ].sort(),
    ).toEqual(
      surface.sidecar.filter((m) => m.startsWith('groupAnalysis.')).sort(),
    )
  })

  it('accepts valid requests and names each refusal', () => {
    const ok: [string, Record<string, unknown>][] = [
      ['groupAnalysis.catalog', { project: PROJECT }],
      [
        'groupAnalysis.start',
        {
          project: PROJECT,
          spec: FIXTURE.spec,
          stageCurrency: { aggregate: 'outdated', pybrainage: 'unknown' },
        },
      ],
      [
        'groupAnalysis.saveSpec',
        {
          project: PROJECT,
          specId: null,
          name: 'SCI vs CTRL',
          spec: FIXTURE.spec,
          expectedRevision: 0,
        },
      ],
    ]
    for (const [method, request] of ok) {
      expect(() => validateGroupAnalysisRequest(method, request)).not.toThrow()
    }
    const refused: [string, Record<string, unknown>, RegExp][] = [
      ['groupAnalysis.run', { project: PROJECT }, /allowlisted/],
      [
        'groupAnalysis.catalog',
        { project: PROJECT, cfg: {} },
        /invalid fields/,
      ],
      [
        'groupAnalysis.cancel',
        { project: PROJECT, operationId: '../x' },
        /operation ID/,
      ],
      [
        'groupAnalysis.start',
        { project: PROJECT, spec: FIXTURE.spec, stageCurrency: {} },
        /stage currency/,
      ],
      [
        'groupAnalysis.deleteSpec',
        { project: PROJECT, specId: null, expectedRevision: 0 },
        /saved-analysis ID/,
      ],
      [
        'groupAnalysis.saveSet',
        {
          project: PROJECT,
          setId: null,
          name: 'Set',
          measures: ['aseg:Brain-Stem', 'aseg:Brain-Stem'],
          expectedRevision: 0,
        },
        /each once/,
      ],
      [
        'groupAnalysis.lockSet',
        {
          project: PROJECT,
          setId: 'gset-0123456789abcdef',
          expectedRevision: -1,
        },
        /library revision/,
      ],
      [
        'groupAnalysis.measureDetail',
        {
          project: PROJECT,
          resultId: 'gar-0123456789abcdef',
          measureId: 'aseg:bi',
        },
        /measure ID/,
      ],
    ]
    for (const [method, request, message] of refused) {
      expect(() => validateGroupAnalysisRequest(method, request)).toThrow(
        message,
      )
    }
  })
})
