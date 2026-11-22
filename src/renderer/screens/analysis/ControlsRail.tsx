/**
 * The Analysis controls: the saved-analysis bar and five sections that edit
 * the spec v2 draft, each headed by what it asks of the operator: the
 * design, the measures (with atlases and labeling), the covariates (with
 * the design check), the subjects, and the inference.
 */

import { useMemo, useState, type ReactNode } from 'react'
import type {
  GroupAnalysisCatalog,
  GroupAnalysisInputs,
  GroupAnalysisSpecV2,
  VariableRefV2,
} from '../../../shared/group-analysis'
import type { AtlasLabelingState } from '../../state/atlas-labeling'
import type { GroupAnalysisState, Load } from '../../state/group-analysis'
import { useApp } from '../../state/context'
import { Btn, ConfirmDialog } from '../../ui'
import { CORRECTION_SHORT } from '../../figures/format'
import { LabelingProgress } from './AtlasLabelingPanel'
import { atlasName } from './rail-text'
import { CovariatePicker } from './CovariatePicker'
import { Notice } from './CurrencyNotice'
import { DesignCheckView } from './DesignCheck'
import { DesignChooser } from './DesignChooser'
import { HEAD_SIZE_TEXT, designText } from './describe'
import { applyDesignFix } from './draft-v2'
import { InclusionRules } from './InclusionRules'
import { InferenceSettings } from './InferenceSettings'
import { MeasurePicker } from './MeasurePicker'
import { NameDialog, RailSection, SelectField } from './controls'
import { measureChoices, refTerm, variableChoices } from './variables'

type SectionKey =
  | 'design'
  | 'measures'
  | 'covariates'
  | 'inclusion'
  | 'inference'

/** The controls rail's inputs. */
export interface ControlsRailProps {
  state: GroupAnalysisState
  draft: GroupAnalysisSpecV2
  catalog: GroupAnalysisCatalog
  labeling: AtlasLabelingState
  onOpenRuns: () => void
  onOpenDiagnostics: () => void
}

