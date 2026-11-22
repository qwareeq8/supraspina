/**
 * Add an atlas. Nothing is bundled: a source that serves pinned files
 * without a login (Schaefer 2018 on GitHub) downloads after the operator
 * acknowledges its license, with the size, progress, and Cancel; the
 * others open their official page and import the downloaded files. Files
 * from anywhere else import with a license the operator names and
 * confirms.
 */

import { useId, useState, type ReactNode } from 'react'
import type {
  AtlasDownloadOperation,
  AtlasSource,
  AtlasSourceListing,
  AtlasSourceUrlKind,
  AtlasSourcesList,
} from '../../../shared/atlas-labeling'
import type {
  AddAtlasRequest,
  AtlasLabelingState,
} from '../../state/atlas-labeling'
import type { Load } from '../../state/group-analysis'
import { useApp } from '../../state/context'
import {
  Bar,
  Btn,
  Field,
  FONTS,
  Hint,
  Ico,
  ICONS,
  ICON_SIZE,
  Modal,
  TextInput,
} from '../../ui'
import { CheckRow, SelectField, SubHeading } from './controls'
import { bytesText } from './rail-text'

type ImportRecipe = AddAtlasRequest['recipeId']

const RECIPE_TEXT: Readonly<Record<ImportRecipe, string>> = {
  'user-gcs': 'Surface classifier (lh and rh .gcs)',
  'user-annot': 'Surface annotation (lh and rh .annot)',
  'user-volume': 'Label maps in subject space with a color table',
}

const PRINTABLE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/
const HTTPS = /^https:\/\/[^\s]+$/

/** The import form, prefilled from a source when one is chosen. */
interface ImportDraft {
  recipeId: ImportRecipe
  label: string
  licenseName: string
  licenseUrl: string
  confirmed: boolean
  externalSourceId: string | null
}

function importFor(source: AtlasSource | null): ImportDraft {
  const recipe =
    source?.recipeId === 'user-gcs' ||
    source?.recipeId === 'user-annot' ||
    source?.recipeId === 'user-volume'
      ? source.recipeId
      : 'user-gcs'
  return {
    recipeId: recipe,
    label: source?.label.slice(0, 64) ?? '',
    licenseName: source?.license.name ?? '',
    licenseUrl: source?.license.url ?? '',
    confirmed: false,
    externalSourceId: source?.sourceId ?? null,
  }
}

/** The add-atlas dialog's inputs. */
export interface AddAtlasDialogProps {
  labeling: AtlasLabelingState
  onDismiss: () => void
}

