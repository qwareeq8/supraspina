/**
 * Pure edits of a spec v2 draft that keep it consistent: the design scope
 * and population, subset filters, tests, strata, derived variables, the
 * design-check fixes, and the inference rules that follow the design (an F
 * test has no direction, and max-T never pools t and F tests).
 */

import {
  poolsInAllTests,
  testRank as sharedTestRank,
  type AnalysisScope,
  type AnalysisTest,
  type AnalysisTestKind,
  type DerivedVariable,
  type DesignFix,
  type GroupAnalysisSpecV2,
  type GroupDefinition,
  type GroupingSpecV2,
  type SubsetFilter,
  type TestFactor,
  type VariableRefV2,
  type VariableTransform,
} from '../../../shared/group-analysis'
import { proposeGroups } from '../../state/group-analysis'
import {
  findChoice,
  refKey,
  refTerm,
  sameRef,
  type VariableChoice,
} from './variables'

/** The most tests one draft holds. */
export const MAX_TESTS = 16
/** The most subset filters one draft holds. */
export const MAX_SUBSET_FILTERS = 8
/** The most covariates one test adds. */
export const MAX_TEST_COVARIATES = 4
/** The most covariates every test shares, beyond age and sex. */
export const MAX_EXTRA_COVARIATES = 8
/** The most derived variables one draft defines. */
export const MAX_DERIVED = 16
/** The most groups one grouping defines. */
export const MAX_GROUPS = 8

/** What each test kind is called in each scope. */
export const TEST_KIND_LABEL: Readonly<
  Record<AnalysisScope, Record<AnalysisTestKind, string>>
> = {
  between: {
    'two-group': 'Two groups',
    omnibus: 'Three or more groups',
    interaction: 'Slope difference',
    association: 'Association',
  },
  within: {
    'two-group': 'Subgroup comparison',
    omnibus: 'Three or more subgroups',
    association: 'Association',
    interaction: 'Slope difference',
  },
}

/** The transform labels of a tested or moderating variable. */
export const TRANSFORM_LABEL: Readonly<Record<VariableTransform, string>> = {
  none: 'None',
  log1p: 'log(1 + x)',
  standardize: 'Per SD',
}

const PRINTABLE_TRIM = (text: string, max: number): string =>
  text
    .replace(/[^\x20-\x7e]/g, '')
    .slice(0, max)
    .trim()

/**
 * Propose groups from a categorical choice: a control-like reference and
 * the other levels merged under their shared prefix.
 *
 * @returns The grouping with its focal and reference labels.
 */
export function proposeGrouping(choice: VariableChoice): {
  grouping: GroupingSpecV2
  focal: string
  reference: string
} {
  const proposal = proposeGroups({
    levels: choice.levels.map((level) => ({
      value: level.value,
      n: level.n ?? 0,
    })),
  })
  return {
    grouping: { variable: choice.ref, groups: proposal.groups },
    focal: proposal.focal,
    reference: proposal.reference,
  }
}

/**
 * Give each level its own group, as for an omnibus test or strata.
 *
 * @returns The grouping, at most eight groups.
 */
export function groupPerLevel(choice: VariableChoice): GroupingSpecV2 {
  return {
    variable: choice.ref,
    groups: choice.levels.slice(0, MAX_GROUPS).map((level) => ({
      label: PRINTABLE_TRIM(level.value, 64) || 'Group',
      levels: [level.value],
    })),
  }
}

/**
 * Group levels by their first character, for coded levels such as injury
 * levels (C5, C6, T4, L1 make C, T, and L) or AIS grades with subcodes.
 *
 * @returns One group per first character, in order of appearance.
 */
export function groupByFirstCharacter(
  grouping: GroupingSpecV2,
  levels: readonly string[],
): GroupingSpecV2 {
  const groups: GroupDefinition[] = []
  for (const level of levels) {
    const label = level.trim().charAt(0).toUpperCase()
    if (!label || !/[\x21-\x7e]/.test(label)) continue
    const group = groups.find((item) => item.label === label)
    if (group) group.levels.push(level)
    else if (groups.length < MAX_GROUPS) groups.push({ label, levels: [level] })
  }
  return { ...grouping, groups }
}

