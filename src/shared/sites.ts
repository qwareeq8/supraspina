/**
 * The site label rule and the `registry.setSite` request contract.
 *
 * A site is one acquisition batch: a scanner plus protocol. The sidecar owns
 * storage and the authoritative checks (`sidecar/supraspina_sidecar/sites.py`);
 * the rule here mirrors it for the main process and the renderer.
 * `sidecar/tests/fixtures/sites/site-labels.json` binds both sides to the same
 * accepted and refused labels.
 */

/** The longest site label, in characters. */
export const MAX_SITE_LABEL_LENGTH = 64

/**
 * One trimmed site label: letters, digits, spaces, periods, underscores, and
 * hyphens, starting with a letter or digit and ending without a space.
 */
export const SITE_LABEL_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9._-])?$/

/** The refusal for a label outside the rule. */
export const SITE_LABEL_RULE =
  'Use a site label of 1 to 64 letters, digits, spaces, periods, underscores, or hyphens, or leave the value empty.'

/** The most subjects one `registry.setSite` request may name. */
export const MAX_SET_SITE_SUBJECTS = 20_000

// Mirror the stored-record subject rule in registry_store.py (_SUBJECT_ID).
const SUBJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

// Trim ASCII whitespace only, as sites.py does, so both sides agree on
// every input (String.prototype.trim also strips Unicode spaces).
const EDGE_WHITESPACE = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g

/**
 * Return the canonical site label, or null for an unset site.
 *
 * @param value - The untrusted label; null and blank text mean unset.
 * @returns The trimmed label, or null.
 * @throws {TypeError} For a value outside the label rule.
 * @example
 * normalizeSiteLabel('  Prisma ') // 'Prisma'
 */
export function normalizeSiteLabel(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new TypeError(SITE_LABEL_RULE)
  const label = value.replace(EDGE_WHITESPACE, '')
  if (label === '') return null
  if (!SITE_LABEL_PATTERN.test(label)) throw new TypeError(SITE_LABEL_RULE)
  return label
}

/**
 * Report whether a value is a canonical site label.
 *
 * @returns True for a trimmed label inside the rule.
 * @example
 * isSiteLabel('Prisma') // true
 */
export function isSiteLabel(value: unknown): value is string {
  return typeof value === 'string' && SITE_LABEL_PATTERN.test(value)
}

/**
 * Find an existing label that differs from `label` only in letter case.
 *
 * Labels are case-sensitive, but `Prisma` and `prisma` in one project are
 * refused, because they would split one scanner into two sites.
 *
 * @returns The conflicting label, or null.
 * @example
 * siteLabelConflict('prisma', ['Prisma']) // 'Prisma'
 */
export function siteLabelConflict(
  label: string,
  existing: Iterable<string>,
): string | null {
  const folded = label.toLowerCase()
  for (const candidate of existing) {
    if (candidate !== label && candidate.toLowerCase() === folded) {
      return candidate
    }
  }
  return null
}

/** The fields of a `registry.setSite` request after the project reference. */
export interface RegistrySetSiteFields {
  /** The subjects to change, each named once. */
  subjectIds: string[]
  /** The canonical label to set, or null to clear the site. */
  site: string | null
  /** The stored revision the editor last saw, for every named subject. */
  expectedRevisions: Record<string, number>
}

/**
 * Validate the fields of one `registry.setSite` request.
 *
 * The sidecar repeats every check; this parse lets main refuse a malformed
 * request before it crosses the process boundary.
 *
 * @throws {TypeError} For the first field outside the contract.
 */
export function parseRegistrySetSiteFields(
  value: unknown,
): RegistrySetSiteFields {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Provide a valid site request.')
  }
  const fields = value as Record<string, unknown>
  const subjectIds = fields.subjectIds
  if (
    !Array.isArray(subjectIds) ||
    subjectIds.length === 0 ||
    subjectIds.length > MAX_SET_SITE_SUBJECTS
  ) {
    throw new TypeError('Select 1 to 20,000 subjects to set a site for.')
  }
  const seen = new Set<string>()
  for (const subjectId of subjectIds) {
    if (
      typeof subjectId !== 'string' ||
      !SUBJECT_ID_PATTERN.test(subjectId) ||
      subjectId.includes('..')
    ) {
      throw new TypeError('Select subjects with valid IDs to set a site for.')
    }
    if (seen.has(subjectId)) {
      throw new TypeError('Name each subject once in a site request.')
    }
    seen.add(subjectId)
  }
  const revisions = fields.expectedRevisions
  if (
    revisions === null ||
    typeof revisions !== 'object' ||
    Array.isArray(revisions)
  ) {
    throw new TypeError('Provide the saved revision of every subject.')
  }
  const revisionEntries = Object.entries(revisions as Record<string, unknown>)
  if (
    revisionEntries.length !== seen.size ||
    revisionEntries.some(
      ([subjectId, revision]) =>
        !seen.has(subjectId) ||
        typeof revision !== 'number' ||
        !Number.isSafeInteger(revision) ||
        revision < 0,
    )
  ) {
    throw new TypeError('Provide the saved revision of every subject.')
  }
  if (!('site' in fields)) throw new TypeError(SITE_LABEL_RULE)
  return {
    subjectIds: [...subjectIds] as string[],
    site: normalizeSiteLabel(fields.site),
    expectedRevisions: Object.fromEntries(revisionEntries) as Record<
      string,
      number
    >,
  }
}
