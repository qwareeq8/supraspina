import { describe, expect, it } from 'vitest'
import {
  isInputLimitReason,
  nameBlockedSubjects,
  type NotRunRecord,
  restateRecordedReasons,
  restateLogLine,
  runSummaryText,
  terminalMarkerText,
  terminalReasonText,
} from './terminal-reason'

describe('restateRecordedReasons', () => {
  it('leaves the current sentence and other text unchanged', () => {
    const current = 'Reconstruction failed, so this step did not run.'
    expect(restateRecordedReasons(current)).toBe(current)
    expect(restateRecordedReasons('Resolve dependency recon.')).toBe(
      'Resolve dependency recon.',
    )
    expect(
      restateRecordedReasons(
        'Review the blocked workflow nodes before the run.',
      ),
    ).toBe('Review the blocked workflow nodes before the run.')
  })

  it.each([
    // What the current sidecar writes when no blocked node records a reason.
    [
      'Resolve 1 blocked node. The blocked node records no reason.',
      'Resolve 1 blocked job. The blocked job records no reason.',
    ],
    [
      'Resolve 2 blocked nodes. The blocked nodes record no reason.',
      'Resolve 2 blocked jobs. The blocked jobs record no reason.',
    ],
    [
      'This pass runs 1 node; 1 blocked node will not run. Create a runnable upstream node.',
      'This pass runs 1 job; 1 blocked job will not run. Create a runnable upstream job.',
    ],
    [
      'No work is scheduled: the 1 node is current.',
      'No work is scheduled: the 1 job is current.',
    ],
    [
      'No work is scheduled: all 288 nodes are current.',
      'No work is scheduled: all 288 jobs are current.',
    ],
    // A resolve order that does not open the text reads as recorded.
    ['Note: Resolve 1 blocked node.', 'Note: Resolve 1 blocked node.'],
  ])('states the sidecar node counts of %j in jobs', (summary, restated) => {
    expect(restateRecordedReasons(summary)).toBe(restated)
  })

  it.each([
    ['Inspect process exit code 1.', 'The process exited with code 1.'],
    ['Inspect process exit code -9.', 'The process exited with code -9.'],
    [
      // A source image that truncates the brain inferiorly; the refusal is
      // worded as an order about the crop.
      'Keep the brain mask away from every crop face.',
      'The brain reaches the edge of the source image, so no crop can keep the required margin; the scan does not cover the whole brain.',
    ],
  ])('states the recorded adapter order %j as a fact', (order, fact) => {
    expect(restateRecordedReasons(order)).toBe(fact)
    expect(restateRecordedReasons(fact)).toBe(fact)
  })

  it.each([
    [
      'Increase available memory for recon-all after rc=137; allow at least 32 GB and up to about 80 GB peak.',
      'recon-all ran out of memory (exit code 137); it needs at least 32 GB and up to about 80 GB at peak.',
    ],
    [
      // A Reconstruction failure.
      'Increase available memory for recon-all; mri_synthseg was killed by signal 9, which is how the kernel ends a process that ran out of memory. mri_synthseg alone needs about 24 GB free.',
      'recon-all ran out of memory; mri_synthseg was killed by signal 9, which is how the kernel ends a process that ran out of memory. mri_synthseg alone needs about 24 GB free.',
    ],
    [
      'Increase available memory for recon-all; a recon-all tool was killed by signal 9, which is how the kernel ends a process that ran out of memory. mri_synthseg alone needs about 24 GB free.',
      'recon-all ran out of memory; a recon-all tool was killed by signal 9, which is how the kernel ends a process that ran out of memory. mri_synthseg alone needs about 24 GB free.',
    ],
    [
      // The whole stale-marker message of the Reconstruction adapter: the
      // remedy's cause leads, and the sentence after it reads as recorded.
      'Retry the reconstruction; recon-all refused to start because an interrupted run left scripts/IsRunning behind. Supraspina removes that marker before continuing a subject when no recon-all is running for it.',
      'recon-all refused to start because an interrupted run left scripts/IsRunning behind. Supraspina removes that marker before continuing a subject when no recon-all is running for it.',
    ],
    [
      'Inspect the failed surface topology correction.',
      'Surface topology correction failed.',
    ],
    ['Inspect the failed surface inflation.', 'Surface inflation failed.'],
    [
      'Inspect the failed white-surface generation.',
      'White-surface generation failed.',
    ],
    [
      'Inspect the failed FreeSurfer stats2table call.',
      'The FreeSurfer stats2table call failed.',
    ],
    [
      'Inspect the failed brain-FOV preparation.',
      'Brain-FOV preparation failed.',
    ],
    [
      // An R analysis failure on a read-only report template.
      'Provide every structural CSV and metadata.csv input.',
      'R could not open a file it reads; the job log names the file and the cause.',
    ],
  ])('states the stage tool order %j as a fact', (order, fact) => {
    // The stage adapters are bound into receipts, so they keep the order.
    expect(restateRecordedReasons(order)).toBe(fact)
    expect(restateRecordedReasons(fact)).toBe(fact)
  })

  it.each([
    [
      'This pass runs 3 nodes; 2 blocked nodes will not run. Inspect process exit code 1. 1 more reason applies.',
      'This pass runs 3 jobs; 2 blocked jobs will not run. The process exited with code 1. 1 more reason applies.',
    ],
    [
      'Resolve 2 blocked nodes. Rerun recon before enigma because no matching current provenance receipt exists.',
      'Resolve 2 blocked jobs. Reconstruction has no current receipt for ENIGMA QC.',
    ],
  ])('restates the orders inside %j', (text, restated) => {
    expect(restateRecordedReasons(text)).toBe(restated)
  })

  // The scheduler's readiness reasons (_producer_ready) name stages by
  // their keys. They also block plan-time nodes and enter the plan digest,
  // so the sidecar keeps them and they read here with the stage names.
  it.each([
    [
      // A blocked ENIGMA QC job.
      'Rerun recon before enigma because no matching current provenance receipt exists.',
      'Reconstruction has no current receipt for ENIGMA QC.',
    ],
    [
      'Rerun pybrainage before clinical because no matching current provenance receipt exists.',
      'PyBrainAge prediction has no current receipt for Clinical merge.',
    ],
    [
      'Restore current recon->enigma required artifacts.',
      'The Reconstruction output that ENIGMA QC requires does not match its receipt.',
    ],
    [
      'Resolve the integrity check failure for brainfov: Verify brain-FOV currentness.',
      'The Brain FOV preparation integrity check failed: Verify brain-FOV currentness.',
    ],
    [
      'Resolve the integrity check failure for recon: Recheck unknown detector evidence.',
      'The Reconstruction integrity check failed: The detector evidence is unknown.',
    ],
    [
      // The plan-time form names no stage: the node's own stage failed it.
      'Resolve the integrity check failure: Run the detector again after RuntimeError.',
      'The integrity check failed: The detector failed with an unexpected error (RuntimeError).',
    ],
  ])('states the scheduler readiness order %j as a fact', (order, fact) => {
    expect(restateRecordedReasons(order)).toBe(fact)
    expect(restateRecordedReasons(fact)).toBe(fact)
  })

  // The planner blocks a node whose dependency is blocked and names that
  // stage and the root cause (_propagate_blocked_dependencies). The reason
  // enters plan.blockers and the plan digest, so the sidecar keeps it; the
  // sentences are the ones the sidecar test
  // test_dependents_name_the_stage_they_wait_for_and_the_root_cause_once pins.
  it.each([
    [
      'Wait for Reconstruction, which is blocked: Install recon-all.',
      'Depends on Reconstruction, which is blocked: Install recon-all.',
    ],
    [
      'Wait for FreeSurfer feature extraction. Reconstruction is blocked: Install recon-all.',
      'Depends on FreeSurfer feature extraction. Reconstruction is blocked: Install recon-all.',
    ],
    [
      'Wait for Age metadata integration. Reconstruction is blocked: Install recon-all.',
      'Depends on Age metadata integration. Reconstruction is blocked: Install recon-all.',
    ],
    [
      // The real planner's reason when Registry roles are missing.
      'Wait for Clinical merge, which is blocked: Prepare Clinical merge. Assign registry roles to sub-missing. Resolve ambiguous registry roles for sub-ambiguous.',
      'Depends on Clinical merge, which is blocked: Prepare Clinical merge. Assign registry roles to sub-missing. Resolve ambiguous registry roles for sub-ambiguous.',
    ],
    [
      // A root cause that is itself a readiness order reads as its fact too.
      'Wait for FreeSurfer feature extraction. Reconstruction is blocked: Rerun brainfov before recon because no matching current provenance receipt exists.',
      'Depends on FreeSurfer feature extraction. Reconstruction is blocked: Brain FOV preparation has no current receipt for Reconstruction.',
    ],
  ])('states the dependency wait %j as a fact', (order, fact) => {
    expect(restateRecordedReasons(order)).toBe(fact)
    expect(restateRecordedReasons(fact)).toBe(fact)
  })

  it('keeps a wait that is not the dependency sentence as recorded', () => {
    for (const text of [
      'Wait for an operator decision.',
      'Wait for the active workflow to finish before starting another.',
      'Wait for Reconstruction.',
      'Wait for Reconstruction, which is still running.',
    ]) {
      expect(restateRecordedReasons(text)).toBe(text)
    }
  })

  it('keeps a readiness order that names an unknown stage as recorded', () => {
    for (const text of [
      'Rerun retired before enigma because no matching current provenance receipt exists.',
      'Rerun recon before retired because no matching current provenance receipt exists.',
      'Restore current recon->retired required artifacts.',
      'Resolve the integrity check failure for retired: Verify it.',
      // An inherited object key is not a stage.
      'Restore current constructor->enigma required artifacts.',
      // Not the sentence the sidecar writes.
      'Rerun recon before enigma.',
      'Restore current recon artifacts.',
    ]) {
      expect(restateRecordedReasons(text)).toBe(text)
    }
  })

  it('leaves actionable errors and unrecognized orders as recorded', () => {
    for (const text of [
      'Provide the input CSV.',
      'Add the defacing tool to PATH.',
      // A remedy with no cause to state is the actionable error.
      'Provide a valid FreeSurfer license.txt in $FREESURFER_HOME or set FS_LICENSE.',
      // Not the sentence a stage adapter writes.
      'Retry the reconstruction.',
      'Retry the reconstruction; recon-all refused to start.',
      'Increase available memory for recon-all.',
      'Inspect the failed reconstruction.',
      'Resolve the execution failure.',
      'Inspect process exit code one.',
      'Review the aggregation failure: bad row.',
    ]) {
      expect(restateRecordedReasons(text)).toBe(text)
    }
  })
})

