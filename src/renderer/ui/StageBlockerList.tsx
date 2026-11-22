import type { ReactNode } from 'react'
import { pipelineStep } from '../../shared/steps'
import { OPEN_REGISTRY_ACTION } from '../state/execution-feedback'
import { restateRecordedReasons } from '../state/terminal-reason'
import type { ReviewBlockerLine } from '../state/workflow-review-state'
import { FONTS, type Theme } from '../theme/tokens'
import { Btn } from './Button'

/** The blocker lines and the recovery destination they can offer. */
export interface StageBlockerListProps {
  t: Theme
  lines: readonly ReviewBlockerLine[]
  /** Open the Registry from a blocker that names affected subjects. */
  onOpenRegistry?: () => void
}

function disclosureLabel(count: number): string {
  return count === 1
    ? 'Show the affected subject'
    : `Show all ${count} subjects`
}

/**
 * Render deduplicated blockers with the complete subjects behind each cause.
 *
 * Lead each line with the blocked stage's name so a reader can tell which
 * stage the sentence is about. The reason reads as {@link restateRecordedReasons}
 * states it, so an order the plan records, such as a readiness reason that
 * names stages by their registry keys, reads as the fact Logs shows; the line
 * keeps the recorded text, which deduplication and the subjects lookup match.
 * The reason samples a bounded number of subject IDs, so the disclosure lists
 * every affected subject the sidecar reported.
 */
export function StageBlockerList({
  t,
  lines,
  onOpenRegistry,
}: StageBlockerListProps): ReactNode {
  return (
    <ul style={{ margin: 0, paddingLeft: 22 }}>
      {lines.map((line, index) => (
        <li key={`${line.key}:${index}`} style={{ marginBottom: 4 }}>
          <strong style={{ fontWeight: 600 }}>
            {pipelineStep(line.key).name}
          </strong>{' '}
          <span>
            {restateRecordedReasons(line.reason)}
            {line.count > 1 ? ` (${line.count} jobs)` : ''}
          </span>
          {line.subjects.length > 0 && (
            <details style={{ marginTop: 2 }}>
              <summary style={{ cursor: 'pointer' }}>
                {disclosureLabel(line.subjects.length)}
              </summary>
              <ul
                aria-label={`Subjects blocked in ${pipelineStep(line.key).name}`}
                // Reach the overflowing list by keyboard as well as by pointer.
                tabIndex={0}
                style={{
                  margin: '4px 0 0',
                  paddingLeft: 22,
                  maxHeight: 160,
                  overflowY: 'auto',
                  fontFamily: FONTS.mono,
                  overflowWrap: 'anywhere',
                }}
              >
                {line.subjects.map((subjectId) => (
                  <li key={subjectId}>{subjectId}</li>
                ))}
              </ul>
            </details>
          )}
          {line.action === OPEN_REGISTRY_ACTION && onOpenRegistry && (
            <div style={{ marginTop: 5 }}>
              <Btn
                t={t}
                small
                secondary
                label="Open Registry"
                onClick={onOpenRegistry}
              />
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}
