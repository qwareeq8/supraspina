/**
 * The registry CSV import contract shared by the renderer and main process.
 *
 * The sidecar owns the authoritative validation
 * (`sidecar/supraspina_sidecar/registry_store.py`); the constants here mirror
 * that contract for display, for the bounded main-process file read, and for
 * the example file the import UI shows and saves.
 * `sidecar/tests/test_registry_store.py` imports the example below through
 * the real validator, so it cannot drift from the accepted format.
 */

import { normalizeSiteLabel } from './sites'

/** The accepted import columns, in canonical order and spelling. */
export const REGISTRY_IMPORT_COLUMNS = [
  'subjectId',
  'age',
  'sex',
  'sourceCohortLabel',
  'ais',
  'tSinceSci',
  'site',
] as const

/**
 * The bounded size of one import file, mirrored by `_MAX_IMPORT_CSV_BYTES` in
 * `registry_store.py`. The fixed IPC request ceiling in `src/main/ipc.ts`
 * stays the hard transport bound: content whose JSON escaping expands past it
 * is rejected there and fails closed.
 */
export const MAX_REGISTRY_IMPORT_BYTES = 512 * 1024

/** A complete valid example file matching the documented column contract. */
export const REGISTRY_IMPORT_EXAMPLE_CSV = `subjectId,age,sex,sourceCohortLabel,ais,tSinceSci,site
sub-0001,54.7,F,CTRL,,,Prisma
sub-0002,48,M,SCI_nNP,B,3.5,Prisma
sub-0003,61.2,M,SCI_P,C,12,Prisma
`

/** What a chosen import file would do to sites, read before the import. */
export type RegistryImportSitePreview =
  | { siteColumn: false; rows: number }
  | {
      siteColumn: true
      rows: number
      /** Each label with its row count, largest first. */
      sites: { site: string; rows: number }[]
      /** Rows whose site cell is empty. */
      empty: number
      /** Rows whose site cell is outside the label rule. */
      invalid: number
    }

/**
 * Split CSV text into records of cells (RFC 4180 quoting, CRLF or LF).
 *
 * @returns The records, or null for an unterminated quote.
 */
function parseCsv(text: string): string[][] | null {
  const records: string[][] = []
  let record: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character !== '"') cell += character
      else if (text[index + 1] === '"') {
        cell += '"'
        index += 1
      } else quoted = false
    } else if (character === '"') quoted = true
    else if (character === ',') {
      record.push(cell)
      cell = ''
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1
      record.push(cell)
      records.push(record)
      record = []
      cell = ''
    } else cell += character
  }
  if (quoted) return null
  if (cell !== '' || record.length > 0) {
    record.push(cell)
    records.push(record)
  }
  return records
}

/**
 * Preview the sites a registry import file sets, for display before import.
 *
 * The sidecar validates the file; this read only counts the `site` column
 * (matched without regard to case, as the sidecar matches headers).
 *
 * @returns The preview, or null when the text has no readable header.
 * @example
 * previewRegistryImportSites('subjectId,site\nsub-1,Prisma\n')
 * // { siteColumn: true, rows: 1, sites: [{ site: 'Prisma', rows: 1 }], empty: 0, invalid: 0 }
 */
export function previewRegistryImportSites(
  text: string,
): RegistryImportSitePreview | null {
  const records = parseCsv(text.replace(/^\ufeff/, ''))
  const header = records?.[0]
  if (!records || !header) return null
  const rows = records
    .slice(1)
    .filter((cells) => cells.some((cell) => cell.trim() !== ''))
  const position = header.findIndex(
    (name) => name.trim().toLowerCase() === 'site',
  )
  if (position < 0) return { siteColumn: false, rows: rows.length }
  const counts = new Map<string, number>()
  let empty = 0
  let invalid = 0
  for (const cells of rows) {
    let label: string | null
    try {
      label = normalizeSiteLabel(cells[position] ?? '')
    } catch {
      invalid += 1
      continue
    }
    if (label === null) empty += 1
    else counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return {
    siteColumn: true,
    rows: rows.length,
    sites: [...counts]
      .map(([site, count]) => ({ site, rows: count }))
      .sort((a, b) => b.rows - a.rows || a.site.localeCompare(b.site)),
    empty,
    invalid,
  }
}