describe('runSummaryText', () => {
  it.each([
    // What the sidecar's _state_summary writes for a pass in which nothing
    // runs; the summary enters the plan digest, so the sidecar keeps it.
    [
      'Resolve 1 blocked node. Reconstruction failed, so this step did not run.',
      'No work is scheduled: 1 job is blocked. Reconstruction failed, so this step did not run.',
    ],
    [
      'Resolve 3 blocked nodes. Reconstruction failed, so this step did not run. 1 more reason applies.',
      'No work is scheduled: 3 jobs are blocked. Reconstruction failed, so this step did not run. 1 more reason applies.',
    ],
    [
      'Resolve 2 blocked nodes. The blocked nodes record no reason.',
      'No work is scheduled: 2 jobs are blocked. The blocked jobs record no reason.',
    ],
    [
      'Resolve 2 blocked nodes. The authorized cleanup failed, so this work did not start.',
      'No work is scheduled: 2 jobs are blocked. The authorized cleanup failed, so this work did not start.',
    ],
    [
      'Resolve 2 blocked nodes. Wait for Reconstruction, which is blocked: Install recon-all. 1 more reason applies.',
      'No work is scheduled: 2 jobs are blocked. Depends on Reconstruction, which is blocked: Install recon-all. 1 more reason applies.',
    ],
    // A lead-in with nothing after it.
    ['Resolve 1 blocked node.', 'No work is scheduled: 1 job is blocked.'],
  ])('states the current summary %j as a fact', (summary, fact) => {
    expect(runSummaryText(summary)).toBe(fact)
    expect(runSummaryText(fact)).toBe(fact)
  })

  it.each([
    // A stage plan the scheduler's readiness check blocked.
    [
      'Resolve 1 blocked node. Rerun recon before enigma because no matching current provenance receipt exists.',
      'No work is scheduled: 1 job is blocked. Reconstruction has no current receipt for ENIGMA QC.',
    ],
  ])('states the recorded order summary %j as a fact', (summary, fact) => {
    expect(runSummaryText(summary)).toBe(fact)
  })

  it('leaves every other summary as written', () => {
    for (const summary of [
      'No work is scheduled.',
      'This pass runs 3 jobs (1 waiting on dependencies); 2 blocked jobs will not run. Reconstruction failed, so this step did not run.',
      'Started run run-1: 3 jobs queued. Watch In flight here and the output in Logs.',
      'Dry run only: planned 2 commands and executed nothing. Turn off Dry run first to execute.',
      'Register every subject before starting the workflow because sub-001 is unregistered.',
      // Not the lead-in the sidecar writes, or not at the start.
      'Resolve 1 blocked node before retrying this workflow.',
      'Resolve the blocked nodes.',
      'Resolve two blocked nodes.',
      'Note: Resolve 1 blocked node.',
      '',
    ]) {
      expect(runSummaryText(summary)).toBe(summary)
    }
  })

  it('names the subjects of a blocked reason from the plan nodes', () => {
    // The sidecar's blocker names no subject, so the stage line takes the
    // subjects from the blocked plan nodes.
    const nodes = [
      node(
        'recon',
        'sub-901',
        'planned',
        'No earlier run left a receipt for it.',
      ),
      node('recon', 'sub-902', 'blocked', CONFLICT),
    ]
    expect(runSummaryText(`Resolve 1 blocked node. ${CONFLICT}`, nodes)).toBe(
      `No work is scheduled: 1 job is blocked. Reconstruction for sub-902: ${CONFLICT}`,
    )
    expect(
      runSummaryText(
        `This pass runs 1 node; 1 blocked node will not run. ${CONFLICT}`,
        nodes,
      ),
    ).toBe(
      `This pass runs 1 job; 1 blocked job will not run. Reconstruction for sub-902: ${CONFLICT}`,
    )
    // Without nodes, or with no reason after the lead-in, nothing is named.
    expect(runSummaryText(`Resolve 1 blocked node. ${CONFLICT}`)).toBe(
      `No work is scheduled: 1 job is blocked. ${CONFLICT}`,
    )
    expect(runSummaryText('Resolve 1 blocked node.', nodes)).toBe(
      'No work is scheduled: 1 job is blocked.',
    )
    expect(
      runSummaryText('No work is scheduled: all 21 nodes are current.', nodes),
    ).toBe('No work is scheduled: all 21 jobs are current.')
  })
})

