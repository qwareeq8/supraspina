/**
 * Label subjects with an atlas on demand: how many subjects are labeled and
 * out of date, the estimate per parallel job, the tool facts with the
 * actions that fix them (choosing the subregions Python, the FreeSurfer
 * home, importing existing outputs), the progress of a running labeling
 * with Cancel, each subject's state, and clearing the labels.
 */

import { useState, type ReactNode } from 'react'
import {
  ATLAS_RECIPES,
  IMPORTABLE_RECIPES,
  type AtlasCatalog,
  type AtlasEntry,
  type AtlasLabelOperation,
  type AtlasToolFact,
  type AtlasToolFix,
  type SubjectLabelState,
} from '../../../shared/atlas-labeling'
import type { AtlasLabelingState } from '../../state/atlas-labeling'
import { useApp } from '../../state/context'
import {
  Bar,
  Btn,
  ConfirmDialog,
  FONTS,
  Hint,
  Ico,
  ICONS,
  ICON_SIZE,
} from '../../ui'
import { SelectField } from './controls'
import { durationText } from './measure-sources'
import {
  TEMPLATE_ONLY_ATLASES,
  atlasName,
  factFixes,
  labelingOutcomeText,
  labelingProgressText,
} from './rail-text'

const STATE_TEXT: Readonly<Record<SubjectLabelState, string>> = {
  missing: 'Not labeled',
  queued: 'Queued',
  running: 'Labeling',
  current: 'Labeled',
  stale: 'Out of date',
  provisional: 'Provisional',
  failed: 'Failed',
  skipped: 'Skipped',
}

/** The progress of a running labeling, with Cancel. */
export function LabelingProgress({
  operation,
  label,
  onCancel,
}: {
  operation: AtlasLabelOperation
  label: string
  onCancel: () => void
}): ReactNode {
  const { t } = useApp()
  return (
    <div
      role="status"
      style={{
        display: 'grid',
        gap: 6,
        padding: '8px 10px',
        border: `1px solid ${t.borderSoft}`,
        borderRadius: 5,
        background: t.bg,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: FONTS.sans,
            fontSize: 12,
            fontWeight: 600,
            color: t.text,
          }}
        >
          Labeling {label}
        </span>
        <Btn
          t={t}
          small
          label="Cancel"
          ariaLabel="Cancel the labeling"
          icon={<Ico d={ICONS.stop} size={ICON_SIZE.nav} />}
          onClick={onCancel}
        />
      </div>
      <Bar
        t={t}
        value={operation.completed}
        max={Math.max(1, operation.total)}
        color={t.running}
      />
      <span
        style={{ fontFamily: FONTS.sans, fontSize: 11.5, color: t.textSoft }}
      >
        {labelingProgressText(operation)}
      </span>
    </div>
  )
}

/** One tool fact with the action that fixes it. */
function ToolFact({
  fact,
  fix,
  catalog,
  labeling,
  atlasId,
  importable,
  onOpenDiagnostics,
}: {
  fact: AtlasToolFact
  fix: AtlasToolFix
  catalog: AtlasCatalog
  labeling: AtlasLabelingState
  atlasId: string
  /** Whether the sidecar takes this atlas's outputs from elsewhere. */
  importable: boolean
  onOpenDiagnostics: () => void
}): ReactNode {
  const { t } = useApp()
  const ok = fact.state === 'ok'
  const color = ok ? t.done : fact.state === 'unknown' ? t.dimText : t.warning
  const python =
    fact.toolId === 'subregions-python' ? catalog.subregionsPython : null

  return (
    <li style={{ display: 'grid', gap: 4 }}>
      <span style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <span style={{ display: 'inline-flex', paddingTop: 2, flexShrink: 0 }}>
          <Ico d={ok ? ICONS.circleCheck : ICONS.circleAlert} stroke={color} />
        </span>
        <span
          style={{
            fontFamily: FONTS.sans,
            fontSize: 11.5,
            color: t.text,
            overflowWrap: 'anywhere',
          }}
        >
          {fact.detail}
        </span>
      </span>
      {python && (
        <span
          style={{
            paddingLeft: 18,
            fontFamily: FONTS.mono,
            fontSize: 11,
            color: t.textSoft,
            overflowWrap: 'anywhere',
          }}
        >
          {python}
        </span>
      )}
      {(fix || python) && (
        <span
          style={{ display: 'flex', gap: 6, flexWrap: 'wrap', paddingLeft: 18 }}
        >
          {fix === 'choose-subregions-python' && (
            <Btn
              t={t}
              small
              secondary
              label="Choose Python 3.12..."
              disabled={labeling.busy}
              onClick={() => void labeling.chooseSubregionsPython()}
            />
          )}
          {python && (
            <Btn
              t={t}
              small
              ghost
              label="Clear"
              ariaLabel="Clear the subregions Python"
              disabled={labeling.busy}
              onClick={() => void labeling.clearSubregionsPython()}
            />
          )}
          {fix === 'set-freesurfer-home' && (
            <Btn
              t={t}
              small
              secondary
              label="Open Diagnostics"
              onClick={onOpenDiagnostics}
            />
          )}
          {fix === 'import-outputs' && importable && (
            <Btn
              t={t}
              small
              secondary
              label="Import outputs..."
              disabled={labeling.busy}
              onClick={() => void labeling.importLabels(atlasId)}
            />
          )}
        </span>
      )}
    </li>
  )
}

