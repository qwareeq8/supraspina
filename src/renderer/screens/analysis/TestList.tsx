/**
 * The tests of a design: one row per test with its label, kind, and
 * whether it is in the correction family, an editor per test (the
 * comparison, the tested variable and its transform, the slope
 * difference's moderator, and up to four extra covariates), and Add test.
 */

import { useState, type ReactNode } from 'react'
import type {
  AnalysisScope,
  AnalysisTest,
  AnalysisTestKind,
  GroupAnalysisInputs,
  GroupAnalysisSpecV2,
  PairwiseMode,
  TestFactor,
  VariableRefV2,
  VariableTransform,
} from '../../../shared/group-analysis'
import { useApp } from '../../state/context'
import { Btn, FONTS, Hint, Segments, TextInput, Toggle } from '../../ui'
import { CheckRow, SelectField } from './controls'
import {
  MAX_TEST_COVARIATES,
  MAX_TESTS,
  TEST_KIND_LABEL,
  TRANSFORM_LABEL,
  addTest,
  defaultFactorChoice,
  fitFactor,
  proposeGrouping,
  removeTest,
  testRank,
  updateTest,
  withTestKind,
} from './draft-v2'
import { GroupingEditor, type GroupRename } from './GroupingEditor'
import {
  findChoice,
  refKey,
  refLabel,
  sameRef,
  type VariableChoice,
} from './variables'

/** The kinds each scope offers, in menu order. */
const KINDS: Readonly<Record<AnalysisScope, AnalysisTestKind[]>> = {
  between: ['two-group', 'omnibus', 'interaction', 'association'],
  within: ['two-group', 'omnibus', 'association', 'interaction'],
}

/** The test list's inputs. */
export interface TestListProps {
  draft: GroupAnalysisSpecV2
  choices: readonly VariableChoice[]
  /** The covariates a test may add (variables and measures). */
  covariateChoices: readonly VariableChoice[]
  inputs: GroupAnalysisInputs | null
  onChange: (next: GroupAnalysisSpecV2) => void
}

function followRename(factor: TestFactor, rename: GroupRename | null) {
  if (!rename) return factor
  const rename1 = (label: string): string =>
    label === rename.from ? rename.to : label
  return {
    ...factor,
    focal: factor.focal === null ? null : rename1(factor.focal),
    reference: rename1(factor.reference),
  }
}

function kindSummary(
  test: AnalysisTest,
  scope: AnalysisScope,
  choices: readonly VariableChoice[],
): string {
  const rank = testRank(test, choices)
  return `${TEST_KIND_LABEL[scope][test.kind]}${rank > 1 ? `, F test (${rank} df)` : ''}`
}

