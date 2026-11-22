/**
 * The site facts the Registry and Subjects screens state.
 *
 * These mirror `sites.site_state` in `sidecar/supraspina_sidecar/sites.py`: no
 * subject with a site is one implicit site (the behavior before sites
 * existed), every subject with one is complete, and anything else is mixed,
 * which blocks the site-using stages in the plan.
 */

import {
  normalizeSiteLabel,
  SITE_LABEL_RULE,
  siteLabelConflict,
} from '../../shared/sites'
import type { CohortRole } from '../../shared/types'

/** The help beside every site field. */
export const SITE_HELP = 'The scanner and protocol a subject was scanned with.'

/**
 * The hint an empty site field shows. A label already in use would read as a
 * stored value, so the hint stays neutral.
 */
export const SITE_PLACEHOLDER = 'Scanner or site, e.g. Prisma'

/** One registered subject's site and cohort role. */
export interface SiteEntry {
  id: string
  site: string | null | undefined
  role: CohortRole | undefined
}

/** One site label with its subjects. */
export interface SiteCount {
  site: string
  subjects: number
  controls: number
}

/** The sites of a set of registered subjects. */
export interface SiteSummary {
  mode: 'none' | 'complete' | 'mixed'
  /** Subjects without a site, sorted. */
  unset: string[]
  /** Each label once, largest first, then by label. */
  sites: SiteCount[]
  /** Controls without a site. */
  unsetControls: number
}

/**
 * Summarize the sites of registered subjects.
 *
 * @param entries - One entry per registered subject.
 * @returns The mode, the unset subjects, and the per-site counts.
 * @example
 * summarizeSites([{ id: 'sub-1', site: 'Prisma', role: 'healthy' }]).mode
 * // 'complete'
 */
export function summarizeSites(entries: readonly SiteEntry[]): SiteSummary {
  const counts = new Map<string, SiteCount>()
  const unset: string[] = []
  let unsetControls = 0
  for (const entry of entries) {
    const control = entry.role === 'healthy' ? 1 : 0
    if (!entry.site) {
      unset.push(entry.id)
      unsetControls += control
      continue
    }
    const count = counts.get(entry.site) ?? {
      site: entry.site,
      subjects: 0,
      controls: 0,
    }
    count.subjects += 1
    count.controls += control
    counts.set(entry.site, count)
  }
  const sites = [...counts.values()].sort(
    (a, b) => b.subjects - a.subjects || a.site.localeCompare(b.site),
  )
  return {
    mode: sites.length === 0 ? 'none' : unset.length > 0 ? 'mixed' : 'complete',
    unset: unset.sort((a, b) => a.localeCompare(b)),
    sites,
    unsetControls,
  }
}

/**
 * State the per-site subject counts, or null when no subject has a site.
 *
 * @returns A sentence such as "Sites: A 50, B 4.".
 */
export function siteCountsText(summary: SiteSummary): string | null {
  if (summary.sites.length === 0) return null
  const counts = summary.sites
    .map((count) => `${count.site} ${count.subjects}`)
    .join(', ')
  return `${summary.sites.length === 1 ? 'Site' : 'Sites'}: ${counts}.`
}

/**
 * State how many unregistered subjects hold a site, or null for none.
 *
 * A held site joins planning and the site counts only once its subject is
 * registered, so the counts leave it out and this sentence names it.
 *
 * @param held - The number of unregistered subjects with a site.
 * @returns A sentence such as "The sites of 7 unregistered subjects are held
 *   until registration.", or null.
 */
export function siteHeldText(held: number): string | null {
  if (held <= 0) return null
  return held === 1
    ? 'The site of 1 unregistered subject is held until registration.'
    : `The sites of ${held} unregistered subjects are held until registration.`
}

/**
 * State how many subjects lack a site while others have one.
 *
 * @returns A sentence such as "82 subjects have no site, and 7 do.", or null
 *   unless the sites are mixed.
 */
export function siteMixedText(summary: SiteSummary): string | null {
  if (summary.mode !== 'mixed') return null
  const unset = summary.unset.length
  const set = summary.sites.reduce((total, count) => total + count.subjects, 0)
  const lacking =
    unset === 1 ? '1 subject has no site' : `${unset} subjects have no site`
  return `${lacking}, and ${set} ${set === 1 ? 'does' : 'do'}.`
}

/**
 * State each site without controls while the cohort has controls elsewhere.
 *
 * Such a site confounds site with group: its group difference cannot be
 * separated from the scanner.
 *
 * @returns One sentence per site, such as "Site B has no controls.".
 */
export function siteConfoundFacts(summary: SiteSummary): string[] {
  const controls =
    summary.unsetControls +
    summary.sites.reduce((total, count) => total + count.controls, 0)
  if (
    controls === 0 ||
    summary.sites.length + (summary.unset.length > 0 ? 1 : 0) < 2
  ) {
    return []
  }
  return summary.sites
    .filter((count) => count.controls === 0)
    .map((count) => `Site ${count.site} has no controls.`)
}

