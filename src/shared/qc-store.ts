/** Parses the canonical versioned QC verdict store in trusted TypeScript. */

import type { QcReviewEvidence } from './contract'
import type { QcVerdict } from './types'

/** The only accepted QC store schema version. */
export const QC_STORE_SCHEMA_VERSION = 2 as const
/** The limit on each persisted QC note in Unicode code points. */
export const MAX_QC_NOTE_LENGTH = 4_096
/** The limit on the number of persisted QC tags per subject. */
export const MAX_QC_TAGS = 32
/** The limit on each persisted QC tag in Unicode code points. */
export const MAX_QC_TAG_LENGTH = 64
/** The limit on each persisted QC subject ID in Unicode code points. */
export const MAX_QC_SUBJECT_ID_LENGTH = 128

/** One canonical persisted subject QC record. */
export interface QcStoreRecord {
  verdict: QcVerdict | null
  note: string
  tags: string[]
  reviewEvidence: QcReviewEvidence | null
  revision: number
  updatedAt: string
}

/** The complete canonical QC verdict store. */
export interface QcStoreDocument {
  schemaVersion: typeof QC_STORE_SCHEMA_VERSION
  verdicts: Record<string, QcStoreRecord>
}

const VERDICTS = new Set<QcVerdict>(['pass', 'fail', 'defer'])
const CANONICAL_TOP_LEVEL_KEYS = ['schemaVersion', 'verdicts'] as const
const CANONICAL_RECORD_KEYS = [
  'note',
  'reviewEvidence',
  'revision',
  'tags',
  'updatedAt',
  'verdict',
] as const
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const HEX_DIGEST = /^[a-f0-9]{64}$/
const RUN_ID = /^run-[a-f0-9]{8,32}$/
const REQUIRED_GALLERY_TABS = ['subcortical', 'internal', 'external'] as const

function unicodeLength(value: string): number {
  return Array.from(value).length
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

/**
 * Return whether a subject ID is a bounded, traversal-safe path segment.
 *
 * @returns True when the ID is safe for QC-store addressing.
 */
export function isValidQcSubjectId(value: string): boolean {
  return (
    unicodeLength(value) > 0 &&
    unicodeLength(value) <= MAX_QC_SUBJECT_ID_LENGTH &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value.includes('..')
  )
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !CANONICAL_TIMESTAMP.test(value) ||
    Number(value.slice(0, 4)) === 0
  )
    return false
  const timestamp = Date.parse(value)
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  )
}

function parseVerdict(value: unknown): QcVerdict | null {
  if (value === null) return null
  if (typeof value === 'string' && VERDICTS.has(value as QcVerdict)) {
    return value as QcVerdict
  }
  throw new Error('Remove the invalid verdict from the QC verdict store.')
}

function parseReviewEvidence(value: unknown): QcReviewEvidence | null {
  if (value === null) return null
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'evidenceVersion',
      'galleries',
      'reviewedAt',
      'reviewer',
    ]) ||
    value.evidenceVersion !== 1 ||
    typeof value.reviewer !== 'string' ||
    unicodeLength(value.reviewer) === 0 ||
    unicodeLength(value.reviewer) > 128 ||
    !isCanonicalTimestamp(value.reviewedAt) ||
    !Array.isArray(value.galleries) ||
    value.galleries.length !== REQUIRED_GALLERY_TABS.length
  ) {
    throw new Error(
      'Remove the invalid review evidence from the QC verdict store.',
    )
  }
  const galleries = value.galleries.map((gallery) => {
    if (
      !isRecord(gallery) ||
      !hasExactKeys(gallery, [
        'displayPath',
        'label',
        'openedAt',
        'receiptSha256',
        'runId',
        'tab',
      ]) ||
      !REQUIRED_GALLERY_TABS.includes(
        gallery.tab as (typeof REQUIRED_GALLERY_TABS)[number],
      ) ||
      typeof gallery.label !== 'string' ||
      unicodeLength(gallery.label) === 0 ||
      unicodeLength(gallery.label) > 128 ||
      typeof gallery.displayPath !== 'string' ||
      unicodeLength(gallery.displayPath) === 0 ||
      unicodeLength(gallery.displayPath) > 16_384 ||
      typeof gallery.runId !== 'string' ||
      !RUN_ID.test(gallery.runId) ||
      typeof gallery.receiptSha256 !== 'string' ||
      !HEX_DIGEST.test(gallery.receiptSha256) ||
      !isCanonicalTimestamp(gallery.openedAt)
    ) {
      throw new Error(
        'Remove the invalid gallery evidence from the QC verdict store.',
      )
    }
    return {
      tab: gallery.tab as QcReviewEvidence['galleries'][number]['tab'],
      label: gallery.label,
      displayPath: gallery.displayPath,
      runId: gallery.runId,
      receiptSha256: gallery.receiptSha256,
      openedAt: gallery.openedAt,
    }
  })
  const tabs = galleries.map((gallery) => gallery.tab).sort()
  if (
    tabs.join('\0') !== [...REQUIRED_GALLERY_TABS].sort().join('\0') ||
    new Set(galleries.map((gallery) => gallery.runId)).size !== 1 ||
    new Set(galleries.map((gallery) => gallery.receiptSha256)).size !== 1
  ) {
    throw new Error('Keep QC verdict store gallery evidence consistent.')
  }
  return {
    evidenceVersion: 1,
    reviewer: value.reviewer,
    reviewedAt: value.reviewedAt,
    galleries,
  }
}