export function TestList({
  draft,
  choices,
  covariateChoices,
  inputs,
  onChange,
}: TestListProps): ReactNode {
  const { t } = useApp()
  const scope = draft.design.scope
  const [open, setOpen] = useState<string | null>(
    draft.tests.length === 1 ? (draft.tests[0]?.id ?? null) : null,
  )
  const [adding, setAdding] = useState<AnalysisTestKind>(
    scope === 'within' ? 'association' : 'two-group',
  )
  const inFamily = draft.tests.filter((test) => test.inFamily).length
  const only = draft.tests.length === 1 ? draft.tests[0] : undefined
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {/* A single test needs no card or summary row: its editor says it all. */}
      {only && (
        <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
          <TestEditor
            draft={draft}
            test={only}
            choices={choices}
            covariateChoices={covariateChoices}
            inputs={inputs}
            lastInFamily={only.inFamily && inFamily === 1}
            onChange={onChange}
          />
        </div>
      )}
      {!only &&
        draft.tests.map((test) => {
          const expanded = open === test.id
          const editorId = `analysis-test-${test.id}`
          return (
            <div
              key={test.id}
              style={{
                border: `1px solid ${t.borderSoft}`,
                borderRadius: 5,
                background: t.bg,
                minWidth: 0,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 6px 4px 8px',
                  minWidth: 0,
                }}
              >
                <div style={{ flex: 1, minWidth: 0, display: 'grid' }}>
                  <span
                    style={{
                      fontFamily: FONTS.sans,
                      fontSize: 12,
                      fontWeight: 600,
                      color: t.text,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={test.label}
                  >
                    {test.label}
                  </span>
                  <span
                    style={{
                      fontFamily: FONTS.sans,
                      fontSize: 11,
                      color: t.dimText,
                    }}
                  >
                    {kindSummary(test, scope, choices)}
                    {test.inFamily ? '' : '; sensitivity, outside the family'}
                  </span>
                </div>
                <Btn
                  t={t}
                  small
                  ghost
                  label={expanded ? 'Close' : 'Edit'}
                  ariaLabel={`${expanded ? 'Close' : 'Edit'} ${test.label}`}
                  ariaExpanded={expanded}
                  ariaControls={editorId}
                  onClick={() => setOpen(expanded ? null : test.id)}
                />
              </div>
              {expanded && (
                <div
                  id={editorId}
                  style={{
                    display: 'grid',
                    gap: 8,
                    padding: '6px 8px 8px',
                    borderTop: `1px solid ${t.borderSoft}`,
                  }}
                >
                  <TestEditor
                    draft={draft}
                    test={test}
                    choices={choices}
                    covariateChoices={covariateChoices}
                    inputs={inputs}
                    lastInFamily={test.inFamily && inFamily === 1}
                    onChange={onChange}
                  />
                </div>
              )}
            </div>
          )
        })}
      {draft.tests.length < MAX_TESTS && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto',
            gap: 6,
            alignItems: 'end',
          }}
        >
          <SelectField
            label="Add a test"
            value={adding}
            options={KINDS[scope].map((kind) => ({
              value: kind,
              label: TEST_KIND_LABEL[scope][kind],
            }))}
            onChange={(value) => setAdding(value as AnalysisTestKind)}
          />
          {/* Match the select beside it at every density. */}
          <Btn
            t={t}
            label="Add test"
            style={{ height: 'var(--ss-input-h)' }}
            onClick={() => {
              const next = addTest(draft, adding, choices)
              onChange(next)
              setOpen(next.tests.at(-1)?.id ?? null)
            }}
          />
        </div>
      )}
    </div>
  )
}

/** One test's editor's inputs. */
interface TestEditorProps {
  draft: GroupAnalysisSpecV2
  test: AnalysisTest
  choices: readonly VariableChoice[]
  covariateChoices: readonly VariableChoice[]
  inputs: GroupAnalysisInputs | null
  /** The only test in the family, which must stay in it. */
  lastInFamily: boolean
  onChange: (next: GroupAnalysisSpecV2) => void
}