/** The labeling panel's inputs. */
export interface AtlasLabelingPanelProps {
  entry: AtlasEntry
  catalog: AtlasCatalog
  labeling: AtlasLabelingState
  onOpenDiagnostics: () => void
}

/** Render the labeling controls of one atlas. */
export function AtlasLabelingPanel({
  entry,
  catalog,
  labeling,
  onOpenDiagnostics,
}: AtlasLabelingPanelProps): ReactNode {
  const { t } = useApp()
  const [jobs, setJobs] = useState(2)
  const [statesOpen, setStatesOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  const templateOnly = TEMPLATE_ONLY_ATLASES.has(entry.atlasId)
  // The sidecar takes outputs made elsewhere for these recipes only.
  const importable =
    !templateOnly &&
    entry.recipeId !== null &&
    IMPORTABLE_RECIPES.has(entry.recipeId)
  const recipe = templateOnly
    ? ATLAS_RECIPES.find((item) => item.recipeId === 'template-fsaverage5')
    : ATLAS_RECIPES.find((item) => item.recipeId === entry.recipeId)
  if (!recipe) return null
  const operation = labeling.labeling
  const running = operation?.state === 'running'
  const mine = operation?.atlasId === entry.atlasId
  const facts = catalog.tools.filter((fact) =>
    recipe.tools.includes(fact.toolId),
  )
  const blocked = facts.some(
    (fact) => fact.state === 'missing' || fact.state === 'broken',
  )
  const name = atlasName(entry.label)
  const { counts } = entry
  const missing =
    entry.estimateSeconds !== null && recipe.estimateSeconds > 0
      ? Math.round(entry.estimateSeconds / recipe.estimateSeconds)
      : Math.max(0, counts.total - counts.labeled - counts.stale)
  const estimate = missing * recipe.estimateSeconds
  const subjectStates =
    labeling.subjects?.atlasId === entry.atlasId ? labeling.subjects.load : null

  if (templateOnly) {
    return (
      <div style={{ display: 'grid', gap: 6 }}>
        <Hint t={t}>
          Labeling {name} labels the fsaverage5 template only, for the brain
          view; the measures come from each subject&apos;s own stats.
        </Hint>
        {running && mine ? (
          <LabelingProgress
            operation={operation}
            label={name}
            onCancel={() => void labeling.cancel()}
          />
        ) : (
          <div>
            <Btn
              t={t}
              small
              label="Label the template"
              disabled={labeling.busy || running || blocked}
              onClick={() => void labeling.start(entry.atlasId, 'missing', 1)}
            />
          </div>
        )}
        {facts.length > 0 && blocked && (
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'grid',
              gap: 6,
            }}
          >
            {factFixes(facts).map(({ fact, fix }) => (
              <ToolFact
                key={fact.toolId}
                fact={fact}
                fix={fix}
                catalog={catalog}
                labeling={labeling}
                atlasId={entry.atlasId}
                importable={importable}
                onOpenDiagnostics={onOpenDiagnostics}
              />
            ))}
          </ul>
        )}
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {entry.recipeId === 'user-gcs' || entry.recipeId === 'user-annot' ? (
        <Hint t={t}>
          Labeling maps {name} onto the fsaverage5 template for the brain view,
          then onto each subject.
        </Hint>
      ) : null}
      {running && mine ? (
        <LabelingProgress
          operation={operation}
          label={name}
          onCancel={() => void labeling.cancel()}
        />
      ) : running ? (
        <Hint t={t}>
          Another atlas is being labeled; one labeling runs at a time.
        </Hint>
      ) : (
        <>
          {operation && mine && (
            <span
              role="status"
              style={{
                fontFamily: FONTS.sans,
                fontSize: 11.5,
                color: t.textSoft,
              }}
            >
              {labelingOutcomeText(operation, name)}
            </span>
          )}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) 96px',
              gap: 8,
              alignItems: 'end',
            }}
          >
            <Btn
              t={t}
              small
              primary
              label={
                missing === 0
                  ? 'Every subject is labeled'
                  : `Label ${missing} ${missing === 1 ? 'subject' : 'subjects'} with ${name}`
              }
              disabled={labeling.busy || blocked || missing === 0}
              title={blocked ? 'A tool below must be fixed first.' : undefined}
              onClick={() =>
                void labeling.start(entry.atlasId, 'missing', jobs)
              }
              style={{ justifyContent: 'center' }}
            />
            <SelectField
              label="In parallel"
              value={String(jobs)}
              options={Array.from({ length: 8 }, (_, index) => ({
                value: String(index + 1),
                label: `${index + 1} ${index === 0 ? 'subject' : 'subjects'}`,
              }))}
              onChange={(value) => setJobs(Number(value))}
            />
          </div>
          {missing > 0 && (
            <Hint t={t}>
              Takes {durationText(estimate / jobs)} with {jobs} in parallel.
              Canceling keeps the subjects already labeled; subjects whose recon
              is out of date or running are skipped.
            </Hint>
          )}
          {counts.stale > 0 && (
            <div>
              <Btn
                t={t}
                small
                label={`Relabel ${counts.stale} out of date`}
                disabled={labeling.busy || blocked}
                onClick={() =>
                  void labeling.start(entry.atlasId, 'stale', jobs)
                }
              />
            </div>
          )}
        </>
      )}
      {facts.length > 0 && (
        <ul
          aria-label="Labeling tools"
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'grid',
            gap: 6,
          }}
        >
          {factFixes(facts).map(({ fact, fix }) => (
            <ToolFact
              key={fact.toolId}
              fact={fact}
              fix={fix}
              catalog={catalog}
              labeling={labeling}
              atlasId={entry.atlasId}
              importable={importable}
              onOpenDiagnostics={onOpenDiagnostics}
            />
          ))}
        </ul>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {importable && (
          <Btn
            t={t}
            small
            ghost
            label="Import outputs..."
            title="Import labeling outputs made elsewhere, one folder per subject."
            disabled={labeling.busy || running}
            onClick={() => void labeling.importLabels(entry.atlasId)}
          />
        )}
        <Btn
          t={t}
          small
          ghost
          label="Subject states"
          ariaExpanded={statesOpen}
          ariaControls={`atlas-states-${entry.atlasId}`}
          onClick={() => {
            if (!statesOpen) labeling.readSubjects(entry.atlasId)
            setStatesOpen((value) => !value)
          }}
        />
        {counts.labeled + counts.stale + counts.failed > 0 && (
          <Btn
            t={t}
            small
            ghost
            label="Clear labels..."
            disabled={labeling.busy || running}
            onClick={() => setClearing(true)}
          />
        )}
      </div>
      {statesOpen && (
        <div id={`atlas-states-${entry.atlasId}`}>
          {subjectStates?.phase === 'ready' ? (
            <SubjectStates rows={subjectStates.value} />
          ) : subjectStates?.phase === 'error' ? (
            <Hint t={t} style={{ color: t.failed }}>
              {subjectStates.message}
            </Hint>
          ) : (
            <Hint t={t}>Reading the label states.</Hint>
          )}
        </div>
      )}
      {(entry.license || entry.citation) && (
        <Hint t={t}>
          {entry.license
            ? `License: ${entry.license.name}${
                entry.license.acknowledgedAt
                  ? `, confirmed ${entry.license.acknowledgedAt.slice(0, 10)}`
                  : ''
              }. `
            : ''}
          {entry.citation ? `Cite: ${entry.citation}` : ''}
        </Hint>
      )}
      {clearing && (
        <ConfirmDialog
          t={t}
          title={`Clear the ${name} labels?`}
          message="The labels leave the project's labeling cache; the recon folders are untouched. Stored results that used them become out of date."
          onDismiss={() => setClearing(false)}
          actions={[
            {
              label: 'Cancel',
              onSelect: () => setClearing(false),
              initialFocus: true,
            },
            {
              label: 'Clear labels',
              tone: 'danger',
              onSelect: () => {
                setClearing(false)
                void labeling.clear(entry.atlasId, 'all')
              },
            },
          ]}
        />
      )}
    </div>
  )
}

