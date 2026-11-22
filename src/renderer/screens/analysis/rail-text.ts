/**
 * The wording and small pure helpers of the Analysis rail's v2 controls,
 * kept out of the component modules: sizes, atlas names and labeling
 * progress, tool-fact fixes, head-size availability, the design-check
 * line and fix labels, the smallest-cell fact, and derived variables.
 */

import type {
  AtlasLabelOperation,
  AtlasToolFact,
  AtlasToolFix,
} from '../../../shared/atlas-labeling'
import type {
  DerivedVariable,
  DesignCheck,
  DesignFix,
  DesignIssueSeverity,
  GroupAnalysisCatalog,
  GroupAnalysisInputs,
  HeadSizeSource,
  VariableRefV2,
} from '../../../shared/group-analysis'
import { HEAD_SIZE_TEXT } from './describe'
import { durationText } from './measure-sources'
import { refKey, refTerm, type VariableChoice } from './variables'

/** The head-size measure each source reads. */
const HEAD_SIZE_MEASURE: Readonly<Record<HeadSizeSource, string | null>> = {
  etiv: 'global:eTIV',
  stiv: 'global:sTIV',
  'synthseg-tiv': 'global:synthsegTIV',
  none: null,
}

/** Format a byte count, for example "15.8 MB". */
export function bytesText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** The atlases whose labeling labels the fsaverage5 template only. */
export const TEMPLATE_ONLY_ATLASES: ReadonlySet<string> = new Set(['dkt'])

/**
 * Name an atlas inside a sentence: a leading capital word is lowercased
 * ("Brainstem subfields" reads "brainstem subfields"), an acronym is kept
 * ("DKT (aparc.DKTatlas)").
 */
export function atlasName(label: string): string {
  return /^[A-Z][a-z]/.test(label)
    ? `${label.charAt(0).toLowerCase()}${label.slice(1)}`
    : label
}

/**
 * Say how far a labeling is, for example "7 of 20 subjects; 1 failed, 1
 * skipped; labeling sub-071; about 2.2 h left."
 */
export function labelingProgressText(operation: AtlasLabelOperation): string {
  const parts = [
    `${operation.completed} of ${operation.total} ${operation.total === 1 ? 'subject' : 'subjects'}`,
    operation.failed > 0 ? `${operation.failed} failed` : null,
    operation.skipped > 0 ? `${operation.skipped} skipped` : null,
    operation.state === 'running' && operation.current
      ? `labeling ${operation.current.subjectId}`
      : null,
    operation.state === 'running' && operation.remainingSeconds !== null
      ? `${durationText(operation.remainingSeconds)} left`
      : null,
  ].filter(Boolean)
  return `${parts.join('; ')}.`
}

/** Say how a finished labeling ended. */
export function labelingOutcomeText(
  operation: AtlasLabelOperation,
  label: string,
): string {
  const done = operation.completed - operation.failed - operation.skipped
  const counts = [
    `${Math.max(0, done)} labeled`,
    operation.failed > 0 ? `${operation.failed} failed` : null,
    operation.skipped > 0 ? `${operation.skipped} skipped` : null,
  ]
    .filter(Boolean)
    .join(', ')
  if (operation.state === 'cancelled')
    return `The ${label} labeling was canceled: ${counts}; labeled subjects keep their labels.`
  if (operation.state === 'failed')
    return operation.message ?? `The ${label} labeling failed: ${counts}.`
  return `The ${label} labeling finished: ${counts}.`
}

/**
 * Pair each tool fact with its fix, offering each fix once (two facts can
 * share one, as a broken segment_subregions and a missing interpreter).
 *
 * @param facts - The tool facts in order.
 * @returns Each fact with its fix, or null for a repeated fix.
 */
