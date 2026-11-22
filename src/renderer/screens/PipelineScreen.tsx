/**
 * Lets the operator edit per-stage parameters with type-correct widgets, toggle
 * each of the {@link PIPELINE_STEPS} on or off, and preview the resulting
 * command that the sidecar would run. The "edit-config-not-scripts" boundary
 * holds because every change is written to a working copy of
 * `cfg.steps[key].params`; the underlying shell scripts stay untouched.
 *
 * The screen runs on shared application-shell state, and falls back to
 * {@link DEFAULT_PROJECT_CONFIG} through `getApi()` when no `cfg` prop is
 * supplied so standalone tests and previews remain useful.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

import {
  Btn,
  Card,
  Code,
  CodeText,
  Field,
  FONTS,
  Hint,
  Ico,
  ICONS,
  ICON_SIZE,
  InfoTip,
  LoadingState,
  Page,
  PathInput,
  Segments,
  TextInput,
  TextPill,
  Toggle,
  type Theme,
  NoticeGlyph,
} from '../ui'
import { getApi } from '../state/api'
import { useApp } from '../state/context'
import {
  defaultParams,
  PIPELINE_STEPS_IN_DISPLAY_ORDER,
  pipelineStep,
  type ParamSpec,
  type StepKey,
} from '../../shared/steps'
import {
  PARAM_HELP,
  spelledOutStepName,
  STEP_HELP,
  STEP_NAME_SPELLED_OUT,
} from '../../shared/help'
import { isAnalysisEligible } from '../../shared/analysis-cohort'
import type { Subject, ToolStatus } from '../../shared/types'
import { brainchartsSiteFact, outlierSiteFact } from '../state/site-facts'
import {
  advisoryStages,
  DEFAULT_PROJECT_CONFIG,
  FREESURFER_FOLDER_ADVISORY_PREFIX,
  type ProjectConfig,
} from '../../shared/project-schema'

type ParamValue = ParamSpec['default']

type ParamMap = Record<string, ParamValue>

type CommandPreviewState = 'loading' | 'ready' | 'unavailable'

interface CommandPreviewSnapshot {
  cfg: ProjectConfig
  stepKey: StepKey
  state: Exclude<CommandPreviewState, 'loading'>
  command: string
}

interface ValidationSnapshot {
  cfg: ProjectConfig
  warnings: string[]
  errors: string[]
}

/**
 * Optional shared state from the application shell, accepted so the screen can
 * also run standalone in tests and previews.
 */
export interface PipelineScreenProps {
  cfg?: ProjectConfig
  onCfgChange?: (cfg: ProjectConfig) => void
  dirty?: boolean
  onDirtyChange?: (dirty: boolean) => void
  /**
   * Disable unavailable choice values by `"<stepKey>.<param>"` key. Populate
   * this map from the live environment report, or omit it in standalone mode.
   */
  disabledChoiceOptions?: Record<string, readonly string[]>
}

/** Build a per-stage working map, falling back to schema defaults. */
function readStageParams(cfg: ProjectConfig, key: StepKey): ParamMap {
  const defaults = defaultParams(key)
  const out: ParamMap = { ...defaults }
  const steps = cfg.steps as Record<string, unknown> | undefined
  const stage = steps ? steps[key] : undefined
  if (stage && typeof stage === 'object') {
    const params = (stage as { params?: unknown }).params
    if (params && typeof params === 'object') {
      for (const [name, value] of Object.entries(params as ParamMap)) {
        if (name in defaults) {
          out[name] = value
        }
      }
    }
  }
  return out
}

/** Read whether a stage is enabled, falling back to its schema default. */
function readStageEnabled(cfg: ProjectConfig, key: StepKey): boolean {
  const steps = cfg.steps as Record<string, unknown> | undefined
  const stage = steps ? steps[key] : undefined
  if (stage && typeof stage === 'object') {
    const enabled = (stage as { enabled?: unknown }).enabled
    if (typeof enabled === 'boolean') {
      return enabled
    }
  }
  return pipelineStep(key).enabledByDefault
}

/**
 * Return a new configuration with one stage's `enabled` and `params` values
 * replaced. Read this working copy for preview, validation, and save IPC calls.
 */