function TestEditor({
  draft,
  test,
  choices,
  covariateChoices,
  inputs,
  lastInFamily,
  onChange,
}: TestEditorProps): ReactNode {
  const { t } = useApp()
  const scope = draft.design.scope
  const set = (next: AnalysisTest): void =>
    onChange(updateTest(draft, test, next, choices))
  const categorical = choices.filter((choice) => choice.kind === 'categorical')
  const numeric = choices.filter((choice) => choice.kind === 'numeric')
  const population = draft.design.population?.grouping.variable ?? null
  const groupChoices = categorical.filter(
    (choice) => scope === 'between' || !sameRef(choice.ref, population),
  )
  const factor = test.factor
  const labels = factor?.grouping.groups.map((group) => group.label) ?? []
  const options = labels.map((label) => ({ value: label, label }))
  const covariateKeys = new Set(
    [draft.covariates.age, draft.covariates.sex, ...draft.covariates.extra]
      .filter((ref): ref is VariableRefV2 => ref !== null)
      .map(refKey),
  )
  const tested = new Set(
    [factor?.grouping.variable, test.variable?.ref, test.moderator?.ref]
      .filter((ref): ref is VariableRefV2 => Boolean(ref))
      .map(refKey),
  )
  // The design check's cells give each group's complete-case count.
  const cells = inputs?.designCheck?.cells.filter(
    (cell) => cell.testId === test.id && cell.stratum === null,
  )
  const count =
    cells && cells.length > 0
      ? (label: string): number | null =>
          cells.find((cell) => cell.label === label)?.n ?? null
      : undefined

  const groupingSelect = (
    <SelectField
      label="Groups from"
      value={factor ? refKey(factor.grouping.variable) : ''}
      options={[
        ...(factor ? [] : [{ value: '', label: 'Choose a variable' }]),
        ...groupChoices.map((choice) => ({
          value: choice.key,
          label: choice.label,
          disabled: covariateKeys.has(choice.key),
        })),
      ]}
      onChange={(key) => {
        const choice = groupChoices.find((item) => item.key === key)
        if (!choice) return
        const proposal = proposeGrouping(choice)
        set({
          ...test,
          factor: {
            grouping: proposal.grouping,
            focal: test.kind === 'two-group' ? proposal.focal : null,
            reference: proposal.reference,
            model: factor?.model ?? 'all-groups',
          },
        })
      }}
    />
  )
  const groupingEditor = factor && (
    <GroupingEditor
      name={`Groups of ${test.label}`}
      grouping={factor.grouping}
      choice={findChoice(choices, factor.grouping.variable)}
      count={count}
      minGroups={test.kind === 'omnibus' ? 3 : 2}
      onChange={(grouping, rename) =>
        set({
          ...test,
          factor: fitFactor({ ...followRename(factor, rename), grouping }),
        })
      }
    />
  )
  const variableSelect = (
    label: string,
    value: VariableRefV2 | null,
    pool: readonly VariableChoice[],
    onPick: (ref: VariableRefV2) => void,
  ) => (
    <SelectField
      label={label}
      value={refKey(value)}
      options={[
        ...(value ? [] : [{ value: '', label: 'Choose a variable' }]),
        ...pool.map((choice) => ({
          value: choice.key,
          label: choice.label,
          disabled: covariateKeys.has(choice.key),
        })),
      ]}
      onChange={(key) => {
        const choice = pool.find((item) => item.key === key)
        if (choice) onPick(choice.ref)
      }}
    />
  )
  const transformSegments = (
    label: string,
    value: VariableTransform,
    onPick: (transform: VariableTransform) => void,
  ) => (
    <div style={{ display: 'grid', gap: 4 }}>
      <span style={{ fontSize: 11, color: t.dim, fontFamily: FONTS.sans }}>
        {label}
      </span>
      <Segments
        t={t}
        small
        ariaLabel={label}
        value={value}
        options={(Object.keys(TRANSFORM_LABEL) as VariableTransform[]).map(
          (transform) => ({
            value: transform,
            label: TRANSFORM_LABEL[transform],
          }),
        )}
        onChange={(next) => onPick(next as VariableTransform)}
      />
    </div>
  )

  return (
    <>
      {draft.tests.length > 1 && (
        <TextInput
          t={t}
          value={test.label}
          ariaLabel="Test label"
          onChange={(value) => set({ ...test, label: value.slice(0, 64) })}
        />
      )}
      {/* The kind names do not fit a segmented control in the rail. */}
      <SelectField
        label={scope === 'between' ? 'Compare as' : 'Test'}
        value={test.kind}
        options={KINDS[scope].map((kind) => ({
          value: kind,
          label: TEST_KIND_LABEL[scope][kind],
        }))}
        onChange={(value) =>
          set(withTestKind(draft, test, value as AnalysisTestKind, choices))
        }
      />
      {test.kind === 'association' && (
        <>
          {variableSelect(
            'Tested variable',
            test.variable?.ref ?? null,
            numeric,
            (ref) =>
              set({
                ...test,
                variable: {
                  ref,
                  transform: test.variable?.transform ?? 'none',
                },
              }),
          )}
          {transformSegments(
            'Transform',
            test.variable?.transform ?? 'none',
            (transform) =>
              test.variable &&
              set({ ...test, variable: { ...test.variable, transform } }),
          )}
          <Toggle
            t={t}
            checked={test.adjustForGroup}
            label="Adjust for group"
            onChange={(on) => {
              if (!on) {
                set({ ...test, adjustForGroup: false, factor: null })
                return
              }
              const choice =
                findChoice(groupChoices, factor?.grouping.variable) ??
                defaultFactorChoice(draft, groupChoices)
              if (!choice) return
              const proposal = proposeGrouping(choice)
              set({
                ...test,
                adjustForGroup: true,
                factor: {
                  grouping: proposal.grouping,
                  focal: null,
                  reference: proposal.reference,
                  model: 'all-groups',
                },
              })
            }}
          />
          {test.adjustForGroup && factor && (
            <>
              {groupingSelect}
              {groupingEditor}
            </>
          )}
        </>
      )}
      {test.kind !== 'association' && (
        <>
          {groupingSelect}
          {groupingEditor}
          {factor && test.kind === 'two-group' && (
            <>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
                  gap: 8,
                }}
              >
                <SelectField
                  label="Focal group"
                  value={factor.focal ?? ''}
                  options={options}
                  onChange={(value) =>
                    set({ ...test, factor: { ...factor, focal: value } })
                  }
                />
                <SelectField
                  label="Reference group"
                  value={factor.reference}
                  options={options}
                  onChange={(value) =>
                    set({ ...test, factor: { ...factor, reference: value } })
                  }
                />
              </div>
              {labels.length > 2 && (
                <>
                  <Segments
                    t={t}
                    small
                    ariaLabel="Groups in the model"
                    value={factor.model}
                    options={[
                      { value: 'all-groups', label: 'Model all groups' },
                      {
                        value: 'compared-groups',
                        label: 'Compared groups only',
                      },
                    ]}
                    onChange={(value) =>
                      set({
                        ...test,
                        factor: {
                          ...factor,
                          model: value as TestFactor['model'],
                        },
                      })
                    }
                  />
                  <Hint t={t}>
                    {factor.model === 'all-groups'
                      ? 'Every defined group enters the model and shares one residual variance.'
                      : `Only ${factor.focal ?? ''} and ${factor.reference} enter the model.`}
                  </Hint>
                </>
              )}
            </>
          )}
          {factor && test.kind !== 'two-group' && (
            <SelectField
              label="Reference group"
              value={factor.reference}
              options={options}
              onChange={(value) =>
                set({ ...test, factor: { ...factor, reference: value } })
              }
            />
          )}
          {factor && test.kind === 'omnibus' && (
            <>
              <SelectField
                label="Pairwise comparisons"
                value={test.pairwise}
                options={[
                  { value: 'all-pairs', label: 'All pairs' },
                  {
                    value: 'versus-reference',
                    label: `Each group versus ${factor.reference}`,
                  },
                  { value: 'none', label: 'None (the F test only)' },
                ]}
                onChange={(value) =>
                  set({ ...test, pairwise: value as PairwiseMode })
                }
              />
              {test.pairwise !== 'none' && (
                <>
                  <Segments
                    t={t}
                    small
                    ariaLabel="Pairwise correction"
                    value={test.pairwiseFamily}
                    options={[
                      { value: 'pooled', label: 'One family over pairs' },
                      { value: 'per-pair', label: 'Each pair separately' },
                    ]}
                    onChange={(value) =>
                      set({
                        ...test,
                        pairwiseFamily: value as AnalysisTest['pairwiseFamily'],
                      })
                    }
                  />
                  <Toggle
                    t={t}
                    checked={draft.inference.omnibusGate}
                    label="Show pairwise only after a significant omnibus"
                    onChange={(on) =>
                      onChange({
                        ...draft,
                        inference: { ...draft.inference, omnibusGate: on },
                      })
                    }
                  />
                  <Hint t={t}>
                    The gate marks pairwise rows; it never changes a p value.
                  </Hint>
                </>
              )}
            </>
          )}
          {factor && test.kind === 'interaction' && (
            <>
              {variableSelect(
                'Moderator',
                test.moderator?.ref ?? null,
                choices.filter(
                  (choice) => !sameRef(choice.ref, factor.grouping.variable),
                ),
                (ref) =>
                  set({
                    ...test,
                    moderator: {
                      ref,
                      transform:
                        findChoice(choices, ref)?.kind === 'numeric'
                          ? (test.moderator?.transform ?? 'none')
                          : 'none',
                    },
                  }),
              )}
              {findChoice(choices, test.moderator?.ref)?.kind === 'numeric' &&
                transformSegments(
                  'Moderator transform',
                  test.moderator?.transform ?? 'none',
                  (transform) =>
                    test.moderator &&
                    set({
                      ...test,
                      moderator: { ...test.moderator, transform },
                    }),
                )}
              <Hint t={t}>
                {findChoice(choices, test.moderator?.ref)?.kind ===
                'categorical'
                  ? 'Tests whether the group difference differs between the moderator levels.'
                  : 'Tests whether the slope on the moderator differs between groups.'}
              </Hint>
            </>
          )}
        </>
      )}
      {draft.tests.length > 1 && (
        <CheckRow
          checked={test.inFamily}
          disabled={lastInFamily}
          title={
            lastInFamily
              ? 'One or more tests stay in the correction family.'
              : undefined
          }
          label="In the family"
          onChange={(on) => set({ ...test, inFamily: on })}
        />
      )}
      {!test.inFamily && (
        <Hint t={t}>
          A sensitivity test outside the family: its rows have no corrected p.
        </Hint>
      )}
      {draft.tests.length > 1 && (
        <ExtraCovariates
          test={test}
          pool={covariateChoices.filter(
            (choice) =>
              !covariateKeys.has(choice.key) && !tested.has(choice.key),
          )}
          choices={[...choices, ...covariateChoices]}
          onChange={(extraCovariates) => set({ ...test, extraCovariates })}
        />
      )}
      {draft.tests.length > 1 && (
        <div>
          <Btn
            t={t}
            small
            ghost
            label="Remove test"
            ariaLabel={`Remove ${test.label}`}
            onClick={() => onChange(removeTest(draft, test.id, choices))}
          />
        </div>
      )}
    </>
  )
}

