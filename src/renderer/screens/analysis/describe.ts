/**
 * The Analysis panel's wording: variable names, exclusion and stale reasons,
 * the one-line specification summary, and the compute-time estimate; and
 * the table's significance color, kept out of the component module.
 */

import type {
  AnalysisExclusionReason,
  AnalysisInputFile,
  AnalysisInputSource,
  AnalysisInputSourceV1,
  AnalysisSkippedMeasure,
  AnalysisStageCurrency,
  CorrectionFamilyV2,
  GroupAnalysisInputs,
  GroupAnalysisSpecV2,
  GroupAnalysisStaleReason,
  HeadSizeSource,
} from '../../../shared/group-analysis'
import { DK_METRIC_LABELS, measureLabel } from '../../../shared/brain-atlas'
import { parseMeasureId } from '../../../shared/group-analysis'
import { refTerm, type VariableChoice } from './variables'
import { CORRECTION_SHORT, fileSlug } from '../../figures/format'
import type { Theme } from '../../ui'

export { variableLabel, variableTerm } from './variables'

/** Why a subject is out of the sample, as the inclusion list says it. */
export const EXCLUSION_TEXT: Readonly<Record<AnalysisExclusionReason, string>> =
  {
    'config-excluded': 'Excluded in the project settings',
    'qc-failed': 'QC Fail',
    'qc-not-passed': 'No QC Pass',
    'no-group': 'In no defined group',
    'not-compared': 'Not in the compared groups',
    'missing-covariate': 'Missing a covariate',
    'registration-flagged': 'Surface registration flagged',
    outlier: 'ENIGMA outlier',
    'no-measures': 'No values for the measures',
    'not-in-population': 'Outside the population',
    'subset-filtered': 'Removed by a subset filter',
    'missing-variable': 'Missing a tested variable',
  }

/** The v1 input tables by name. */
export const INPUT_TEXT: Readonly<Record<AnalysisInputSourceV1, string>> = {
  'dk-all-stats': 'dk_all_stats.csv',
  'cortical-thickness': 'cortical_thickness.csv',
  icv: 'icv_data.csv',
  brainage: 'predicted_results.csv',
  'metadata-csv': 'metadata.csv',
  'age-csv': 'age.csv',
  'clinical-csv': 'clinical.csv',
  outliers: 'outliers.csv',
}

/** Name one input: a v1 table by file name, a v2 source by its key. */
export function inputSourceText(source: AnalysisInputSource): string {
  return Object.hasOwn(INPUT_TEXT, source)
    ? INPUT_TEXT[source as AnalysisInputSourceV1]
    : source
}

function sampleChange(reason: GroupAnalysisStaleReason): string {
  const parts = [
    reason.added > 0 ? `${reason.added} added` : null,
    reason.removed > 0 ? `${reason.removed} removed` : null,
  ].filter(Boolean)
  return parts.length > 0 ? `: ${parts.join(', ')}` : ''
}

/** Say why a stored result is out of date. */
export function staleReasonText(reason: GroupAnalysisStaleReason): string {
  switch (reason.code) {
    case 'inputs-changed':
      return reason.sources.length > 0
        ? `The input tables changed since this result (${reason.sources.map(inputSourceText).join(', ')}).`
        : 'The input tables changed since this result.'
    case 'qc-changed-sample':
      return `QC verdicts changed the included subjects since this result${sampleChange(reason)}.`
    case 'registry-changed':
      return `The registry changed the included subjects since this result${sampleChange(reason)}.`
    case 'registration-changed':
      return `Surface-registration flags changed since this result${sampleChange(reason)}.`
    case 'engine-changed':
      return 'An earlier version of the analysis engine computed this result.'
    case 'sample-too-small':
      return `Too few subjects remain to fit since this result${reason.removed > 0 ? `: ${reason.removed} removed` : ''}.`
    case 'labels-changed':
      return 'Atlas labels changed since this result.'
  }
}

