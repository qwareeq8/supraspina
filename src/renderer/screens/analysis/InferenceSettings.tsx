/**
 * Set inference: sidedness (two-sided only, with its reason, when any test
 * is an F test), the multiple-comparison correction and a family that
 * follows the design, alpha, the permutation count and seed, and the
 * compute-time estimate.
 */

import { useState, type ReactNode } from 'react'
import type {
  Correction,
  CorrectionFamilyV2,
  GroupAnalysisSpecV2,
  PermutationCount,
  Sidedness,
} from '../../../shared/group-analysis'
import { CORRECTION_LABEL } from '../../figures/format'
import { useApp } from '../../state/context'
import { randomSeed } from '../../state/group-analysis'
import { Btn, Field, Hint, Segments, TextInput } from '../../ui'
import { SelectField } from './controls'
import { FAMILY_TEXT, computeEstimate } from './describe'
import { mixedRanks, normalizeDraft, sidednessLock } from './draft-v2'
import type { VariableChoice } from './variables'

/** The inference controls' inputs. */
export interface InferenceSettingsProps {
  draft: GroupAnalysisSpecV2
  /** The variable choices, for a categorical moderator's levels. */
  choices: readonly VariableChoice[]
  onChange: (next: GroupAnalysisSpecV2) => void
}

