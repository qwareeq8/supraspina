import { PIPELINE_STEPS } from '../../shared/steps'

/**
 * Readable facts for the machine codes the sidecar records as a job's
 * `terminalReason`. A failed or blocked job records operator prose instead,
 * which passes through unchanged, except the orders that the readiness check,
 * the planner, and the bundled stage tools record (see
 * {@link restateRecordedReasons}).
 */
const TERMINAL_REASON_TEXT: ReadonlyMap<string, string> = new Map([
  ['completed', 'Completed with a validated receipt.'],
  ['dry_run', 'Dry run: the command was planned and not executed.'],
  ['operator_cancelled', "Canceled at the operator's request."],
  [
    'operator_cancelled_before_start',
    "Canceled at the operator's request before it started.",
  ],
  ['operator_cancellation_requested', 'The operator requested cancellation.'],
  [
    'auto_fallback_superseded',
    'Superseded by the cohort-wide FastSurfer fallback.',
  ],
  [
    'auto_fallback_cancellation_requested',
    'Cancellation is requested so the cohort-wide FastSurfer fallback can start.',
  ],
  [
    'failure_policy_withheld',
    'Withheld by the failure policy after a failure.',
  ],
  [
    'reconstruction_output_conflict',
    'Blocked: complete Reconstruction output has no matching current receipt, so Supraspina preserved it.',
  ],
  ['scheduler_failure', 'Interrupted by a scheduler failure.'],
  ['persistence_error', "Supraspina could not persist this job's state."],
  [
    'external_process_may_still_be_active',
    'An external process may still be active; Supraspina could not confirm that it ended.',
  ],
  [
    'stale_sidecar_generation',
    'Interrupted: the job was still queued when Supraspina restarted.',
  ],
  [
    'stale_process_tree_settled',
    'Interrupted: after a restart, no owned process remained for this job.',
  ],
  [
    'process_tree_unverified',
    "After a restart, Supraspina could not verify that this job's processes ended.",
  ],
])

/**
 * The sentences of the sidecar's plan and run summaries that count workflow
 * nodes, and the default reason of a node blocked without an upstream one.
 * A summary enters the plan digest, so the sidecar keeps its wording and
 * the app reads it in jobs, as every other surface counts work. A summary's
 * lead-in opens the text, so another sentence that orders a resolve reads as
 * recorded.
 */
const NODE_WORDING =
  /^Resolve (\d+) blocked nodes?\.|^This pass runs (\d+) nodes?( \(\d+ waiting on dependencies\))?; (\d+) blocked nodes? will not run\.|\bNo work is scheduled: (?:the 1 node is|all (\d+) nodes are) current\.|\bThe blocked (node records|nodes record) no reason\.|\bCreate a runnable upstream node\./g

/** Count `count` jobs, or blocked jobs, in the singular or plural. */
function jobCount(count: string, noun = 'job'): string {
  return `${count} ${noun}${count === '1' ? '' : 's'}`
}

/** State one {@link NODE_WORDING} sentence in jobs. */
function jobWording(
  match: string,
  resolve: string | undefined,
  active: string | undefined,
  waiting: string | undefined,
  blocked: string | undefined,
  current: string | undefined,
  noReason: string | undefined,
): string {
  if (resolve !== undefined) {
    return `Resolve ${jobCount(resolve, 'blocked job')}.`
  }
  if (active !== undefined && blocked !== undefined) {
    return `This pass runs ${jobCount(active)}${waiting ?? ''}; ${jobCount(blocked, 'blocked job')} will not run.`
  }
  if (match.endsWith(' current.')) {
    return current === undefined
      ? 'No work is scheduled: the 1 job is current.'
      : `No work is scheduled: all ${current} jobs are current.`
  }
  if (noReason !== undefined) {
    return noReason === 'node records'
      ? 'The blocked job records no reason.'
      : 'The blocked jobs record no reason.'
  }
  return 'Create a runnable upstream job.'
}

/** The name the app gives a stage, or undefined for a key that is none. */
function knownStageName(stepKey: string): string | undefined {
  return PIPELINE_STEPS.find((step) => step.key === stepKey)?.name
}

/**
 * State an order that names a producing and a consuming stage by their keys
 * as the fact `state` words with their names; a match that names a key that
 * is not a stage reads as recorded.
 */
