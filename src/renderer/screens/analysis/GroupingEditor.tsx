/**
 * Edit the groups of one grouping: name each group, assign each level of
 * the variable to a group (several levels merge into one group, as SCI_P
 * and SCI_nNP make SCI), add or remove groups, and group coded levels by
 * their first character (C5, C6, T4, L1 make C, T, and L).
 */

import type { ReactNode } from 'react'
import type { GroupingSpecV2 } from '../../../shared/group-analysis'
import { useApp } from '../../state/context'
import { Btn, FONTS, TextInput } from '../../ui'
import {
  MAX_GROUPS,
  assignLevel,
  firstCharacterHelps,
  groupByFirstCharacter,
  nextGroupLabel,
  renameInGrouping,
} from './draft-v2'
import type { VariableChoice } from './variables'

/** A group rename, so the caller can follow it (focal, reference, population). */
export interface GroupRename {
  from: string
  to: string
}

/** The grouping editor's inputs. */
export interface GroupingEditorProps {
  /** Name the grouping for assistive technology, for example "AIS groups". */
  name: string
  grouping: GroupingSpecV2
  choice: VariableChoice | undefined
  /** The included subjects of a group label, when the sample is resolved. */
  count?: ((label: string) => number | null) | undefined
  /** The fewest groups the editor keeps (removing stops there). */
  minGroups?: number
  onChange: (grouping: GroupingSpecV2, rename: GroupRename | null) => void
}

const NOT_USED = '\u0000not-used'

export function GroupingEditor({
  name,
  grouping,
  choice,
  count,
  minGroups = 2,
  onChange,
}: GroupingEditorProps): ReactNode {
  const { t } = useApp()
  const levels = choice?.levels ?? []
  const levelValues = levels.map((level) => level.value)
  // Levels the grouping names that the variable no longer has stay shown.
  for (const group of grouping.groups) {
    for (const level of group.levels) {
      if (!levelValues.includes(level)) levelValues.push(level)
    }
  }
  const owner = (level: string): string =>
    grouping.groups.find((group) => group.levels.includes(level))?.label ??
    NOT_USED
  const levelN = (value: string): number | null =>
    levels.find((level) => level.value === value)?.n ?? null
  const cell = {
    fontFamily: FONTS.sans,
    fontSize: 11,
    color: t.dimText,
    whiteSpace: 'nowrap',
  } as const
  return (
    <div role="group" aria-label={name} style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'grid', gap: 4 }}>
        {grouping.groups.map((group, index) => (
          <div
            key={index}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <TextInput
              t={t}
              value={group.label}
              ariaLabel={`Name of group ${index + 1}`}
              onChange={(value) => {
                const to = value.slice(0, 64)
                onChange(renameInGrouping(grouping, group.label, to), {
                  from: group.label,
                  to,
                })
              }}
            />
            {count && (
              <span style={cell} title="Included subjects in this group">
                n {count(group.label) ?? '\u2013'}
              </span>
            )}
            {grouping.groups.length > minGroups && (
              <Btn
                t={t}
                small
                ghost
                label="Remove"
                ariaLabel={`Remove group ${group.label}`}
                onClick={() =>
                  onChange(
                    {
                      ...grouping,
                      groups: grouping.groups.filter((_, i) => i !== index),
                    },
                    null,
                  )
                }
              />
            )}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {grouping.groups.length < MAX_GROUPS && (
          <Btn
            t={t}
            small
            ghost
            label="Add group"
            onClick={() =>
              onChange(
                {
                  ...grouping,
                  groups: [
                    ...grouping.groups,
                    { label: nextGroupLabel(grouping), levels: [] },
                  ],
                },
                null,
              )
            }
          />
        )}
        {firstCharacterHelps(levelValues) && (
          <Btn
            t={t}
            small
            ghost
            label="Group levels by first character"
            onClick={() =>
              onChange(groupByFirstCharacter(grouping, levelValues), null)
            }
          />
        )}
      </div>
      {levelValues.length > 0 && (
        <div
          role="group"
          aria-label={`Levels of ${name}`}
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
            alignItems: 'center',
            columnGap: 8,
            rowGap: 3,
            padding: '6px 8px',
            border: `1px solid ${t.borderSoft}`,
            borderRadius: 5,
            background: t.bg,
            maxHeight: 220,
            overflowY: 'auto',
          }}
        >
          {levelValues.map((value) => (
            <LevelRow
              key={value}
              value={value}
              n={levelN(value)}
              owner={owner(value)}
              groups={grouping.groups.map((group) => group.label)}
              onAssign={(target) =>
                onChange(
                  assignLevel(
                    grouping,
                    value,
                    target === NOT_USED ? null : target,
                  ),
                  null,
                )
              }
            />
          ))}
        </div>
      )}
    </div>
  )
}

function LevelRow({
  value,
  n,
  owner,
  groups,
  onAssign,
}: {
  value: string
  n: number | null
  owner: string
  groups: string[]
  onAssign: (target: string) => void
}): ReactNode {
  const { t } = useApp()
  return (
    <>
      <span
        style={{
          fontFamily: FONTS.sans,
          fontSize: 12,
          color: owner === NOT_USED ? t.dimText : t.text,
          overflowWrap: 'anywhere',
          minWidth: 0,
        }}
      >
        {value}
      </span>
      <span
        style={{
          fontFamily: FONTS.sans,
          fontSize: 11,
          color: t.dimText,
          textAlign: 'right',
        }}
      >
        {n ?? ''}
      </span>
      <select
        aria-label={`Group of ${value}`}
        value={owner}
        onChange={(event) => onAssign(event.target.value)}
        style={{
          height: 24,
          minWidth: 0,
          width: '100%',
          padding: '0 4px',
          border: `1px solid ${t.dim}`,
          borderRadius: 4,
          background: t.surface,
          color: t.text,
          fontFamily: FONTS.sans,
          fontSize: 11.5,
        }}
      >
        {groups.map((label, index) => (
          <option key={`${index}:${label}`} value={label}>
            {label || '(unnamed)'}
          </option>
        ))}
        <option value={NOT_USED}>Not used</option>
      </select>
    </>
  )
}
