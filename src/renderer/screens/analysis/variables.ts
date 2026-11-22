/**
 * The variables a spec v2 draft can use: registry fields and metadata CSV
 * columns (the catalog), columns of imported variables tables, the draft's
 * derived variables, and measures used as covariates. Each has a stable
 * key for a select value, a label with its source, a kind, and the
 * observed levels of a categorical variable.
 */

import {
  defaultBinLabels,
  parseMeasureId,
  type DerivedVariable,
  type GroupAnalysisCatalog,
  type VariableRef,
  type VariableRefV2,
} from '../../../shared/group-analysis'
import { measureLabel } from '../../../shared/brain-atlas'

const REGISTRY_FIELD: Readonly<Record<string, string>> = {
  age: 'Age',
  sex: 'Sex',
  cohortRole: 'Cohort role',
  sourceCohortLabel: 'Source cohort label',
  ais: 'AIS grade',
  tSinceSci: 'Time since injury',
  site: 'Site',
}

const SOURCE_FILE: Readonly<Record<VariableRef['source'], string>> = {
  registry: 'Registry',
  'age-csv': 'age.csv',
  'clinical-csv': 'clinical.csv',
  'metadata-csv': 'metadata.csv',
}

/**
 * Name a variable with its source, for example "Registry: Age" or
 * "metadata.csv: group".
 */
export function variableLabel(ref: VariableRef): string {
  const column =
    ref.source === 'registry'
      ? (REGISTRY_FIELD[ref.column] ?? ref.column)
      : ref.column
  return `${SOURCE_FILE[ref.source]}: ${column}`
}

/** Name a variable without its source, for the model formula. */
export function variableTerm(ref: VariableRef): string {
  return ref.source === 'registry'
    ? (REGISTRY_FIELD[ref.column] ?? ref.column).toLowerCase()
    : ref.column
}

/** One variable the draft can choose, with its facts. */
export interface VariableChoice {
  ref: VariableRefV2
  key: string
  label: string
  kind: 'categorical' | 'numeric'
  /** Subjects with a value, when known. */
  n: number | null
  /** The observed (or defined) levels of a categorical variable. */
  levels: { value: string; n: number | null }[]
}

/**
 * Key a variable reference for a select value.
 *
 * @returns A key unique per variable, or an empty string for null.
 */
export function refKey(ref: VariableRefV2 | null): string {
  if (!ref) return ''
  return ref.source === 'imported'
    ? `imported:${ref.table}:${ref.column}`
    : `${ref.source}:${ref.column}`
}

/** Say whether two references name the same variable. */
export function sameRef(
  a: VariableRefV2 | null | undefined,
  b: VariableRefV2 | null | undefined,
): boolean {
  return Boolean(a && b && refKey(a) === refKey(b))
}

/**
 * List the variables a draft can group by, test, filter, or adjust for:
 * the catalog's variables, every column of each imported table, and the
 * draft's derived variables (a `bins` variable is categorical with its bin
 * labels as levels; the others are numeric).
 *
 * @returns The choices in that order.
 */
export function variableChoices(
  catalog: GroupAnalysisCatalog,
  derived: readonly DerivedVariable[],
): VariableChoice[] {
  const choices: VariableChoice[] = catalog.variables.map((variable) => ({
    ref: variable.ref,
    key: refKey(variable.ref),
    label: variableLabel(variable.ref),
    kind: variable.kind,
    n: variable.n,
    levels: variable.levels,
  }))
  for (const table of catalog.variableTables) {
    for (const column of table.columns) {
      const ref: VariableRefV2 = {
        source: 'imported',
        table: table.tableId,
        column: column.column,
      }
      choices.push({
        ref,
        key: refKey(ref),
        label: `${table.name}: ${column.column}`,
        kind: column.kind,
        n: column.n,
        levels: column.levels,
      })
    }
  }
  for (const item of derived) {
    const ref: VariableRefV2 = { source: 'derived', column: item.id }
    const bins = item.op === 'bins'
    const labels = bins
      ? item.params.labels.length > 0
        ? item.params.labels
        : defaultBinLabels(item.params.cuts)
      : []
    choices.push({
      ref,
      key: refKey(ref),
      label: `Derived: ${item.label}`,
      kind: bins ? 'categorical' : 'numeric',
      n: null,
      levels: labels.map((value) => ({ value, n: null })),
    })
  }
  return choices
}

/**
 * List the measures a draft can use as covariates (the whole-brain
 * measures, the aseg structures, and labeled volumes), as numeric choices.
 */
export function measureChoices(
  catalog: GroupAnalysisCatalog,
): VariableChoice[] {
  return catalog.measures
    .filter((measure) => {
      const parsed = measure.available
        ? parseMeasureId(measure.measureId)
        : null
      return (
        parsed !== null &&
        (parsed.source === 'global' ||
          parsed.source === 'aseg' ||
          parsed.source === 'vol')
      )
    })
    .map((measure) => {
      const ref: VariableRefV2 = {
        source: 'measure',
        column: measure.measureId,
      }
      return {
        ref,
        key: refKey(ref),
        label: measureLabel(measure.measureId),
        kind: 'numeric' as const,
        n: null,
        levels: [],
      }
    })
}

/** Find a reference among the choices. */
export function findChoice(
  choices: readonly VariableChoice[],
  ref: VariableRefV2 | null | undefined,
): VariableChoice | undefined {
  if (!ref) return undefined
  const key = refKey(ref)
  return choices.find((choice) => choice.key === key)
}

/**
 * Name a variable with its source, as the choices name it; a variable the
 * catalog no longer lists keeps its column name.
 */
export function refLabel(
  ref: VariableRefV2,
  choices: readonly VariableChoice[],
): string {
  const found = findChoice(choices, ref)
  if (found) return found.label
  if (ref.source === 'measure') return measureLabel(ref.column)
  if (ref.source === 'imported' || ref.source === 'derived') return ref.column
  return variableLabel(ref)
}

/**
 * Name a variable without its source, for the model formula and test
 * labels.
 */
export function refTerm(
  ref: VariableRefV2,
  choices: readonly VariableChoice[],
): string {
  if (ref.source === 'imported') return ref.column
  if (ref.source === 'measure') return measureLabel(ref.column)
  if (ref.source === 'derived') {
    const label = findChoice(choices, ref)?.label
    return label ? label.replace(/^Derived: /, '') : ref.column
  }
  return variableTerm(ref)
}