export function factFixes(
  facts: readonly AtlasToolFact[],
): { fact: AtlasToolFact; fix: AtlasToolFix }[] {
  const seen = new Set<AtlasToolFix>()
  return facts.map((fact) => {
    const fix = fact.fix && !seen.has(fact.fix) ? fact.fix : null
    if (fact.fix) seen.add(fact.fix)
    return { fact, fix }
  })
}

/**
 * Say which head-size sources the catalog cannot provide, with why.
 *
 * @returns The unavailable sources and the reason of each.
 */
export function unavailableHeadSizes(
  catalog: GroupAnalysisCatalog,
): Partial<Record<HeadSizeSource, string>> {
  const out: Partial<Record<HeadSizeSource, string>> = {}
  for (const source of ['etiv', 'stiv', 'synthseg-tiv'] as const) {
    const id = HEAD_SIZE_MEASURE[source]!
    const measure = catalog.measures.find((m) => m.measureId === id)
    if (!measure?.available) {
      out[source] =
        measure?.unavailableReason ??
        `No subject's FreeSurfer stats give ${HEAD_SIZE_TEXT[source]}.`
    }
  }
  return out
}

/** Summarize a design check on one line. */
export function designCheckSummary(check: DesignCheck): string {
  const count = (severity: DesignIssueSeverity): number =>
    check.issues.filter((issue) => issue.severity === severity).length
  const blocking = count('blocking')
  const warnings = count('strong-warning') + count('warning')
  if (blocking === 0 && warnings === 0) return 'Design check: no findings.'
  const parts = [
    blocking > 0
      ? `${blocking} ${blocking === 1 ? 'finding blocks' : 'findings block'} Compute`
      : null,
    warnings > 0
      ? `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`
      : null,
  ].filter(Boolean)
  return `Design check: ${parts.join(', ')}.`
}

/**
 * Name a fix as its button says it, for example "Leave out site B" or
 * "Adjust for site".
 *
 * @param choices - The variable choices, for names.
 */
export function designFixLabel(
  fix: DesignFix,
  choices: readonly VariableChoice[],
): string {
  const name = refTerm(fix.variable, choices)
  return fix.kind === 'drop-level'
    ? `Leave out ${name} ${fix.level}`
    : `Adjust for ${name}`
}

/** Say which modeled cell is smallest against the rule. */
export function smallestCellHint(
  sample: GroupAnalysisInputs | null,
  minCellN: number,
): string {
  const cells = sample?.designCheck?.cells ?? []
  if (cells.length === 0)
    return `A test whose smallest group or cell has fewer than ${minCellN} subjects cannot compute.`
  const smallest = cells.reduce((a, b) => (b.n < a.n ? b : a))
  const where = smallest.stratum ? ` in ${smallest.stratum}` : ''
  return `The smallest cell is ${smallest.label}${where} with ${smallest.n} ${smallest.n === 1 ? 'subject' : 'subjects'}; fewer than ${minCellN} blocks the test.`
}

/**
 * Parse cut points typed as a list, for example "30, 45".
 *
 * @returns The numbers, or null when one is not a number.
 */
export function parseCuts(text: string): number[] | null {
  const parts = text
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
  const numbers = parts.map(Number)
  return numbers.every((value) => Number.isFinite(value)) ? numbers : null
}

/**
 * List the derived variables with the names of their inputs.
 *
 * @param choices - The choices, for input names.
 */
export function derivedText(
  item: DerivedVariable,
  choices: readonly VariableChoice[],
): string {
  const name = (ref: VariableRefV2): string =>
    choices
      .find((choice) => choice.key === refKey(ref))
      ?.label.replace(/^[^:]+: /, '') ?? ref.column
  const names = item.inputs.map(name)
  switch (item.op) {
    case 'sum':
      return names.join(' + ')
    case 'difference':
      return `${names[0] ?? ''} - ${names[1] ?? ''}`
    case 'log1p':
      return `log(1 + ${names[0] ?? ''})`
    case 'bins':
      return `${names[0] ?? ''} in ${item.params.cuts.length + 1} bins`
  }
}