/**
 * Say whether grouping by first character suits the levels: four or more
 * coded levels that merge into two or more groups.
 */
export function firstCharacterHelps(levels: readonly string[]): boolean {
  const firsts = new Set(
    levels.map((level) => level.trim().charAt(0).toUpperCase()),
  )
  return levels.length >= 4 && firsts.size >= 2 && firsts.size < levels.length
}

/**
 * Move a level into a group, or out of every group with `target` null.
 *
 * @returns The new grouping; an emptied group is kept for refilling.
 */
export function assignLevel<T extends { groups: GroupDefinition[] }>(
  grouping: T,
  level: string,
  target: string | null,
): T {
  return {
    ...grouping,
    groups: grouping.groups.map((group) => {
      const without = group.levels.filter((value) => value !== level)
      return group.label === target
        ? { ...group, levels: [...without, level] }
        : { ...group, levels: without }
    }),
  }
}

/** Rename a group of a grouping. */
export function renameInGrouping<T extends { groups: GroupDefinition[] }>(
  grouping: T,
  from: string,
  to: string,
): T {
  return {
    ...grouping,
    groups: grouping.groups.map((group) =>
      group.label === from ? { ...group, label: to } : group,
    ),
  }
}

/**
 * Keep a test factor's focal and reference groups defined after its
 * grouping changed: a vanished reference becomes the last other group, a
 * vanished focal group the first other group.
 *
 * @returns The factor with defined focal and reference groups.
 */
export function fitFactor(factor: TestFactor): TestFactor {
  const labels = factor.grouping.groups.map((group) => group.label)
  if (labels.length === 0) return factor
  const reference = labels.includes(factor.reference)
    ? factor.reference
    : (labels.filter((label) => label !== factor.focal).at(-1) ?? labels[0]!)
  const focal =
    factor.focal === null || labels.includes(factor.focal)
      ? factor.focal
      : (labels.find((label) => label !== reference) ?? labels[0]!)
  return { ...factor, focal, reference }
}

/**
 * Name a new group that no group of the grouping uses.
 *
 * @returns `Group <n>`.
 */
export function nextGroupLabel(grouping: GroupingSpecV2): string {
  const labels = grouping.groups.map((group) => group.label)
  for (let i = labels.length + 1; ; i += 1) {
    const label = `Group ${i}`
    if (!labels.includes(label)) return label
  }
}

/**
 * Give the rank of a test's main term as the engine fits it, with a
 * categorical moderator's levels from the variable choices (its observed
 * or bin levels, so never fewer than the sample holds): k - 1 for an
 * omnibus test, (k - 1)(m - 1) for a slope difference over m levels.
 */
export function testRank(
  test: AnalysisTest,
  choices: readonly VariableChoice[],
): number {
  const moderator =
    test.kind === 'interaction'
      ? findChoice(choices, test.moderator?.ref)
      : null
  return sharedTestRank(
    test,
    moderator?.kind === 'categorical' ? moderator.levels.length : null,
  )
}

/**
 * Say why the sidedness is two-sided only, or null when it may be chosen:
 * a test of rank above 1, or a heterogeneity test over more strata than a
 * rank-1 test can split into one contrast, is an F test.
 */
export function sidednessLock(
  spec: GroupAnalysisSpecV2,
  choices: readonly VariableChoice[],
): string | null {
  const ranked = spec.tests.find((test) => testRank(test, choices) > 1)
  if (ranked) {
    return `${ranked.label} is an F test, which has no direction, so every test is two-sided.`
  }
  const strata = spec.stratify?.heterogeneity
    ? spec.stratify.grouping.groups.length
    : 0
  if (strata > 2) {
    return 'The heterogeneity test across three or more strata is an F test, which has no direction, so every test is two-sided.'
  }
  return null
}

/**
 * Say whether the tests max-T pools over all tests mix t and F tests (an
 * interaction forms its own family and a sensitivity test has none).
 */