function withStage(
  cfg: ProjectConfig,
  key: StepKey,
  patch: { enabled?: boolean; params?: ParamMap },
): ProjectConfig {
  const steps: ProjectConfig['steps'] = { ...cfg.steps }
  const prev = steps[key] ?? { enabled: false, params: {} }
  steps[key] = {
    ...prev,
    enabled: patch.enabled ?? readStageEnabled(cfg, key),
    params: patch.params ?? readStageParams(cfg, key),
  }
  return { ...cfg, steps }
}

/** Validate one parameter value against its specification. Return an error or null. */
function validateParam(spec: ParamSpec, value: ParamValue): string | null {
  switch (spec.kind) {
    case 'int': {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return 'Enter an integer.'
      }
      if (!Number.isInteger(value)) {
        return 'Enter a whole number without decimals.'
      }
      if (value < spec.min || value > spec.max) {
        return `Enter a value from ${spec.min} to ${spec.max}.`
      }
      return null
    }
    case 'float': {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return 'Enter a number.'
      }
      return null
    }
    case 'path': {
      if (spec.must === 'exist' && (value === '' || value == null)) {
        return 'Enter a path.'
      }
      return null
    }
    default:
      return null
  }
}

/** Display names for stored choice values; other values show as stored. */
const CHOICE_LABEL: Readonly<Record<string, string>> = {
  freesurfer: 'FreeSurfer',
  fastsurfer: 'FastSurfer',
  auto: 'Automatic',
}

/** Format a scalar default for the "Default: ..." line. */
function showDefault(value: ParamValue): string {
  if (typeof value === 'boolean') {
    return value ? 'on' : 'off'
  }
  if (value === '') {
    return '(empty)'
  }
  return String(value)
}

interface ParamFieldProps {
  t: Theme
  name: string
  spec: ParamSpec
  value: ParamValue
  onChange: (value: ParamValue) => void
  onBrowseDir: () => void
  onBrowseFile: () => void
  disabledOptions?: readonly string[] | undefined
  help?: string | undefined
}

/**
 * Render the correct widget for one {@link ParamSpec}, wrapped in a labeled
 * {@link Field} that surfaces the default value and any inline validation error.
 */
