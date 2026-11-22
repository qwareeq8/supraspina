/**
 * Names why an opt-in install, setup, or provisioning control refuses to
 * start, so every disabled control can say what enables it.
 */

/** The first unmet condition that keeps a gated operation from starting. */
export type InstallGateKind =
  | 'no-project'
  | 'safe-execution'
  | 'unsaved'
  | 'busy'

/** One refusal: its kind, the operation it gates, and the sentence to show. */
export interface InstallGate {
  kind: InstallGateKind
  /** The operation phrase that completes "to ...", for example "install R". */
  action: string
  /** The sentence naming what enables the operation. */
  reason: string
}

/** The state an installation gate reads. */
export interface InstallGateInput {
  /** The operation phrase that completes "to ...", for example "install R". */
  action: string
  projectOpen: boolean
  safeExecution: boolean
  /** Whether unsaved project edits refuse the operation. */
  dirty: boolean
  /** Whether another gated operation is still running. */
  busy: boolean
}

/**
 * Return the first unmet condition for a gated operation, or null when it can
 * start.
 *
 * The order follows how the operator enables the operation: open a project,
 * turn on Allow live runs, which leaves the project unsaved on purpose, save
 * it, then wait for any running installation.
 *
 * @returns The refusal, or null when nothing refuses the operation.
 */
export function installGate(input: InstallGateInput): InstallGate | null {
  const { action } = input
  if (!input.projectOpen) {
    return {
      kind: 'no-project',
      action,
      reason: `Open a saved project to ${action}.`,
    }
  }
  if (!input.safeExecution) {
    return {
      kind: 'safe-execution',
      action,
      reason: `Allow live runs to ${action}.`,
    }
  }
  if (input.dirty) {
    return { kind: 'unsaved', action, reason: `Save the project to ${action}.` }
  }
  if (input.busy) {
    return {
      kind: 'busy',
      action,
      reason: `Another installation is running. Supraspina can ${action} once it finishes.`,
    }
  }
  return null
}