function SubjectStates({
  rows,
}: {
  rows: readonly {
    subjectId: string
    state: SubjectLabelState
    message: string | null
    provenance: 'labeled' | 'imported' | null
  }[]
}): ReactNode {
  const { t } = useApp()
  const counts = new Map<SubjectLabelState, number>()
  for (const row of rows)
    counts.set(row.state, (counts.get(row.state) ?? 0) + 1)
  const imported = rows.filter((row) => row.provenance === 'imported').length
  const noted = rows.filter(
    (row) =>
      row.state === 'failed' ||
      row.state === 'skipped' ||
      row.state === 'stale',
  )
  return (
    <div
      style={{
        display: 'grid',
        gap: 4,
        padding: '6px 8px',
        border: `1px solid ${t.borderSoft}`,
        borderRadius: 4,
        background: t.bg,
        fontFamily: FONTS.sans,
        fontSize: 11.5,
        color: t.text,
      }}
    >
      <span>
        {[...counts.entries()]
          .map(([state, n]) => `${STATE_TEXT[state]} ${n}`)
          .join(', ')}
        {imported > 0 ? `; ${imported} imported` : ''}
      </span>
      {noted.length > 0 && (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            maxHeight: 140,
            overflowY: 'auto',
            display: 'grid',
            gap: 2,
          }}
        >
          {noted.map((row) => (
            <li key={row.subjectId} style={{ display: 'flex', gap: 8 }}>
              <span style={{ fontFamily: FONTS.mono, flexShrink: 0 }}>
                {row.subjectId}
              </span>
              <span style={{ color: t.dimText }}>
                {STATE_TEXT[row.state]}
                {row.message ? `: ${row.message}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