export function ParamField(props: ParamFieldProps): ReactNode {
  const { t, name, spec, value, onChange, onBrowseDir, onBrowseFile } = props
  const { disabledOptions, help } = props
  const generatedId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const controlId = `pipeline-parameter-${generatedId}`
  const error = validateParam(spec, value)
  // The explanation and the schema default sit behind the label's info tip.
  // A standing line names the default only while the value differs from it.
  const defaultLine = `Default: ${showDefault(spec.default)}.`
  const info = help ? `${help} ${defaultLine}` : defaultLine
  const hint = Object.is(value, spec.default) ? undefined : defaultLine
  // Surface an unavailable selected choice as a blocking field error.
  const valueUnavailable =
    spec.kind === 'choice' &&
    typeof value === 'string' &&
    (disabledOptions?.includes(value) ?? false)
  const fieldProps = error
    ? { t, label: spec.label, info, error }
    : valueUnavailable
      ? {
          t,
          label: spec.label,
          info,
          error: 'Install this choice from Environment before selecting it.',
        }
      : { t, label: spec.label, info, ...(hint ? { hint } : {}) }
  const describedBy = error
    ? `${controlId}-error`
    : hint
      ? `${controlId}-hint`
      : undefined

  let control: ReactNode
  switch (spec.kind) {
    case 'bool':
      control = (
        // Center the switch in a row as tall as an input, so it sits on the
        // line of its neighbors' controls under a label on theirs.
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            minHeight: 'var(--ss-input-h)',
          }}
        >
          <Toggle
            t={t}
            checked={value === true}
            onChange={(v) => onChange(v)}
            ariaLabel={spec.label}
          />
        </span>
      )
      break
    case 'int':
      control = (
        <input
          id={controlId}
          type="number"
          step={1}
          min={spec.min}
          max={spec.max}
          value={typeof value === 'number' ? value : ''}
          aria-label={spec.label}
          aria-invalid={error != null}
          aria-describedby={describedBy}
          aria-errormessage={error ? `${controlId}-error` : undefined}
          onChange={(e) => {
            const raw = e.target.value
            if (raw === '') {
              onChange(Number.NaN)
              return
            }
            onChange(Math.trunc(Number(raw)))
          }}
          style={numberInputStyle(t, error != null)}
        />
      )
      break
    case 'float':
      control = (
        <input
          id={controlId}
          type="number"
          step={spec.step ?? 'any'}
          value={typeof value === 'number' && !Number.isNaN(value) ? value : ''}
          aria-label={spec.label}
          aria-invalid={error != null}
          aria-describedby={describedBy}
          aria-errormessage={error ? `${controlId}-error` : undefined}
          onChange={(e) => {
            const raw = e.target.value
            onChange(raw === '' ? Number.NaN : Number(raw))
          }}
          style={numberInputStyle(t, error != null)}
        />
      )
      break
    case 'text':
      control = (
        // Every text parameter takes a code-like value: a command flag, a
        // column name or a file-name pattern.
        <TextInput
          t={t}
          value={typeof value === 'string' ? value : ''}
          onChange={(v) => onChange(v)}
          placeholder={spec.placeholder ?? ''}
          ariaLabel={spec.label}
          mono
        />
      )
      break
    case 'path':
      control = (
        <PathInput
          t={t}
          value={typeof value === 'string' ? value : ''}
          onChange={(v) => onChange(v)}
          onBrowse={
            spec.must === 'exist' || spec.picker === 'file'
              ? onBrowseFile
              : onBrowseDir
          }
          invalid={error != null}
          ariaLabel={spec.label}
        />
      )
      break
    case 'choice':
      control = (
        <Segments
          t={t}
          value={typeof value === 'string' ? value : (spec.options[0] ?? '')}
          options={spec.options.map((option) => ({
            value: option,
            label: CHOICE_LABEL[option] ?? option,
          }))}
          onChange={(v) => onChange(v)}
          ariaLabel={spec.label}
          disabledOptions={disabledOptions}
          small
        />
      )
      break
    default:
      control = null
  }

  // A path needs the full row; other controls keep to a readable width.
  const isPath = spec.kind === 'path'
  return (
    <div
      data-param={name}
      style={{
        maxWidth: isPath ? '40rem' : '28rem',
        ...(isPath ? { gridColumn: '1 / -1' } : {}),
      }}
    >
      <Field {...fieldProps} controlId={controlId}>
        {control}
      </Field>
    </div>
  )
}

function numberInputStyle(t: Theme, invalid: boolean): CSSProperties {
  return {
    width: '100%',
    minHeight: 'var(--ss-input-h)',
    padding: '5px 8px',
    fontFamily: FONTS.mono,
    fontSize: 12,
    color: t.text,
    background: t.surface2,
    border: `1px solid ${invalid ? t.failed : t.dim}`,
    borderRadius: 6,
  }
}

