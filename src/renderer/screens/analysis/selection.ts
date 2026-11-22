/** The selection the Analysis result tabs share. */

/** The selected measure and, from the measure figure, subject. */
export interface AnalysisSelection {
  measureId: string | null
  subjectId: string | null
}

/**
 * Choose the measure a result opens on: the kept selection when the result
 * has it, else the first significant row, else the first row.
 *
 * @returns The measure ID, or null for a result without rows.
 */
export function initialMeasure(
  result: { rows: readonly { measureId: string; significant: boolean }[] },
  current: string | null,
): string | null {
  if (current && result.rows.some((row) => row.measureId === current))
    return current
  return (
    (result.rows.find((row) => row.significant) ?? result.rows[0])?.measureId ??
    null
  )
}