function betweenStages(
  state: (producer: string, consumer: string) => string,
): (match: string, producerKey: string, consumerKey: string) => string {
  return (match, producerKey, consumerKey) => {
    const producer = knownStageName(producerKey)
    const consumer = knownStageName(consumerKey)
    return producer === undefined || consumer === undefined
      ? match
      : state(producer, consumer)
  }
}

/** A fact that replaces a matched order: text with `$n` groups, or a function. */
type OrderFact = string | ((match: string, ...groups: string[]) => string)

/**
 * The facts for the orders a recorded reason can quote, each matched as the
 * exact sentence, anywhere in the text. The sidecar's readiness check
 * (`_producer_ready`, and the plan-time integrity check beside it) records
 * the first group: a stage plan's blocked nodes carry it into the plan and
 * its digest, so the sidecar keeps the text, and a stage key it names reads
 * as the stage's name. The planner records the second group for a node whose
 * dependency is blocked (`_propagate_blocked_dependencies` in
 * `sidecar/supraspina_sidecar/workflow.py`): the node and a dependency
 * blocker in the plan, and so its digest, carry it, and it reads as the
 * dependency it is, since waiting never clears a blocked stage. The bundled
 * stage tools (the stage adapters' failure messages) record the third group:
 * their files are bound into receipts, so the text is restated here rather
 * than changed there. Any other order reads as recorded.
 *
 * A stage tool's remedy reads as its fact when the message also states the
 * cause, as the out-of-memory and stale-marker messages of Reconstruction
 * do: every surface that shows a failure reason states what happened (the
 * Terminal reason, the job's error line, the Runs notice and stage card, the
 * Dashboard), and the action sits beside it as Retry job, Resume, or
 * Clean up and retry. A remedy with no cause to state, such as "Provide a
 * valid FreeSurfer license.txt in $FREESURFER_HOME or set FS_LICENSE.",
 * reads as recorded: it is the actionable error.
 */
const RECORDED_ORDER_FACTS: readonly (readonly [RegExp, OrderFact])[] = [
  // The readiness check, which enters the plan digest. A consumer is blocked
  // when a producer it reads has no receipt for the current inputs, or when
  // the producer's output no longer matches the receipt it has.
  [
    /Rerun ([\w-]+) before ([\w-]+) because no matching current provenance receipt exists\./g,
    betweenStages(
      (producer, consumer) =>
        `${producer} has no current receipt for ${consumer}.`,
    ),
  ],
  [
    /Restore current ([\w-]+)->([\w-]+) required artifacts\./g,
    betweenStages(
      (producer, consumer) =>
        `The ${producer} output that ${consumer} requires does not match its receipt.`,
    ),
  ],
  // The integrity check fails when a stage's detector cannot tell whether
  // its output is complete; the detector's own detail follows as recorded.
  [
    /Resolve the integrity check failure for ([\w-]+): /g,
    (match, stepKey = '') => {
      const stage = knownStageName(stepKey)
      return stage === undefined
        ? match
        : `The ${stage} integrity check failed: `
    },
  ],
  [/Resolve the integrity check failure: /g, 'The integrity check failed: '],
  [/Recheck unknown detector evidence\./g, 'The detector evidence is unknown.'],
  [
    /Run the detector again after (\w+)\./g,
    'The detector failed with an unexpected error ($1).',
  ],
  // The planner's reason for a node whose dependency is blocked, which names
  // that stage and the root cause once: the blocked stage itself, or, down a
  // chain of dependents, the stage the chain starts at.
  [
    /\bWait for ([^,.:]+), which is blocked: /g,
    'Depends on $1, which is blocked: ',
  ],
  [/\bWait for ([^,.:]+)\. (?=[^,.:]+ is blocked: )/g, 'Depends on $1. '],
  // Stage adapters, bound into receipts.
  [/Inspect process exit code (-?\d+)\./g, 'The process exited with code $1.'],
  // The Brain FOV helper (brainfov.py plan_crop) refuses an uncapped crop
  // when a face of the brain mask has no clearance, which happens only where
  // the mask reaches the source image's edge: the acquisition truncates the
  // brain, and no crop can add the margin.
  [
    /Keep the brain mask away from every crop face\./g,
    'The brain reaches the edge of the source image, so no crop can keep the required margin; the scan does not cover the whole brain.',
  ],
  [
    /Increase available memory for recon-all after rc=137; allow at least 32 GB and up to about 80 GB peak\./g,
    'recon-all ran out of memory (exit code 137); it needs at least 32 GB and up to about 80 GB at peak.',
  ],
  [
    /Increase available memory for recon-all; ([^;.]+?) was killed by signal 9,/g,
    'recon-all ran out of memory; $1 was killed by signal 9,',
  ],
  // Its next sentence, kept as recorded, says that Supraspina removes the
  // marker when it continues the subject, which is what a retry does.
  [
    /Retry the reconstruction; recon-all refused to start because an interrupted run left scripts\/IsRunning behind\./g,
    'recon-all refused to start because an interrupted run left scripts/IsRunning behind.',
  ],
  [
    /Inspect the failed surface topology correction\./g,
    'Surface topology correction failed.',
  ],
  [/Inspect the failed surface inflation\./g, 'Surface inflation failed.'],
  [
    /Inspect the failed white-surface generation\./g,
    'White-surface generation failed.',
  ],
  [
    /Inspect the failed FreeSurfer stats2table call\./g,
    'The FreeSurfer stats2table call failed.',
  ],
  [
    /Inspect the failed brain-FOV preparation\./g,
    'Brain-FOV preparation failed.',
  ],
  // The R analysis adapter (final.py parse_failure) records this remedy for any
  // "cannot open file" or "no such file" line in R's output, so it also
  // covers files that exist but cannot be opened, such as a read-only report
  // template. State only what R reported; the job log names the file.
  [
    /Provide every structural CSV and metadata\.csv input\./g,
    'R could not open a file it reads; the job log names the file and the cause.',
  ],
]