/** Render the pipeline parameter editor. */
export function PipelineScreen(props: PipelineScreenProps = {}): ReactNode {
  const { t, density, saveProject, tweaks, subjects, toolStatus, setRoute } =
    useApp()
  const api = getApi()

  const [internalCfg, setInternalCfg] = useState<ProjectConfig>(
    () => props.cfg ?? DEFAULT_PROJECT_CONFIG,
  )
  // Prefer the shell-owned configuration when supplied.
  const cfg = props.cfg ?? internalCfg

  const [activeKey, setActiveKey] = useState<StepKey>('recon')
  const [previewSnapshot, setPreviewSnapshot] =
    useState<CommandPreviewSnapshot | null>(null)
  const previewRequestSequence = useRef(0)
  const [validationSnapshot, setValidationSnapshot] =
    useState<ValidationSnapshot | null>(null)
  const [localDirty, setLocalDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [revealedCommandKey, setRevealedCommandKey] = useState<StepKey | null>(
    null,
  )

  const dirty = props.dirty ?? localDirty

  const currentPreview =
    previewSnapshot?.cfg === cfg && previewSnapshot.stepKey === activeKey
      ? previewSnapshot
      : null
  const preview = currentPreview?.command ?? ''
  const previewState: CommandPreviewState = currentPreview?.state ?? 'loading'
  const currentValidation =
    validationSnapshot?.cfg === cfg ? validationSnapshot : null
  const errors = currentValidation?.errors ?? []

  const stage = useMemo(() => pipelineStep(activeKey), [activeKey])
  const stageParams = useMemo<ParamMap>(
    () => (cfg ? readStageParams(cfg, activeKey) : {}),
    [cfg, activeKey],
  )
  const stageEnabled = useMemo(
    () => (cfg ? readStageEnabled(cfg, activeKey) : false),
    [cfg, activeKey],
  )

  const markDirty = useCallback(() => {
    if (props.onDirtyChange) {
      props.onDirtyChange(true)
    } else {
      setLocalDirty(true)
    }
  }, [props])

  const commitCfg = useCallback(
    (next: ProjectConfig) => {
      setInternalCfg(next)
      props.onCfgChange?.(next)
      markDirty()
    },
    [props, markDirty],
  )

  // Refetch the live command preview and validation whenever cfg or the stage
  // changes.
  useEffect(() => {
    const requestSequence = ++previewRequestSequence.current
    const work = cfg

    const isCurrent = (): boolean =>
      previewRequestSequence.current === requestSequence

    // Keep expected draft-preview failures local to the command card. Continue
    // structural validation when the authoritative planner must resolve a
    // managed-resource path, license mount, backend, or device.
    void api.pipeline
      .previewCommand(work, activeKey)
      .then((cmd) => {
        if (!isCurrent()) return
        setPreviewSnapshot({
          cfg: work,
          stepKey: activeKey,
          state: 'ready',
          command: cmd,
        })
      })
      .catch(() => {
        if (!isCurrent()) return
        setPreviewSnapshot({
          cfg: work,
          stepKey: activeKey,
          state: 'unavailable',
          command: '',
        })
      })

    void api.project
      .validate(work)
      .then((report) => {
        if (!isCurrent()) return
        setValidationSnapshot({
          cfg: work,
          warnings: report.warnings,
          errors: report.errors,
        })
      })
      .catch(() => {
        if (!isCurrent()) return
        setValidationSnapshot({
          cfg: work,
          warnings: [],
          errors: ['Retry configuration validation.'],
        })
      })

    return () => {
      if (isCurrent()) {
        previewRequestSequence.current += 1
      }
    }
  }, [api, cfg, activeKey])

  const setParam = useCallback(
    (name: string, value: ParamValue) => {
      if (!cfg) {
        return
      }
      const nextParams: ParamMap = { ...stageParams, [name]: value }
      commitCfg(withStage(cfg, activeKey, { params: nextParams }))
    },
    [cfg, activeKey, stageParams, commitCfg],
  )

  const toggleStage = useCallback(
    (key: StepKey, enabled: boolean) => {
      if (!cfg) {
        return
      }
      commitCfg(withStage(cfg, key, { enabled }))
    },
    [cfg, commitCfg],
  )

  const browseDir = useCallback(
    (name: string) => {
      void api.fs.chooseDir({}).then((picked) => {
        if (picked != null) {
          setParam(name, picked)
        }
      })
    },
    [api, setParam],
  )

  const browseFile = useCallback(
    (name: string) => {
      void api.fs.chooseFile({}).then((picked) => {
        if (picked != null) {
          setParam(name, picked)
        }
      })
    },
    [api, setParam],
  )

  const resetDefaults = useCallback(() => {
    commitCfg(withStage(cfg, activeKey, { params: defaultParams(activeKey) }))
  }, [cfg, activeKey, commitCfg])

  const save = useCallback(() => {
    setSaving(true)
    saveProject(cfg)
      .then(() => {
        setLoadError(null)
        if (props.onDirtyChange) {
          props.onDirtyChange(false)
        } else {
          setLocalDirty(false)
        }
      })
      .catch((e: unknown) => {
        setLoadError(
          e instanceof Error ? e.message : 'Retry saving the project.',
        )
      })
      .finally(() => setSaving(false))
  }, [cfg, props, saveProject])

  const parcellationAdvisory = useMemo(() => {
    if (activeKey !== 'features') {
      return false
    }
    const value = stageParams.parcellation
    return typeof value === 'string' && value !== 'aparc.a2009s'
  }, [activeKey, stageParams])

  // Show an advisory only where the operator can act on it: a stage-scoped
  // advisory belongs to the stages it names, while an advisory that names no
  // stage shows anywhere.
  // The richer stage-local parcellation advisory owns the message while the
  // Features stage is selected; drop the validator's wording of the same
  // cause so one cause shows once in the shared live region.
  const visibleWarnings = useMemo(() => {
    const warnings = currentValidation?.warnings ?? []
    return warnings.filter((msg) => {
      if (
        parcellationAdvisory &&
        msg.startsWith('Set features.parcellation to aparc.a2009s')
      ) {
        return false
      }
      const stages = advisoryStages(msg)
      return stages === null || stages.includes(activeKey)
    })
  }, [parcellationAdvisory, currentValidation, activeKey])

  const paramEntries = useMemo(
    () =>
      Object.entries(stage.params).filter(([, spec]) => {
        if (!spec.visibleWhen) return true
        const controller = stage.params[spec.visibleWhen.name]
        const current = stageParams[spec.visibleWhen.name]
        const value = current === undefined ? controller?.default : current
        return value !== undefined && spec.visibleWhen.values.includes(value)
      }),
    [stage, stageParams],
  )

  const shellOwned = props.onCfgChange !== undefined
  const saveHint = dirty ? { hint: 'unsaved' } : {}
  const headerActions = (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      {/*
        Use a text label because the shared icon set has no unambiguous
        revert-to-defaults glyph. Avoid the refresh icon because it means "reload
        live data" elsewhere.
      */}
      <Btn
        t={t}
        label="Reset to defaults"
        ghost
        small
        onClick={resetDefaults}
      />
      {/* The shell's toolbar Save saves a shell-owned configuration, so
          the page offers its own Save only when it stands alone. */}
      {!shellOwned && (
        <Btn
          t={t}
          label={saving ? 'Saving...' : 'Save'}
          icon={<Ico d={ICONS.check} size={ICON_SIZE.nav} />}
          primary
          small
          onClick={save}
          disabled={!dirty || saving}
          title="Saves to the project config. Scripts are not changed."
          {...saveHint}
        />
      )}
    </div>
  )

  return (
    <Page t={t} title="Pipeline" right={headerActions}>
      {loadError ? (
        <div style={{ marginBottom: density.gap }}>
          <Card t={t}>
            <div
              style={{ color: t.failed, fontFamily: FONTS.sans, fontSize: 12 }}
            >
              {/* The advisory list below owns messages it already shows. */}
              {errors.includes(loadError) ? (
                'Resolve the failed validation finding below, then save again.'
              ) : (
                <CodeText text={loadError} />
              )}
            </div>
          </Card>
        </div>
      ) : null}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(220px, 280px) 1fr',
          gap: density.gap,
          alignItems: 'start',
        }}
      >
        <StageList
          t={t}
          cfg={cfg}
          activeKey={activeKey}
          onSelect={setActiveKey}
          onToggle={toggleStage}
        />

        <div
          style={{ display: 'flex', flexDirection: 'column', gap: density.gap }}
        >
          <Card
            t={t}
            title={stage.name}
            sub={stage.goal}
            action={
              <span
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                {/* The normal state shows no pill; only an off stage says so. */}
                {!stageEnabled && (
                  <TextPill
                    t={t}
                    label="Off"
                    color={t.dimText}
                    ariaLabel="This stage is off."
                  />
                )}
                <InfoTip
                  t={t}
                  text={`${spelledOutStepName(activeKey)}: ${STEP_HELP[activeKey]}`}
                  label={`About ${stage.name}`}
                />
              </span>
            }
          >
            {/*
              Keep persistent configuration advisories in one polite live region.
              Re-run validation after a stage switch without interrupting the
              operator with an assertive alert.
            */}
            <div role="status" aria-live="polite">
              {errors.length > 0 ? (
                <div style={{ marginBottom: density.gap }}>
                  {errors.map((msg) => (
                    <AdvisoryRow key={msg} t={t} status="failed" text={msg} />
                  ))}
                </div>
              ) : null}

              {parcellationAdvisory ? (
                <div style={{ marginBottom: density.gap }}>
                  <AdvisoryRow
                    t={t}
                    status="warn"
                    text="PyBrainAge feature extraction needs aparc.a2009s: the pinned model reads this Destrieux region map, and another atlas breaks PyBrainAge. Structural aggregation separately reads Desikan-Killiany aparc statistics."
                  />
                </div>
              ) : null}

              {visibleWarnings.length > 0 ? (
                <div style={{ marginBottom: density.gap }}>
                  {visibleWarnings.map((msg) => (
                    <AdvisoryRow
                      key={msg}
                      t={t}
                      status="warn"
                      text={msg}
                      action={
                        msg.startsWith(FREESURFER_FOLDER_ADVISORY_PREFIX) ? (
                          <Btn
                            t={t}
                            small
                            label="Open Diagnostics"
                            title="Open Diagnostics to set the FreeSurfer folder."
                            onClick={() => setRoute('diagnostics')}
                          />
                        ) : undefined
                      }
                    />
                  ))}
                </div>
              ) : null}
            </div>

            {!stageEnabled ? (
              <div style={{ marginBottom: density.gap }}>
                <Hint t={t}>This stage is off and runs skip it.</Hint>
              </div>
            ) : null}

            {activeKey === 'outliers' ? (
              <OutlierSiteFact t={t} gap={density.gap} subjects={subjects} />
            ) : null}

            {activeKey === 'braincharts' ? (
              <BrainChartsFacts
                t={t}
                gap={density.gap}
                subjects={subjects}
                toolStatus={toolStatus}
                onOpenDiagnostics={() => setRoute('diagnostics')}
              />
            ) : null}

            {paramEntries.length === 0 ? (
              <div
                style={{
                  color: t.dim,
                  fontFamily: FONTS.sans,
                  fontSize: 13,
                  padding: '8px 0',
                }}
              >
                This stage has no editable parameters.
              </div>
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                  gap: density.gap,
                  alignItems: 'start',
                }}
              >
                {paramEntries.map(([name, spec]) => {
                  const current = stageParams[name]
                  const value = current === undefined ? spec.default : current
                  return (
                    <ParamField
                      key={name}
                      t={t}
                      name={name}
                      spec={spec}
                      value={value}
                      onChange={(v) => setParam(name, v)}
                      onBrowseDir={() => browseDir(name)}
                      onBrowseFile={() => browseFile(name)}
                      disabledOptions={
                        props.disabledChoiceOptions?.[`${activeKey}.${name}`]
                      }
                      help={PARAM_HELP[`${activeKey}.${name}`]}
                    />
                  )
                })}
              </div>
            )}
          </Card>

          <Card
            t={t}
            title="Command preview"
            action={
              !tweaks.showCommandHints ? (
                <Btn
                  t={t}
                  small
                  ghost
                  label={
                    revealedCommandKey === activeKey
                      ? 'Hide command'
                      : 'Reveal command'
                  }
                  onClick={() =>
                    setRevealedCommandKey((current) =>
                      current === activeKey ? null : activeKey,
                    )
                  }
                />
              ) : undefined
            }
          >
            {!tweaks.showCommandHints && revealedCommandKey !== activeKey ? (
              <Hint t={t}>
                The command stays hidden under your machine-local disclosure
                preference; Reveal command shows it for this stage.
              </Hint>
            ) : previewState === 'loading' ? (
              <LoadingState t={t} label="Resolving the command..." />
            ) : previewState === 'unavailable' ? (
              <div
                role="status"
                aria-label="Command preview unavailable"
                aria-live="polite"
              >
                <Code
                  t={t}
                  kind="command"
                  value="# The draft command could not be resolved."
                />
                <Hint t={t} style={{ marginTop: 8 }}>
                  Runtime resources and automatic choices appear during exact
                  plan review. The independent configuration validation above
                  still applies.
                </Hint>
              </div>
            ) : (
              <>
                <Code
                  t={t}
                  kind="command"
                  value={
                    preview ||
                    '# No command: the stage is off or a required path is empty.'
                  }
                />
                {preview === '' ? (
                  <Hint t={t} style={{ marginTop: 8 }}>
                    Turn the stage on in the Stages list and fill every required
                    path above to generate a command.
                  </Hint>
                ) : null}
                {isPlaceholderPreview(preview) ? (
                  <Hint t={t} style={{ marginTop: 8 }}>
                    Supraspina resolves this placeholder against the installed
                    tool versions at run time.
                  </Hint>
                ) : null}
                {preview.includes(RECON_PREVIEW_INPUT) ? (
                  <Hint t={t} style={{ marginTop: 8 }}>
                    {reconInputHint(cfg)}
                  </Hint>
                ) : null}
              </>
            )}
          </Card>
        </div>
      </div>
    </Page>
  )
}

