/** Renders the shared subject-folder and T1-file matching rule fields. */

import type { ReactNode } from 'react'
import { Field, TextInput, type Theme } from '../ui'
import { patternError } from './matching-rules'

/** The two editable matching patterns and their change handlers. */
export interface MatchingRuleFieldsProps {
  t: Theme
  subjectGlob: string
  onSubjectGlob: (value: string) => void
  t1Pattern: string
  onT1Pattern: (value: string) => void
  /** Show validation errors beneath invalid patterns. */
  validate?: boolean
}

/** Edit the subject folder and T1 file name patterns. */
export function MatchingRuleFields({
  t,
  subjectGlob,
  onSubjectGlob,
  t1Pattern,
  onT1Pattern,
  validate = false,
}: MatchingRuleFieldsProps): ReactNode {
  const subjectError = validate ? patternError(subjectGlob) : null
  const t1Error = validate ? patternError(t1Pattern) : null
  return (
    <>
      <Field
        t={t}
        label="Subject folder name pattern"
        hint="Matches folders inside the input data folder, for example participant-*."
        {...(subjectError ? { error: subjectError } : {})}
      >
        <TextInput
          t={t}
          value={subjectGlob}
          onChange={onSubjectGlob}
          mono
          placeholder="sub-*"
          ariaLabel="Subject folder name pattern"
          invalid={subjectError !== null}
        />
      </Field>
      <Field
        t={t}
        label="T1 file name pattern"
        hint="Matches T1 files inside each subject folder, including its subfolders."
        {...(t1Error ? { error: t1Error } : {})}
      >
        <TextInput
          t={t}
          value={t1Pattern}
          onChange={onT1Pattern}
          mono
          placeholder="*_T1w.nii.gz"
          ariaLabel="T1 file name pattern"
          invalid={t1Error !== null}
        />
      </Field>
    </>
  )
}
