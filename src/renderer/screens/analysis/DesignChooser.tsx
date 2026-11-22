/**
 * Choose the design: between groups (one comparison of the groups of a
 * variable, as SCI vs CTRL, three or more groups, or a slope difference)
 * or within a group (a population such as SCI, then a list of tests).
 * Both take subset filters, optional strata, and variables added from an
 * imported table or derived from others.
 */

import { useState, type ReactNode } from 'react'
import type {
  AnalysisScope,
  AnalysisVariableTable,
  GroupAnalysisInputs,
  GroupAnalysisSpecV2,
} from '../../../shared/group-analysis'
import { useApp } from '../../state/context'
import { Btn, FONTS, Hint, Segments, Toggle } from '../../ui'
import { CheckRow, SelectField, SubHeading } from './controls'
import {
  addDerived,
  draftUses,
  removeDerived,
  withPopulationVariable,
  withScope,
  withStratify,
} from './draft-v2'
import { GroupingEditor } from './GroupingEditor'
import { SubsetFilters } from './SubsetFilters'
import { TestList } from './TestList'
import { DerivedDialog, ImportVariablesDialog } from './VariableDialogs'
import { derivedText } from './rail-text'
import { findChoice, refKey, sameRef, type VariableChoice } from './variables'

/** The design chooser's inputs. */
export interface DesignChooserProps {
  draft: GroupAnalysisSpecV2
  choices: readonly VariableChoice[]
  covariateChoices: readonly VariableChoice[]
  tables: readonly AnalysisVariableTable[]
  inputs: GroupAnalysisInputs | null
  busy: boolean
  onChange: (next: GroupAnalysisSpecV2) => void
  onImportVariables: () => Promise<AnalysisVariableTable | null>
  onRemoveVariables: (tableId: string) => Promise<boolean>
}

export function DesignChooser({
  draft,
  choices,
  covariateChoices,
  tables,
  inputs,
  busy,
  onChange,
  onImportVariables,
  onRemoveVariables,
}: DesignChooserProps): ReactNode {
  const { t } = useApp()
  const [dialog, setDialog] = useState<null | 'derive' | 'import'>(null)
  const scope = draft.design.scope
  const categorical = choices.filter(
    (choice) => choice.kind === 'categorical' && choice.levels.length >= 1,
  )
  return (
    <>
      <Segments
        t={t}
        small
        ariaLabel="Design"
        value={scope}
        options={[
          {
            value: 'between',
            label: 'Between groups',
            title:
              'Compare adjusted measures between the groups of a variable.',
          },
          {
            value: 'within',
            label: 'Within a group',
            title:
              'Run tests inside one population, such as subgroups or clinical scores.',
          },
        ]}
        onChange={(value) =>
          onChange(withScope(draft, value as AnalysisScope, choices))
        }
      />
      {scope === 'within' && (
        <PopulationPicker
          draft={draft}
          categorical={categorical}
          inputs={inputs}
          onChange={onChange}
        />
      )}
      {scope === 'within' && <SubHeading>Tests</SubHeading>}
      <TestList
        draft={draft}
        choices={choices}
        covariateChoices={covariateChoices}
        inputs={inputs}
        onChange={onChange}
      />
      <SubHeading>Subset rows</SubHeading>
      <SubsetFilters draft={draft} choices={choices} onChange={onChange} />
      <SubHeading>Stratify by</SubHeading>
      <SelectField
        label="Strata from"
        value={draft.stratify ? refKey(draft.stratify.grouping.variable) : ''}
        options={[
          { value: '', label: 'No strata' },
          ...categorical
            .filter(
              (choice) =>
                !sameRef(
                  choice.ref,
                  draft.design.population?.grouping.variable,
                ),
            )
            .map((choice) => ({ value: choice.key, label: choice.label })),
        ]}
        onChange={(key) =>
          onChange(
            withStratify(
              draft,
              categorical.find((choice) => choice.key === key) ?? null,
            ),
          )
        }
      />
      {draft.stratify && (
        <>
          <GroupingEditor
            name="Strata"
            grouping={draft.stratify.grouping}
            choice={findChoice(choices, draft.stratify.grouping.variable)}
            onChange={(grouping) =>
              onChange({
                ...draft,
                stratify: { ...draft.stratify!, grouping },
              })
            }
          />
          <Toggle
            t={t}
            checked={draft.stratify.heterogeneity}
            label="Test whether effects differ between strata"
            onChange={(on) =>
              onChange({
                ...draft,
                stratify: { ...draft.stratify!, heterogeneity: on },
              })
            }
          />
          <Hint t={t}>
            Every test runs in each stratum with its own centering
            {draft.stratify.heterogeneity
              ? '; the heterogeneity test is a pooled test-by-stratum interaction.'
              : '.'}
          </Hint>
        </>
      )}
      <SubHeading>Variables</SubHeading>
      <VariablesSummary
        draft={draft}
        choices={choices}
        tables={tables}
        onChange={onChange}
      />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Btn
          t={t}
          small
          label="Import table..."
          title="The registry and the metadata CSVs provide the variables. Import a table or derive a variable to add more."
          disabled={busy}
          onClick={() => setDialog('import')}
        />
        <Btn
          t={t}
          small
          label="Derive..."
          disabled={draft.variables.derived.length >= 16}
          onClick={() => setDialog('derive')}
        />
      </div>
      {dialog === 'derive' && (
        <DerivedDialog
          draft={draft}
          choices={choices}
          onDismiss={() => setDialog(null)}
          onAdd={(item) => {
            setDialog(null)
            onChange(addDerived(draft, item))
          }}
        />
      )}
      {dialog === 'import' && (
        <ImportVariablesDialog
          draft={draft}
          tables={tables}
          busy={busy}
          onImport={onImportVariables}
          onRemove={onRemoveVariables}
          onDismiss={() => setDialog(null)}
        />
      )}
    </>
  )
}