/**
 * Reconstruction input named by a subject-free preview; matches the sidecar's
 * `PREVIEW_T1_INPUT`.
 */
const RECON_PREVIEW_INPUT = '<T1 input for ${subject}>'

/** Say which file stands in for the preview's reconstruction input. */
function reconInputHint(cfg: ProjectConfig): string {
  const discovered = `the T1 that subject discovery matched with the T1 pattern "${cfg.patterns.t1Pattern}"`
  const source = readStageEnabled(cfg, 'deface')
    ? "the defaced copy of each subject's T1"
    : readStageEnabled(cfg, 'brainfov')
      ? `each subject's reviewed Brain FOV crop, or ${discovered} when no crop is needed`
      : `each subject's ${discovered.slice('the '.length)}`
  return `${RECON_PREVIEW_INPUT} stands for ${source}. Review plan lists each subject's exact path.`
}

/** Detect the sidecar's generic placeholder preview string heuristically. */
function isPlaceholderPreview(value: string): boolean {
  if (value === '') {
    return false
  }
  const lower = value.toLowerCase()
  return lower.includes('placeholder') || lower.includes('not yet')
}

interface AdvisoryRowProps {
  t: Theme
  status: 'warn' | 'failed'
  text: string
  /** The action that resolves the advisory, set beside its text. */
  action?: ReactNode
}