/** A letter or digit: a reason without one says nothing. */
const READABLE = /[\p{L}\p{N}]/u

/** How an error marker states one terminal job outcome. */
interface MarkerOutcome {
  /** The clause that states the outcome, before any exit code or reason. */
  readonly lead: string
  /**
   * The word that opens a known code's fact when the fact already names this
   * outcome, such as "Interrupted: the job was still queued ...".
   */
  readonly word?: string
  /** The code whose fact only restates this outcome. */
  readonly restatedBy?: string
}

/**
 * The outcome each error marker states, by the order the sidecar opens it
 * with. The sidecar's `_terminal_job_error_message` in
 * `sidecar/supraspina_sidecar/workflow_manager.py` writes one marker per job
 * that ended in an error status, as "<order>[ (exit code N)]: <reason>.";
 * a sidecar test keeps the orders in step.
 */
const TERMINAL_MARKER_OUTCOME: ReadonlyMap<string, MarkerOutcome> = new Map([
  ['Investigate the failed job', { lead: 'The job failed' }],
  ['Resolve the blocked job', { lead: 'The job was blocked', word: 'Blocked' }],
  [
    'Review the withheld job',
    { lead: 'The job was withheld', word: 'Withheld' },
  ],
  [
    'Resume the interrupted job',
    { lead: 'The job was interrupted', word: 'Interrupted' },
  ],
  ['Refresh the stale job', { lead: 'The job has an unknown run state' }],
  [
    'Repair job persistence',
    {
      lead: "Supraspina could not persist the job's state",
      restatedBy: 'persistence_error',
    },
  ],
])

/**
 * A whole error marker: its order, the optional exit code, then the recorded
 * reason after a colon, or a bare full stop.
 */
const TERMINAL_MARKER = new RegExp(
  `^(${[...TERMINAL_MARKER_OUTCOME.keys()].join('|')})` +
    String.raw`(?: \(exit code (-?\d+)\))?(?:: ([\s\S]*)|\.)$`,
)

/** The text the sidecar puts in a marker in place of a missing reason. */
const MARKER_REASON_FILLER = /^Review terminal status [\w-]+\.$/

/** A fact that continues an outcome clause, after the word it drops. */
const OUTCOME_CONTINUATION = /^(?::\s|\s|\.$)/