export function mixedRanks(spec: GroupAnalysisSpecV2): boolean {
  const pooled = spec.tests.filter(poolsInAllTests)
  return new Set(pooled.map((test) => sharedTestRank(test))).size > 1
}

/**
 * Keep the inference settings and the per-test flags consistent with the
 * design: two-sided for any F test, no pooled max-T over mixed ranks,
 * pairwise comparisons only after an omnibus test, the omnibus gate only
 * when it can mark something, and one or more tests in the family.
 */
export function normalizeDraft(
  spec: GroupAnalysisSpecV2,
  choices: readonly VariableChoice[],
): GroupAnalysisSpecV2 {
  let tests = spec.tests.map((test) =>
    test.kind === 'omnibus' || test.pairwise === 'none'
      ? test
      : { ...test, pairwise: 'none' as const },
  )
  if (tests.length > 0 && !tests.some((test) => test.inFamily)) {
    tests = tests.map((test, index) =>
      index === 0 ? { ...test, inFamily: true } : test,
    )
  }
  const next = { ...spec, tests }
  let inference = spec.inference
  if (inference.sidedness !== 'two-sided' && sidednessLock(next, choices)) {
    inference = { ...inference, sidedness: 'two-sided' }
  }
  if (
    inference.correction === 'maxt-fwe' &&
    inference.family === 'all-tests' &&
    mixedRanks(next)
  ) {
    inference = { ...inference, family: 'per-test' }
  }
  const gated = tests.some(
    (test) => test.kind === 'omnibus' && test.pairwise !== 'none',
  )
  if (inference.omnibusGate && !gated) {
    inference = { ...inference, omnibusGate: false }
  }
  return inference === spec.inference ? next : { ...next, inference }
}

/**
 * Label a test from its content, for example "SCI vs CTRL", "Time since
 * injury, log(1 + x)", or "Slope of LEMS by group".
 *
 * @returns A printable label of at most 64 characters.
 */
export function autoTestLabel(
  test: AnalysisTest,
  choices: readonly VariableChoice[],
): string {
  const transform = (transform: VariableTransform): string =>
    transform === 'log1p'
      ? ', log(1 + x)'
      : transform === 'standardize'
        ? ', per SD'
        : ''
  let label = ''
  if (test.kind === 'two-group' && test.factor) {
    label = `${test.factor.focal ?? ''} vs ${test.factor.reference}`
  } else if (test.kind === 'omnibus' && test.factor) {
    const labels = test.factor.grouping.groups.map((group) => group.label)
    label =
      labels.length > 2
        ? `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)!}`
        : labels.join(' and ')
  } else if (test.kind === 'association' && test.variable) {
    label = `${refTerm(test.variable.ref, choices)}${transform(test.variable.transform)}`
  } else if (test.kind === 'interaction' && test.moderator) {
    label = `Slope of ${refTerm(test.moderator.ref, choices)} by group`
  }
  return PRINTABLE_TRIM(label, 64) || 'Test'
}

/**
 * Give a test ID no test of the draft uses.
 *
 * @returns `t<n>`.
 */
export function nextTestId(spec: GroupAnalysisSpecV2): string {
  const ids = new Set(spec.tests.map((test) => test.id))
  for (let i = spec.tests.length + 1; ; i += 1) {
    const id = `t${i}`
    if (!ids.has(id)) return id
  }
}

function covariateKeys(spec: GroupAnalysisSpecV2): Set<string> {
  return new Set(
    [spec.covariates.age, spec.covariates.sex, ...spec.covariates.extra]
      .filter((ref): ref is VariableRefV2 => ref !== null)
      .map(refKey),
  )
}

/**
 * Order choices for a within-group default: clinical variables (imported,
 * derived, clinical.csv) before the registry, whose cohort fields mirror
 * the population.
 */
function clinicalFirst(choices: readonly VariableChoice[]): VariableChoice[] {
  const rank: Record<VariableRefV2['source'], number> = {
    imported: 0,
    derived: 1,
    'clinical-csv': 2,
    'metadata-csv': 3,
    'age-csv': 4,
    registry: 5,
    measure: 6,
  }
  return [...choices].sort((a, b) => rank[a.ref.source] - rank[b.ref.source])
}