/** Render one advisory with redundant color and shape cues. */
function AdvisoryRow(props: AdvisoryRowProps): ReactNode {
  const { t, status, text, action } = props
  const color = status === 'failed' ? t.failed : t.warning
  // Pair color with the ringed failure or alert mark so
  // color-vision-deficient readers can distinguish the states by shape.
  const icon = status === 'failed' ? ICONS.circleX : ICONS.circleAlert
  return (
    <div
      style={{
        display: 'flex',
        gap: 6,
        alignItems: 'flex-start',
        padding: '4px 0',
        color,
        fontFamily: FONTS.sans,
        fontSize: 12,
        lineHeight: 1.4,
      }}
    >
      <Ico d={icon} stroke={color} />
      <span>
        <CodeText text={text} />
      </span>
      {action != null && (
        <span style={{ flexShrink: 0, marginTop: -3, marginLeft: 4 }}>
          {action}
        </span>
      )}
    </div>
  )
}

interface OutlierSiteFactProps {
  t: Theme
  gap: number
  subjects: readonly Subject[]
}

/**
 * State that outlier review pools every site once the analysis cohort spans
 * more than one site label.
 */
export function OutlierSiteFact(props: OutlierSiteFactProps): ReactNode {
  const { t, gap, subjects } = props
  const fact = useMemo(
    () =>
      outlierSiteFact(
        subjects.filter(isAnalysisEligible).map((subject) => subject.site),
      ),
    [subjects],
  )
  if (!fact) return null
  return (
    <div data-testid="outlier-site-fact" style={{ marginBottom: gap }}>
      <Hint t={t}>{fact}</Hint>
    </div>
  )
}