/**
 * List the skipped measures with their reasons, the first few by name.
 *
 * @returns One sentence, or null when none is skipped.
 */
export function skippedText(
  skipped: readonly AnalysisSkippedMeasure[],
  shown = 3,
): string | null {
  if (skipped.length === 0) return null
  const named = skipped
    .slice(0, shown)
    .map((m) => `${measureLabel(m.measureId)}: ${m.reason.replace(/\.$/, '')}`)
  const rest = skipped.length - named.length
  return `Skipped: ${named.join('; ')}${rest > 0 ? `; and ${rest} more` : ''}.`
}

/** The stage names a missing-output sentence uses. */
const STAGE_OUTPUT: Readonly<
  Record<
    'aggregate' | 'pybrainage',
    { source: AnalysisInputSource; name: string }
  >
> = {
  aggregate: { source: 'dk-all-stats', name: 'Structural aggregation' },
  pybrainage: { source: 'brainage', name: 'PyBrainAge prediction' },
}

/**
 * Say which pipeline stage the draft reads has not written its table yet,
 * as in a project before its first Run all.
 *
 * @returns The sentence, or null when every table exists.
 */
export function missingOutputText(
  stages: readonly ('aggregate' | 'pybrainage')[],
  inputs: readonly AnalysisInputFile[],
): string | null {
  for (const stage of stages) {
    const { source, name } = STAGE_OUTPUT[stage]
    const input = inputs.find((i) => i.source === source)
    if (input && !input.present) {
      return `${name} has no output yet. Run all produces it.`
    }
  }
  return null
}

/** The head-size covariates by name. */
export const HEAD_SIZE_TEXT: Readonly<Record<HeadSizeSource, string>> = {
  etiv: 'eTIV',
  stiv: 'sTIV',
  'synthseg-tiv': 'SynthSeg TIV',
  none: 'None',
}

/**
 * List the pipeline stages whose tables a specification reads: the
 * aggregate tables (DK, aseg, and the v1 whole-brain measures) and
 * Brain-PAD. Tier A and B measures follow each subject's recon instead.
 *
 * @returns `aggregate`, `pybrainage`, or both.
 */
export function draftStages(spec: {
  measures: readonly string[]
}): ('aggregate' | 'pybrainage')[] {
  const brain = spec.measures.some((id) => id.startsWith('brainage:'))
  const other = spec.measures.some(
    (id) =>
      id.startsWith('dk:') ||
      id.startsWith('aseg:') ||
      id === 'global:eTIV' ||
      id === 'global:meanThickness',
  )
  return [
    ...(other ? (['aggregate'] as const) : []),
    ...(brain ? (['pybrainage'] as const) : []),
  ]
}

/**
 * Say whether the tables a draft reads are current, counting the recon
 * stage when the draft reads per-subject stats or labels.
 *
 * @returns "Inputs current", "Inputs out of date", or "Inputs not yet judged".
 */
export function inputsCurrencyText(
  spec: GroupAnalysisSpecV2,
  currency: AnalysisStageCurrency,
): string {
  const states: string[] = draftStages(spec).map((stage) => currency[stage])
  const perSubject = spec.measures.some(
    (id) =>
      id.startsWith('parc:') ||
      id.startsWith('vol:') ||
      (id.startsWith('global:') &&
        id !== 'global:eTIV' &&
        id !== 'global:meanThickness'),
  )
  if (perSubject) states.push(currency.recon?.state ?? 'unknown')
  if (states.includes('outdated')) return 'Inputs out of date'
  if (states.includes('unknown')) return 'Inputs not yet judged'
  return 'Inputs current'
}

/**
 * Name the design, for example "SCI vs CTRL", "SCI_P, SCI_nNP, and CTRL",
 * or "Within SCI, 5 tests".
 */