export function AddAtlasDialog({
  labeling,
  onDismiss,
}: AddAtlasDialogProps): ReactNode {
  const { t } = useApp()
  const titleId = `add-atlas-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const [form, setForm] = useState<ImportDraft | null>(null)
  const [acknowledging, setAcknowledging] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  return (
    <Modal
      t={t}
      labelledBy={titleId}
      onDismiss={onDismiss}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onDismiss()
      }}
      cardStyle={{ width: 'min(560px, 100%)', padding: 18, gap: 12 }}
    >
      <h2
        id={titleId}
        style={{
          margin: 0,
          fontFamily: FONTS.serif,
          fontWeight: 400,
          fontSize: 18,
          color: t.textStrong,
        }}
      >
        Add an atlas
      </h2>
      <Hint t={t}>
        Supraspina bundles no atlas. Each source is downloaded from or opened at
        its official site under its own license; added atlases are kept in this
        computer&apos;s atlas folder and shared by projects.
      </Hint>
      {labeling.actionError && (
        <Hint t={t} style={{ color: t.failed }}>
          {labeling.actionError}
        </Hint>
      )}
      {note && (
        <p
          role="status"
          style={{
            margin: 0,
            fontFamily: FONTS.sans,
            fontSize: 12,
            color: t.text,
          }}
        >
          {note}
        </p>
      )}
      {form ? (
        <ImportForm
          form={form}
          busy={labeling.busy}
          onChange={setForm}
          onBack={() => setForm(null)}
          onImport={(request) => {
            void labeling.addAtlas(request).then((atlas) => {
              if (atlas) {
                setNote(
                  `Added ${atlas.label}; it is listed under Added atlases.`,
                )
                setForm(null)
              }
            })
          }}
        />
      ) : (
        <>
          <SubHeading>From its website</SubHeading>
          <SourceList
            sources={labeling.sources}
            download={labeling.download}
            busy={labeling.busy}
            acknowledging={acknowledging}
            onAcknowledge={setAcknowledging}
            onDownload={(sourceId) => {
              setAcknowledging(null)
              void labeling.startDownload(sourceId)
            }}
            onCancelDownload={() => void labeling.cancelDownload()}
            onOpenPage={(sourceId, kind) =>
              void labeling.openPage(sourceId, kind)
            }
            onImport={(source) => setForm(importFor(source))}
          />
          <SubHeading>From files</SubHeading>
          <Hint t={t}>
            Import a classifier, an annotation, or label maps from elsewhere,
            with the license you confirm.
          </Hint>
          <div>
            <Btn
              t={t}
              small
              label="Import files..."
              onClick={() => setForm(importFor(null))}
            />
          </div>
        </>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Btn t={t} label="Done" primary onClick={onDismiss} />
      </div>
    </Modal>
  )
}

function SourceList({
  sources,
  download,
  busy,
  acknowledging,
  onAcknowledge,
  onDownload,
  onCancelDownload,
  onOpenPage,
  onImport,
}: {
  sources: Load<AtlasSourcesList>
  download: AtlasDownloadOperation | null
  busy: boolean
  acknowledging: string | null
  onAcknowledge: (sourceId: string | null) => void
  onDownload: (sourceId: string) => void
  onCancelDownload: () => void
  onOpenPage: (sourceId: string, kind: AtlasSourceUrlKind) => void
  onImport: (source: AtlasSource) => void
}): ReactNode {
  const { t } = useApp()
  if (sources.phase === 'loading')
    return <Hint t={t}>Reading the atlas sources.</Hint>
  if (sources.phase === 'error')
    return (
      <Hint t={t} style={{ color: t.failed }}>
        {sources.message}
      </Hint>
    )
  return (
    <ul
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'grid',
        gap: 8,
      }}
    >
      {sources.value.sources.map((listing) => (
        <SourceRow
          key={listing.source.sourceId}
          listing={listing}
          download={
            download?.sourceId === listing.source.sourceId ? download : null
          }
          busy={busy || download?.state === 'running'}
          acknowledging={acknowledging === listing.source.sourceId}
          onAcknowledge={onAcknowledge}
          onDownload={onDownload}
          onCancelDownload={onCancelDownload}
          onOpenPage={onOpenPage}
          onImport={onImport}
        />
      ))}
    </ul>
  )
}

function SourceRow({
  listing,
  download,
  busy,
  acknowledging,
  onAcknowledge,
  onDownload,
  onCancelDownload,
  onOpenPage,
  onImport,
}: {
  listing: AtlasSourceListing
  download: AtlasDownloadOperation | null
  busy: boolean
  acknowledging: boolean
  onAcknowledge: (sourceId: string | null) => void
  onDownload: (sourceId: string) => void
  onCancelDownload: () => void
  onOpenPage: (sourceId: string, kind: AtlasSourceUrlKind) => void
  onImport: (source: AtlasSource) => void
}): ReactNode {
  const { t } = useApp()
  const { source } = listing
  const [read, setRead] = useState(false)
  const bytes = source.files.reduce((sum, file) => sum + file.bytes, 0)
  const running = download?.state === 'running'
  return (
    <li
      style={{
        display: 'grid',
        gap: 6,
        padding: '8px 10px',
        border: `1px solid ${t.borderSoft}`,
        borderRadius: 5,
        background: t.bg,
      }}
    >
      <div style={{ display: 'grid', gap: 2 }}>
        <span
          style={{
            fontFamily: FONTS.sans,
            fontSize: 12.5,
            fontWeight: 600,
            color: t.text,
          }}
        >
          {source.label}
        </span>
        <span
          style={{ fontFamily: FONTS.sans, fontSize: 11.5, color: t.textSoft }}
        >
          {source.kind === 'surface' ? 'Surface' : 'Volume'} atlas on{' '}
          {source.site}. License:{' '}
          <button
            type="button"
            title={source.license.url}
            aria-label={`Open the ${source.license.name} license of ${source.label}`}
            onClick={() => onOpenPage(source.sourceId, 'license')}
            style={{
              display: 'inline',
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: t.accent,
              cursor: 'pointer',
              font: 'inherit',
              textAlign: 'left',
              textDecoration: 'underline',
              textUnderlineOffset: 2,
            }}
          >
            {source.license.name}
          </button>
          .
          {listing.state === 'present' && listing.cached
            ? ` Downloaded ${listing.cached.retrievedAt.slice(0, 10)} (${bytesText(listing.cached.bytes)}).`
            : listing.state === 'corrupt'
              ? ' The downloaded copy fails its hash check; download it again.'
              : ''}
          {source.requiresLogin ? ' The site asks for a login or a form.' : ''}
        </span>
      </div>
      {running && download ? (
        <div role="status" style={{ display: 'grid', gap: 4 }}>
          <Bar
            t={t}
            value={download.receivedBytes}
            max={Math.max(1, download.totalBytes)}
            color={t.running}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                flex: 1,
                fontFamily: FONTS.sans,
                fontSize: 11.5,
                color: t.textSoft,
              }}
            >
              {bytesText(download.receivedBytes)} of{' '}
              {bytesText(download.totalBytes)}
              {download.file ? `; ${download.file}` : ''}
            </span>
            <Btn
              t={t}
              small
              label="Cancel"
              ariaLabel="Cancel the download"
              onClick={onCancelDownload}
            />
          </div>
        </div>
      ) : download && download.state !== 'done' ? (
        <Hint
          t={t}
          style={{ color: download.state === 'failed' ? t.failed : t.dimText }}
        >
          {download.state === 'cancelled'
            ? 'The download was canceled; nothing was kept.'
            : (download.message ?? 'The download failed.')}
        </Hint>
      ) : null}
      {acknowledging && !running ? (
        <div style={{ display: 'grid', gap: 6 }}>
          <Hint t={t}>
            The files are licensed under {source.license.name}. Read the license
            before downloading; Supraspina records that you acknowledged it.
          </Hint>
          <CheckRow
            checked={read}
            onChange={setRead}
            label={`I have read the ${source.license.name} license of ${source.label}.`}
          />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Btn
              t={t}
              small
              primary
              label={`Download ${bytesText(bytes)}`}
              disabled={!read || busy}
              onClick={() => onDownload(source.sourceId)}
            />
            <Btn
              t={t}
              small
              ghost
              label="Cancel"
              onClick={() => onAcknowledge(null)}
            />
          </div>
        </div>
      ) : (
        !running && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {listing.downloadable && listing.state !== 'present' && (
              <Btn
                t={t}
                small
                secondary
                label={`Download from ${source.site}`}
                disabled={busy}
                onClick={() => onAcknowledge(source.sourceId)}
              />
            )}
            <Btn
              t={t}
              small
              ghost
              label={`Open ${source.site}`}
              icon={<Ico d={ICONS.external} size={ICON_SIZE.nav} />}
              onClick={() => onOpenPage(source.sourceId, 'page')}
            />
            {!listing.downloadable && (
              <Btn
                t={t}
                small
                ghost
                label="Import downloaded files..."
                onClick={() => onImport(source)}
              />
            )}
          </div>
        )
      )}
    </li>
  )
}

function ImportForm({
  form,
  busy,
  onChange,
  onBack,
  onImport,
}: {
  form: ImportDraft
  busy: boolean
  onChange: (form: ImportDraft) => void
  onBack: () => void
  onImport: (request: AddAtlasRequest) => void
}): ReactNode {
  const { t } = useApp()
  const label = form.label.trim()
  const licenseName = form.licenseName.trim()
  const licenseUrl = form.licenseUrl.trim()
  const errors = [
    label.length > 0 && label.length <= 64 && PRINTABLE.test(label)
      ? null
      : 'Name the atlas with 1 to 64 printable ASCII characters.',
    licenseName.length > 0 &&
    licenseName.length <= 128 &&
    PRINTABLE.test(licenseName)
      ? null
      : 'Name the license the files come with.',
    licenseUrl === '' || (HTTPS.test(licenseUrl) && licenseUrl.length <= 512)
      ? null
      : 'Give the license link as an https address, or leave it empty.',
    form.confirmed ? null : 'Confirm the license permits this use.',
  ].filter((error): error is string => error !== null)
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
      }}
      style={{ display: 'grid', gap: 10 }}
    >
      <SelectField
        label="Files"
        value={form.recipeId}
        options={(Object.keys(RECIPE_TEXT) as ImportRecipe[]).map((recipe) => ({
          value: recipe,
          label: RECIPE_TEXT[recipe],
        }))}
        onChange={(value) =>
          onChange({ ...form, recipeId: value as ImportRecipe })
        }
      />
      <Field t={t} label="Atlas name">
        <TextInput
          t={t}
          value={form.label}
          onChange={(value) => onChange({ ...form, label: value })}
        />
      </Field>
      <Field t={t} label="License">
        <TextInput
          t={t}
          value={form.licenseName}
          placeholder="For example MIT, or the terms on the download page"
          onChange={(value) =>
            onChange({ ...form, licenseName: value, confirmed: false })
          }
        />
      </Field>
      <Field t={t} label="License link" hint="Optional.">
        <TextInput
          t={t}
          value={form.licenseUrl}
          placeholder="https://"
          onChange={(value) => onChange({ ...form, licenseUrl: value })}
        />
      </Field>
      <CheckRow
        checked={form.confirmed}
        onChange={(confirmed) => onChange({ ...form, confirmed })}
        label="I confirm this license permits my use of the atlas."
      />
      {errors.length > 0 && <Hint t={t}>{errors[0]}</Hint>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Btn t={t} label="Back" ghost onClick={onBack} />
        <Btn
          t={t}
          label="Choose files..."
          secondary
          disabled={errors.length > 0 || busy}
          onClick={() =>
            onImport({
              recipeId: form.recipeId,
              label,
              license: { name: licenseName, url: licenseUrl || null },
              externalSourceId: form.externalSourceId,
            })
          }
        />
      </div>
    </form>
  )
}
