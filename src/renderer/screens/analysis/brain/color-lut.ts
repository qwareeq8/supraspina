/**
 * FreeSurfer's color table (`FreeSurferColorLUT.txt`): the name and color
 * of every label value a FreeSurfer label map uses, for example 173
 * Midbrain, 174 Pons, 175 Medulla and 178 SCP (brainstem subfields), 7001
 * and up (amygdala nuclei), 8001 and up and 8103/8203 and up (thalamic
 * nuclei). The table comes from the saved FreeSurfer home through main.
 */

/** One color-table entry. */
export interface LutEntry {
  index: number
  name: string
  rgb: [number, number, number]
}

/** A parsed color table, by label value and by name. */
export interface ColorLut {
  byIndex: Map<number, LutEntry>
  byName: Map<string, LutEntry>
}

/** The most entries a table may hold (8.2.0 has about 1,400). */
const MAX_ENTRIES = 20_000
/** The largest label value a table may name. */
const MAX_INDEX = 1_000_000

/**
 * Parse a FreeSurfer color table: `index name r g b a` lines, `#` comments
 * and blank lines skipped. A repeated name keeps its first index.
 *
 * @throws TypeError when the table holds no entry or too many.
 */
export function parseColorLut(text: string): ColorLut {
  const byIndex = new Map<number, LutEntry>()
  const byName = new Map<string, LutEntry>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const cells = line.split(/\s+/)
    if (cells.length < 5) continue
    const index = Number(cells[0])
    const rgb = cells.slice(2, 5).map(Number)
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index > MAX_INDEX ||
      rgb.some((c) => !Number.isInteger(c) || c < 0 || c > 255)
    ) {
      continue
    }
    if (byIndex.size >= MAX_ENTRIES) {
      throw new TypeError('The color table has too many entries.')
    }
    const entry: LutEntry = {
      index,
      name: cells[1]!,
      rgb: rgb as [number, number, number],
    }
    byIndex.set(index, entry)
    if (!byName.has(entry.name)) byName.set(entry.name, entry)
  }
  if (byIndex.size === 0) {
    throw new TypeError('The color table has no entries.')
  }
  return { byIndex, byName }
}

/** The brainstem subfield labels (`segment_subregions brainstem`). */
export const BRAINSTEM_SUBFIELDS = {
  midbrain: 173,
  pons: 174,
  medulla: 175,
  scp: 178,
} as const

/**
 * Say whether a label value is an amygdala nucleus (7001 and up).
 *
 * @returns True for 7001 to 7099.
 */
export function isAmygdalaNucleus(index: number): boolean {
  return index >= 7001 && index <= 7099
}

/**
 * Say whether a label value is a thalamic nucleus: the older 8001 table or
 * the `segment_subregions thalamus` labels, 8103 and up (left) and 8203 and
 * up (right).
 */
export function isThalamicNucleus(index: number): boolean {
  return (
    (index >= 8001 && index <= 8099) ||
    (index >= 8103 && index <= 8199) ||
    (index >= 8203 && index <= 8299)
  )
}

/**
 * Say whether a label value is a hippocampal subfield of
 * `segment_subregions hippo-amygdala`: 203 to 214 without the lateral
 * ventricle (213), and 226 to 246. The fissure (215) is not tissue.
 */
export function isHippocampalSubfield(index: number): boolean {
  return (
    (index >= 203 && index <= 214 && index !== 213) ||
    (index >= 226 && index <= 246)
  )
}