/**
 * The variable a group test of the draft groups by, as a default: the
 * design's grouping between groups, a clinical variable that splits the
 * population within a group.
 *
 * @returns The choice, or undefined without a categorical variable.
 */
export function defaultFactorChoice(
  spec: GroupAnalysisSpecV2,
  choices: readonly VariableChoice[],
): VariableChoice | undefined {
  const categorical = choices.filter(
    (choice) => choice.kind === 'categorical' && choice.levels.length >= 2,
  )
  const population = spec.design.population?.grouping.variable ?? null
  if (spec.design.scope === 'within') {
    const covariates = covariateKeys(spec)
    // A column with the population's own levels (a cohort column) cannot
    // split the population.
    const own = new Set(
      findChoice(choices, population)?.levels.map((level) => level.value) ?? [],
    )
    const mirrors = (choice: VariableChoice): boolean =>
      own.size > 0 &&
      choice.levels.length === own.size &&
      choice.levels.every((level) => own.has(level.value))
    return (
      clinicalFirst(categorical).find(
        (choice) =>
          !sameRef(choice.ref, population) &&
          !covariates.has(choice.key) &&
          !mirrors(choice),
      ) ?? categorical[0]
    )
  }
  const used = spec.tests.find((test) => test.factor)?.factor?.grouping.variable
  return (
    findChoice(categorical, used) ??
    categorical.find((choice) => choice.ref.column === 'sourceCohortLabel') ??
    categorical[0]
  )
}

function defaultNumericChoice(
  spec: GroupAnalysisSpecV2,
  choices: readonly VariableChoice[],
): VariableChoice | undefined {
  const covariates = covariateKeys(spec)
  const tested = new Set(
    spec.tests.flatMap((test) =>
      [test.variable?.ref, test.moderator?.ref]
        .filter((ref): ref is VariableRefV2 => Boolean(ref))
        .map(refKey),
    ),
  )
  const numeric = clinicalFirst(
    choices.filter((choice) => choice.kind === 'numeric'),
  )
  return (
    numeric.find(
      (choice) => !covariates.has(choice.key) && !tested.has(choice.key),
    ) ??
    numeric.find((choice) => !covariates.has(choice.key)) ??
    numeric[0]
  )
}

function factorFor(kind: AnalysisTestKind, choice: VariableChoice): TestFactor {
  if (kind === 'omnibus') {
    const grouping = groupPerLevel(choice)
    const proposal = proposeGrouping(choice)
    const reference = grouping.groups.some(
      (group) => group.label === proposal.reference,
    )
      ? proposal.reference
      : (grouping.groups[0]?.label ?? 'Group 1')
    return { grouping, focal: null, reference, model: 'all-groups' }
  }
  const { grouping, focal, reference } = proposeGrouping(choice)
  return {
    grouping,
    focal: kind === 'two-group' ? focal : null,
    reference,
    model: 'all-groups',
  }
}

/**
 * Build a new test of one kind with defaults from the draft: a group test
 * groups by the design's grouping (between) or a clinical variable other
 * than the population (within); an association tests a numeric variable no
 * covariate or other test uses.
 */
export function newTest(
  spec: GroupAnalysisSpecV2,
  kind: AnalysisTestKind,
  choices: readonly VariableChoice[],
): AnalysisTest {
  const factorChoice = defaultFactorChoice(spec, choices)
  const numeric = defaultNumericChoice(spec, choices)
  const factor =
    kind !== 'association' && factorChoice
      ? factorFor(kind, factorChoice)
      : null
  const test: AnalysisTest = {
    id: nextTestId(spec),
    label: 'Test',
    kind,
    factor,
    pairwise: kind === 'omnibus' ? 'all-pairs' : 'none',
    pairwiseFamily: 'pooled',
    variable:
      kind === 'association' && numeric
        ? { ref: numeric.ref, transform: 'none' }
        : null,
    moderator:
      kind === 'interaction' && numeric
        ? { ref: numeric.ref, transform: 'none' }
        : null,
    adjustForGroup: false,
    inFamily: true,
    extraCovariates: [],
  }
  return { ...test, label: autoTestLabel(test, choices) }
}