/** The plan-time reason a Reconstruction node with an output conflict records. */
const CONFLICT =
  'Choose a fresh derivatives namespace because detector-complete Reconstruction output has no matching current receipt; preserve the existing tree.'

/** A plan node or job that records `reason`. */
function node(
  stepKey: string,
  subjectId: string | null,
  status: string,
  reason?: string | null,
): NotRunRecord {
  return { stepKey, subjectId, status, reason }
}

describe('nameBlockedSubjects', () => {
  it('names the stage and the one subject a reason blocked', () => {
    // A blocked-run notice for sub-901 and sub-902.
    expect(
      nameBlockedSubjects(CONFLICT, [
        node('recon', 'sub-901', 'done', null),
        node('recon', 'sub-902', 'blocked', CONFLICT),
      ]),
    ).toBe(`Reconstruction for sub-902: ${CONFLICT}`)
  })

  it('names up to three subjects in order and counts the rest', () => {
    const blocked = (ids: string[]): NotRunRecord[] =>
      ids.map((id) => node('recon', id, 'blocked', CONFLICT))
    expect(nameBlockedSubjects(CONFLICT, blocked(['sub-2', 'sub-1']))).toBe(
      `Reconstruction for sub-1 and sub-2: ${CONFLICT}`,
    )
    expect(
      nameBlockedSubjects(CONFLICT, blocked(['sub-10', 'sub-9', 'sub-100'])),
    ).toBe(`Reconstruction for sub-9, sub-10, and sub-100: ${CONFLICT}`)
    expect(
      nameBlockedSubjects(
        CONFLICT,
        blocked(['sub-5', 'sub-4', 'sub-3', 'sub-2', 'sub-1', 'sub-1']),
      ),
    ).toBe(
      `Reconstruction for sub-1, sub-2, sub-3, and 2 more subjects: ${CONFLICT}`,
    )
    expect(
      nameBlockedSubjects(
        CONFLICT,
        blocked(['sub-4', 'sub-3', 'sub-2', 'sub-1']),
      ),
    ).toBe(
      `Reconstruction for sub-1, sub-2, sub-3, and 1 more subject: ${CONFLICT}`,
    )
  })

  it('keeps the count of further reasons after the named reason', () => {
    const text = `${CONFLICT} 1 more reason applies.`
    expect(
      nameBlockedSubjects(text, [
        node('recon', 'sub-902', 'blocked', CONFLICT),
        node('enigma', null, 'blocked', 'The age metadata file is missing.'),
      ]),
    ).toBe(`Reconstruction for sub-902: ${text}`)
  })

  it('matches a reason as it reads, restated and closed with a full stop', () => {
    // The summary closes a reason with a full stop and restates it; the
    // record keeps the text the sidecar wrote.
    expect(
      nameBlockedSubjects(
        'The integrity check failed: The detector evidence is unknown.',
        [
          node(
            'deface',
            'sub-7',
            'blocked',
            'Resolve the integrity check failure: Recheck unknown detector evidence.',
          ),
        ],
      ),
    ).toBe(
      'Optional defacing for sub-7: The integrity check failed: The detector evidence is unknown.',
    )
    expect(
      nameBlockedSubjects('Blocked by the site policy.', [
        node('recon', 'sub-3', 'withheld', ' Blocked by the site policy '),
      ]),
    ).toBe('Reconstruction for sub-3: Blocked by the site policy.')
  })

  it('reads the longest reason the text opens with', () => {
    const short = 'The input is missing.'
    const long = `${short} Its folder is empty.`
    expect(
      nameBlockedSubjects(long, [
        node('recon', 'sub-1', 'blocked', short),
        node('recon', 'sub-2', 'blocked', long),
      ]),
    ).toBe(`Reconstruction for sub-2: ${long}`)
  })

  it('leaves a reason it cannot attribute to subjects of one stage as it is', () => {
    const unchanged: [string, NotRunRecord[]][] = [
      // A cohort stage has no subject to name.
      [
        'Reconstruction has no current receipt for ENIGMA QC.',
        [
          node(
            'enigma',
            null,
            'blocked',
            'Rerun recon before enigma because no matching current provenance receipt exists.',
          ),
        ],
      ],
      // A cohort node shares the reason.
      [
        CONFLICT,
        [
          node('recon', 'sub-902', 'blocked', CONFLICT),
          node('aggregate', null, 'blocked', CONFLICT),
        ],
      ],
      // Two stages share the reason.
      [
        CONFLICT,
        [
          node('recon', 'sub-902', 'blocked', CONFLICT),
          node('deface', 'sub-903', 'blocked', CONFLICT),
        ],
      ],
      // No record states it, or only work that ran does.
      [CONFLICT, [node('recon', 'sub-902', 'blocked', 'Another reason.')]],
      [CONFLICT, [node('recon', 'sub-902', 'planned', CONFLICT)]],
      [CONFLICT, [node('recon', 'sub-902', 'failed', CONFLICT)]],
      [CONFLICT, []],
      // A stage key the app does not know.
      [CONFLICT, [node('retired', 'sub-902', 'blocked', CONFLICT)]],
      // The text does not open with the reason.
      [`Note: ${CONFLICT}`, [node('recon', 'sub-902', 'blocked', CONFLICT)]],
      ['', [node('recon', 'sub-902', 'blocked', '')]],
    ]
    for (const [text, records] of unchanged) {
      expect(nameBlockedSubjects(text, records)).toBe(text)
    }
  })
})