export function designText(spec: GroupAnalysisSpecV2): string {
  const tests = `${spec.tests.length} ${spec.tests.length === 1 ? 'test' : 'tests'}`
  const strata = spec.stratify
    ? `, by ${spec.stratify.grouping.groups.length} strata`
    : ''
  if (spec.design.scope === 'within') {
    const groups = spec.design.population?.groups ?? []
    const within =
      groups.length > 0 ? `Within ${groups.join(' + ')}` : 'Within a group'
    return `${within}, ${spec.tests.length === 1 ? spec.tests[0]!.label : tests}${strata}`
  }
  return `${spec.tests.length === 1 ? spec.tests[0]!.label : tests}${strata}`
}

/**
 * Write the shared model formula, for example
 * "y ~ test + age + sex (+ eTIV for volumes and areas)".
 *
 * @param choices - The variable choices, for names.
 */
export function modelFormulaV2(
  spec: GroupAnalysisSpecV2,
  choices: readonly VariableChoice[],
): string {
  const { covariates } = spec
  const only = spec.tests.length === 1 ? spec.tests[0]! : null
  const terms = [
    !only
      ? 'test'
      : only.kind === 'association' && only.variable
        ? refTerm(only.variable.ref, choices)
        : only.kind === 'interaction' && only.moderator
          ? `group x ${refTerm(only.moderator.ref, choices)}`
          : 'group',
  ]
  if (only?.kind === 'association' && only.adjustForGroup) terms.push('group')
  for (const ref of [covariates.age, covariates.sex, ...covariates.extra]) {
    if (ref) terms.push(refTerm(ref, choices))
  }
  const head = HEAD_SIZE_TEXT[covariates.headSize.source]
  const size =
    covariates.headSize.source === 'none'
      ? ''
      : covariates.headSize.rule === 'extensive'
        ? ` (+ ${head} for volumes and areas)`
        : ` + ${head}`
  return `y ~ ${terms.join(' + ')}${size}`
}

/** The correction families by name. */
export const FAMILY_TEXT: Readonly<Record<CorrectionFamilyV2, string>> = {
  'all-tests': 'All tests together',
  'per-test': 'Each test separately',
  'per-measure-family': 'Each measure family',
  'per-test-and-measure-family': 'Each test and measure family',
}

/**
 * Describe the inference settings, for example
 * "max-T FWE, 5000 permutations, two-sided, alpha 0.05".
 */
export function inferenceTextV2(spec: GroupAnalysisSpecV2): string {
  const { correction, permutations, sidedness, alpha, family } = spec.inference
  const method =
    correction === 'maxt-fwe'
      ? `max-T FWE, ${permutations} permutations`
      : correction === 'none'
        ? 'uncorrected'
        : CORRECTION_SHORT[correction] === 'FDR'
          ? 'BH-FDR'
          : CORRECTION_SHORT[correction]
  const side =
    sidedness === 'two-sided' ? 'two-sided' : `one-sided (${sidedness})`
  const scope =
    spec.tests.length > 1 && correction !== 'none'
      ? `, ${FAMILY_TEXT[family].toLowerCase()}`
      : ''
  return `${method}${scope}, ${side}, alpha ${alpha}`
}

/**
 * Summarize a draft on one line of facts.
 *
 * @param inputs - Its resolved sample, or null before it resolves.
 * @param choices - The variable choices, for names.
 * @returns The summary parts in order.
 */