/** Change a test's kind, keeping its grouping where the new kind uses one. */
export function withTestKind(
  spec: GroupAnalysisSpecV2,
  test: AnalysisTest,
  kind: AnalysisTestKind,
  choices: readonly VariableChoice[],
): AnalysisTest {
  if (kind === test.kind) return test
  const fresh = newTest(spec, kind, choices)
  const grouped = test.factor
  let factor: TestFactor | null = fresh.factor
  if (grouped && kind !== 'association') {
    const labels = grouped.grouping.groups.map((group) => group.label)
    const choice = findChoice(choices, grouped.grouping.variable)
    if (kind === 'omnibus' && labels.length < 3 && choice) {
      factor = factorFor('omnibus', choice)
    } else {
      const reference = grouped.reference
      const focal =
        kind === 'two-group'
          ? (grouped.focal ??
            labels.find((label) => label !== reference) ??
            reference)
          : null
      factor = { ...grouped, focal, reference }
    }
  }
  // A categorical moderator cannot become a tested variable.
  const numericModerator =
    test.moderator &&
    findChoice(choices, test.moderator.ref)?.kind === 'numeric'
      ? test.moderator
      : null
  const next: AnalysisTest = {
    ...fresh,
    id: test.id,
    inFamily: test.inFamily,
    extraCovariates: test.extraCovariates,
    factor: kind === 'association' ? null : factor,
    variable:
      kind === 'association'
        ? (test.variable ?? numericModerator ?? fresh.variable)
        : null,
    moderator:
      kind === 'interaction'
        ? (test.moderator ?? test.variable ?? fresh.moderator)
        : null,
  }
  return { ...next, label: autoTestLabel(next, choices) }
}

/** Replace one test, relabeling it when its label was the automatic one. */
export function updateTest(
  spec: GroupAnalysisSpecV2,
  previous: AnalysisTest,
  next: AnalysisTest,
  choices: readonly VariableChoice[],
): GroupAnalysisSpecV2 {
  const relabeled =
    previous.label === autoTestLabel(previous, choices) &&
    next.label === previous.label
      ? { ...next, label: autoTestLabel(next, choices) }
      : next
  return normalizeDraft(
    {
      ...spec,
      tests: spec.tests.map((test) =>
        test.id === previous.id ? relabeled : test,
      ),
    },
    choices,
  )
}

/**
 * Add a test of one kind.
 *
 * @returns The draft, unchanged at sixteen tests.
 */
export function addTest(
  spec: GroupAnalysisSpecV2,
  kind: AnalysisTestKind,
  choices: readonly VariableChoice[],
): GroupAnalysisSpecV2 {
  if (spec.tests.length >= MAX_TESTS) return spec
  return normalizeDraft(
    {
      ...spec,
      tests: [...spec.tests, newTest(spec, kind, choices)],
    },
    choices,
  )
}

/** Remove a test; the last test stays. */
export function removeTest(
  spec: GroupAnalysisSpecV2,
  testId: string,
  choices: readonly VariableChoice[],
): GroupAnalysisSpecV2 {
  if (spec.tests.length <= 1) return spec
  return normalizeDraft(
    {
      ...spec,
      tests: spec.tests.filter((test) => test.id !== testId),
    },
    choices,
  )
}

/**
 * Switch the design scope. Within a group takes its population from the
 * draft's comparison (SCI vs CTRL keeps SCI) and starts with an
 * association test; between groups compares the population's groups.
 */