function PopulationPicker({
  draft,
  categorical,
  inputs,
  onChange,
}: {
  draft: GroupAnalysisSpecV2
  categorical: readonly VariableChoice[]
  inputs: GroupAnalysisInputs | null
  onChange: (next: GroupAnalysisSpecV2) => void
}): ReactNode {
  const { t } = useApp()
  const population = draft.design.population
  const setPopulation = (next: NonNullable<typeof population>) =>
    onChange({ ...draft, design: { ...draft.design, population: next } })
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <SubHeading>Population</SubHeading>
      <SelectField
        label="Population from"
        value={population ? refKey(population.grouping.variable) : ''}
        options={[
          ...(population ? [] : [{ value: '', label: 'Choose a variable' }]),
          ...categorical.map((choice) => ({
            value: choice.key,
            label: choice.label,
          })),
        ]}
        onChange={(key) => {
          const choice = categorical.find((item) => item.key === key)
          if (choice) onChange(withPopulationVariable(draft, choice))
        }}
      />
      {population && (
        <>
          <GroupingEditor
            name="Population groups"
            grouping={population.grouping}
            choice={findChoice(categorical, population.grouping.variable)}
            minGroups={1}
            onChange={(grouping, rename) =>
              setPopulation({
                grouping,
                groups: population.groups
                  .map((label) =>
                    rename && label === rename.from ? rename.to : label,
                  )
                  .filter((label) =>
                    grouping.groups.some((group) => group.label === label),
                  ),
              })
            }
          />
          <div role="group" aria-label="Groups in the population">
            {population.grouping.groups.map((group) => {
              const on = population.groups.includes(group.label)
              return (
                <CheckRow
                  key={group.label}
                  checked={on}
                  disabled={on && population.groups.length === 1}
                  {...(on && population.groups.length === 1
                    ? { title: 'The population needs at least one group.' }
                    : {})}
                  label={`Test within ${group.label}`}
                  onChange={(checked) =>
                    setPopulation({
                      ...population,
                      groups: checked
                        ? [...population.groups, group.label]
                        : population.groups.filter(
                            (label) => label !== group.label,
                          ),
                    })
                  }
                />
              )
            })}
          </div>
          {inputs && (
            <span
              aria-live="polite"
              style={{ fontFamily: FONTS.sans, fontSize: 12, color: t.text }}
            >
              <strong style={{ fontWeight: 600 }}>{inputs.included}</strong>{' '}
              {inputs.included === 1 ? 'subject' : 'subjects'} in{' '}
              {population.groups.join(' + ') || 'the population'}
            </span>
          )}
        </>
      )}
    </div>
  )
}

function VariablesSummary({
  draft,
  choices,
  tables,
  onChange,
}: {
  draft: GroupAnalysisSpecV2
  choices: readonly VariableChoice[]
  tables: readonly AnalysisVariableTable[]
  onChange: (next: GroupAnalysisSpecV2) => void
}): ReactNode {
  const { t } = useApp()
  const derived = draft.variables.derived
  if (tables.length === 0 && derived.length === 0) {
    return null
  }
  return (
    <div style={{ display: 'grid', gap: 3 }}>
      {tables.map((table) => (
        <span
          key={table.tableId}
          style={{ fontFamily: FONTS.sans, fontSize: 12, color: t.text }}
        >
          {table.name}{' '}
          <span style={{ color: t.dimText }}>
            ({table.columns.length}{' '}
            {table.columns.length === 1 ? 'variable' : 'variables'})
          </span>
        </span>
      ))}
      {derived.map((item) => {
        const used =
          draftUses(
            { ...draft, variables: { derived: [] } },
            (ref) => ref.source === 'derived' && ref.column === item.id,
          ) ||
          derived.some(
            (other) =>
              other.id !== item.id &&
              other.inputs.some(
                (ref) => ref.source === 'derived' && ref.column === item.id,
              ),
          )
        return (
          <div
            key={item.id}
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
              {item.label}{' '}
              <span style={{ color: t.dimText }}>
                = {derivedText(item, choices)}
              </span>
            </span>
            <Btn
              t={t}
              small
              ghost
              label="Remove"
              ariaLabel={`Remove the derived variable ${item.label}`}
              disabled={used}
              title={used ? 'The analysis uses this variable.' : undefined}
              onClick={() => onChange(removeDerived(draft, item.id))}
            />
          </div>
        )
      })}
    </div>
  )
}