describe('terminalReasonText', () => {
  it.each([
    ['operator_cancelled', "Canceled at the operator's request."],
    [
      'operator_cancelled_before_start',
      "Canceled at the operator's request before it started.",
    ],
    ['operator_cancellation_requested', 'The operator requested cancellation.'],
    ['dry_run', 'Dry run: the command was planned and not executed.'],
  ])('states the known code %s as a fact', (code, text) => {
    expect(terminalReasonText(code)).toBe(text)
  })

  it('restates the scheduler readiness order a blocked job records', () => {
    expect(
      terminalReasonText(
        'Rerun recon before features because no matching current provenance receipt exists.',
      ),
    ).toBe(
      'Reconstruction has no current receipt for FreeSurfer feature extraction.',
    )
    expect(
      terminalReasonText(
        'Restore current recon->aggregate required artifacts.',
      ),
    ).toBe(
      'The Reconstruction output that Structural data aggregation requires does not match its receipt.',
    )
  })

  it('restates the dependency wait a blocked node records', () => {
    const wait =
      'Wait for Clinical merge, which is blocked: Prepare Clinical merge. Assign registry roles to sub-missing.'
    const fact =
      'Depends on Clinical merge, which is blocked: Prepare Clinical merge. Assign registry roles to sub-missing.'
    expect(terminalReasonText(wait)).toBe(fact)
    expect(terminalMarkerText(`Resolve the blocked job: ${wait}`)).toBe(
      `The job was blocked: ${fact}`,
    )
  })

  it('keeps recorded prose and unknown codes as recorded', () => {
    expect(terminalReasonText('Provide the input CSV.')).toBe(
      'Provide the input CSV.',
    )
    expect(terminalReasonText('future_reason_code')).toBe('future_reason_code')
    // An inherited object key is not a known code.
    expect(terminalReasonText('constructor')).toBe('constructor')
  })

  it('reads a reason without a letter or digit as no reason', () => {
    // Two historical Reconstruction failures recorded a log trailer line.
    expect(terminalReasonText('-'.repeat(58))).toBeNull()
    expect(terminalReasonText(' *** ... === \n')).toBeNull()
    expect(terminalReasonText('')).toBeNull()
    expect(terminalReasonText(null)).toBeNull()
    expect(terminalReasonText(undefined)).toBeNull()
    // One readable character keeps the reason, as recorded.
    expect(terminalReasonText('--- exit 1 ---')).toBe('--- exit 1 ---')
    expect(terminalReasonText('  \u00c9chec  ')).toBe('\u00c9chec')
  })
})