/**
 * List the distinct site labels in use, sorted.
 *
 * @returns Each label once.
 */
export function siteLabels(
  sites: Iterable<string | null | undefined>,
): string[] {
  const labels = new Set<string>()
  for (const site of sites) if (site) labels.add(site)
  return [...labels].sort((a, b) => a.localeCompare(b))
}

/**
 * Check a site label typed into a form, as the sidecar will.
 *
 * @param value - The typed text; blank means no site.
 * @param existing - The labels other subjects keep.
 * @returns The refusal, or null when the label (or no site) is valid.
 * @example
 * siteLabelError('prisma', ['Prisma'])
 * // 'Use the existing site label Prisma; the two labels differ only in letter case.'
 */
export function siteLabelError(
  value: string,
  existing: Iterable<string>,
): string | null {
  let label: string | null
  try {
    label = normalizeSiteLabel(value)
  } catch {
    return SITE_LABEL_RULE
  }
  if (label === null) return null
  const conflict = siteLabelConflict(label, existing)
  return conflict === null
    ? null
    : `Use the existing site label ${conflict}; the two labels differ only in letter case.`
}

/**
 * State that ENIGMA outlier review pools every site, or null for fewer than
 * two site labels.
 *
 * The review flags values against the whole cohort's mean and SD, so a
 * scanner offset can make one site's subjects look like outliers.
 */
export function outlierSiteFact(
  sites: Iterable<string | null | undefined>,
): string | null {
  return siteLabels(sites).length < 2
    ? null
    : "Outliers are judged against the whole cohort, so a site's scanner offset can flag its subjects."
}

/** The fewest usable controls a site needs before BrainCharts adapts to it. */
const BRAINCHARTS_MIN_CONTROLS = 2
/** The lifespan model's age range in years; the run refuses other ages. */
const BRAINCHARTS_MIN_AGE = -5
const BRAINCHARTS_MAX_AGE = 110

/** One analysis subject as BrainCharts counts it. */
export interface BrainChartsEntry {
  site: string | null | undefined
  role: CohortRole | undefined
  age: number | null
  sex: string
}

/** What BrainCharts does with each site, as one sentence and its tone. */
export interface BrainChartsSiteFact {
  tone: 'fact' | 'warn'
  text: string
}

/**
 * State which sites BrainCharts adapts the model to and which it refuses.
 *
 * Mirrors the plan's BrainCharts advisory and blocker in
 * `sidecar/supraspina_sidecar/workflow.py`: a subject counts with an age from
 * -5 to 110 years and sex F or M, a site needs at least 2 such controls, and
 * subjects without a site form one unnamed site.
 *
 * @returns The fact, or null for one adaptable site or no subjects.
 * @example
 * brainchartsSiteFact(entries)?.text
 * // 'Adapts the model to 1 of 2 sites. Site B has no controls, so its
 * // 4 subjects get no z-scores.'
 */
export function brainchartsSiteFact(
  entries: readonly BrainChartsEntry[],
): BrainChartsSiteFact | null {
  const counts = new Map<string, { controls: number; subjects: number }>()
  for (const entry of entries) {
    if (
      entry.age === null ||
      entry.age < BRAINCHARTS_MIN_AGE ||
      entry.age > BRAINCHARTS_MAX_AGE ||
      (entry.sex !== 'F' && entry.sex !== 'M')
    ) {
      continue
    }
    const site = entry.site ?? ''
    const count = counts.get(site) ?? { controls: 0, subjects: 0 }
    count.subjects += 1
    if (entry.role === 'healthy') count.controls += 1
    counts.set(site, count)
  }
  if (counts.size === 0) return null
  // Order as the sidecar does: by code point, so the unnamed site leads.
  const refused = [...counts.keys()]
    .filter((site) => counts.get(site)!.controls < BRAINCHARTS_MIN_CONTROLS)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  if (refused.length === counts.size) {
    return {
      tone: 'warn',
      text: 'No site has at least 2 controls, so the model cannot be adapted.',
    }
  }
  if (refused.length === 0) {
    return counts.size < 2
      ? null
      : {
          tone: 'fact',
          text: `Adapts the model to each of the ${counts.size} sites.`,
        }
  }
  const facts = refused.map((site) => {
    const { controls, subjects } = counts.get(site)!
    const lacking = controls === 0 ? 'no controls' : '1 control'
    if (!site) {
      return `The subjects without a site have ${lacking}, so they get no z-scores.`
    }
    const outcome =
      subjects === 1
        ? 'its 1 subject gets no z-scores'
        : `its ${subjects} subjects get no z-scores`
    return `Site ${site} has ${lacking}, so ${outcome}.`
  })
  return {
    tone: 'warn',
    text: `Adapts the model to ${counts.size - refused.length} of ${counts.size} sites. ${facts.join(' ')}`,
  }
}