export function withScope(
  spec: GroupAnalysisSpecV2,
  scope: AnalysisScope,
  choices: readonly VariableChoice[],
): GroupAnalysisSpecV2 {
  if (scope === spec.design.scope) return spec
  if (scope === 'within') {
    const factor = spec.tests.find((test) => test.factor)?.factor ?? null
    let population = factor
      ? {
          grouping: factor.grouping,
          groups: [
            factor.focal ??
              factor.grouping.groups.find(
                (group) => group.label !== factor.reference,
              )?.label ??
              factor.reference,
          ],
        }
      : null
    if (!population) {
      const choice = choices.find(
        (item) => item.kind === 'categorical' && item.levels.length >= 2,
      )
      if (choice) {
        const proposal = proposeGrouping(choice)
        population = { grouping: proposal.grouping, groups: [proposal.focal] }
      }
    }
    const within: GroupAnalysisSpecV2 = {
      ...spec,
      design: { ...spec.design, scope, population },
      tests: [],
    }
    return normalizeDraft(
      {
        ...within,
        tests: [newTest(within, 'association', choices)],
      },
      choices,
    )
  }
  const population = spec.design.population
  const between: GroupAnalysisSpecV2 = {
    ...spec,
    design: { ...spec.design, scope, population: null },
    tests: [],
  }
  let factor: TestFactor | null = null
  if (population && population.grouping.groups.length >= 2) {
    const focal = population.groups[0] ?? population.grouping.groups[0]!.label
    const reference =
      population.grouping.groups.find((group) => group.label !== focal)
        ?.label ?? focal
    factor = {
      grouping: population.grouping,
      focal,
      reference,
      model: 'all-groups',
    }
  }
  const test = newTest(between, 'two-group', choices)
  const first = factor
    ? { ...test, factor, label: autoTestLabel({ ...test, factor }, choices) }
    : test
  return normalizeDraft({ ...between, tests: [first] }, choices)
}

/** Choose the variable a within-group population comes from. */
export function withPopulationVariable(
  spec: GroupAnalysisSpecV2,
  choice: VariableChoice,
): GroupAnalysisSpecV2 {
  const proposal = proposeGrouping(choice)
  return {
    ...spec,
    design: {
      ...spec.design,
      population: { grouping: proposal.grouping, groups: [proposal.focal] },
    },
  }
}

/**
 * Add a subset filter that keeps every level (categorical) or an open
 * range the operator bounds (numeric).
 */
export function addSubsetFilter(
  spec: GroupAnalysisSpecV2,
  choice: VariableChoice,
): GroupAnalysisSpecV2 {
  if (spec.design.subset.length >= MAX_SUBSET_FILTERS) return spec
  if (spec.design.subset.some((filter) => sameRef(filter.variable, choice.ref)))
    return spec
  const filter: SubsetFilter = {
    variable: choice.ref,
    keep:
      choice.kind === 'categorical'
        ? { levels: choice.levels.map((level) => level.value) }
        : { min: null, max: null },
  }
  return {
    ...spec,
    design: { ...spec.design, subset: [...spec.design.subset, filter] },
  }
}

/**
 * Replace or remove (`keep` null) one subset filter.
 *
 * @param keep - What it keeps, or null to remove it.
 */
export function setSubsetFilter(
  spec: GroupAnalysisSpecV2,
  index: number,
  keep: SubsetFilter['keep'] | null,
): GroupAnalysisSpecV2 {
  const subset =
    keep === null
      ? spec.design.subset.filter((_, i) => i !== index)
      : spec.design.subset.map((filter, i) =>
          i === index ? { ...filter, keep } : filter,
        )
  return { ...spec, design: { ...spec.design, subset } }
}

/**
 * Stratify by a categorical variable (one stratum per level), or stop.
 *
 * @param choice - The variable, or null for no strata.
 */
export function withStratify(
  spec: GroupAnalysisSpecV2,
  choice: VariableChoice | null,
): GroupAnalysisSpecV2 {
  return {
    ...spec,
    stratify: choice
      ? {
          grouping: groupPerLevel(choice),
          heterogeneity: spec.stratify?.heterogeneity ?? true,
        }
      : null,
  }
}

/**
 * Give a derived variable an ID from its label that no other uses.
 *
 * @returns `dv-<slug>`.
 */