describe('terminalMarkerText', () => {
  // Each marker below is what the sidecar's _terminal_job_error_message
  // writes for the job.
  it.each([
    [
      'Resume the interrupted job: stale_sidecar_generation.',
      'The job was interrupted: the job was still queued when Supraspina restarted.',
    ],
    [
      'Resume the interrupted job: stale_process_tree_settled.',
      'The job was interrupted: after a restart, no owned process remained for this job.',
    ],
    [
      'Resume the interrupted job (exit code 143): scheduler_failure.',
      'The job was interrupted (exit code 143) by a scheduler failure.',
    ],
    [
      'Review the withheld job: failure_policy_withheld.',
      'The job was withheld by the failure policy after a failure.',
    ],
    [
      'Resolve the blocked job (exit code 0): reconstruction_output_conflict.',
      'The job was blocked (exit code 0): complete Reconstruction output has no matching current receipt, so Supraspina preserved it.',
    ],
    [
      'Repair job persistence: persistence_error.',
      "Supraspina could not persist the job's state.",
    ],
    [
      'Repair job persistence (exit code 0): persistence_error.',
      "Supraspina could not persist the job's state (exit code 0).",
    ],
    [
      'Refresh the stale job: future_code.',
      'The job has an unknown run state: future_code.',
    ],
    [
      'Investigate the failed job (exit code 2): operator_cancelled.',
      "The job failed (exit code 2): Canceled at the operator's request.",
    ],
  ])('states the coded marker %j as a fact', (marker, fact) => {
    expect(terminalMarkerText(marker)).toBe(fact)
  })

  it('states a missing or separator-only reason as no recorded reason', () => {
    // The log trailer two historical Reconstruction failures recorded.
    expect(
      terminalMarkerText(
        `Investigate the failed job (exit code 1): ${'-'.repeat(58)}.`,
      ),
    ).toBe('The job failed (exit code 1) with no recorded reason.')
    // The sidecar's filler for an empty reason is an order, not a reason.
    expect(
      terminalMarkerText(
        'Investigate the failed job (exit code -9): Review terminal status failed.',
      ),
    ).toBe('The job failed (exit code -9) with no recorded reason.')
    expect(
      terminalMarkerText(
        'Resume the interrupted job: Review terminal status interrupted.',
      ),
    ).toBe('The job was interrupted with no recorded reason.')
    expect(
      terminalMarkerText(
        'Repair job persistence: Review terminal status persistence-error.',
      ),
    ).toBe("Supraspina could not persist the job's state.")
    // A marker with no reason part at all.
    expect(
      terminalMarkerText('Investigate the failed job (exit code 1).'),
    ).toBe('The job failed (exit code 1) with no recorded reason.')
  })

  it('states a recorded reason as the Terminal reason field does', () => {
    expect(
      terminalMarkerText(
        'Investigate the failed job (exit code 137): Increase available memory for recon-all after rc=137; allow at least 32 GB and up to about 80 GB peak.',
      ),
    ).toBe(
      'The job failed (exit code 137): recon-all ran out of memory (exit code 137); it needs at least 32 GB and up to about 80 GB at peak.',
    )
    expect(
      terminalMarkerText(
        'Investigate the failed job (exit code 1): Retry the reconstruction; recon-all refused to start because an interrupted run left scripts/IsRunning behind. Supraspina removes that marker before continuing a subject when no recon-all is running for it.',
      ),
    ).toBe(
      'The job failed (exit code 1): recon-all refused to start because an interrupted run left scripts/IsRunning behind. Supraspina removes that marker before continuing a subject when no recon-all is running for it.',
    )
    // The sidecar records the fact and names the missing file.
    expect(
      terminalMarkerText(
        'Investigate the failed job (exit code 127): An unexpected error (ValueError) ended the job. Provide the clinical metadata CSV at /p/metadata.csv with the participant_id, Cohort, and AIS columns.',
      ),
    ).toBe(
      'The job failed (exit code 127): An unexpected error (ValueError) ended the job. Provide the clinical metadata CSV at /p/metadata.csv with the participant_id, Cohort, and AIS columns.',
    )
    expect(
      terminalMarkerText(
        'Investigate the failed job (exit code 1): Inspect process exit code 1.',
      ),
    ).toBe('The job failed (exit code 1): The process exited with code 1.')
    // A reason without a closing full stop gains one.
    expect(terminalMarkerText('Investigate the failed job: disk full')).toBe(
      'The job failed: disk full.',
    )
    expect(
      terminalMarkerText(
        'Resolve the blocked job: Reconstruction failed, so this step did not run.',
      ),
    ).toBe(
      'The job was blocked: Reconstruction failed, so this step did not run.',
    )
    // Only a known code's fact continues the outcome clause.
    expect(
      terminalMarkerText('Resolve the blocked job: Blocked by the QC gate.'),
    ).toBe('The job was blocked: Blocked by the QC gate.')
    // A blocked ENIGMA QC job.
    expect(
      terminalMarkerText(
        'Resolve the blocked job: Rerun recon before enigma because no matching current provenance receipt exists.',
      ),
    ).toBe(
      'The job was blocked: Reconstruction has no current receipt for ENIGMA QC.',
    )
  })

  it('leaves any other error line to the caller', () => {
    for (const line of [
      'Inspect the spawn failure: No such file or directory.',
      'oom_killed: Increase available memory for recon-all.',
      'Resume the interrupted jobs: stale_sidecar_generation.',
      'Investigate the failed job (exit code one): x.',
      'Note: Investigate the failed job (exit code 1): x.',
      'Investigate the failed job',
      '',
    ]) {
      expect(terminalMarkerText(line)).toBeNull()
    }
  })
})

