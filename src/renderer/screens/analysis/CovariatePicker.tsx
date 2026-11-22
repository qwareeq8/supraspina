/**
 * Adjust for covariates: age and sex, the head-size covariate (eTIV, sTIV,
 * SynthSeg TIV, or none) and the measures it applies to, and other shared
 * covariates (variables, or measures such as the whole brainstem).
 * Covariates are centered on the sample mean.
 */

import type { ReactNode } from 'react'
import type {
  GroupAnalysisCatalog,
  GroupAnalysisSpecV2,
  HeadSizeSource,
  VariableRefV2,
} from '../../../shared/group-analysis'
import { useApp } from '../../state/context'
import { Btn, FONTS, Hint, Segments } from '../../ui'
import { CheckRow, SelectField, SubHeading } from './controls'
import { HEAD_SIZE_TEXT } from './describe'
import { MAX_EXTRA_COVARIATES } from './draft-v2'
import { refKey, refLabel, type VariableChoice } from './variables'
import { unavailableHeadSizes } from './rail-text'

/** The covariate picker's inputs. */
export interface CovariatePickerProps {
  draft: GroupAnalysisSpecV2
  catalog: GroupAnalysisCatalog
  choices: readonly VariableChoice[]
  /** The measures that may serve as covariates. */
  measureChoices: readonly VariableChoice[]
  onChange: (next: GroupAnalysisSpecV2) => void
}

export function CovariatePicker({
  draft,
  catalog,
  choices,
  measureChoices,
  onChange,
}: CovariatePickerProps): ReactNode {
  const { t } = useApp()
  const { covariates } = draft
  const tested = new Set(
    draft.tests.flatMap((test) =>
      [test.factor?.grouping.variable, test.variable?.ref, test.moderator?.ref]
        .filter((ref): ref is VariableRefV2 => Boolean(ref))
        .map(refKey),
    ),
  )
  const set = (patch: Partial<GroupAnalysisSpecV2['covariates']>) =>
    onChange({ ...draft, covariates: { ...covariates, ...patch } })
  const refFor = (key: string): VariableRefV2 | null =>
    choices.find((choice) => choice.key === key)?.ref ?? null
  const used = new Set([refKey(covariates.age), refKey(covariates.sex)])
  const extraKeys = new Set(covariates.extra.map(refKey))
  const full = covariates.extra.length >= MAX_EXTRA_COVARIATES
  const others = choices.filter((choice) => !used.has(choice.key))
  const missing = unavailableHeadSizes(catalog)
  const head = covariates.headSize
  const measureExtras = covariates.extra.filter(
    (ref) => ref.source === 'measure',
  )
  const measurePool = measureChoices.filter(
    (choice) => !extraKeys.has(choice.key),
  )
  const disabledHead = (Object.keys(missing) as HeadSizeSource[]).filter(
    (source) => source !== head.source,
  )
  return (
    <>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
          gap: 8,
        }}
      >
        <SelectField
          label="Age"
          value={refKey(covariates.age)}
          options={[
            { value: '', label: 'Not adjusted' },
            ...choices
              .filter(
                (choice) =>
                  choice.kind === 'numeric' && /age/i.test(choice.label),
              )
              .map((choice) => ({
                value: choice.key,
                label: choice.label,
                disabled: tested.has(choice.key),
              })),
          ]}
          onChange={(key) =>
            set({
              age: refFor(key),
              extra: covariates.extra.filter((ref) => refKey(ref) !== key),
            })
          }
        />
        <SelectField
          label="Sex"
          value={refKey(covariates.sex)}
          options={[
            { value: '', label: 'Not adjusted' },
            ...choices
              .filter(
                (choice) =>
                  choice.kind === 'categorical' &&
                  /sex|gender/i.test(choice.label),
              )
              .map((choice) => ({
                value: choice.key,
                label: choice.label,
                disabled: tested.has(choice.key),
              })),
          ]}
          onChange={(key) =>
            set({
              sex: refFor(key),
              extra: covariates.extra.filter((ref) => refKey(ref) !== key),
            })
          }
        />
      </div>
      <div style={{ display: 'grid', gap: 4 }}>
        <span style={{ fontSize: 11, color: t.dim, fontFamily: FONTS.sans }}>
          Head size
        </span>
        <Segments
          t={t}
          small
          ariaLabel="Head size"
          value={head.source}
          disabledOptions={disabledHead}
          options={(Object.keys(HEAD_SIZE_TEXT) as HeadSizeSource[]).map(
            (source) => ({ value: source, label: HEAD_SIZE_TEXT[source] }),
          )}
          onChange={(value) =>
            set({ headSize: { ...head, source: value as HeadSizeSource } })
          }
        />
        {head.source !== 'none' && (
          <Segments
            t={t}
            small
            ariaLabel="Head size applies to"
            value={head.rule}
            options={[
              { value: 'extensive', label: 'Volumes and areas' },
              { value: 'all', label: 'All measures' },
            ]}
            onChange={(value) =>
              set({
                headSize: { ...head, rule: value as 'extensive' | 'all' },
              })
            }
          />
        )}
        {head.source !== 'none' && missing[head.source] ? (
          <Hint t={t} style={{ color: t.warning }}>
            {missing[head.source]}
          </Hint>
        ) : disabledHead.length > 0 ? (
          <Hint t={t}>
            {disabledHead
              .map((source) => `${HEAD_SIZE_TEXT[source]}: ${missing[source]}`)
              .join(' ')}
          </Hint>
        ) : null}
      </div>
      <SubHeading>Other covariates</SubHeading>
      <div
        role="group"
        aria-label="Other covariates"
        style={{
          display: 'grid',
          maxHeight: 168,
          overflowY: 'auto',
          padding: '2px 8px',
          border: `1px solid ${t.borderSoft}`,
          borderRadius: 4,
          background: t.bg,
        }}
      >
        {others.map((choice) => {
          const on = extraKeys.has(choice.key)
          const blocked = tested.has(choice.key)
          return (
            <CheckRow
              key={choice.key}
              checked={on}
              disabled={(!on && full) || (!on && blocked)}
              title={blocked ? 'A test tests this variable.' : undefined}
              label={choice.label}
              trailing={choice.n === null ? undefined : `n ${choice.n}`}
              onChange={(checked) =>
                set({
                  extra: checked
                    ? [...covariates.extra, choice.ref]
                    : covariates.extra.filter(
                        (ref) => refKey(ref) !== choice.key,
                      ),
                })
              }
            />
          )
        })}
      </div>
      {measureExtras.map((ref) => (
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
            }}
          >
            {refLabel(ref, measureChoices)}
          </span>
          <Btn
            t={t}
            small
            ghost
            label="Remove"
            ariaLabel={`Stop adjusting for ${refLabel(ref, measureChoices)}`}
            onClick={() =>
              set({
                extra: covariates.extra.filter(
                  (item) => refKey(item) !== refKey(ref),
                ),
              })
            }
          />
        </div>
      ))}
      {!full && measurePool.length > 0 && (
        <SelectField
          label="Adjust for a measure"
          value=""
          options={[
            { value: '', label: 'No measure covariate' },
            ...measurePool.map((choice) => ({
              value: choice.key,
              label: choice.label,
            })),
          ]}
          onChange={(key) => {
            const choice = measurePool.find((item) => item.key === key)
            if (choice) set({ extra: [...covariates.extra, choice.ref] })
          }}
        />
      )}
      <Hint t={t}>Covariates are centered on the sample mean.</Hint>
    </>
  )
}
