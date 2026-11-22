/**
 * Subset rows: keep chosen levels of a categorical variable or a numeric
 * range, up to eight filters, applied before every test.
 */

import { useState, type ReactNode } from 'react'
import type {
  GroupAnalysisSpecV2,
  RangeKeep,
} from '../../../shared/group-analysis'
import { useApp } from '../../state/context'
import { Btn, Field, FONTS, TextInput } from '../../ui'
import { CheckRow } from './controls'
import {
  MAX_SUBSET_FILTERS,
  addSubsetFilter,
  setSubsetFilter,
} from './draft-v2'
import { findChoice, refKey, refLabel, type VariableChoice } from './variables'

/** The subset filters' inputs. */
export interface SubsetFiltersProps {
  draft: GroupAnalysisSpecV2
  choices: readonly VariableChoice[]
  onChange: (next: GroupAnalysisSpecV2) => void
}

export function SubsetFilters({
  draft,
  choices,
  onChange,
}: SubsetFiltersProps): ReactNode {
  const { t } = useApp()
  const used = new Set(draft.design.subset.map((f) => refKey(f.variable)))
  const pool = choices.filter((choice) => !used.has(choice.key))
  return (
    <div
      role="group"
      aria-label="Subset rows"
      style={{ display: 'grid', gap: 6 }}
    >
      {draft.design.subset.map((filter, index) => {
        const choice = findChoice(choices, filter.variable)
        const label = refLabel(filter.variable, choices)
        return (
          <div
            key={refKey(filter.variable)}
            style={{
              display: 'grid',
              gap: 4,
              padding: '6px 8px',
              border: `1px solid ${t.borderSoft}`,
              borderRadius: 5,
              background: t.bg,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontFamily: FONTS.sans,
                  fontSize: 12,
                  fontWeight: 600,
                  color: t.text,
                  overflowWrap: 'anywhere',
                }}
              >
                Keep {label}
              </span>
              <Btn
                t={t}
                small
                ghost
                label="Remove"
                ariaLabel={`Remove the filter on ${label}`}
                onClick={() => onChange(setSubsetFilter(draft, index, null))}
              />
            </div>
            {'levels' in filter.keep ? (
              <div role="group" aria-label={`Levels of ${label} to keep`}>
                {(
                  choice?.levels.map((level) => level.value) ??
                  filter.keep.levels
                ).map((level) => {
                  const kept = 'levels' in filter.keep ? filter.keep.levels : []
                  const on = kept.includes(level)
                  return (
                    <CheckRow
                      key={level}
                      checked={on}
                      disabled={on && kept.length === 1}
                      title={
                        on && kept.length === 1
                          ? 'A filter keeps one or more levels.'
                          : undefined
                      }
                      label={level}
                      trailing={
                        choice?.levels.find((item) => item.value === level)
                          ?.n ?? undefined
                      }
                      onChange={(checked) =>
                        onChange(
                          setSubsetFilter(draft, index, {
                            levels: checked
                              ? [...kept, level]
                              : kept.filter((value) => value !== level),
                          }),
                        )
                      }
                    />
                  )
                })}
              </div>
            ) : (
              <RangeFields
                label={label}
                keep={filter.keep}
                onChange={(keep) =>
                  onChange(setSubsetFilter(draft, index, keep))
                }
              />
            )}
          </div>
        )
      })}
      {draft.design.subset.length < MAX_SUBSET_FILTERS && pool.length > 0 && (
        <select
          aria-label="Add a subset filter"
          value=""
          onChange={(event) => {
            const choice = pool.find((item) => item.key === event.target.value)
            if (choice) onChange(addSubsetFilter(draft, choice))
          }}
          style={{
            height: 'var(--ss-input-h)',
            width: '100%',
            minWidth: 0,
            padding: '0 6px',
            border: `1px solid ${t.dim}`,
            borderRadius: 4,
            background: t.bg,
            color: t.textSoft,
            fontFamily: FONTS.sans,
            fontSize: 11.5,
          }}
        >
          <option value="">
            {draft.design.subset.length === 0
              ? 'Every row; add a filter'
              : 'Add another filter'}
          </option>
          {pool.map((choice) => (
            <option key={choice.key} value={choice.key}>
              {choice.label}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

function RangeFields({
  label,
  keep,
  onChange,
}: {
  label: string
  keep: RangeKeep
  onChange: (keep: RangeKeep) => void
}): ReactNode {
  const { t } = useApp()
  const [text, setText] = useState({
    min: keep.min === null ? '' : String(keep.min),
    max: keep.max === null ? '' : String(keep.max),
  })
  const parse = (value: string): number | null | undefined => {
    if (value.trim() === '') return null
    const number = Number(value)
    return Number.isFinite(number) ? number : undefined
  }
  const field = (bound: 'min' | 'max') => {
    const parsed = parse(text[bound])
    return (
      <Field
        t={t}
        label={bound === 'min' ? 'At least' : 'At most'}
        {...(parsed === undefined ? { error: 'Use a number.' } : {})}
      >
        <TextInput
          t={t}
          value={text[bound]}
          ariaLabel={`${label} ${bound === 'min' ? 'at least' : 'at most'}`}
          invalid={parsed === undefined}
          placeholder="Open"
          onChange={(value) => {
            setText((current) => ({ ...current, [bound]: value }))
            const next = parse(value)
            if (next !== undefined) onChange({ ...keep, [bound]: next })
          }}
        />
      </Field>
    )
  }
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
        gap: 8,
      }}
    >
      {field('min')}
      {field('max')}
    </div>
  )
}
