import { describe, expect, it } from 'vitest'
import type { WorkflowNode } from '../../shared/contract'
import { DEFAULT_PROJECT_CONFIG } from '../../shared/project-schema'
import type { StepKey } from '../../shared/steps'
import {
  belongsToStageThatIsOff,
  noWorkSummaryText,
  skippedReasonText,
} from './plan-node-facts'

const OUTSIDE_RECOVERY =
  'This work is outside the invalid source-node recovery closure, so it is not scheduled.'
const REUSED = 'The current detector-backed receipt is reused.'

/** A project configuration with exactly `off` turned off. */
function switches(off: readonly StepKey[]) {
  const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
  for (const [key, step] of Object.entries(cfg.steps)) {
    step.enabled = !off.includes(key as StepKey)
  }
  return cfg
}

function skipped(
  stepKey: StepKey,
  count: number,
  reason: string,
): WorkflowNode[] {
  return Array.from({ length: count }, (_, index) => ({
    nodeId: `${stepKey}-${index}`,
    stepKey,
    scope: 'subject' as const,
    subjectId: `sub-${index}`,
    status: 'skipped' as const,
    dependencies: [],
    reason,
  }))
}

/** The Run all plan of a 4-subject project with six stages off. */
const RUN_ALL_NODES: WorkflowNode[] = [
  ...skipped(
    'brainfov',
    4,
    'Brain FOV preparation is off in project configuration.',
  ),
  ...skipped('deface', 4, 'Optional defacing is off in project configuration.'),
  ...skipped('recon', 4, REUSED),
  ...skipped('enigma', 1, REUSED),
  ...skipped('outliers', 1, REUSED),
  ...skipped('features', 1, REUSED),
  ...skipped('age', 1, REUSED),
  ...skipped('aggregate', 1, REUSED),
  ...skipped(
    'pybrainage',
    1,
    'PyBrainAge prediction is off in project configuration.',
  ),
  ...skipped('clinical', 1, 'Clinical merge is off in project configuration.'),
  ...skipped(
    'brainpad',
    1,
    'Brain-PAD statistics is off in project configuration.',
  ),
  ...skipped('final', 1, 'R analysis is off in project configuration.'),
]

describe('plan node facts', () => {
  it('counts the nodes of stages that are off apart from the current ones', () => {
    expect(RUN_ALL_NODES).toHaveLength(21)
    expect(
      noWorkSummaryText(
        'No work is scheduled: all 21 nodes are current.',
        RUN_ALL_NODES,
        switches([
          'brainfov',
          'deface',
          'pybrainage',
          'clinical',
          'brainpad',
          'final',
        ]),
      ),
    ).toBe(
      'No work is scheduled: 9 jobs are current and 12 belong to stages that are off.',
    )
  })

  it('names one stage that is off in the singular', () => {
    const nodes = [
      ...skipped('recon', 195, REUSED),
      ...skipped(
        'deface',
        82,
        'Optional defacing is off in project configuration.',
      ),
    ]
    expect(
      noWorkSummaryText(
        'No work is scheduled: all 277 nodes are current.',
        nodes,
        switches(['deface']),
      ),
    ).toBe(
      'No work is scheduled: 195 jobs are current and 82 belong to a stage that is off.',
    )
    expect(
      noWorkSummaryText(
        'No work is scheduled: all 2 nodes are current.',
        [
          ...skipped('recon', 1, REUSED),
          ...skipped(
            'deface',
            1,
            'Optional defacing is off in project configuration.',
          ),
        ],
        switches(['deface']),
      ),
    ).toBe(
      'No work is scheduled: 1 job is current and 1 belongs to a stage that is off.',
    )
  })

  it('says so when every node belongs to a stage that is off', () => {
    const off = 'Optional defacing is off in project configuration.'
    expect(
      noWorkSummaryText(
        'No work is scheduled: all 3 nodes are current.',
        skipped('deface', 3, off),
        switches(['deface']),
      ),
    ).toBe('No work is scheduled: all 3 jobs belong to a stage that is off.')
    expect(
      noWorkSummaryText(
        'No work is scheduled: the 1 node is current.',
        skipped('deface', 1, off),
        switches(['deface']),
      ),
    ).toBe('No work is scheduled: the 1 job belongs to a stage that is off.')
  })

  it('reads a stage the configuration turns off under the recovery wording as off', () => {
    const nodes = [
      ...skipped('brainfov', 2, OUTSIDE_RECOVERY),
      ...skipped('recon', 2, OUTSIDE_RECOVERY),
    ]
    const cfg = switches(['brainfov'])
    expect(nodes.map((node) => belongsToStageThatIsOff(node, cfg))).toEqual([
      true,
      true,
      false,
      false,
    ])
    expect(nodes.map((node) => skippedReasonText(node, cfg))).toEqual([
      'Off in project configuration.',
      'Off in project configuration.',
      'Not part of this recovery.',
      'Not part of this recovery.',
    ])
    expect(
      noWorkSummaryText(
        'No work is scheduled: all 4 nodes are current.',
        nodes,
        cfg,
      ),
    ).toBe(
      'No work is scheduled: 2 jobs are current and 2 belong to a stage that is off.',
    )
  })

  it('passes every other summary, and one its nodes do not match, through', () => {
    const cfg = switches(['deface'])
    const nodes = [
      ...skipped('recon', 1, REUSED),
      ...skipped(
        'deface',
        1,
        'Optional defacing is off in project configuration.',
      ),
    ]
    for (const message of [
      'No work is scheduled.',
      'No work is scheduled: 2 nodes are blocked.',
      'This pass runs 2 nodes.',
      // A summary without the plan's nodes, or with other nodes.
      'No work is scheduled: all 288 nodes are current.',
    ]) {
      expect(noWorkSummaryText(message, nodes, cfg)).toBe(message)
    }
    expect(
      noWorkSummaryText(
        'No work is scheduled: all 2 nodes are current.',
        [],
        cfg,
      ),
    ).toBe('No work is scheduled: all 2 nodes are current.')
    // Nothing is off, so every node is current as the sidecar says.
    expect(
      noWorkSummaryText(
        'No work is scheduled: all 2 nodes are current.',
        skipped('recon', 2, REUSED),
        cfg,
      ),
    ).toBe('No work is scheduled: all 2 nodes are current.')
    // A reason that only resembles the off wording is not a stage that is off.
    expect(
      skippedReasonText(
        skipped(
          'recon',
          1,
          'Reuse of completed work is off in project configuration.',
        )[0]!,
        cfg,
      ),
    ).toBe('Reuse of completed work is off in project configuration.')
  })
})