function ExtraCovariates({
  test,
  pool,
  choices,
  onChange,
}: {
  test: AnalysisTest
  pool: readonly VariableChoice[]
  choices: readonly VariableChoice[]
  onChange: (refs: VariableRefV2[]) => void
}): ReactNode {
  const { t } = useApp()
  const chosen = new Set(test.extraCovariates.map(refKey))
  const options = pool.filter((choice) => !chosen.has(choice.key))
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <span style={{ fontSize: 11, color: t.dim, fontFamily: FONTS.sans }}>
        Also adjust for
      </span>
      {test.extraCovariates.map((ref) => (
        <div
          key={refKey(ref)}
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontFamily: FONTS.sans,
              fontSize: 12,
              color: t.text,
              overflowWrap: 'anywhere',
            }}
          >
            {refLabel(ref, choices)}
          </span>
          <Btn
            t={t}
            small
            ghost
            label="Remove"
            ariaLabel={`Stop adjusting ${test.label} for ${refLabel(ref, choices)}`}
            onClick={() =>
              onChange(
                test.extraCovariates.filter(
                  (item) => refKey(item) !== refKey(ref),
                ),
              )
            }
          />
        </div>
      ))}
      {test.extraCovariates.length < MAX_TEST_COVARIATES ? (
        <select
          aria-label={`Add a covariate to ${test.label}`}
          value=""
          onChange={(event) => {
            const choice = options.find(
              (item) => item.key === event.target.value,
            )
            if (choice) onChange([...test.extraCovariates, choice.ref])
          }}
          style={{
            height: 'var(--ss-input-h)',
            width: '100%',
            minWidth: 0,
            padding: '0 6px',
            border: `1px solid ${t.dim}`,
            borderRadius: 4,
            background: t.bg,
            color: test.extraCovariates.length === 0 ? t.textSoft : t.text,
            fontFamily: FONTS.sans,
            fontSize: 11.5,
          }}
        >
          <option value="">
            {test.extraCovariates.length === 0
              ? 'Nothing beyond the shared covariates'
              : 'Add another covariate'}
          </option>
          {options.map((choice) => (
            <option key={choice.key} value={choice.key}>
              {choice.label}
            </option>
          ))}
        </select>
      ) : (
        <Hint t={t}>A test adds at most four covariates.</Hint>
      )}
    </div>
  )
}
