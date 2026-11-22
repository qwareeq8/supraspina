/** Tests the refusal a gated install, setup, or provisioning control states. */

import { describe, expect, it } from 'vitest'
import { installGate, type InstallGateInput } from './install-gate'

const READY: InstallGateInput = {
  action: 'install Rscript',
  projectOpen: true,
  safeExecution: true,
  dirty: false,
  busy: false,
}

describe('installGate', () => {
  it('lets a saved project under Allow live runs start the operation', () => {
    expect(installGate(READY)).toBeNull()
  })

  it('names the first unmet condition in the order the operator meets them', () => {
    // Enabling Allow live runs leaves the project unsaved on purpose, so the
    // save comes after it, and a running installation comes last.
    expect(
      installGate({
        ...READY,
        projectOpen: false,
        safeExecution: false,
        dirty: true,
        busy: true,
      }),
    ).toEqual({
      kind: 'no-project',
      action: 'install Rscript',
      reason: 'Open a saved project to install Rscript.',
    })
    expect(
      installGate({ ...READY, safeExecution: false, dirty: true, busy: true }),
    ).toMatchObject({
      kind: 'safe-execution',
      reason: 'Allow live runs to install Rscript.',
    })
    expect(installGate({ ...READY, dirty: true, busy: true })).toMatchObject({
      kind: 'unsaved',
      reason: 'Save the project to install Rscript.',
    })
    expect(installGate({ ...READY, busy: true })).toMatchObject({
      kind: 'busy',
      reason:
        'Another installation is running. Supraspina can install Rscript once it finishes.',
    })
  })
})