export function InferenceSettings({
  draft,
  choices,
  onChange,
}: InferenceSettingsProps): ReactNode {
  const { t } = useApp()
  const { inference, tests } = draft
  const set = (patch: Partial<GroupAnalysisSpecV2['inference']>) =>
    onChange(
      normalizeDraft(
        { ...draft, inference: { ...inference, ...patch } },
        choices,
      ),
    )
  const [alphaText, setAlphaText] = useState(String(inference.alpha))
  const [seedText, setSeedText] = useState(String(inference.seed))
  const [shownAlpha, setShownAlpha] = useState(inference.alpha)
  const [shownSeed, setShownSeed] = useState(inference.seed)
  // Follow a draft replaced from outside, such as a loaded saved analysis.
  if (shownAlpha !== inference.alpha) {
    setShownAlpha(inference.alpha)
    if (Number(alphaText) !== inference.alpha)
      setAlphaText(String(inference.alpha))
  }
  if (shownSeed !== inference.seed) {
    setShownSeed(inference.seed)
    if (Number(seedText) !== inference.seed) setSeedText(String(inference.seed))
  }
  const alpha = Number(alphaText)
  const alphaError =
    alphaText.trim() === '' ||
    !Number.isFinite(alpha) ||
    alpha < 0.001 ||
    alpha > 0.2
      ? 'Use an alpha from 0.001 to 0.2.'
      : undefined
  const seed = Number(seedText)
  const seedError =
    !/^\d+$/.test(seedText.trim()) || seed > 4_294_967_295
      ? 'Use a whole number from 0 to 4294967295.'
      : undefined
  const single = tests.length === 1 ? tests[0]! : null
  const focal =
    single?.kind === 'two-group' ? (single.factor?.focal ?? null) : null
  const slopes = tests.every((test) => test.kind === 'association')
  const lock = sidednessLock(draft, choices)
  const maxT = inference.correction === 'maxt-fwe'
  const mixed = mixedRanks(draft)
  const families: CorrectionFamilyV2[] =
    tests.length === 1
      ? ['all-tests', 'per-measure-family']
      : [
          'all-tests',
          'per-test',
          'per-measure-family',
          'per-test-and-measure-family',
        ]
  return (
    <>
      <Segments
        t={t}
        small
        ariaLabel="Sidedness"
        value={inference.sidedness}
        disabledOptions={lock ? ['lower', 'higher'] : []}
        options={[
          { value: 'two-sided', label: 'Two-sided' },
          {
            value: 'lower',
            label: focal
              ? `Lower in ${focal}`
              : slopes
                ? 'Negative slope'
                : 'Lower',
          },
          {
            value: 'higher',
            label: focal
              ? `Higher in ${focal}`
              : slopes
                ? 'Positive slope'
                : 'Higher',
          },
        ]}
        onChange={(value) => set({ sidedness: value as Sidedness })}
      />
      {lock && <Hint t={t}>{lock}</Hint>}
      <SelectField
        label="Correction"
        value={inference.correction}
        options={(Object.keys(CORRECTION_LABEL) as Correction[]).map((c) => ({
          value: c,
          label: CORRECTION_LABEL[c],
        }))}
        onChange={(value) => {
          const correction = value as Correction
          set({
            correction,
            ...(correction === 'maxt-fwe' && inference.permutations === 0
              ? { permutations: 5000 }
              : {}),
          })
        }}
      />
      {inference.correction !== 'none' &&
        (tests.length === 1 ? (
          <Segments
            t={t}
            small
            ariaLabel="Correction family"
            value={
              inference.family === 'per-measure-family' ||
              inference.family === 'per-test-and-measure-family'
                ? 'per-measure-family'
                : 'all-tests'
            }
            options={[
              { value: 'all-tests', label: 'The selected measures' },
              { value: 'per-measure-family', label: 'Each measure family' },
            ]}
            onChange={(value) => set({ family: value as CorrectionFamilyV2 })}
          />
        ) : (
          <SelectField
            label="Correct over"
            value={inference.family}
            hint={
              maxT && mixed
                ? 'Max-T cannot pool t and F tests; choose Holm, Bonferroni, or BH-FDR to correct them together.'
                : undefined
            }
            options={families.map((family) => ({
              value: family,
              label: FAMILY_TEXT[family],
              disabled: family === 'all-tests' && maxT && mixed,
            }))}
            onChange={(value) => set({ family: value as CorrectionFamilyV2 })}
          />
        ))}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '84px minmax(0, 1fr)',
          gap: 8,
          alignItems: 'start',
        }}
      >
        <Field
          t={t}
          label="Alpha"
          {...(alphaError ? { error: alphaError } : {})}
        >
          <TextInput
            t={t}
            mono
            value={alphaText}
            invalid={alphaError !== undefined}
            onChange={(value) => {
              setAlphaText(value)
              const next = Number(value)
              if (
                value.trim() !== '' &&
                Number.isFinite(next) &&
                next >= 0.001 &&
                next <= 0.2
              ) {
                setShownAlpha(next)
                set({ alpha: next })
              }
            }}
          />
        </Field>
        <Field t={t} label="Seed" {...(seedError ? { error: seedError } : {})}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <TextInput
              t={t}
              mono
              value={seedText}
              invalid={seedError !== undefined}
              onChange={(value) => {
                setSeedText(value)
                const next = Number(value)
                if (/^\d+$/.test(value.trim()) && next <= 4_294_967_295) {
                  setShownSeed(next)
                  set({ seed: next })
                }
              }}
            />
            <Btn
              t={t}
              small
              ghost
              label="New"
              ariaLabel="Draw a new seed"
              onClick={() => {
                const next = randomSeed()
                setSeedText(String(next))
                setShownSeed(next)
                set({ seed: next })
              }}
            />
          </div>
        </Field>
      </div>
      <div style={{ display: 'grid', gap: 4 }}>
        <span style={{ fontSize: 11, color: t.dim }}>Permutations</span>
        <Segments
          t={t}
          small
          ariaLabel="Permutations"
          value={String(inference.permutations)}
          disabledOptions={maxT ? ['0'] : []}
          options={[
            { value: '0', label: 'None' },
            { value: '1000', label: '1000' },
            { value: '5000', label: '5000' },
            { value: '10000', label: '10000' },
          ]}
          onChange={(value) =>
            set({ permutations: Number(value) as PermutationCount })
          }
        />
      </div>
      <Hint t={t}>
        Compute takes{' '}
        {computeEstimate(
          draft.measures.length *
            tests.length *
            Math.max(1, draft.stratify?.grouping.groups.length ?? 1),
          inference.permutations,
        )}
        .
      </Hint>
    </>
  )
}