interface BrainChartsFactsProps {
  t: Theme
  gap: number
  subjects: readonly Subject[]
  toolStatus: ToolStatus | null
  onOpenDiagnostics: () => void
}

/**
 * State what BrainCharts does with each site of the analysis cohort and
 * whether its model and runtime are set up, as the plan will find them.
 */
export function BrainChartsFacts(props: BrainChartsFactsProps): ReactNode {
  const { t, gap, subjects, toolStatus, onOpenDiagnostics } = props
  const fact = useMemo(
    () =>
      brainchartsSiteFact(
        subjects.filter(isAnalysisEligible).map((subject) => ({
          site: subject.site,
          role: subject.cohortRole,
          age: subject.age,
          sex: subject.sex,
        })),
      ),
    [subjects],
  )
  // The sidecar lists the setup only while the saved project turns the stage
  // on, so an unsaved switch shows no setup line yet.
  const setup = toolStatus?.items.find((item) => item.id === 'braincharts')
  const unset = setup?.status === 'missing' || setup?.status === 'warn'
  if (!fact && !unset) return null
  return (
    <div
      data-testid="braincharts-facts"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        marginBottom: gap,
      }}
    >
      {fact ? (
        fact.tone === 'warn' ? (
          <div
            style={{
              display: 'flex',
              gap: 6,
              alignItems: 'flex-start',
              color: t.warning,
              fontFamily: FONTS.sans,
              fontSize: 12,
              lineHeight: 1.4,
            }}
          >
            <NoticeGlyph t={t} tone="warn" />
            <span>{fact.text}</span>
          </div>
        ) : (
          <Hint t={t}>{fact.text}</Hint>
        )
      ) : null}
      {unset ? (
        <div
          style={{
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <Hint t={t} style={{ flex: '1 1 240px' }}>
            The BrainCharts model and runtime are not set up. Diagnostics sets
            them up under Scientific resources.
          </Hint>
          <Btn
            t={t}
            small
            label="Open Diagnostics"
            onClick={onOpenDiagnostics}
          />
        </div>
      ) : null}
    </div>
  )
}

