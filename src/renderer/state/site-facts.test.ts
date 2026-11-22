import { describe, expect, it } from 'vitest'
import { SITE_LABEL_RULE } from '../../shared/sites'
import type { CohortRole } from '../../shared/types'
import {
  brainchartsSiteFact,
  outlierSiteFact,
  siteConfoundFacts,
  siteCountsText,
  siteHeldText,
  siteLabelError,
  siteLabels,
  siteMixedText,
  summarizeSites,
  type BrainChartsEntry,
  type SiteEntry,
} from './site-facts'

function entries(
  count: number,
  site: string | null,
  role: SiteEntry['role'],
  prefix: string,
): SiteEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${String(index).padStart(3, '0')}`,
    site,
    role,
  }))
}

describe('summarizeSites', () => {
  it('reads no site anywhere as one implicit site', () => {
    const summary = summarizeSites(entries(3, null, 'healthy', 'sub'))
    expect(summary.mode).toBe('none')
    expect(siteCountsText(summary)).toBeNull()
    expect(siteMixedText(summary)).toBeNull()
    expect(siteConfoundFacts(summary)).toEqual([])
  })

  it('states a partial assignment: 50 without a site and 5 with one', () => {
    const summary = summarizeSites([
      ...entries(30, null, 'healthy', 'ctl'),
      ...entries(20, null, 'sci-neuropathic-pain', 'sci'),
      ...entries(4, 'B', 'sci-neuropathic-pain', 'sb'),
      ...entries(1, 'A', 'sci-no-neuropathic-pain', 'new'),
    ])
    expect(summary.mode).toBe('mixed')
    expect(summary.unset).toHaveLength(50)
    expect(summary.unset[0]).toBe('ctl-000')
    expect(siteCountsText(summary)).toBe('Sites: B 4, A 1.')
    expect(siteMixedText(summary)).toBe('50 subjects have no site, and 5 do.')
    expect(siteConfoundFacts(summary)).toEqual([
      'Site B has no controls.',
      'Site A has no controls.',
    ])
  })

  it('states a complete assignment with the largest site first', () => {
    const summary = summarizeSites([
      ...entries(4, 'B', 'sci-neuropathic-pain', 'sb'),
      ...entries(30, 'A', 'healthy', 'ctl'),
      ...entries(20, 'A', 'sci-neuropathic-pain', 'sci'),
    ])
    expect(summary.mode).toBe('complete')
    expect(siteCountsText(summary)).toBe('Sites: A 50, B 4.')
    expect(siteMixedText(summary)).toBeNull()
    expect(siteConfoundFacts(summary)).toEqual(['Site B has no controls.'])
  })

  it('uses singular forms and names one site', () => {
    const summary = summarizeSites([
      ...entries(1, null, 'healthy', 'a'),
      ...entries(1, 'Prisma', 'healthy', 'b'),
    ])
    expect(siteCountsText(summary)).toBe('Site: Prisma 1.')
    expect(siteMixedText(summary)).toBe('1 subject has no site, and 1 does.')
  })

  it('states no confound without controls or with a single site', () => {
    expect(
      siteConfoundFacts(
        summarizeSites([
          ...entries(2, 'Prisma', 'sci-neuropathic-pain', 'a'),
          ...entries(2, 'Ingenia', 'sci-neuropathic-pain', 'b'),
        ]),
      ),
    ).toEqual([])
    expect(
      siteConfoundFacts(
        summarizeSites(entries(2, 'Prisma', 'sci-neuropathic-pain', 'a')),
      ),
    ).toEqual([])
  })
})

describe('siteHeldText', () => {
  it('states the sites held until registration, or nothing', () => {
    // The counts leave held sites out, so this sentence names them.
    expect(siteHeldText(0)).toBeNull()
    expect(siteHeldText(1)).toBe(
      'The site of 1 unregistered subject is held until registration.',
    )
    expect(siteHeldText(7)).toBe(
      'The sites of 7 unregistered subjects are held until registration.',
    )
  })
})

describe('site labels in forms', () => {
  it('lists each label once in order', () => {
    expect(
      siteLabels(['Prisma', null, 'Ingenia', undefined, 'Prisma']),
    ).toEqual(['Ingenia', 'Prisma'])
  })

  it('accepts blank text and valid labels, and states each refusal', () => {
    expect(siteLabelError('', ['Prisma'])).toBeNull()
    expect(siteLabelError('  Prisma ', ['Prisma'])).toBeNull()
    expect(siteLabelError('Prisma/3T', [])).toBe(SITE_LABEL_RULE)
    expect(siteLabelError('prisma', ['Prisma'])).toBe(
      'Use the existing site label Prisma; the two labels differ only in letter case.',
    )
  })
})

describe('brainchartsSiteFact', () => {
  const entry = (
    site: string | null,
    role: CohortRole,
    age: number | null = 40,
    sex = 'F',
  ): BrainChartsEntry => ({ site, role, age, sex })
  const controls = (site: string | null, count: number): BrainChartsEntry[] =>
    Array.from({ length: count }, () => entry(site, 'healthy'))
  const patients = (site: string | null, count: number): BrainChartsEntry[] =>
    Array.from({ length: count }, () => entry(site, 'sci-neuropathic-pain'))

  it('states the refused site and its subjects, as the plan advisory does', () => {
    expect(
      brainchartsSiteFact([
        ...controls('A', 30),
        ...patients('A', 20),
        ...patients('B', 4),
      ]),
    ).toEqual({
      tone: 'warn',
      text: 'Adapts the model to 1 of 2 sites. Site B has no controls, so its 4 subjects get no z-scores.',
    })
  })

  it('counts only controls the model can take, as the run does', () => {
    // The run refuses an age outside the model's -5 to 110 years, so Skyra
    // keeps one usable control.
    expect(
      brainchartsSiteFact([
        ...controls('Prisma', 2),
        entry('Skyra', 'healthy', 110),
        entry('Skyra', 'healthy', 111),
      ])?.text,
    ).toBe(
      'Adapts the model to 1 of 2 sites. Site Skyra has 1 control, so its 1 subject gets no z-scores.',
    )
  })

  it('names a site with one control and a single subject in order', () => {
    expect(
      brainchartsSiteFact([
        ...controls('Prisma', 3),
        ...controls('Skyra', 1),
        ...patients('Achieva', 1),
      ])?.text,
    ).toBe(
      'Adapts the model to 1 of 3 sites. Site Achieva has no controls, so its 1 subject gets no z-scores. Site Skyra has 1 control, so its 1 subject gets no z-scores.',
    )
  })

  it('blocks when no site has 2 usable controls', () => {
    // Controls without an age or with sex O do not count.
    expect(
      brainchartsSiteFact([
        entry('Prisma', 'healthy'),
        entry('Prisma', 'healthy', null),
        entry('Prisma', 'healthy', 40, 'O'),
        ...patients('Prisma', 4),
      ]),
    ).toEqual({
      tone: 'warn',
      text: 'No site has at least 2 controls, so the model cannot be adapted.',
    })
  })

  it('states nothing for one adaptable site and a fact for several', () => {
    expect(
      brainchartsSiteFact([...controls(null, 2), ...patients(null, 3)]),
    ).toBeNull()
    expect(brainchartsSiteFact([])).toBeNull()
    expect(
      brainchartsSiteFact([
        ...controls('Prisma', 2),
        ...controls('Ingenia', 2),
      ]),
    ).toEqual({
      tone: 'fact',
      text: 'Adapts the model to each of the 2 sites.',
    })
  })

  it('states the subjects without a site as one unnamed group', () => {
    expect(
      brainchartsSiteFact([...controls('Prisma', 2), ...patients(null, 2)])
        ?.text,
    ).toBe(
      'Adapts the model to 1 of 2 sites. The subjects without a site have no controls, so they get no z-scores.',
    )
  })
})

describe('outlierSiteFact', () => {
  it('states the pooled review only for two or more site labels', () => {
    expect(outlierSiteFact([])).toBeNull()
    expect(outlierSiteFact(['Prisma', 'Prisma', null])).toBeNull()
    expect(outlierSiteFact(['Prisma', undefined, 'Ingenia'])).toBe(
      "Outliers are judged against the whole cohort, so a site's scanner offset can flag its subjects.",
    )
  })
})
