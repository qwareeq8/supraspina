import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isSiteLabel,
  MAX_SET_SITE_SUBJECTS,
  MAX_SITE_LABEL_LENGTH,
  normalizeSiteLabel,
  parseRegistrySetSiteFields,
  SITE_LABEL_RULE,
  siteLabelConflict,
} from './sites'

interface LabelCase {
  input: unknown
  label?: string | null
  refused?: true
}

// The same file drives sidecar/tests/test_sites.py, so the two rules agree.
const FIXTURE = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../sidecar/tests/fixtures/sites/site-labels.json'),
    'utf8',
  ),
) as { cases: LabelCase[] }

describe('site labels', () => {
  it('normalizes and refuses exactly the shared fixture cases', () => {
    expect(FIXTURE.cases.length).toBeGreaterThan(20)
    for (const entry of FIXTURE.cases) {
      if (entry.refused) {
        expect(() => normalizeSiteLabel(entry.input)).toThrow(SITE_LABEL_RULE)
      } else {
        expect(normalizeSiteLabel(entry.input)).toBe(entry.label)
      }
    }
  })

  it('accepts only canonical labels as stored values', () => {
    expect(isSiteLabel('Prisma 3T')).toBe(true)
    expect(isSiteLabel('x'.repeat(MAX_SITE_LABEL_LENGTH))).toBe(true)
    expect(isSiteLabel('x'.repeat(MAX_SITE_LABEL_LENGTH + 1))).toBe(false)
    expect(isSiteLabel(' Prisma')).toBe(false)
    expect(isSiteLabel('Prisma ')).toBe(false)
    expect(isSiteLabel('')).toBe(false)
    expect(isSiteLabel(null)).toBe(false)
  })

  it('finds a label that differs only in letter case', () => {
    expect(siteLabelConflict('prisma', ['Prisma', 'Ingenia'])).toBe('Prisma')
    expect(siteLabelConflict('Prisma', ['Prisma', 'Ingenia'])).toBeNull()
    expect(siteLabelConflict('Skyra', ['Prisma'])).toBeNull()
  })
})

describe('registry.setSite request fields', () => {
  const valid = {
    subjectIds: ['sub-101', 'sub-102'],
    site: '  Ingenia ',
    expectedRevisions: { 'sub-101': 3, 'sub-102': 1 },
  }

  it('normalizes the label and keeps the subjects in request order', () => {
    expect(parseRegistrySetSiteFields(valid)).toEqual({
      subjectIds: ['sub-101', 'sub-102'],
      site: 'Ingenia',
      expectedRevisions: { 'sub-101': 3, 'sub-102': 1 },
    })
    expect(parseRegistrySetSiteFields({ ...valid, site: null }).site).toBe(null)
    expect(parseRegistrySetSiteFields({ ...valid, site: ' ' }).site).toBe(null)
  })

  it('refuses malformed subjects, revisions, and labels', () => {
    const refusals: Array<[unknown, string]> = [
      [null, 'Provide a valid site request.'],
      [{ ...valid, subjectIds: [] }, 'Select 1 to 20,000 subjects'],
      [
        {
          ...valid,
          subjectIds: Array.from(
            { length: MAX_SET_SITE_SUBJECTS + 1 },
            (_, index) => `sub-${index}`,
          ),
        },
        'Select 1 to 20,000 subjects',
      ],
      [
        { ...valid, subjectIds: ['../escape'] },
        'Select subjects with valid IDs',
      ],
      [
        { ...valid, subjectIds: ['sub-101', 'sub-101'] },
        'Name each subject once',
      ],
      [
        { ...valid, expectedRevisions: { 'sub-101': 3 } },
        'Provide the saved revision of every subject.',
      ],
      [
        { ...valid, expectedRevisions: { 'sub-101': 3, 'sub-999': 1 } },
        'Provide the saved revision of every subject.',
      ],
      [
        { ...valid, expectedRevisions: { 'sub-101': 3, 'sub-102': -1 } },
        'Provide the saved revision of every subject.',
      ],
      [
        { ...valid, expectedRevisions: { 'sub-101': 3, 'sub-102': 1.5 } },
        'Provide the saved revision of every subject.',
      ],
      [
        { ...valid, expectedRevisions: [3, 1] },
        'Provide the saved revision of every subject.',
      ],
      [{ ...valid, site: 'Prisma!' }, SITE_LABEL_RULE],
      [
        {
          subjectIds: valid.subjectIds,
          expectedRevisions: valid.expectedRevisions,
        },
        SITE_LABEL_RULE,
      ],
    ]
    for (const [request, message] of refusals) {
      expect(() => parseRegistrySetSiteFields(request)).toThrow(message)
    }
  })
})
