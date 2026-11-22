import { describe, expect, it } from 'vitest'
import {
  previewRegistryImportSites,
  REGISTRY_IMPORT_COLUMNS,
  REGISTRY_IMPORT_EXAMPLE_CSV,
} from './registry-import'

describe('registry import contract', () => {
  it('accepts an optional site column that the example uses', () => {
    expect(REGISTRY_IMPORT_COLUMNS.at(-1)).toBe('site')
    expect(REGISTRY_IMPORT_EXAMPLE_CSV.split('\n')[0]).toBe(
      REGISTRY_IMPORT_COLUMNS.join(','),
    )
    expect(previewRegistryImportSites(REGISTRY_IMPORT_EXAMPLE_CSV)).toEqual({
      siteColumn: true,
      rows: 3,
      sites: [{ site: 'Prisma', rows: 3 }],
      empty: 0,
      invalid: 0,
    })
  })
})

describe('previewRegistryImportSites', () => {
  it('reports a file without a site column', () => {
    expect(
      previewRegistryImportSites(
        'subjectId,age,sex,sourceCohortLabel\nsub-1,40,F,CTRL\n\n',
      ),
    ).toEqual({ siteColumn: false, rows: 1 })
  })

  it('counts labels, empty cells, and labels outside the rule', () => {
    const text =
      '\ufeffSubjectId,SITE\r\n' +
      'sub-1, Prisma \r\n' +
      'sub-2,Ingenia\r\n' +
      'sub-3,Prisma\r\n' +
      'sub-4,\r\n' +
      'sub-5,"Prisma, 3T"\r\n' +
      'sub-6,"Skyra ""A"""\r\n' +
      'sub-7'
    expect(previewRegistryImportSites(text)).toEqual({
      siteColumn: true,
      rows: 7,
      sites: [
        { site: 'Prisma', rows: 2 },
        { site: 'Ingenia', rows: 1 },
      ],
      empty: 2,
      invalid: 2,
    })
  })

  it('orders equal counts by label and reads quoted line breaks', () => {
    expect(
      previewRegistryImportSites('site,note\nSkyra,"two\nlines"\nAvanto,x\n'),
    ).toMatchObject({
      rows: 2,
      sites: [
        { site: 'Avanto', rows: 1 },
        { site: 'Skyra', rows: 1 },
      ],
    })
  })

  it('returns null for text without a readable header', () => {
    expect(previewRegistryImportSites('')).toBeNull()
    expect(previewRegistryImportSites('site\n"Prisma')).toBeNull()
  })
})