interface StageListProps {
  t: Theme
  cfg: ProjectConfig
  activeKey: StepKey
  onSelect: (key: StepKey) => void
  onToggle: (key: StepKey, enabled: boolean) => void
}

/** Render the configurable-stage selector. */
function StageList(props: StageListProps): ReactNode {
  const { t, cfg, activeKey, onSelect, onToggle } = props
  const [hoveredKey, setHoveredKey] = useState<StepKey | null>(null)
  return (
    <Card t={t} title="Stages" padded={false}>
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {PIPELINE_STEPS_IN_DISPLAY_ORDER.map((step, i) => {
          const selected = step.key === activeKey
          const enabled = readStageEnabled(cfg, step.key)
          // Mark hover with the shared button surface. Preserve the accent fill
          // and border for selection.
          const hovered = !selected && hoveredKey === step.key
          return (
            <li key={step.key}>
              <div
                onMouseEnter={() => setHoveredKey(step.key)}
                onMouseLeave={() =>
                  setHoveredKey((k) => (k === step.key ? null : k))
                }
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '3px 10px',
                  // Separate rows with one hairline boundary.
                  borderBottom:
                    i < PIPELINE_STEPS_IN_DISPLAY_ORDER.length - 1
                      ? `1px solid ${t.borderSoft}`
                      : 'none',
                  background: selected
                    ? t.accentSoft
                    : hovered
                      ? t.surface2
                      : 'transparent',
                  borderLeft: `2px solid ${
                    selected ? t.accent : 'transparent'
                  }`,
                  transition: 'background .12s',
                }}
              >
                <button
                  type="button"
                  aria-current={selected ? 'true' : undefined}
                  title={STEP_NAME_SPELLED_OUT[step.key]}
                  onClick={() => onSelect(step.key)}
                  style={{
                    flex: 1,
                    minHeight: 'var(--ss-row-min-h)',
                    display: 'flex',
                    flexDirection: 'row',
                    alignItems: 'baseline',
                    gap: 6,
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 0,
                    textAlign: 'left',
                  }}
                >
                  <span
                    style={{
                      fontFamily: FONTS.sans,
                      fontSize: 12,
                      color: selected ? t.textStrong : t.textSoft,
                    }}
                  >
                    {step.name}
                  </span>
                </button>
                <Toggle
                  t={t}
                  checked={enabled}
                  onChange={(v) => onToggle(step.key, v)}
                  ariaLabel={`${step.name} stage`}
                />
              </div>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