export function specSummary(
  spec: GroupAnalysisSpecV2,
  inputs: GroupAnalysisInputs | null,
  currency: AnalysisStageCurrency,
  choices: readonly VariableChoice[],
): string[] {
  const only = spec.tests.length === 1 ? spec.tests[0]! : null
  const cells = inputs?.designCheck?.cells.filter(
    (cell) => cell.testId === only?.id && cell.stratum === null,
  )
  const n = (label: string | null | undefined): number | undefined =>
    cells?.find((cell) => cell.label === label)?.n
  const focal = only?.kind === 'two-group' ? n(only.factor?.focal) : undefined
  const reference =
    only?.kind === 'two-group' ? n(only.factor?.reference) : undefined
  // One two-group comparison reads as its group sizes, focal first.
  const count = !inputs
    ? ''
    : focal !== undefined && reference !== undefined
      ? `, n ${focal} / ${reference}`
      : `, n ${inputs.included}`
  const measures = `${spec.measures.length} ${spec.measures.length === 1 ? 'measure' : 'measures'}`
  // Current inputs are the normal state and need no phrase.
  const inputsText = inputsCurrencyText(spec, currency)
  return [
    `${designText(spec)}${count}`,
    measures,
    modelFormulaV2(spec, choices),
    inferenceTextV2(spec),
    ...(inputsText === 'Inputs current'
      ? []
      : [`Draft ${inputsText.charAt(0).toLowerCase()}${inputsText.slice(1)}`]),
  ]
}

/** The measure-permutation fits the engine does per second (about 646 x 5000 in 1 s). */
const FITS_PER_SECOND = 3_200_000

/**
 * Estimate the compute time of a draft.
 *
 * @returns The estimate, for example "about 2 s".
 */
export function computeEstimate(
  measures: number,
  permutations: number,
): string {
  const seconds = 1 + (measures * Math.max(1, permutations)) / FITS_PER_SECOND
  if (seconds < 5) return 'a few seconds'
  if (seconds < 90) return `about ${Math.round(seconds)} s`
  return `about ${Math.round(seconds / 60)} min`
}

function capital(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

/**
 * Name a measure for the table's Measure column, without its hemisphere.
 *
 * @returns The name, for example "Precentral thickness".
 */
export function tableMeasureName(id: string): string {
  const parsed = parseMeasureId(id)
  if (!parsed) return id
  if (parsed.source === 'dk') {
    const label = measureLabel(
      `dk:bi:${parsed.region}:${parsed.metric}`,
    ).replace(/ \(bilateral mean\)$/, '')
    return label || `${parsed.region} ${DK_METRIC_LABELS[parsed.metric]}`
  }
  if (parsed.source === 'aseg') {
    return capital(
      measureLabel(id)
        .replace(/ \(bilateral mean\)$/, '')
        .replace(/^(Left|Right) /, ''),
    )
  }
  return measureLabel(id)
}

/**
 * Give the table's hemisphere cell.
 *
 * @returns "L", "R", "Both", or an empty string.
 */
export function tableHemisphere(id: string): string {
  const parsed = parseMeasureId(id)
  if (!parsed) return ''
  if (parsed.source === 'dk') {
    return parsed.hemisphere === 'lh'
      ? 'L'
      : parsed.hemisphere === 'rh'
        ? 'R'
        : 'Both'
  }
  if (parsed.source === 'aseg') {
    if (parsed.hemisphere === 'bi') return 'Both'
    if (parsed.structure.startsWith('Left-')) return 'L'
    if (parsed.structure.startsWith('Right-')) return 'R'
  }
  return ''
}

/** An export folder name as main accepts it. */
export const EXPORT_FOLDER_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/

/**
 * Check an export folder name.
 *
 * @returns The actionable error, or null for a valid name.
 */
export function exportFolderError(name: string): string | null {
  if (EXPORT_FOLDER_NAME.test(name)) return null
  return 'Name the folder with 1 to 128 lowercase letters, digits, dots, hyphens, or underscores, starting with a letter or digit.'
}

/** Name the export folder `<YYYY-MM-DD>-<slug>` in local time. */
export function exportFolderName(name: string, now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${fileSlug(name)}`
}

/**
 * Give the Sig. cell's text color. A selected row sits on the accent tint,
 * where the dim text falls below 4.5:1, so "No" takes the soft body text.
 */
export function sigCellColor(
  t: Theme,
  significant: boolean,
  selected: boolean,
): string {
  if (significant) return t.done
  return selected ? t.textSoft : t.dimText
}
