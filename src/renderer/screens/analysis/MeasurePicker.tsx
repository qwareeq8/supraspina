/**
 * Choose measures: pick a source (the pipeline tables, each subject's
 * FreeSurfer stats, atlases labeled on demand, or added atlases), see how
 * far it reaches the subjects and label more, filter by metric,
 * hemisphere, and name, check measures in a searchable list, and apply,
 * save, lock, or import ROI sets. Editing the selection of a locked set
 * saves a copy; the locked set never changes.
 */

import { useMemo, useState, type ReactNode } from 'react'
import { DK_METRIC_LABELS, measureLabel } from '../../../shared/brain-atlas'
import type { AtlasCatalog } from '../../../shared/atlas-labeling'
import {
  parseMeasureId,
  type AnalysisMeasure,
  type GroupAnalysisCatalog,
  type ParcMetric,
  type RoiSet,
} from '../../../shared/group-analysis'
import { measureShortLabel } from '../../figures/format'
import type { AtlasLabelingState } from '../../state/atlas-labeling'
import { useApp } from '../../state/context'
import { Btn, ConfirmDialog, FONTS, Hint, Segments, TextInput } from '../../ui'
import { AddAtlasDialog } from './AddAtlasDialog'
import { AtlasLabelingPanel } from './AtlasLabelingPanel'
import { TEMPLATE_ONLY_ATLASES } from './rail-text'
import { CheckRow, NameDialog, SelectField } from './controls'
import { MissingInputNotice } from './CurrencyNotice'
import {
  TIER_TEXT,
  measureHemi,
  measureSourceId,
  measureSources,
  sourceFactsText,
  sourceOptionText,
  type HemiFilter,
  type MeasureSourceOption,
  type SourceTier,
} from './measure-sources'

const COMMON_METRICS: readonly ParcMetric[] = [
  'ThickAvg',
  'SurfArea',
  'GrayVol',
]

const HEMI_TEXT: Readonly<Record<HemiFilter, string>> = {
  bi: 'Bilateral mean',
  lh: 'Left',
  rh: 'Right',
  mid: 'Midline',
}