describe('restateLogLine', () => {
  // Each whole line a bundled stage tool or the sidecar writes as an
  // order, with the fact Logs shows for it.
  it.each([
    // From resources/step8/aggregate_stats.py and
    // resources/features/extract_features.py.
    ['Process 82 discovered subjects.', 'Found 82 subjects.'],
    ['Process 1 discovered subjects.', 'Found 1 subject.'],
    [
      'Review /data/study/derivatives/step8/wm_volumes.csv with 82 rows and 70 structures.',
      'Wrote /data/study/derivatives/step8/wm_volumes.csv: 82 rows and 70 structures.',
    ],
    [
      'Review /p/dk_all_stats.csv with 82 rows and 213 columns.',
      'Wrote /p/dk_all_stats.csv: 82 rows and 213 columns.',
    ],
    [
      'Review /p/concatenated_results.csv with 82 rows and 150 features.',
      'Wrote /p/concatenated_results.csv: 82 rows and 150 features.',
    ],
    [
      'Review /p/a folder/icv.csv with 1 rows and 1 columns.',
      'Wrote /p/a folder/icv.csv: 1 row and 1 column.',
    ],
    ['Review /p/icv.csv with 82 rows.', 'Wrote /p/icv.csv: 82 rows.'],
    // From resources/pybrainage/predict.py.
    [
      'Review /p/predicted_results.csv with 82 subjects.',
      'Wrote /p/predicted_results.csv: 82 subjects.',
    ],
    [
      'Retry with the ROI-name convention after the scaler rejects the FreeSurfer column names.',
      'The scaler rejected the FreeSurfer column names; retrying with the ROI-name convention.',
    ],
    [
      'Retry the failed whole-cohort model call row by row.',
      'The whole-cohort model call failed; retrying row by row.',
    ],
    // From resources/enigma/outliers_qc.R.
    [
      'Review outliers.csv (4 flagged) and histograms in /p/outliers.',
      'Wrote outliers.csv (4 flagged) and histograms in /p/outliers.',
    ],
    // From resources/step9/FreesurferAnalysisScript.R.
    [
      'Review the completed Step 9 results in /p/.step9-generation-1.',
      'Wrote the Step 9 results in /p/.step9-generation-1.',
    ],
    // Failure lines of the extraction and aggregation tools.
    [
      'Review the failed aparcstats2table lh call: exit 1.',
      'The aparcstats2table lh call failed: exit 1.',
    ],
    [
      'Review the failed asegstats2table call: ERROR: cannot find aseg.stats.',
      'The asegstats2table call failed: ERROR: cannot find aseg.stats.',
    ],
    [
      'Review the aggregation failure: could not parse lh.aparc.stats.',
      'The aggregation failed: could not parse lh.aparc.stats.',
    ],
    // The sidecar's replay warning feeds its replay ids.
    [
      'Review only the bounded restart replay; expect earlier log content to be omitted.',
      'The restart replay is bounded, so earlier log content is omitted.',
    ],
    // The clinical merge fills Subject_ID from the join key after its
    // empty-column check.
    [
      'clinical-merge: no value for Subject_ID; every analysis that reads these columns will be empty.',
      'clinical-merge: the metadata supplies no Subject_ID values; the workbook takes Subject_ID from the join key unless the metadata has a Subject_ID column.',
    ],
    [
      'clinical-merge: no value for Subject_ID, Sex, Time since SCI (years); every analysis that reads these columns will be empty.',
      'clinical-merge: no value for Sex, Time since SCI (years); every analysis that reads these columns will be empty. The metadata supplies no Subject_ID values; the workbook takes Subject_ID from the join key unless the metadata has a Subject_ID column.',
    ],
    [
      'clinical-merge: no value for Sex, AIS; every analysis that reads these columns will be empty.',
      'clinical-merge: no value for Sex, AIS; every analysis that reads these columns will be empty.',
    ],
  ])('states the line %j as a fact', (line, fact) => {
    for (const level of ['INFO', 'WARN']) {
      expect(restateLogLine(line, level)).toBe(fact)
    }
  })

  it('leaves the lines the sidecar and the tools now write as written', () => {
    for (const line of [
      'An unexpected error (ValueError) ended the job. Reduce the metadata projection source size.',
      'Published the complete Step 9 generation at /p/step9.',
      'Excluded 2 subject(s) without a chronological age from Brain-PAD statistics: sub-1, sub-2',
    ]) {
      expect(restateLogLine(line, 'INFO')).toBe(line)
    }
  })

  it('matches only the whole line, so tool output reads as written', () => {
    for (const line of [
      'Note: Process 82 discovered subjects.',
      'Process 82 discovered subjects. Done.',
      'Review the log file.',
      'Review /p/x.csv with many rows.',
      'recon-all: Inspect process exit code 1.',
      'Provide 150 feature columns for the aparc.a2009s thickness contract; found 148.',
      '',
    ]) {
      expect(restateLogLine(line, 'INFO')).toBe(line)
    }
  })

  it('states an error line as its outcome or a restated reason', () => {
    expect(
      restateLogLine(
        'Investigate the failed job (exit code 1): Inspect process exit code 1.',
        'ERROR',
      ),
    ).toBe('The job failed (exit code 1): The process exited with code 1.')
    expect(
      restateLogLine(
        'Inspect the spawn failure: Rerun recon before enigma because no matching current provenance receipt exists.',
        'ERROR',
      ),
    ).toBe(
      'Inspect the spawn failure: Reconstruction has no current receipt for ENIGMA QC.',
    )
    // A progress line at the error level is not a tool's progress line.
    expect(restateLogLine('Process 82 discovered subjects.', 'ERROR')).toBe(
      'Process 82 discovered subjects.',
    )
    // The blocked job's line in the stream, which search reads too.
    expect(
      restateLogLine(
        'Resolve the blocked job: Rerun recon before aggregate because no matching current provenance receipt exists.',
        'ERROR',
      ),
    ).toBe(
      'The job was blocked: Reconstruction has no current receipt for Structural data aggregation.',
    )
  })
})

describe('isInputLimitReason', () => {
  it.each([
    ['Keep the brain mask away from every crop face.', true],
    ['Keep brain mask bounds inside the source image.', true],
    ['Retain 15 mm around both brain mask crop faces.', true],
    ['Retain 15 mm around all six planned crop faces.', true],
    ['Fit the brain plus 15 mm minimum margins within 256 mm.', true],
    ['The process exited with code 1.', false],
    ['Inspect the failed brain-FOV preparation.', false],
    [null, false],
  ] as const)('reads %j as an input limit: %s', (reason, limit) => {
    // A Brain FOV crop refusal follows from the source
    // image, so Resume on the same input fails the same way.
    expect(isInputLimitReason(reason)).toBe(limit)
  })
})