export function ControlsRail({
  state,
  draft,
  catalog,
  labeling,
  onOpenRuns,
  onOpenDiagnostics,
}: ControlsRailProps): ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState<Record<SectionKey, boolean>>({
    design: true,
    measures: true,
    covariates: false,
    inclusion: false,
    inference: false,
  })
  const [dialog, setDialog] = useState<null | 'save' | 'delete'>(null)
  const toggle = (key: SectionKey) => () =>
    setOpen((o) => ({ ...o, [key]: !o[key] }))
  const onChange = state.setDraft
  const list = state.list.phase === 'ready' ? state.list.value : null
  const inputs: Load<GroupAnalysisInputs> | null = state.inputs
  const sample = inputs?.phase === 'ready' ? inputs.value : null
  const check = sample?.designCheck ?? null
  const choices = useMemo(
    () => variableChoices(catalog, draft.variables.derived),
    [catalog, draft.variables.derived],
  )
  const measures = useMemo(() => measureChoices(catalog), [catalog])
  const covariateChoices = useMemo(
    () => [...choices, ...measures],
    [choices, measures],
  )
  const atlases =
    labeling.catalog.phase === 'ready' ? labeling.catalog.value : null
  const operation = labeling.labeling
  const labelingName =
    operation &&
    atlasName(
      atlases?.atlases.find((entry) => entry.atlasId === operation.atlasId)
        ?.label ?? operation.atlasId,
    )

  const covariateSummary = [
    draft.covariates.age,
    draft.covariates.sex,
    ...draft.covariates.extra,
  ]
    .filter((ref): ref is VariableRefV2 => ref !== null)
    .map((ref) => refTerm(ref, covariateChoices))
    .concat(
      draft.covariates.headSize.source === 'none'
        ? []
        : [HEAD_SIZE_TEXT[draft.covariates.headSize.source]],
    )
    .join(', ')
  const short = CORRECTION_SHORT[draft.inference.correction] || 'Uncorrected'
  const blocking = check?.issues.filter(
    (issue) => issue.severity === 'blocking',
  )

  return (
    <div style={{ display: 'grid' }}>
      <div style={{ display: 'grid', gap: 8, padding: '10px 12px 12px' }}>
        <SelectField
          label="Saved analysis"
          value={state.draftSource.specId ?? ''}
          options={[
            { value: '', label: 'Unsaved draft' },
            ...(list?.specs ?? []).map((s) => ({
              value: s.specId,
              label: s.name,
            })),
          ]}
          onChange={(value) => {
            if (value) state.loadSavedSpec(value)
          }}
        />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Btn
            t={t}
            small
            label="Save"
            disabled={state.busy || !list || state.draftErrors.length > 0}
            onClick={() => setDialog('save')}
          />
          {state.draftSource.specId && (
            <Btn
              t={t}
              small
              danger
              label="Delete"
              disabled={state.busy}
              onClick={() => setDialog('delete')}
            />
          )}
          <Btn
            t={t}
            small
            ghost
            label="Start over"
            title="Replace the draft with the project defaults."
            onClick={state.resetDraft}
          />
        </div>
        {operation?.state === 'running' && labelingName && (
          <LabelingProgress
            operation={operation}
            label={labelingName}
            onCancel={() => void labeling.cancel()}
          />
        )}
        {labeling.actionError && (
          <Notice
            tone="error"
            headline={labeling.actionError}
            action={{ label: 'Dismiss', onClick: labeling.dismissError }}
          />
        )}
        {sample?.issues.map((issue) => (
          <Notice key={issue} tone="attention" headline={issue} />
        ))}
        {blocking && blocking.length > 0 && (
          <Notice
            tone="attention"
            headline="The design check blocks Compute."
            detail={blocking[0]!.message}
            action={
              open.covariates
                ? undefined
                : {
                    label: 'Show',
                    onClick: () => setOpen((o) => ({ ...o, covariates: true })),
                  }
            }
          />
        )}
      </div>
      <RailSection
        id="analysis-section-design"
        title="Choose the design"
        summary={designText(draft)}
        open={open.design}
        onToggle={toggle('design')}
      >
        <DesignChooser
          draft={draft}
          choices={choices}
          covariateChoices={covariateChoices}
          tables={catalog.variableTables}
          inputs={sample}
          busy={state.busy}
          onChange={onChange}
          onImportVariables={state.importVariables}
          onRemoveVariables={state.removeVariables}
        />
      </RailSection>
      <RailSection
        id="analysis-section-measures"
        title="Choose measures"
        summary={`${draft.measures.length} selected`}
        open={open.measures}
        onToggle={toggle('measures')}
      >
        <MeasurePicker
          measures={draft.measures}
          catalog={catalog}
          atlases={atlases}
          labeling={labeling}
          sets={list?.sets ?? []}
          busy={state.busy}
          onChange={(ids) => onChange({ ...draft, measures: ids })}
          onSaveSet={state.saveSet}
          onLockSet={state.lockSet}
          onDeleteSet={state.deleteSet}
          onImportSet={state.importSet}
          onOpenRuns={onOpenRuns}
          onOpenDiagnostics={onOpenDiagnostics}
        />
      </RailSection>
      <RailSection
        id="analysis-section-covariates"
        title="Adjust for covariates"
        summary={covariateSummary || 'None'}
        open={open.covariates}
        onToggle={toggle('covariates')}
      >
        <CovariatePicker
          draft={draft}
          catalog={catalog}
          choices={choices}
          measureChoices={measures}
          onChange={onChange}
        />
        <DesignCheckView
          draft={draft}
          check={check}
          pending={
            state.draftErrors.length > 0
              ? 'The design check runs once the analysis can compute.'
              : inputs?.phase === 'error'
                ? inputs.message
                : 'The design check runs with the sample.'
          }
          choices={choices}
          onFix={(fix) => onChange(applyDesignFix(draft, fix, choices))}
        />
      </RailSection>
      <RailSection
        id="analysis-section-inclusion"
        title="Include subjects"
        summary={sample ? `${sample.included} included` : undefined}
        open={open.inclusion}
        onToggle={toggle('inclusion')}
      >
        <InclusionRules draft={draft} inputs={inputs} onChange={onChange} />
      </RailSection>
      <RailSection
        id="analysis-section-inference"
        title="Set inference"
        summary={`${short}, alpha ${draft.inference.alpha}`}
        open={open.inference}
        onToggle={toggle('inference')}
      >
        <InferenceSettings
          draft={draft}
          choices={choices}
          onChange={onChange}
        />
      </RailSection>
      {dialog === 'save' && (
        <NameDialog
          title="Save the analysis"
          label="Name"
          initial={state.draftSource.name ?? ''}
          confirmLabel="Save"
          note="Saving under the loaded name replaces that analysis; a new name adds one."
          onDismiss={() => setDialog(null)}
          onConfirm={(name) => {
            setDialog(null)
            void state.saveSpec(name)
          }}
        />
      )}
      {dialog === 'delete' && state.draftSource.specId && (
        <ConfirmDialog
          t={t}
          title={`Delete ${state.draftSource.name ?? 'this analysis'}?`}
          message="The saved analysis leaves the project's library. Stored results and the draft stay."
          onDismiss={() => setDialog(null)}
          actions={[
            {
              label: 'Cancel',
              onSelect: () => setDialog(null),
              initialFocus: true,
            },
            {
              label: 'Delete',
              tone: 'danger',
              onSelect: () => {
                setDialog(null)
                void state.deleteSpec(state.draftSource.specId!)
              },
            },
          ]}
        />
      )}
    </div>
  )
}