function parseRecordFields(
  value: Record<string, unknown>,
  updatedAt: unknown,
): QcStoreRecord {
  if (
    typeof value.note !== 'string' ||
    unicodeLength(value.note) > MAX_QC_NOTE_LENGTH ||
    !Array.isArray(value.tags) ||
    value.tags.length > MAX_QC_TAGS ||
    value.tags.some(
      (tag) =>
        typeof tag !== 'string' || unicodeLength(tag) > MAX_QC_TAG_LENGTH,
    ) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 ||
    !isCanonicalTimestamp(updatedAt)
  ) {
    throw new Error('Remove the invalid record from the QC verdict store.')
  }
  const verdict = parseVerdict(value.verdict)
  const reviewEvidence = parseReviewEvidence(value.reviewEvidence ?? null)
  if (verdict !== null && reviewEvidence === null) {
    throw new Error('Provide review evidence for every QC verdict.')
  }
  return {
    verdict,
    note: value.note,
    tags: [...value.tags] as string[],
    reviewEvidence,
    revision: Number(value.revision),
    updatedAt,
  }
}

function parseCanonicalRecord(value: unknown): QcStoreRecord {
  if (!isRecord(value) || !hasExactKeys(value, CANONICAL_RECORD_KEYS)) {
    throw new Error(
      'Remove the invalid canonical record from the QC verdict store.',
    )
  }
  return parseRecordFields(value, value.updatedAt)
}

function parseVerdicts(
  value: unknown,
  parseRecord: (record: unknown) => QcStoreRecord,
): Record<string, QcStoreRecord> {
  if (!isRecord(value)) {
    throw new Error('Provide QC verdict store verdicts as an object.')
  }
  const verdicts: Record<string, QcStoreRecord> = Object.create(null) as Record<
    string,
    QcStoreRecord
  >
  for (const [subjectId, record] of Object.entries(value)) {
    if (!isValidQcSubjectId(subjectId)) {
      throw new Error(
        'Remove the invalid subject ID from the QC verdict store.',
      )
    }
    verdicts[subjectId] = parseRecord(record)
  }
  return verdicts
}

/**
 * Return an empty canonical QC document for a project with no persisted store.
 */
export function emptyQcStore(): QcStoreDocument {
  return {
    schemaVersion: QC_STORE_SCHEMA_VERSION,
    verdicts: Object.create(null) as Record<string, QcStoreRecord>,
  }
}

/**
 * Parse one canonical QC verdict-store document.
 *
 * Reject unversioned layouts, unknown keys, partial records, and coercible
 * revisions; never rewrite the store to make invalid data loadable.
 *
 * @throws Error when the document violates the canonical schema.
 */
export function parseQcStore(value: unknown): QcStoreDocument {
  if (!isRecord(value)) {
    throw new Error('Provide the QC verdict store as an object.')
  }
  if (
    !hasExactKeys(value, CANONICAL_TOP_LEVEL_KEYS) ||
    value.schemaVersion !== QC_STORE_SCHEMA_VERSION
  ) {
    throw new Error('Use a supported QC verdict store schema.')
  }
  return {
    schemaVersion: QC_STORE_SCHEMA_VERSION,
    verdicts: parseVerdicts(value.verdicts, parseCanonicalRecord),
  }
}