/**
 * Restate each order the readiness check, the planner's dependency wait, or a
 * stage tool recorded as its fact (see {@link RECORDED_ORDER_FACTS}), and the
 * sidecar's sentences that count workflow nodes in jobs (see
 * {@link NODE_WORDING}). Any other text is returned unchanged.
 *
 * @param text - A recorded reason or a run summary that may quote one.
 * @example
 * restateRecordedReasons(
 *   'Rerun recon before enigma because no matching current provenance receipt exists.',
 * )
 * // "Reconstruction has no current receipt for ENIGMA QC."
 * restateRecordedReasons(
 *   'Resolve 2 blocked nodes. The blocked nodes record no reason.',
 * )
 * // "Resolve 2 blocked jobs. The blocked jobs record no reason."
 */
export function restateRecordedReasons(text: string): string {
  const restated = RECORDED_ORDER_FACTS.reduce(
    // The two branches differ only in type: String.replace has no overload
    // for a union of a replacement string and a replacer function.
    (current, [order, fact]) =>
      typeof fact === 'string'
        ? current.replace(order, fact)
        : current.replace(order, fact),
    text,
  )
  return restated.replace(NODE_WORDING, jobWording)
}

/**
 * The lead-in the sidecar's `_state_summary` gives the summary of a pass in
 * which nothing runs, "Resolve 2 blocked nodes.", with the count it captures.
 * The summary is part of the plan and enters its digest, so the sidecar keeps
 * the text and it is restated for display here.
 */
const BLOCKED_PASS_LEAD_IN = /^Resolve (\d+) blocked jobs?\.(?=\s|$)/

/**
 * The lead-in of a stated summary that counts blocked nodes, as
 * {@link runSummaryText} states a pass in which nothing runs and as the
 * sidecar writes a pass that runs some work; the first blocked reason
 * follows it.
 */
const STATED_BLOCKED_LEAD_IN =
  /^(?:No work is scheduled: \d+ jobs? (?:is|are) blocked\.|This pass runs [^.]*; \d+ blocked jobs? will not run\.)\s+/

/**
 * A plan node or job that may not have run, with the reason it records: a
 * plan node's `reason`, or a job's `terminalReason`.
 */
export interface NotRunRecord {
  readonly stepKey: string
  readonly subjectId: string | null
  readonly status: string
  readonly reason?: string | null | undefined
}

/**
 * The statuses of work that did not run, whose reasons a run summary quotes.
 * See `_state_summary` in the sidecar workflow manager.
 */
export const NOT_RUN_STATUSES: ReadonlySet<string> = new Set([
  'blocked',
  'withheld',
  'stale',
])

/** How many subject identifiers a sentence names before counting the rest. */
const NAMED_SUBJECTS = 3

/**
 * Name subjects in order: "sub-1", "sub-1 and sub-2", "sub-1, sub-2, and
 * sub-3", or the first three and a count of the rest.
 */
