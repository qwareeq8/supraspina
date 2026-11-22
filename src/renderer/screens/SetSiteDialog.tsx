import { useEffect, useId, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type {
  RegistryRecord,
  RegistrySetSiteResult,
} from '../../shared/contract'
import { COHORT_LABEL } from '../../shared/help'
import { normalizeSiteLabel } from '../../shared/sites'
import type {
  Cohort,
  CohortRole,
  ProjectRef,
  Subject,
} from '../../shared/types'
import { getApi } from '../state/api'
import { useDurableMutations } from '../state/durable-mutations-state'
import {
  SITE_HELP,
  SITE_PLACEHOLDER,
  siteLabelError,
  siteLabels,
} from '../state/site-facts'
import {
  ConfirmDialog,
  ErrorState,
  Field,
  FONTS,
  Hint,
  Segments,
  TextInput,
  type Theme,
} from '../ui'

const ROLE_COHORT: Record<CohortRole, Cohort> = {
  healthy: 'CTRL',
  'sci-no-neuropathic-pain': 'SCI_nNP',
  'sci-neuropathic-pain': 'SCI_P',
  ambiguous: 'UNKNOWN',
}

/** The view filter value for subjects without a site (not a valid label). */
const NO_SITE = ' none'
const ALL = ' all'

/**
 * One subject the dialog can set a site for. A discovered subject without a
 * registry record has revision 0, and the sidecar holds its site until it is
 * registered, since a record needs a sex and a cohort a site cannot supply.
 */
interface SiteRow {
  subjectId: string
  cohortRole: CohortRole
  site: string | null
  revision: number
  registered: boolean
}

/** Configuration for {@link SetSiteDialog}. */
export interface SetSiteDialogProps {
  t: Theme
  project: ProjectRef
  /** The subjects selected when the dialog opens; unknown IDs drop out. */
  initialSelection: readonly string[]
  /** The discovered subjects, whose unregistered ones are listed too. */
  discovered: readonly Pick<Subject, 'id' | 'site'>[]
  onDismiss: () => void
  /**
   * Called after a successful write with the subjects it covered, before the
   * caller closes the dialog.
   */
  onDone: (result: RegistrySetSiteResult, subjectIds: string[]) => void
}

/**
 * Set or clear the site of a selection of subjects in one write.
 *
 * The dialog reads the registry for the stored revisions, adds the discovered
 * subjects it does not hold, lets the operator adjust the selection (filtered
 * by current site), and sends one `registry.setSite` request; a stale record
 * refuses the whole write, and the dialog then reloads the revisions so the
 * next attempt applies.
 */
export function SetSiteDialog({
  t,
  project,
  initialSelection,
  discovered,
  onDismiss,
  onDone,
}: SetSiteDialogProps): ReactNode {
  const mutations = useDurableMutations()
  const [records, setRecords] = useState<RegistryRecord[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [selection, setSelection] = useState<Set<string>>(
    () => new Set(initialSelection),
  )
  const [label, setLabel] = useState('')
  const [touched, setTouched] = useState(false)
  const [view, setView] = useState(ALL)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listId = useId()
  const inputId = useId()

  useEffect(() => {
    let live = true
    getApi()
      .registry.list({ project })
      .then((rows) => {
        if (!live) return
        setRecords(
          [...rows].sort((a, b) => a.subjectId.localeCompare(b.subjectId)),
        )
        setLoadError(null)
      })
      .catch((cause: unknown) => {
        if (!live) return
        setLoadError(
          cause instanceof Error
            ? cause.message
            : 'Retry loading the registry.',
        )
        setRecords([])
      })
    return () => {
      live = false
    }
  }, [project, reload])

  const rows = useMemo<SiteRow[]>(() => {
    if (records === null) return []
    const registered = new Set(records.map((row) => row.subjectId))
    return [
      ...records.map((row) => ({
        subjectId: row.subjectId,
        cohortRole: row.cohortRole,
        site: row.site,
        revision: row.revision,
        registered: true,
      })),
      ...discovered
        .filter((subject) => !registered.has(subject.id))
        .map((subject) => ({
          subjectId: subject.id,
          cohortRole: 'ambiguous' as const,
          site: subject.site ?? null,
          revision: 0,
          registered: false,
        })),
    ].sort((a, b) => a.subjectId.localeCompare(b.subjectId))
  }, [records, discovered])
  const chosen = useMemo(
    () => rows.filter((row) => selection.has(row.subjectId)),
    [rows, selection],
  )
  const labels = useMemo(() => siteLabels(rows.map((row) => row.site)), [rows])
  // The chosen records' own labels may change spelling; others must agree.
  const otherLabels = useMemo(
    () =>
      siteLabels(
        rows
          .filter((row) => !selection.has(row.subjectId))
          .map((row) => row.site),
      ),
    [rows, selection],
  )
  const labelError = siteLabelError(label, otherLabels)
  let normalized: string | null = null
  try {
    normalized = normalizeSiteLabel(label)
  } catch {
    normalized = null
  }
  const shown = useMemo(
    () =>
      rows.filter((row) =>
        view === ALL ? true : view === NO_SITE ? !row.site : row.site === view,
      ),
    [rows, view],
  )
  const allShownSelected =
    shown.length > 0 && shown.every((row) => selection.has(row.subjectId))
  const unsetCount = rows.filter((row) => !row.site).length
  const withSite = chosen.filter((row) => row.site).length
  const unregisteredChosen = chosen.filter((row) => !row.registered).length

  const write = async (site: string | null): Promise<void> => {
    if (busy || chosen.length === 0) return
    setBusy(true)
    setError(null)
    let result: RegistrySetSiteResult | null = null
    try {
      await mutations.enqueue(project, 'registry:sites', async () => {
        result = await getApi().registry.setSite({
          project,
          subjectIds: chosen.map((row) => row.subjectId),
          site,
          expectedRevisions: Object.fromEntries(
            chosen.map((row) => [row.subjectId, row.revision]),
          ),
        })
      })
      const done = result as RegistrySetSiteResult | null
      if (done)
        onDone(
          done,
          chosen.map((row) => row.subjectId),
        )
    } catch (cause: unknown) {
      setError(
        cause instanceof Error ? cause.message : 'Retry setting the site.',
      )
      // Read the stored revisions again so a retry applies to current values.
      setReload((value) => value + 1)
    } finally {
      setBusy(false)
    }
  }

  const toggle = (subjectId: string): void => {
    const next = new Set(selection)
    if (next.has(subjectId)) next.delete(subjectId)
    else next.add(subjectId)
    setSelection(next)
  }

  const toggleShown = (): void => {
    const next = new Set(selection)
    for (const row of shown) {
      if (allShownSelected) next.delete(row.subjectId)
      else next.add(row.subjectId)
    }
    setSelection(next)
  }

  const count = chosen.length
  const facts = [
    withSite > 0
      ? `${withSite} of the selected subjects ${withSite === 1 ? 'has' : 'have'} a site; Clear site removes it.`
      : null,
    unregisteredChosen > 0
      ? `${unregisteredChosen} of the selected subjects ${unregisteredChosen === 1 ? 'is' : 'are'} not registered; the site is held until registration.`
      : null,
  ].filter((fact) => fact !== null)
  const footnote =
    records === null
      ? 'Loading the registry...'
      : count === 0
        ? 'Select at least one subject.'
        : facts.length > 0
          ? facts.join(' ')
          : null
  const title =
    count === 0
      ? 'Set site'
      : `Set site for ${count} ${count === 1 ? 'subject' : 'subjects'}`
  const cell: CSSProperties = {
    fontFamily: FONTS.mono,
    fontSize: 11,
    color: t.text,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }

  return (
    <ConfirmDialog
      t={t}
      title={title}
      busy={busy}
      error={error}
      onDismiss={onDismiss}
      {...(footnote === null ? {} : { footnote })}
      actions={[
        { label: 'Cancel', onSelect: onDismiss },
        {
          label: 'Clear site',
          onSelect: () => void write(null),
          disabled: withSite === 0,
        },
        {
          label: busy ? 'Setting...' : 'Set site',
          tone: 'primary',
          onSelect: () => {
            setTouched(true)
            if (normalized !== null && labelError === null) {
              void write(normalized)
            }
          },
          disabled: count === 0 || normalized === null || labelError !== null,
        },
      ]}
      message={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field
            t={t}
            label="Site"
            controlId={inputId}
            hint={SITE_HELP}
            {...((touched || label.trim() !== '') && labelError
              ? { error: labelError }
              : {})}
          >
            <TextInput
              t={t}
              id={inputId}
              value={label}
              list={listId}
              placeholder={SITE_PLACEHOLDER}
              onChange={(value) => {
                setLabel(value)
                setError(null)
              }}
              invalid={(touched || label.trim() !== '') && labelError !== null}
            />
            <datalist id={listId}>
              {labels.map((site) => (
                <option key={site} value={site} />
              ))}
            </datalist>
          </Field>
          {loadError ? (
            <ErrorState
              t={t}
              title="Could not load the registry."
              detail={loadError}
            />
          ) : records === null ? null : rows.length === 0 ? (
            <Hint t={t}>
              This project has no discovered or registered subjects.
            </Hint>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Segments
                t={t}
                small
                value={view}
                ariaLabel="Show subjects by site"
                onChange={setView}
                options={[
                  { value: ALL, label: `All ${rows.length}` },
                  ...(unsetCount > 0 && unsetCount < rows.length
                    ? [{ value: NO_SITE, label: `No site ${unsetCount}` }]
                    : []),
                  ...labels.map((site) => ({
                    value: site,
                    label: `${site} ${rows.filter((row) => row.site === site).length}`,
                  })),
                ]}
              />
              <div
                style={{
                  border: `1px solid ${t.borderSoft}`,
                  borderRadius: 4,
                  background: t.surface,
                }}
              >
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '5px 8px',
                    borderBottom: `1px solid ${t.borderSoft}`,
                    fontFamily: FONTS.sans,
                    fontSize: 11,
                    color: t.dim,
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={allShownSelected}
                    onChange={toggleShown}
                  />
                  Select all {shown.length} shown
                </label>
                <ul
                  aria-label="Subjects"
                  style={{
                    listStyle: 'none',
                    margin: 0,
                    padding: '2px 0',
                    maxHeight: 200,
                    overflowY: 'auto',
                  }}
                >
                  {shown.map((row) => (
                    <li key={row.subjectId}>
                      <label
                        style={{
                          display: 'grid',
                          gridTemplateColumns:
                            '24px minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)',
                          alignItems: 'center',
                          gap: 8,
                          padding: '3px 8px',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={selection.has(row.subjectId)}
                          onChange={() => toggle(row.subjectId)}
                          aria-label={`Select ${row.subjectId}`}
                        />
                        <span style={cell}>{row.subjectId}</span>
                        <span
                          style={{
                            ...cell,
                            fontFamily: FONTS.sans,
                            color: t.dim,
                          }}
                        >
                          {row.registered
                            ? COHORT_LABEL[ROLE_COHORT[row.cohortRole]]
                            : 'Not registered'}
                        </span>
                        <span
                          title={row.site ?? 'No site'}
                          style={{
                            ...cell,
                            color: row.site ? t.text : t.dimText,
                            fontFamily: row.site ? FONTS.mono : FONTS.sans,
                          }}
                        >
                          {row.site ?? 'No site'}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      }
    />
  )
}