export function derivedId(
  label: string,
  existing: readonly DerivedVariable[],
): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24)
      .replace(/-+$/g, '') || 'variable'
  const ids = new Set(existing.map((item) => item.id))
  if (!ids.has(`dv-${slug}`)) return `dv-${slug}`
  for (let i = 2; ; i += 1) {
    const id = `dv-${slug}-${i}`
    if (!ids.has(id)) return id
  }
}

function refsOf(spec: GroupAnalysisSpecV2): VariableRefV2[] {
  return [
    ...(spec.design.population
      ? [spec.design.population.grouping.variable]
      : []),
    ...spec.design.subset.map((filter) => filter.variable),
    ...(spec.stratify ? [spec.stratify.grouping.variable] : []),
    ...[spec.covariates.age, spec.covariates.sex].filter(
      (ref): ref is VariableRefV2 => ref !== null,
    ),
    ...spec.covariates.extra,
    ...spec.variables.derived.flatMap((item) => item.inputs),
    ...spec.tests.flatMap((test) => [
      ...(test.factor ? [test.factor.grouping.variable] : []),
      ...(test.variable ? [test.variable.ref] : []),
      ...(test.moderator ? [test.moderator.ref] : []),
      ...test.extraCovariates,
    ]),
  ]
}

/** Say whether the draft uses a variable anywhere. */
export function draftUses(
  spec: GroupAnalysisSpecV2,
  match: (ref: VariableRefV2) => boolean,
): boolean {
  return refsOf(spec).some(match)
}

/**
 * Add a derived variable.
 *
 * @returns The draft, unchanged at sixteen.
 */
export function addDerived(
  spec: GroupAnalysisSpecV2,
  item: DerivedVariable,
): GroupAnalysisSpecV2 {
  if (spec.variables.derived.length >= MAX_DERIVED) return spec
  return {
    ...spec,
    variables: { derived: [...spec.variables.derived, item] },
  }
}

/**
 * Remove a derived variable the draft does not use.
 *
 * @returns The draft, unchanged while the variable is in use.
 */
export function removeDerived(
  spec: GroupAnalysisSpecV2,
  id: string,
): GroupAnalysisSpecV2 {
  if (draftUses(spec, (ref) => ref.source === 'derived' && ref.column === id))
    return spec
  return {
    ...spec,
    variables: {
      derived: spec.variables.derived.filter((item) => item.id !== id),
    },
  }
}

/**
 * Apply a design-check fix: leave out one level of a variable (a subset
 * filter that drops it), or add the variable as a covariate.
 *
 * @param choices - The variable choices, for the levels to keep.
 * @returns The draft, unchanged when the fix cannot apply.
 */
export function applyDesignFix(
  spec: GroupAnalysisSpecV2,
  fix: DesignFix,
  choices: readonly VariableChoice[],
): GroupAnalysisSpecV2 {
  if (fix.kind === 'add-covariate') {
    const used = covariateKeys(spec)
    if (
      used.has(refKey(fix.variable)) ||
      spec.covariates.extra.length >= MAX_EXTRA_COVARIATES
    )
      return spec
    return {
      ...spec,
      covariates: {
        ...spec.covariates,
        extra: [...spec.covariates.extra, fix.variable],
      },
    }
  }
  const index = spec.design.subset.findIndex((filter) =>
    sameRef(filter.variable, fix.variable),
  )
  const existing = index >= 0 ? spec.design.subset[index]! : null
  if (existing && 'levels' in existing.keep) {
    const levels = existing.keep.levels.filter((level) => level !== fix.level)
    if (levels.length === 0 || levels.length === existing.keep.levels.length)
      return spec
    return setSubsetFilter(spec, index, { levels })
  }
  if (existing || spec.design.subset.length >= MAX_SUBSET_FILTERS) return spec
  const choice = findChoice(choices, fix.variable)
  const levels = (choice?.levels ?? [])
    .map((level) => level.value)
    .filter((level) => level !== fix.level)
  if (levels.length === 0) return spec
  return {
    ...spec,
    design: {
      ...spec.design,
      subset: [
        ...spec.design.subset,
        { variable: fix.variable, keep: { levels } },
      ],
    },
  }
}
