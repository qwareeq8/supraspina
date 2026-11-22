/**
 * Include subjects: the QC, surface-registration, and outlier rules, the
 * smallest cell a test may model, the live count of included subjects, and
 * a disclosure listing who is out and why.
 */

import { useState, type ReactNode } from 'react'
import type {
  GroupAnalysisInputs,
  GroupAnalysisSpecV2,
  InclusionSpecV2,
} from '../../../shared/group-analysis'
import type { Load } from '../../state/group-analysis'
import { useApp } from '../../state/context'
import { Btn, FONTS, Hint } from '../../ui'
import { SelectField } from './controls'
import { EXCLUSION_TEXT } from './describe'
import { smallestCellHint } from './rail-text'

/** The inclusion controls' inputs. */
export interface InclusionRulesProps {
  draft: GroupAnalysisSpecV2
  inputs: Load<GroupAnalysisInputs> | null
  onChange: (next: GroupAnalysisSpecV2) => void
}

export function InclusionRules({
  draft,
  inputs,
  onChange,
}: InclusionRulesProps): ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const set = (patch: Partial<InclusionSpecV2>) =>
    onChange({ ...draft, inclusion: { ...draft.inclusion, ...patch } })
  const sample = inputs?.phase === 'ready' ? inputs.value : null
  const excluded = sample?.subjects.filter((s) => !s.included) ?? []
  const flagged =
    sample?.subjects.filter((s) => s.missingHemispheres.length > 0).length ?? 0
  return (
    <>
      <SelectField
        label="QC verdict"
        value={draft.inclusion.qc}
        options={[
          { value: 'non-failed', label: 'Non-failed (the analysis cohort)' },
          { value: 'passed', label: 'QC Pass only' },
          { value: 'all', label: 'Every reconstructed subject' },
        ]}
        onChange={(value) => set({ qc: value as InclusionSpecV2['qc'] })}
      />
      <SelectField
        label="Surface-registration flags"
        value={draft.inclusion.registration}
        hint={
          sample
            ? `${flagged} ${flagged === 1 ? 'subject has' : 'subjects have'} a flagged hemisphere, whose cortical measures the rule applies to${sample.registrationProvisional ? '; the check has not judged every hemisphere yet' : ''}.`
            : undefined
        }
        options={[
          {
            value: 'set-missing',
            label: 'Set flagged hemispheres missing',
          },
          { value: 'exclude-subject', label: 'Exclude flagged subjects' },
          { value: 'keep', label: 'Keep' },
        ]}
        onChange={(value) =>
          set({ registration: value as InclusionSpecV2['registration'] })
        }
      />
      <SelectField
        label="ENIGMA outlier flags"
        value={draft.inclusion.outliers}
        options={[
          { value: 'keep', label: 'Keep' },
          { value: 'set-missing', label: 'Set the flagged measure missing' },
          { value: 'exclude-subject', label: 'Exclude flagged subjects' },
        ]}
        onChange={(value) =>
          set({ outliers: value as InclusionSpecV2['outliers'] })
        }
      />
      <SelectField
        label="Smallest cell"
        value={String(draft.inclusion.minCellN)}
        hint={smallestCellHint(sample, draft.inclusion.minCellN)}
        options={Array.from({ length: 19 }, (_, index) => {
          const n = index + 2
          return { value: String(n), label: `${n} subjects` }
        })}
        onChange={(value) => set({ minCellN: Number(value) })}
      />
      <div
        aria-live="polite"
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          fontFamily: FONTS.sans,
          fontSize: 12,
          color: t.text,
        }}
      >
        {sample ? (
          <span>
            <strong style={{ fontWeight: 600 }}>{sample.included}</strong> of{' '}
            {sample.subjects.length} subjects included
            {sample.groups.length > 0 && (
              <span style={{ color: t.dimText }}>
                {' '}
                ({sample.groups.map((g) => `${g.label} ${g.n}`).join(', ')})
              </span>
            )}
          </span>
        ) : inputs?.phase === 'error' ? (
          <span style={{ color: t.failed }}>{inputs.message}</span>
        ) : (
          <span style={{ color: t.dimText }}>Resolving the sample...</span>
        )}
      </div>
      {excluded.length > 0 && (
        <div>
          <Btn
            t={t}
            small
            ghost
            label={`${excluded.length} left out`}
            ariaExpanded={open}
            ariaControls="analysis-excluded-list"
            onClick={() => setOpen((v) => !v)}
          />
          {open && (
            <ul
              id="analysis-excluded-list"
              style={{
                listStyle: 'none',
                margin: '4px 0 0',
                padding: '4px 8px',
                maxHeight: 160,
                overflowY: 'auto',
                border: `1px solid ${t.borderSoft}`,
                borderRadius: 4,
                background: t.bg,
                fontSize: 11.5,
                fontFamily: FONTS.sans,
              }}
            >
              {excluded.map((s) => (
                <li
                  key={s.subjectId}
                  style={{ display: 'flex', gap: 8, padding: '2px 0' }}
                >
                  <span style={{ fontFamily: FONTS.mono, color: t.text }}>
                    {s.subjectId}
                  </span>
                  <span style={{ color: t.dimText }}>
                    {s.reason ? EXCLUSION_TEXT[s.reason] : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {sample?.skippedMeasures.length ? (
        <Hint t={t}>
          {sample.skippedMeasures.length} selected{' '}
          {sample.skippedMeasures.length === 1 ? 'measure is' : 'measures are'}{' '}
          skipped: {sample.skippedMeasures[0]!.reason}
        </Hint>
      ) : null}
    </>
  )
}
