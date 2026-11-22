/**
 * Tests for the PyBrainAge setup text. The adapter reports each setup step as
 * an order with the step's key and a failed step as an order to fix it; the
 * status line and the streamed output state both as facts.
 */

import { describe, expect, it } from 'vitest'
import { setupProgressStatus, setupProgressText } from './pybrainage-setup'

describe('setupProgressText', () => {
  // The steps execute_provision in adapters/pybrainage.py runs, in order.
  it.each([
    ['check_micromamba', 'Checking micromamba'],
    ['create_env', 'Creating the locked environment'],
    ['install_pip_deps', 'Installing the pinned pip packages'],
    ['probe_runtime', 'Checking the runtime versions'],
    ['fetch_model', 'Fetching the model archive'],
    ['verify_model', 'Verifying the model archive'],
    ['extract_model', 'Extracting the model'],
    ['validate_pickle', 'Validating the model and scaler'],
    ['publish_generation', 'Publishing the verified setup'],
    ['record_state', 'Recording the setup state'],
  ])('states the %s step and its failure as facts', (step, fact) => {
    expect(setupProgressText(`Run ${step}.`)).toBe(`${fact}...`)
    expect(
      setupProgressText(
        `Fix ${step} after this failure: the command exited with code 1.`,
      ),
    ).toBe(`${fact} failed: the command exited with code 1.`)
    expect(setupProgressText(`Fix ${step} after this failure: `)).toBe(
      `${fact} failed.`,
    )
    expect(setupProgressText(`Fix ${step} after this failure.`)).toBe(
      `${fact} failed.`,
    )
  })

  it('keeps the failure detail whole, remedy and line breaks included', () => {
    expect(
      setupProgressText(
        'Fix fetch_model after this failure: Prepare the model cache after fixing this error: [Errno 28] No space left on device\ncurl: (23) write error',
      ),
    ).toBe(
      'Fetching the model archive failed: Prepare the model cache after fixing this error: [Errno 28] No space left on device\ncurl: (23) write error',
    )
  })

  it('shows every other message as written', () => {
    for (const message of [
      'The PyBrainAge environment is provisioned.',
      'PyBrainAge provisioning is complete.',
      'PyBrainAge setup was canceled.',
      '$ micromamba create -y --root-prefix /p -p /p/envs/pybrainage',
      'Transaction finished',
      // A step the adapter does not run, or not the adapter's whole line.
      'Run retired_step.',
      'Run create_env',
      'Run create_env. Then more.',
      'Fix retired_step after this failure: boom',
      '',
    ]) {
      expect(setupProgressText(message)).toBe(message)
    }
  })
})

describe('setupProgressStatus', () => {
  // The sidecar reports a canceled setup in the error phase with this exact
  // message (provisioning.py), which must not read as a failure.
  it('states a canceled setup as canceled, not failed', () => {
    expect(
      setupProgressStatus({
        phase: 'error',
        message: 'PyBrainAge setup was canceled.',
      }),
    ).toBe('cancelled')
  })

  it('keeps every other error a failure and maps the other phases', () => {
    expect(setupProgressStatus({ phase: 'error', message: 'HTTP 503' })).toBe(
      'error',
    )
    expect(
      setupProgressStatus({
        phase: 'error',
        message: 'Fix fetch_model after this failure: canceled by the server',
      }),
    ).toBe('error')
    expect(setupProgressStatus({ phase: 'done', message: '' })).toBe('done')
    expect(setupProgressStatus({ phase: 'env', message: '' })).toBe('running')
  })
})