function subjectsPhrase(subjects: readonly string[]): string {
  const named = subjects.slice(0, NAMED_SUBJECTS)
  const rest = subjects.length - named.length
  const items =
    rest > 0
      ? [...named, `${rest} more subject${rest === 1 ? '' : 's'}`]
      : named
  if (items.length <= 2) return items.join(' and ')
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1) ?? ''}`
}

/**
 * A recorded reason as a summary quotes it: restated, and closed with a full
 * stop as the sidecar closes it there.
 */
function quotedReason(reason: string): string {
  const text = restateRecordedReasons(reason.trim())
  return /[.!?]$/.test(text) ? text : `${text}.`
}

/**
 * Name the stage and the subjects a blocked reason belongs to, before the
 * reason. A run summary quotes the first blocked reason without the nodes it
 * belongs to, and a subject's reason, such as the Reconstruction output
 * conflict ("Choose a fresh derivatives namespace because ..."), names no
 * subject; the nodes and jobs that record it do. The reason reads as
 * recorded after the name: a plan-time remedy may be an order, and it enters
 * the plan digest.
 *
 * @param text - A reason as a summary quotes it after its lead-in, restated,
 *   with any count of further reasons after it.
 * @param records - The plan nodes and jobs of the plan or run; only those
 *   that did not run are read.
 * @returns "<stage> for <subjects>: <text>" when every record that did not
 *   run and states the reason belongs to one stage and names a subject;
 *   otherwise the text unchanged, since a cohort node or a second stage
 *   leaves the subjects unattributable.
 * @example
 * nameBlockedSubjects('Choose a fresh derivatives namespace because ...', [
 *   { stepKey: 'recon', subjectId: 'sub-902', status: 'blocked',
 *     reason: 'Choose a fresh derivatives namespace because ...' },
 * ]) // "Reconstruction for sub-902: Choose a fresh derivatives namespace ..."
 */
export function nameBlockedSubjects(
  text: string,
  records: readonly NotRunRecord[],
): string {
  const stating = records.flatMap((record) => {
    if (!NOT_RUN_STATUSES.has(record.status)) return []
    if (!READABLE.test(record.reason ?? '')) return []
    const quoted = quotedReason(record.reason ?? '')
    return text === quoted || text.startsWith(`${quoted} `)
      ? [{ record, quoted }]
      : []
  })
  // One reason can open another; the text quotes the longest.
  const longest = Math.max(0, ...stating.map(({ quoted }) => quoted.length))
  const owners = stating
    .filter(({ quoted }) => quoted.length === longest)
    .map(({ record }) => record)
  const stepKey = owners[0]?.stepKey
  const stage = stepKey === undefined ? undefined : knownStageName(stepKey)
  if (
    stage === undefined ||
    owners.some(
      (record) => record.subjectId === null || record.stepKey !== stepKey,
    )
  ) {
    return text
  }
  const subjects = [
    ...new Set(owners.map((record) => record.subjectId ?? '')),
  ].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  return `${stage} for ${subjectsPhrase(subjects)}: ${text}`
}

/**
 * State a plan's summary for display. The summary of a pass in which nothing
 * runs opens with an order to resolve the blocked nodes, which reads as the
 * fact beside the no-work summary ("No work is scheduled: all 288 nodes are
 * current."): no work is scheduled, and how many nodes are blocked. The
 * reason after it reads as {@link restateRecordedReasons} states it, and the
 * action stays with the outcome's View blockers and recovery controls. Given
 * the plan's nodes, the reason after a blocked count names the stage and
 * subjects it belongs to (see {@link nameBlockedSubjects}). Any other
 * summary, such as "No work is scheduled: all 288 nodes are current.", reads
 * as written.
 *
 * @param message - A plan or run summary's message as the sidecar wrote it.
 * @param records - The plan's nodes, to name the subjects of the reason;
 *   none leaves the reason as it reads.
 * @example
 * runSummaryText(
 *   'Resolve 2 blocked nodes. Reconstruction failed, so this step did not run.',
 * )
 * // "No work is scheduled: 2 jobs are blocked. Reconstruction failed, so
 * // this step did not run."
 */
export function runSummaryText(
  message: string,
  records: readonly NotRunRecord[] = [],
): string {
  // Restate the recorded reasons first, so the lead-in counts jobs.
  const stated = restateRecordedReasons(message).replace(
    BLOCKED_PASS_LEAD_IN,
    (_lead: string, count: string) =>
      `No work is scheduled: ${count === '1' ? '1 job is' : `${count} jobs are`} blocked.`,
  )
  const lead = STATED_BLOCKED_LEAD_IN.exec(stated)?.[0]
  return lead === undefined
    ? stated
    : lead + nameBlockedSubjects(stated.slice(lead.length), records)
}

/**
 * The Brain FOV helper's crop-planning refusals (brainfov.py plan_crop and
 * _bounded_crop_axis), recorded as the job's terminal reason. Each follows
 * from the source image's geometry and the configured margins, so a retry on
 * the same input repeats the same check and fails the same way.
 */
const INPUT_LIMIT_REASONS: readonly RegExp[] = [
  /^Keep the brain mask away from every crop face\.$/,
  /^Keep brain mask bounds inside the source image\.$/,
  /^Retain [\d.]+ mm around (?:both brain mask|all six planned) crop faces\.$/,
  /^Fit the brain plus [\d.]+ mm minimum margins within [\d.]+ mm\.$/,
]

/**
 * Whether a job's terminal reason is an input limit: a refusal that follows
 * from the input itself, which a retry on the same input repeats.
 *
 * @example
 * isInputLimitReason('Keep the brain mask away from every crop face.') // true
 */
export function isInputLimitReason(reason: string | null | undefined): boolean {
  const recorded = reason?.trim() ?? ''
  return INPUT_LIMIT_REASONS.some((limit) => limit.test(recorded))
}

/**
 * State a job's terminal reason for display. A known machine code becomes its
 * readable fact, and an order that the readiness check, the planner, or a
 * stage tool recorded reads as its fact; any other text, including an unknown
 * code, is shown as recorded so no reason is hidden. A reason with no letter
 * or digit, such as a line of dashes captured from a log trailer, reads as no
 * reason at all.
 *
 * @returns The text to show for it, or null when there is no reason to show.
 * @example
 * terminalReasonText('operator_cancelled') // "Canceled at the operator's request."
 * terminalReasonText('----------') // null
 */
export function terminalReasonText(
  reason: string | null | undefined,
): string | null {
  const text = reason?.trim() ?? ''
  if (!READABLE.test(text)) return null
  return TERMINAL_REASON_TEXT.get(text) ?? restateRecordedReasons(text)
}

/**
 * State the error marker the sidecar writes for a job that ended in an error
 * status as a fact. The marker opens with an order and quotes the recorded
 * reason, raw code included, so it is restated here with the outcome and the
 * reason as the Terminal reason field shows it: a known code reads as its
 * fact, a reason with no letter or digit as no recorded reason, and a
 * recorded order as its fact. The sidecar keys its log replay and deduplication on the marker
 * as written, so only the text shown changes.
 *
 * @param line - A log line at the error level.
 * @returns The restated marker, or null when the line is not a marker.
 * @example
 * terminalMarkerText('Investigate the failed job (exit code 1): -----.')
 * // "The job failed (exit code 1) with no recorded reason."
 * terminalMarkerText('Resume the interrupted job: scheduler_failure.')
 * // "The job was interrupted by a scheduler failure."
 */
export function terminalMarkerText(line: string): string | null {
  const match = TERMINAL_MARKER.exec(line)
  const outcome = match ? TERMINAL_MARKER_OUTCOME.get(match[1] ?? '') : null
  if (!match || !outcome) return null
  const exitCode = match[2]
  const opening =
    exitCode === undefined
      ? outcome.lead
      : `${outcome.lead} (exit code ${exitCode})`
  const reason = match[3]?.trim() ?? ''
  // The sidecar ends a marker with a full stop, so a code arrives with one.
  const code = reason.replace(/\.$/, '')
  if (code === outcome.restatedBy) return `${opening}.`
  const fact = TERMINAL_REASON_TEXT.get(code)
  if (fact !== undefined && outcome.word && fact.startsWith(outcome.word)) {
    // "Interrupted by a scheduler failure." continues "The job was
    // interrupted" instead of repeating it.
    const rest = fact.slice(outcome.word.length)
    if (OUTCOME_CONTINUATION.test(rest)) return `${opening}${rest}`
  }
  const stated =
    fact ??
    (MARKER_REASON_FILLER.test(reason) ? null : terminalReasonText(reason))
  if (stated === null) {
    return outcome.restatedBy === undefined
      ? `${opening} with no recorded reason.`
      : `${opening}.`
  }
  return /[.!?]$/.test(stated)
    ? `${opening}: ${stated}`
    : `${opening}: ${stated}.`
}

/** State a count of things, singular for one. */
function counted(count: string, noun: string): string {
  return `${count} ${noun}${count === '1' ? '' : 's'}`
}

/**
 * State the clinical merge's empty-column warning without its Subject_ID
 * false alarm: the merge fills Subject_ID from the join key after the check
 * unless the metadata carries a Subject_ID column of its own.
 */
function clinicalMergeGapFact(list: string): string {
  const columns = list.split(', ')
  const empty = columns.filter((column) => column !== 'Subject_ID')
  if (empty.length === columns.length) {
    return `clinical-merge: no value for ${list}; every analysis that reads these columns will be empty.`
  }
  const subjectId =
    'metadata supplies no Subject_ID values; the workbook takes Subject_ID from the join key unless the metadata has a Subject_ID column.'
  if (empty.length === 0) return `clinical-merge: the ${subjectId}`
  return `clinical-merge: no value for ${empty.join(', ')}; every analysis that reads these columns will be empty. The ${subjectId}`
}

/**
 * The facts for the whole log lines that read as orders, each matched
 * against the entire line. The bundled stage tools write the progress and
 * failure lines to their output (`resources/step8/aggregate_stats.py`,
 * `resources/features/extract_features.py`, `resources/pybrainage/predict.py`,
 * `resources/enigma/outliers_qc.R`, `resources/step9/FreesurferAnalysisScript.R`);
 * their files are bound into receipts, so the text is restated here. The
 * sidecar writes the bounded-replay warning, whose text its log replay ids
 * hash. The clinical merge (whose script its command, and so its receipts, carry)
 * checks for empty columns before it fills Subject_ID from the join key, so
 * its warning lists Subject_ID whenever the metadata has no such column.
 */
const LOG_LINE_FACTS: readonly (readonly [
  RegExp,
  (...groups: string[]) => string,
])[] = [
  [
    /^clinical-merge: no value for (.+); every analysis that reads these columns will be empty\.$/,
    (list = '') => clinicalMergeGapFact(list),
  ],
  [
    /^Process (\d+) discovered subjects\.$/,
    (n = '') => `Found ${counted(n, 'subject')}.`,
  ],
  [
    /^Review (.+) with (\d+) rows and (\d+) (column|structure|feature)s\.$/,
    (path = '', rows = '', n = '', unit = '') =>
      `Wrote ${path}: ${counted(rows, 'row')} and ${counted(n, unit)}.`,
  ],
  [
    /^Review (.+) with (\d+) (row|subject)s\.$/,
    (path = '', n = '', unit = '') => `Wrote ${path}: ${counted(n, unit)}.`,
  ],
  [
    /^Review outliers\.csv \((\d+) flagged\) and histograms in (.+)\.$/,
    (n = '', dir = '') =>
      `Wrote outliers.csv (${n} flagged) and histograms in ${dir}.`,
  ],
  [
    /^Review the completed Step 9 results in (.+)\.$/,
    (dir = '') => `Wrote the Step 9 results in ${dir}.`,
  ],
  [
    /^Retry with the ROI-name convention after the scaler rejects the FreeSurfer column names\.$/,
    () =>
      'The scaler rejected the FreeSurfer column names; retrying with the ROI-name convention.',
  ],
  [
    /^Retry the failed whole-cohort model call row by row\.$/,
    () => 'The whole-cohort model call failed; retrying row by row.',
  ],
  [
    /^Review the failed (.+?) call: (.*)\.$/,
    (label = '', detail = '') => `The ${label} call failed: ${detail}.`,
  ],
  [
    /^Review the aggregation failure: (.*)\.$/,
    (detail = '') => `The aggregation failed: ${detail}.`,
  ],
  [
    /^Review only the bounded restart replay; expect earlier log content to be omitted\.$/,
    () => 'The restart replay is bounded, so earlier log content is omitted.',
  ],
]

/**
 * State a log line for display and search. An error line that is the
 * sidecar's marker for a job's outcome reads as that outcome (see
 * {@link terminalMarkerText}), and any other error line reads a recorded
 * order as its fact. Another line that is exactly an order a stage tool or
 * the sidecar writes reads as its fact; every other line,
 * including the tools' own output, is shown as written. The line's identity
 * and recorded text stay as the sidecar sent them.
 *
 * @param line - The log line as recorded.
 * @param level - The line's level, such as "INFO", "WARN", or "ERROR".
 * @returns The text to show and search.
 * @example
 * restateLogLine('Process 82 discovered subjects.', 'INFO') // "Found 82 subjects."
 * restateLogLine(
 *   'Review /p/wm_volumes.csv with 82 rows and 70 structures.',
 *   'INFO',
 * ) // "Wrote /p/wm_volumes.csv: 82 rows and 70 structures."
 */
export function restateLogLine(line: string, level: string): string {
  if (level === 'ERROR') {
    return terminalMarkerText(line) ?? restateRecordedReasons(line)
  }
  for (const [order, fact] of LOG_LINE_FACTS) {
    const match = order.exec(line)
    if (match) return fact(...match.slice(1))
  }
  return line
}
