/**
 * Authoritative analysis-cohort helpers for renderer run surfaces. Discovery
 * owns scientific eligibility. Do not reconstruct eligibility from cohort roles
 * or T1 availability. Only the renderer invariant that QC Fail cannot remain
 * eligible, the evidence rule that makes a recorded QC verdict effective, and
 * the configured include and exclude lists, which discovery also applies, are
 * enforced here.
 */

import type { QcVerdict, Subject } from './types'

/** The recorded verdict and review evidence of one stored QC record. */
export interface QcRecordEvidence {
  verdict?: string | null
  reviewEvidence?: unknown
}

/**
 * Project one stored QC record onto its evidence-backed verdict. This is the
 * renderer twin of the sidecar's `cohort.effective_qc_verdict`; keep the two
 * in step. A verdict other than Pass, Fail, or Defer reads as unreviewed, and
 * so does Pass or Fail without gallery review evidence.
 *
 * @param record - The stored record, or null when none exists.
 * @returns The effective verdict, or null for an unreviewed subject.
 */
export function effectiveQcVerdict(
  record: QcRecordEvidence | null | undefined,
): QcVerdict | null {
  const verdict = record?.verdict
  if (verdict !== 'pass' && verdict !== 'fail' && verdict !== 'defer') {
    return null
  }
  if (verdict !== 'defer' && record?.reviewEvidence == null) return null
  return verdict
}

/**
 * Normalize one raw discovery row to the renderer's QC exclusion invariant.
 *
 * @param subject - A subject returned by discovery or refreshOne.
 * @returns A copy with strict eligibility that is false on QC Fail.
 */
export function normalizeAnalysisEligibility(subject: Subject): Subject {
  return {
    ...subject,
    analysisEligible:
      subject.analysisEligible === true && subject.qc !== 'fail',
  }
}

/**
 * Normalize a discovery response without deriving eligibility from role data.
 *
 * @returns Normalized subjects in their original order.
 */
export function normalizeAnalysisSubjects(
  subjects: readonly Subject[],
): Subject[] {
  return subjects.map(normalizeAnalysisEligibility)
}

/**
 * Test whether a subject belongs to the current authoritative analysis cohort.
 *
 * @returns True only for an explicitly eligible, non-failed subject.
 */
export function isAnalysisEligible(subject: Subject): boolean {
  return subject.analysisEligible === true && subject.qc !== 'fail'
}

/**
 * Return the current authoritative analysis cohort in discovery order.
 *
 * @param subjects - All retained discovery rows, including ineligible rows.
 */
export function analysisEligibleSubjects(
  subjects: readonly Subject[],
): Subject[] {
  return subjects.filter(isAnalysisEligible)
}

/** The configured subject lists, as in `ProjectConfig.subjects`. */
export interface SubjectScope {
  include: readonly string[]
  exclude: readonly string[]
}

/** Mirror the sidecar's `_safe_subject_id`, which drops unsafe listed IDs. */
function safeSubjectId(id: string): boolean {
  return (
    id.length > 0 &&
    !['/', '\\', '\0', '..'].some((token) => id.includes(token))
  )
}

/**
 * Keep the rows the configured include and exclude lists admit. This is the
 * renderer twin of the sidecar's `cohort.subject_in_config_scope`, which
 * discovery applies: rows held from the previous discovery drop a newly
 * excluded subject at once instead of counting it until rediscovery answers.
 *
 * @returns The rows in scope, in their original order.
 */
export function subjectsInConfigScope(
  subjects: readonly Subject[],
  scope: SubjectScope,
): Subject[] {
  const include = new Set(scope.include.filter(safeSubjectId))
  const exclude = new Set(scope.exclude.filter(safeSubjectId))
  return subjects.filter(
    (subject) =>
      !exclude.has(subject.id) &&
      (include.size === 0 || include.has(subject.id)),
  )
}

/** Why a subject with a QC Fail verdict is out of the analysis cohort. */
export const QC_FAIL_EXCLUSION_REASON =
  'Excluded from analysis: the QC verdict is Fail.'

/**
 * Explain why a retained row cannot be selected for analysis.
 *
 * @returns An accessible, operator-facing reason.
 */
export function analysisIneligibilityReason(subject: Subject): string {
  if (subject.qc === 'fail') return QC_FAIL_EXCLUSION_REASON
  return (
    subject.unavailableReason?.trim() ||
    'Excluded from the current analysis cohort.'
  )
}

/**
 * Explain why no analysis run can start for the current discovery result.
 *
 * @param subjects - All retained discovery rows.
 * @returns A precise empty-cohort message for the run surfaces.
 */
export function emptyAnalysisCohortReason(
  subjects: readonly Subject[],
): string {
  if (subjects.length === 0) {
    return 'Add subjects to the configured data root before running.'
  }
  if (subjects.every((subject) => subject.qc === 'fail')) {
    return 'Change at least one QC Fail verdict before running.'
  }
  return 'Resolve subject eligibility before running.'
}