function capital(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

function metricText(metric: ParcMetric): string {
  return metric === 'GWC'
    ? 'Gray-to-white contrast'
    : capital(DK_METRIC_LABELS[metric])
}

/** Name a measure in the checklist, without what the filters already say. */
function checklistLabel(measure: AnalysisMeasure): string {
  const parsed = parseMeasureId(measure.measureId)
  if (!parsed) return measure.measureId
  if (parsed.source === 'parc') return parsed.region
  if (parsed.source === 'vol') return parsed.structure
  if (parsed.source === 'global' || parsed.source === 'brainage')
    return measureLabel(measure.measureId)
  return measureShortLabel(measure.measureId)
}

/** Whether a measure passes the picker's filters. */
function shown(
  measure: AnalysisMeasure,
  source: MeasureSourceOption,
  metric: ParcMetric,
  hemi: HemiFilter,
  query: string,
): boolean {
  if (measureSourceId(measure.measureId) !== source.id) return false
  const parsed = parseMeasureId(measure.measureId)
  if (!parsed) return false
  if (parsed.source === 'dk' || parsed.source === 'parc') {
    if (parsed.metric !== metric) return false
  }
  if (source.hemis.length > 1 && measureHemi(measure.measureId) !== hemi)
    return false
  if (!query) return true
  const needle = query.toLowerCase()
  return (
    measureLabel(measure.measureId).toLowerCase().includes(needle) ||
    measure.measureId.toLowerCase().includes(needle)
  )
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((id) => set.has(id))
}

/** The measure picker's inputs. */
export interface MeasurePickerProps {
  measures: readonly string[]
  catalog: GroupAnalysisCatalog
  /** The atlas catalog, or null while it loads or when it cannot be read. */
  atlases: AtlasCatalog | null
  labeling: AtlasLabelingState
  sets: readonly RoiSet[]
  busy: boolean
  onChange: (measures: string[]) => void
  onSaveSet: (
    setId: string | null,
    name: string,
    measures: string[],
  ) => Promise<RoiSet | null>
  onLockSet: (setId: string) => Promise<boolean>
  onDeleteSet: (setId: string) => Promise<boolean>
  onImportSet: () => Promise<{ set: RoiSet; invalid: string[] } | null>
  onOpenRuns: () => void
  onOpenDiagnostics: () => void
}

export function MeasurePicker({
  measures,
  catalog,
  atlases,
  labeling,
  sets,
  busy,
  onChange,
  onSaveSet,
  onLockSet,
  onDeleteSet,
  onImportSet,
  onOpenRuns,
  onOpenDiagnostics,
}: MeasurePickerProps): ReactNode {
  const { t } = useApp()
  const sources = useMemo(
    () => measureSources(catalog, atlases),
    [catalog, atlases],
  )
  const first = measures[0] ?? ''
  const [sourceId, setSourceId] = useState<string>(
    measureSourceId(first) ?? 'dk',
  )
  const source = sources.find((item) => item.id === sourceId) ?? sources[0]!
  const firstParsed = parseMeasureId(first)
  const [metricChoice, setMetric] = useState<ParcMetric>(
    firstParsed?.source === 'dk' || firstParsed?.source === 'parc'
      ? firstParsed.metric
      : 'ThickAvg',
  )
  const [hemiChoice, setHemi] = useState<HemiFilter>(measureHemi(first) ?? 'bi')
  const metric = source.metrics.includes(metricChoice)
    ? metricChoice
    : (source.metrics[0] ?? 'ThickAvg')
  const hemi = source.hemis.includes(hemiChoice)
    ? hemiChoice
    : (source.hemis[0] ?? 'bi')
  const [query, setQuery] = useState('')
  const [setId, setSetId] = useState<string>('')
  const [dialog, setDialog] = useState<
    null | 'save' | 'lock' | 'delete' | 'atlas'
  >(null)
  const [note, setNote] = useState<string | null>(null)

  const selected = useMemo(() => new Set(measures), [measures])
  const list = catalog.measures.filter((m) =>
    shown(m, source, metric, hemi, query.trim()),
  )
  const shownIds = list.filter((m) => m.available).map((m) => m.measureId)
  const shownSelected = shownIds.filter((id) => selected.has(id)).length
  const setMeasures = (ids: string[]): void => onChange(ids)
  const toggle = (id: string, on: boolean): void =>
    setMeasures(on ? [...measures, id] : measures.filter((m) => m !== id))

  const dkInput = catalog.inputs.find(
    (input) => input.source === 'dk-all-stats',
  )
  const sourceMissing =
    (source.id === 'dk' || source.id === 'aseg') && dkInput && !dkInput.present
      ? (dkInput.reason ??
        'The region table of the aggregate stage is missing.')
      : null
  const entry = source.entry
  const sourceCount = catalog.measures.filter(
    (m) => measureSourceId(m.measureId) === source.id,
  ).length

  const chosenSet = sets.find((s) => s.setId === setId) ?? null
  const edited = chosenSet !== null && !sameSet(chosenSet.measures, measures)
  const perSource = new Map<string, number>()
  for (const id of measures) {
    const key = measureSourceId(id)
    if (key) perSource.set(key, (perSource.get(key) ?? 0) + 1)
  }
  const breakdown = [...perSource.entries()]
    .map(([key, n]) => {
      const name = sources.find((item) => item.id === key)?.short ?? key
      return `${n} ${name}`
    })
    .join(', ')

  const metricSegment = COMMON_METRICS.includes(metric) ? metric : 'more'
  const tiers: SourceTier[] = ['pipeline', 'stats', 'labeled', 'added']

  return (
    <>
      <div style={{ display: 'grid', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label
            htmlFor="analysis-measure-source"
            style={{
              flex: 1,
              fontSize: 11,
              color: t.dim,
              fontFamily: FONTS.sans,
            }}
          >
            Source
          </label>
          <Btn
            t={t}
            small
            ghost
            label="Add atlas..."
            onClick={() => setDialog('atlas')}
          />
        </div>
        <select
          id="analysis-measure-source"
          value={source.id}
          onChange={(event) => {
            setSourceId(event.target.value)
            setQuery('')
          }}
          style={{
            height: 'var(--ss-input-h)',
            width: '100%',
            minWidth: 0,
            padding: '0 6px',
            border: `1px solid ${t.dim}`,
            borderRadius: 4,
            background: t.bg,
            color: t.text,
            fontFamily: FONTS.sans,
            fontSize: 11.5,
          }}
        >
          {tiers.map((tier) => {
            const items = sources.filter((item) => item.tier === tier)
            if (items.length === 0) return null
            return (
              <optgroup key={tier} label={TIER_TEXT[tier]}>
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {sourceOptionText(item)}
                  </option>
                ))}
              </optgroup>
            )
          })}
        </select>
      </div>
      {entry && source.tier !== 'pipeline' && (
        <Hint t={t}>
          {sourceFactsText(entry)}
          {!entry.available &&
          entry.unavailableReason &&
          !atlases?.tools.some(
            (fact) => fact.detail === entry.unavailableReason,
          )
            ? ` ${entry.unavailableReason}`
            : ''}
        </Hint>
      )}
      {source.id === 'global' && entry && (
        <Hint t={t}>
          eTIV and mean thickness come from the pipeline tables; the others from{' '}
          {entry.counts.withFiles} of {entry.counts.total} subjects&apos;
          aseg.stats.
        </Hint>
      )}
      {entry &&
        atlases &&
        (entry.tier === 'B' || TEMPLATE_ONLY_ATLASES.has(entry.atlasId)) && (
          <AtlasLabelingPanel
            entry={entry}
            catalog={atlases}
            labeling={labeling}
            onOpenDiagnostics={onOpenDiagnostics}
          />
        )}
      {sourceMissing ? (
        <MissingInputNotice message={sourceMissing} onOpenRuns={onOpenRuns} />
      ) : sourceCount === 0 ? (
        <Hint t={t}>
          {entry?.tier === 'B'
            ? `No subject has labels of ${source.label} yet.`
            : `No subject has measures of ${source.label} yet.`}
        </Hint>
      ) : (
        <>
          {source.metrics.length > 1 && (
            <div style={{ display: 'grid', gap: 6 }}>
              <Segments
                t={t}
                small
                ariaLabel="Surface metric"
                value={metricSegment}
                options={[
                  ...COMMON_METRICS.filter((m) =>
                    source.metrics.includes(m),
                  ).map((m) => ({
                    value: m,
                    label:
                      m === 'ThickAvg'
                        ? 'Thickness'
                        : m === 'SurfArea'
                          ? 'Area'
                          : 'Volume',
                  })),
                  ...(source.metrics.some((m) => !COMMON_METRICS.includes(m))
                    ? [{ value: 'more', label: 'More' }]
                    : []),
                ]}
                onChange={(value) =>
                  setMetric(
                    value === 'more'
                      ? source.metrics.find((m) => !COMMON_METRICS.includes(m))!
                      : (value as ParcMetric),
                  )
                }
              />
              {metricSegment === 'more' && (
                <SelectField
                  label="Other metric"
                  value={metric}
                  options={source.metrics
                    .filter((m) => !COMMON_METRICS.includes(m))
                    .map((m) => ({ value: m, label: metricText(m) }))}
                  onChange={(value) => setMetric(value as ParcMetric)}
                />
              )}
            </div>
          )}
          {source.hemis.length > 1 && (
            <Segments
              t={t}
              small
              ariaLabel="Hemisphere"
              value={hemi}
              options={source.hemis.map((value) => ({
                value,
                label:
                  source.id === 'aseg' && value === 'mid'
                    ? 'Other'
                    : HEMI_TEXT[value],
              }))}
              onChange={(value) => setHemi(value as HemiFilter)}
            />
          )}
          <TextInput
            t={t}
            value={query}
            onChange={setQuery}
            placeholder="Filter by name"
            ariaLabel="Filter measures by name"
          />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flexWrap: 'wrap',
            }}
          >
            <Btn
              t={t}
              small
              label="Select shown"
              disabled={
                shownIds.length === 0 || shownSelected === shownIds.length
              }
              onClick={() =>
                setMeasures([
                  ...measures,
                  ...shownIds.filter((id) => !selected.has(id)),
                ])
              }
            />
            <Btn
              t={t}
              small
              ghost
              label="Clear shown"
              disabled={shownSelected === 0}
              onClick={() =>
                setMeasures(measures.filter((id) => !shownIds.includes(id)))
              }
            />
            <span
              style={{
                marginLeft: 'auto',
                fontSize: 11,
                color: t.dimText,
                fontFamily: FONTS.sans,
              }}
            >
              {shownSelected} of {shownIds.length}
            </span>
          </div>
          <div
            role="group"
            aria-label="Measures"
            tabIndex={-1}
            style={{
              maxHeight: 208,
              overflowY: 'auto',
              border: `1px solid ${t.borderSoft}`,
              borderRadius: 4,
              padding: '2px 8px',
              background: t.bg,
            }}
          >
            {list.length === 0 ? (
              <div
                style={{
                  padding: '6px 0',
                  fontSize: 11.5,
                  color: t.dimText,
                  fontFamily: FONTS.sans,
                }}
              >
                No measure matches.
              </div>
            ) : (
              list.map((measure) => (
                <CheckRow
                  key={measure.measureId}
                  checked={selected.has(measure.measureId)}
                  disabled={!measure.available}
                  title={
                    measure.unavailableReason ?? measureLabel(measure.measureId)
                  }
                  onChange={(on) => toggle(measure.measureId, on)}
                  label={checklistLabel(measure)}
                />
              ))
            )}
          </div>
        </>
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          fontFamily: FONTS.sans,
          fontSize: 11.5,
          color: t.textSoft,
        }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>
          <strong style={{ fontWeight: 600, color: t.text }}>
            {measures.length}
          </strong>{' '}
          selected{breakdown ? `: ${breakdown}` : ''}
        </span>
        <Btn
          t={t}
          small
          ghost
          label="Clear all"
          disabled={measures.length === 0}
          onClick={() => setMeasures([])}
        />
      </div>
      <div
        style={{
          display: 'grid',
          gap: 6,
          paddingTop: 8,
          borderTop: `1px dashed ${t.borderSoft}`,
        }}
      >
        <SelectField
          label="ROI set"
          value={setId}
          options={[
            {
              value: '',
              label: sets.length === 0 ? 'No saved sets' : 'Choose a set',
            },
            ...sets.map((s) => ({
              value: s.setId,
              label: `${s.name} (${s.measures.length})${s.locked ? ', locked' : ''}`,
            })),
          ]}
          onChange={(value) => {
            setSetId(value)
            setNote(null)
            const set = sets.find((s) => s.setId === value)
            if (set) setMeasures([...set.measures])
          }}
        />
        {chosenSet?.locked && (
          <Hint t={t}>
            {edited
              ? `Changed from the locked set; saving makes a copy.`
              : `Locked ${chosenSet.locked.lockedAt.slice(0, 10)}, SHA-256 ${chosenSet.locked.sha256.slice(0, 12)}.`}
          </Hint>
        )}
        {note && <Hint t={t}>{note}</Hint>}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Btn
            t={t}
            small
            label={
              chosenSet && !chosenSet.locked && edited
                ? 'Update set'
                : 'Save as set'
            }
            disabled={
              busy || measures.length === 0 || (chosenSet !== null && !edited)
            }
            onClick={() => setDialog('save')}
          />
          {chosenSet && !chosenSet.locked && !edited && (
            <Btn
              t={t}
              small
              label="Lock"
              disabled={busy}
              onClick={() => setDialog('lock')}
            />
          )}
          {chosenSet && !chosenSet.locked && !edited && (
            <Btn
              t={t}
              small
              ghost
              label="Delete"
              disabled={busy}
              onClick={() => setDialog('delete')}
            />
          )}
          <Btn
            t={t}
            small
            ghost
            label="Import CSV"
            disabled={busy}
            onClick={() => {
              void onImportSet().then((imported) => {
                if (!imported) return
                setSetId(imported.set.setId)
                setMeasures([...imported.set.measures])
                const n = imported.set.measures.length
                const bad = imported.invalid.length
                setNote(
                  `Imported ${n} ${n === 1 ? 'measure' : 'measures'} as ${imported.set.name}${bad > 0 ? `; ${bad} ${bad === 1 ? 'value was' : 'values were'} not a measure ID` : ''}.`,
                )
              })
            }}
          />
        </div>
      </div>
      {dialog === 'atlas' && (
        <AddAtlasDialog labeling={labeling} onDismiss={() => setDialog(null)} />
      )}
      {dialog === 'save' && (
        <NameDialog
          title={
            chosenSet && !chosenSet.locked && edited
              ? 'Update the ROI set'
              : 'Save the selection as a set'
          }
          label="Set name"
          initial={
            chosenSet
              ? chosenSet.locked
                ? `${chosenSet.name} (copy)`.slice(0, 120)
                : chosenSet.name
              : ''
          }
          confirmLabel="Save set"
          note={`${measures.length} measures. A locked set cannot change; lock it after saving.`}
          onDismiss={() => setDialog(null)}
          onConfirm={(name) => {
            setDialog(null)
            const target =
              chosenSet &&
              !chosenSet.locked &&
              edited &&
              name === chosenSet.name
                ? chosenSet.setId
                : null
            void onSaveSet(target, name, [...measures]).then((set) => {
              if (set) setSetId(set.setId)
            })
          }}
        />
      )}
      {dialog === 'lock' && chosenSet && (
        <ConfirmDialog
          t={t}
          title={`Lock ${chosenSet.name}?`}
          message="Locking records the set's SHA-256 and the time, as an a priori record. A locked set never changes; editing it saves a copy."
          onDismiss={() => setDialog(null)}
          actions={[
            { label: 'Cancel', onSelect: () => setDialog(null) },
            {
              label: 'Lock set',
              tone: 'primary',
              initialFocus: true,
              onSelect: () => {
                setDialog(null)
                void onLockSet(chosenSet.setId)
              },
            },
          ]}
        />
      )}
      {dialog === 'delete' && chosenSet && (
        <ConfirmDialog
          t={t}
          title={`Delete ${chosenSet.name}?`}
          message="The set leaves the project's library. Saved analyses keep their own measure lists."
          onDismiss={() => setDialog(null)}
          actions={[
            {
              label: 'Cancel',
              onSelect: () => setDialog(null),
              initialFocus: true,
            },
            {
              label: 'Delete set',
              tone: 'danger',
              onSelect: () => {
                setDialog(null)
                void onDeleteSet(chosenSet.setId).then((ok) => {
                  if (ok) setSetId('')
                })
              },
            },
          ]}
        />
      )}
    </>
  )
}
