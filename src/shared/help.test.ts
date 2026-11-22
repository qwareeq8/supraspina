/** Requires plain-language help coverage for every modeled surface. */

import { describe, expect, it } from 'vitest'
import { MATRIX_STEPS, PIPELINE_STEPS, STEP_KEYS } from './steps'
import {
  COHORT_HELP,
  consequenceFor,
  ENV_CHECK_HELP,
  GLOSSARY,
  MATRIX_STEP_HELP,
  neededForStep,
  PARAM_HELP,
  QC_VERDICT_HELP,
  spelledOutStepName,
  STATUS_MEANING,
  STEP_HELP,
  STEP_NAME_SPELLED_OUT,
} from './help'
import type { EnvCheck } from './types'

describe('help content coverage', () => {
  it('covers every matrix column', () => {
    const missing = MATRIX_STEPS.filter((s) => !MATRIX_STEP_HELP[s.key]).map(
      (s) => s.key,
    )
    expect(missing).toEqual([])
  })

  it('covers every pipeline step', () => {
    const missing = STEP_KEYS.filter((k) => !STEP_HELP[k])
    expect(missing).toEqual([])
  })

  it('spells out each abbreviated stage name around the name itself', () => {
    for (const [key, spelled] of Object.entries(STEP_NAME_SPELLED_OUT)) {
      const name = PIPELINE_STEPS.find((step) => step.key === key)?.name
      expect(spelled.replace(/ \([^)]*\)/, '')).toBe(name)
    }
    expect(spelledOutStepName('brainfov')).toBe(
      'Brain FOV (field of view) preparation',
    )
    expect(spelledOutStepName('brainpad')).toBe(
      'Brain-PAD (brain predicted age difference) statistics',
    )
    expect(spelledOutStepName('recon')).toBe('Reconstruction')
  })

  it('covers every editable parameter', () => {
    const missing: string[] = []
    for (const step of PIPELINE_STEPS) {
      for (const param of Object.keys(step.params)) {
        const key = `${step.key}.${param}`
        if (!PARAM_HELP[key]) missing.push(key)
      }
    }
    expect(missing).toEqual([])
  })

  it('documents only the supported ENIGMA execution engines', () => {
    expect(PARAM_HELP['enigma.backend']).toMatch(/licensed MATLAB installation/)
    expect(PARAM_HELP['enigma.backend']).toMatch(/R2019b MATLAB Runtime/)
    expect(PARAM_HELP['enigma.backend']).not.toMatch(/Octave/)
    expect(ENV_CHECK_HELP).not.toHaveProperty('octave')
  })

  it('explains known and unknown dependency consequences without guessing', () => {
    const known = { id: 'reconall' } as EnvCheck
    const unknown = { id: 'future-check' } as EnvCheck

    expect(neededForStep(known)).toBe('FreeSurfer recon-all')
    expect(consequenceFor(known)).toBe('Needed for FreeSurfer recon-all.')
    expect(neededForStep(unknown)).toBeUndefined()
    expect(consequenceFor(unknown)).toBe(
      'Resolve this check before running the affected steps.',
    )
  })

  it('states status, verdict, glossary, and cohort meanings as facts', () => {
    // These entries say what a state or term is; an order such as "Treat the
    // dependency as ..." or "Record reviewer acceptance ..." misreads as an
    // instruction.
    const ORDER =
      /^(Treat|Interpret|Use|Calculate|Record|Request|Leave|Review|Inspect|Skip|Count|Open)\b/
    const entries = [
      ...Object.entries(STATUS_MEANING),
      ...Object.entries(QC_VERDICT_HELP),
      ...Object.entries(GLOSSARY),
      ...Object.entries(COHORT_HELP),
    ]
    expect(entries.filter(([, text]) => ORDER.test(text))).toEqual([])
    expect(QC_VERDICT_HELP.pass).toMatch(/^Pass means /)
    expect(QC_VERDICT_HELP.fail).toMatch(/^Fail means /)
    expect(QC_VERDICT_HELP.review).toMatch(/^Defer means /)
    expect(STATUS_MEANING.found).toMatch(/^This dependency /)
  })

  it('describes stages, columns, parameters, and checks instead of ordering', () => {
    // Each entry says what a stage does or what a column, setting, or check
    // is; an entry such as "Choose where to write ..." or "Provide the
    // license file ..." reads as an order even when nothing needs doing.
    const ORDER =
      /^(Add|Allow|Build|Check|Choose|Collect|Crop|Gather|Generate|Install|Join|Keep|Leave|List|Merge|Optionally invoke|Predict|Provide|Reconstruct|Render|Re-deface|Review|Run|Select|Set|Use|Warn)\b/
    const entries = [
      ...Object.entries(MATRIX_STEP_HELP),
      ...Object.entries(STEP_HELP),
      ...Object.entries(PARAM_HELP),
      ...Object.entries(ENV_CHECK_HELP),
    ]
    expect(entries.filter(([, text]) => ORDER.test(text))).toEqual([])
    // A later sentence keeps no order either.
    expect(
      entries.filter(([, text]) =>
        /\. (Keep|Leave|Provide|Install|Approve|Use|Turn|Allow) /.test(text),
      ),
    ).toEqual([])
  })
})
