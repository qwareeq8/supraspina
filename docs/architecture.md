# Architecture and lifecycle

Supraspina separates untrusted presentation code from filesystem, process, and
scientific authority.

```text
React renderer
    | typed, context-isolated preload API
Electron main process
    | newline-delimited JSON-RPC 2.0 over stdio
Python sidecar
    | argument arrays, inherited environment plus reviewed overrides
Scientific tools and managed containers
```

## Process boundaries

The React renderer displays project, run, QC, and result state. It has no Node,
filesystem, or process API. The preload bridge exposes the reviewed IPC
contract, and the main process accepts calls only from the trusted application
frame.

The main process owns windows, native dialogs, project-file access, external
link allowlists, machine preferences, lifecycle decisions, and sidecar
supervision. It injects its own runtime context and rejects renderer-supplied
runtime authority.

The Python sidecar validates saved project configurations, discovers subjects,
expands and schedules the workflow DAG, probes scientific dependencies,
provisions reviewed resources, persists runs, logs, manifests, receipts, and QC
state, and owns scientific process trees. External tools receive explicit
argument arrays, working directories, and cancellation ownership rather than
renderer-generated shell commands. Their environments inherit the sidecar
process environment and then apply explicit project or FreeSurfer overrides, so
ambient values such as `PATH`, `DISPLAY`, proxy variables, and package-library
paths can affect execution.

The sidecar's Python project is a source and freezing input, not a published
user package. Its wheel metadata includes `sidecar/LICENSE`, an exact copy of
the root `LICENSE`. The root MIT license covers first-party sidecar code only;
acquired and bundled third-party resources keep their own terms, listed in
`THIRD_PARTY_NOTICES`.

## Sidecar startup and protocol

A packaged build embeds a frozen PyInstaller onedir bundle and always resolves
it at `<resources>/sidecar/supraspina-sidecar`. A missing packaged bundle is a
non-retryable startup error, and the packaged resolver ignores
`SUPRASPINA_SIDECAR`.

Development resolution is:

1. `SUPRASPINA_SIDECAR`, when set.
2. The repository `sidecar/.venv` Python interpreter.
3. `python3` from `PATH`.

The interpreter fallbacks run `-m supraspina_sidecar` with `sidecar/` as their
working directory. An explicit `SUPRASPINA_SIDECAR` command runs unchanged from
the repository root. `npm run dev`, `npm start`, and `npm run preview` all use
this unpackaged path. Only a packaged build, including an electron-builder
unpacked directory or an extracted AppImage payload, exercises frozen-sidecar
selection. To run the sidecar by hand, see
[Set up and run](development.md#set-up-and-run).

Each RPC message is one UTF-8 JSON line. Requests have the shape:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "ping", "params": [] }
```

Responses carry `result` or `error`. Before scientific calls, which are
project-scoped, the main process and sidecar match product version, protocol
version, persistence-schema versions, required capabilities, runtime identity,
and supervisor generation. The handshake timeout is 8 seconds; bounded control
calls use 60 seconds, other calls use up to 600 seconds, and graceful shutdown
uses 12 seconds. Each complete request or response line is capped at 8 MiB in
both directions, and the Python byte reader rejects an oversized unterminated
frame without growing its buffer. These are control-plane limits, not limits on
scientific data reads.

Both runtimes require the exact JSON-RPC 2.0 envelope, bounded integer or string
request IDs, a nonempty method string, and array parameters. An invalid request
receives the standard invalid-request response when an ID can be retained, and
the sidecar continues with the next frame. JSON syntax errors receive a parse
error. A malformed notification is dropped without ending the protocol loop.

Notification payloads are method-specific and bounded at runtime.
`runtime.event` carries project, generation, and sequence identity. Job,
pipeline-log, provisioning, installation, managed-resource, and
process-ownership events use their own schemas. The main process drops an
invalid allowlisted sidecar event before relay, and the preload bridge
validates it again before calling a renderer subscriber. The main process
consumes internal ownership events instead of relaying them.

Renderer-exposed sidecar results also pass a bounded, method-specific runtime
parser in the main process and again in preload. The parsers enforce enums,
finite numbers, collection and string limits, project and generation identity,
and each method's required shape. Typed projections omit unknown sidecar-only
fields. An invalid result rejects that call without invoking renderer code or
ending the sidecar protocol.

## Configuration and storage

The saved `supraspina.project.json` is the scientific configuration authority.
Planning and mutating calls require its current revision and on-disk hash. The
sidecar is attached to a project identity of root, configuration path, and
generation, so a stale response cannot update a newly opened project.

A draft configuration is accepted only for environment checks, tool status,
and subject discovery or refresh. Installation, provisioning, managed-resource
operations, Input QC, planning, and execution require the exact saved revision;
project-reference calls receive the main process's saved copy instead of a
renderer-provided configuration. Tool inputs resolve as follows:

| Tool input                            | Resolution order                                                                                                                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FreeSurfer home                       | Saved `tools.freesurferHome`, then `FREESURFER_HOME`                                                                                                                                                                   |
| FreeSurfer license                    | Saved `tools.freesurferLicense`, then `FS_LICENSE`, then `<resolved FreeSurfer home>/license.txt`, then `<resolved FreeSurfer home>/.license` when no `license.txt` exists                                             |
| Age, Clinical, and Brain-PAD Python   | Saved `tools.pythonExecutable`, then `python3` or `python` on `PATH`; never the isolated PyBrainAge compatibility environment                                                                                          |
| PyBrainAge execution                  | Exact interpreter, predictor, model, and scaler in the current digest-bound provision generation; no configured, system, user-conda, or `PATH` fallback                                                                |
| Diagnostics and outlier Rscript       | Saved `tools.rscriptExecutable`, then `Rscript` on `PATH`                                                                                                                                                              |
| R analysis Rscript                    | Saved `steps.final.params.rscriptExecutable` (normally `${tools.rscriptExecutable}`), then `Rscript` on `PATH`                                                                                                         |
| Z-score comparisons Rscript           | The R analysis Rscript resolution                                                                                                                                                                                      |
| BrainCharts execution                 | Exact interpreter, model tree, and lists in the current digest-bound BrainCharts generation; no configured, system, or `PATH` fallback                                                                                 |
| MATLAB source backend                 | Saved ENIGMA executable, then `matlab` on `PATH`                                                                                                                                                                       |
| MATLAB Runtime                        | Saved ENIGMA `mcrRoot`, then the conventional install roots with or without their `v97` directory                                                                                                                      |
| Subregion segmentation Python         | Machine preference `subregionsPython` (a Python 3.12 that main checks for NumPy, SciPy, nibabel, surfa, and numba), then FreeSurfer's `fspython` when it can load samseg; never the environment check                  |
| Acquired scientific-asset cache       | `SUPRASPINA_SCIENTIFIC_ASSET_ROOT`, then `$XDG_DATA_HOME/supraspina/scientific-assets`, then `~/.local/share/supraspina/scientific-assets`                                                                             |
| Scientific-asset provenance inventory | `SUPRASPINA_PROVENANCE_FILE` override; otherwise packaged metadata in a frozen build or source-tree `THIRD_PARTY_PROVENANCE.json` in development; the selected file must match the pinned schema and upstream identity |

These chains apply only to unset values. An explicit but invalid configured
path stays authoritative and produces a diagnostic instead of falling through.

State is divided as follows:

| Location                            | Contents                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `<project>/supraspina.project.json` | Saved paths, tools, runtime, stages, subject selection, and exclusion configuration                                       |
| `<project>/.supraspina/`            | Run generations, manifests, receipts, registry, provisioning state, QC decisions, and advisory analyses                   |
| Electron user data                  | Mode-0600 machine preferences, managed scientific-resource generations, and the downloaded and added atlases (`atlases/`) |
| Renderer local storage              | Recent-project records, first-run state, skipped update version, and monotonic project-epoch floor                        |
| Configured derivatives and outputs  | Scientific derivatives, tables, figures, reports, and the PyBrainAge and BrainCharts environments and models              |

Machine preferences hold no scientific configuration; they are sanitized field
by field and written atomically. Durable run state uses immutable or
generation-stamped records, with atomic replacement where a current pointer
must advance. Project, configuration, and preference writes use adjacent
temporary files and atomic replacement. Managed SIF generations stage on the
destination filesystem before atomic activation. The pinned SCI_Map
support-asset archive downloads to the operating-system temporary directory,
then validates and extracts into cache-local staging before atomic publication.
Both resource flows discard abandoned staging data on their handled failure
paths.

### Subject registry

The subject registry, `.supraspina/registry.json`, stores a record's `site` key
only when a site is set. No read migrates or backfills the key, so a registry
nobody edits keeps its bytes, and the Clinical and R analysis receipts, which bind
those bytes, stay current. `registry.list` reports an unset site as `null`. An
upsert without the key and an import without a `site` column keep each stored
site. `registry.setSite` sets or clears the site of up to 20,000 subjects in one
atomic write that checks each record's revision. The BrainCharts receipt binds
only a digest of each record's subject ID, age, sex, site, and cohort role, so
other registry edits leave it current. `sites.site_state` reports the site mode
(`none`, `complete`, or `mixed`) that the planner's mixed-site blocker and the
Brain-PAD advisory read.

A record requires a sex and a cohort label, which a site cannot supply. For a
discovered subject without a record (named with revision 0),
`registry.setSite` holds the site in `.supraspina/pending-sites.json` instead.
No receipt or planner reads that file. Discovery reports the held site on the
subject's row, and the upsert or import that creates the record without a site
of its own adopts it and drops the held entry. Until then planning counts the
subject as without a site.

### PyBrainAge provisioning

PyBrainAge provisioning has its own root, `${paths.outputDir}/.pybrainage/`. A
cross-process filesystem lock serializes provisioning, and execution holds a
shared lock through final provenance revalidation and process launch. Each
attempt creates an unpublished directory under `generations/`, materializes the
committed Linux x86_64 explicit conda and pip locks, creates `envs/pybrainage`,
and installs the hash-required `cliffs-delta` wheel without dependency solving.
It stages the matching model, scaler, archive identity, environment metadata,
and locks together. One atomic `current` symlink switch publishes the complete
generation, and the completed state record is written last. A failed or
interrupted attempt removes its unpublished generation and leaves the prior
complete generation active. Each child command's output streams line by line as
`provision.log` notifications, redacted and bounded like job output, and is
appended to `logs/<operationId>.log` under the same root.

The model download uses a bounded `.part` file under the same root. Supraspina
limits transfer size while downloading, checks the exact archive size and
SHA-256, validates archive members and expanded-size bounds, and publishes no
model bytes until the model, scaler, and runtime are complete.
`MAMBA_ROOT_PREFIX`, conda packages, the pip and XDG caches, materialized
locks, downloads, generations, state, and logs all stay under that root.
Provisioning requires at least 5 GiB free on its filesystem before it starts.

Packaged diagnostics and provisioning require the packaged micromamba sibling;
development requires `resources/micromamba/micromamba` in the source tree.
Neither searches `PATH`, user conda, user pip, or shared caches. The selected
regular executable must match the reviewed SHA-256 and report version `2.7.0`.
Diagnostics uses an automatically removed temporary root and does not create
the draft output directory. Completed state binds, and later rechecks, the
manager, locks, runtime versions, conda metadata, archive, model, and scaler
digests.

### BrainCharts provisioning

`provision.braincharts` follows the same pattern below
`${paths.outputDir}/.braincharts/`. It lives in `braincharts_runtime.py`,
outside `adapters/`, so a provisioning change never alters the stage adapter's
receipt identity; the runtime reaches receipts only through the `bcenv` and
`bcmodel` environment checks, which only the `braincharts` receipt binds. The
sidecar refuses a request without `licenseAccepted: true` or on a host other
than Linux x86_64. A setup holds the setup lock exclusively (sizes:
[PyBrainAge and BrainCharts](installation.md#pybrainage-and-braincharts)); a stage run holds it shared for the whole run.

The setup downloads the model archive and the four site and phenotype lists,
pinned to braincharts commit `5a1a782` by URL, size, and SHA-256, with
HTTPS-only curl into `downloads/`, where a partial model download resumes and a
checked file is reused. In a new directory under `generations/` it unpacks the
archive into `models/lifespan_57K_82sites/` within fixed bounds (753 members,
128 MiB, only per-phenotype `Models/` files, and no links) and places the lists
in `models/docs/`. It creates `envs/braincharts` with the shared micromamba
from the committed conda explicit lock (CPython 3.12 and pip), then installs the
hash-required pip lock: wheels only, CPU-only torch, and `bspline` built from
its hashed source distribution. It probes the exact runtime versions, unpickles
one model, switches the `current` symlink, records `provision-state.json` with a
provenance digest over every part, and removes superseded generations while
keeping `pip-cache/` and `downloads/`. Logs go to `logs/<operationId>.log`. A
stage run keeps the runtime's caches inside the run's work directory and pins
each numerical library to one thread.

## Planning, execution, and results

Planning resolves subject discovery, saved configuration, stage dependencies,
QC and registry evidence, environment checks, resource identities, output
state, and resource policy, and binds them to an identity and digest shown in
the renderer. Live execution requires one-use approval for that exact plan.
Within one plan, each node of a receipt lineage is digested once and the active
scientific resource generation is validated once; launch bindings and the
post-exit proof digest their inputs again.

Run, node, and job state is persisted before a scientific child starts.
Terminal state and receipt evidence are committed before a completion event is
published. Results are attributed to the receipt and run that produced them.

### Node identity

A node ID, `node-<index>-<sha8(step:subject)>`, carries the node's position in
the plan, and every stage in `STEP_DESCRIPTORS` gets nodes even while it is
off. Later stages are therefore appended after `final` (`braincharts`, then
`zstats`), so no existing node ID shifts; their display `id` values, 5.5 and
9.5, are display metadata, not node positions. Their settings live only in
`steps.braincharts.params` and `steps.zstats.params`, so no other stage's
configuration digest depends on them.

### Per-subject unit reuse

A cohort stage can declare per-subject units through a `UnitContract`
(`adapters/base.py`, registered beside the adapter). ENIGMA QC's contract is in
`adapters/enigma_units.py`, outside the adapter module whose bytes its receipts
bind. `unit_reuse.py` decides each unit from content digests at launch, adapts
the launch to skip reused units (for ENIGMA, a run-owned `--script` directory
of launchers that skip listed subjects and otherwise run the compiled ones),
proves the inputs and reused outputs unchanged after exit, and writes the
`unitReuse` record. The receipt keeps binding the unchanged upstream command,
so plans and signatures do not change. A plan's `unitReuse` forecast compares
recorded byte counts only and is left out of the plan digest.

Two gaps in the ENIGMA QC receipt are known and kept, because closing either
would change every existing ENIGMA receipt and plan the stage again. Its
reconstruction evidence binds `mri/nu.mgz` whenever that file exists, while the
wrapper reads `mri/orig_nu.mgz` for FreeSurfer 5 to 7, and it binds neither
`surf/{lh,rh}.pial.T1` nor `label/{lh,rh}.aparc.annot`. A change to only those
files does not plan ENIGMA QC again, but unit reuse digests the files each unit
reads, so the next ENIGMA QC run renders the affected subjects again.

### Resource resolution

Packaged builds and source checkouts use the acquired generation while every
reviewed file of each directory holding an acquired file (`enigma`,
`features`) matches its reviewed SHA-256 and mode, and the application's own
copy of each first-party file in those directories matches too. A source
checkout that edited one of those files runs its own `resources/` until the
generation is rebuilt. A directory of bundled files only (`step8`, `step9`,
`braincharts`) always resolves from a source checkout's own `resources/`. In a
packaged build, such a directory that the generation holds in an earlier form
resolves from the frozen subset instead when that copy verifies; when neither
copy verifies, the generation is rejected. Paths under either root bind as the
resource token plus content, and the brain-FOV helper beside the frozen subset
always binds verbatim, so an upgrade that revises only those directories keeps
the generation and changes no per-subject action digest.

### Results inventory and stage currency

The results inventory signs each receipt with the bindings the planner used:
the persisted run configuration, the managed-resource runtime resolved from the
runtime context the main process attaches to every `results.list` request, and
each subject's reviewed Brain FOV input resolved through the review manager. A
`results.list` request that arrives from the renderer with its own runtime
context is refused. The response's `signingNotes` map gives, per subject, the
reason its reviewed Brain FOV input could not be rebound while signing the
page; the renderer's typed projection omits it, so it appears only in sidecar
tests and protocol traces. Its `configSha256` digests the run's configuration
as the main process digests the saved session. A request with `currentConfigSha256` for a run whose digest
differs gets only the run ID, that digest, and an empty page.

Otherwise the response carries `stageCurrency`, which tells the Runs stage
cards whether the planner would reuse each stage as it stands. A node is
current when a receipt in the run or the project store matches the digest the
run's configuration yields and its detector evidence still matches the outputs
on disk. A stage that the run's configuration disables has no entry, because
the planner skips it. The run's recorded asset checks are judged again live,
because they name the resource directory; other recorded tool evidence is kept.

Cohort-scope nodes are judged against the analysis cohort the next Run all
would plan. The analysis-cohort digest binds membership only: the analysis
subjects, their T1 fingerprints, the QC Fail and configuration exclusions, and
the QC policy, under the canonical QC state (every subject unreviewed, the
acknowledgment given, and no review evidence), so a store without verdicts
and a reviewed store with the same membership yield one digest. A cohort
receipt's `scopeBinding.qcVerdicts` and
`qcAcknowledged` record that canonical state; the verdicts a run planned with
are in its run state and the plan's `qcDigest`.

For a run whose plan binding recorded a `qcDigest`, the inventory resolves the
cohort the next Run all would plan. It reads the saved project file at
`project.configPath` (the run's own configuration when that file is
unreadable), rediscovers the subjects and T1 files with
`discover_t1_resolutions`, and applies the saved exclusions and the live QC
records through the `AnalysisCohort` binding that `build_cohort_snapshot` also
uses, acknowledging Defer and unreviewed rows exactly when the cohort holds
one. T1 fingerprints come from `remembered_fingerprint`, an in-process cache in
`cohort.py` keyed by path, device, inode, size, modification time, and change
time. Planning still reads every T1 in full through `_fingerprint` and records
each digest in that cache when the file's identity held for the whole read.
After a plan, or after the first read following launch, later reads stat the
files and hash only those whose identity changed.

The resolved cohort replaces the run's when its digest or any analysis
subject's T1 path or fingerprint differs, so a verdict change that keeps the
membership leaves the run's cohort in place. A cohort stage that matches under
the run's cohort but not under the resolved one reads `outdated` with the cause
`analysis-cohort`. A subject-scope node of a subject whose T1 row changed, or
who joined the cohort, is judged against its new row, both for its signature
and for the input its detector reads. A replaced T1 therefore also puts that
subject's Brain FOV, defacing, and reconstruction out of date, because their
receipts bind the T1 fingerprint. A T1 moved back to a path an earlier run
bound reads current again when the planner would reuse that run's receipt.
Other per-subject nodes bind no analysis cohort.

The page's `analysisCohortChange` names `membership` when the subjects, T1
inputs, or exclusions changed, with `reasons`. Each reason names a kind
(`subjects-added`, `subjects-removed`, `config-exclusion`, `t1-changed`, or
`qc-exclusion`), up to 20 sorted subject identifiers, and the total `count`. A
subject that joined or left because the saved selection includes or excludes
it counts as `config-exclusion`, and a `config-exclusion` with no subject means
only the exclusion list changed. A cohort that Run all could not plan, because
the QC store is unreadable, a subject's T1 is missing or
ambiguous, or no analysis subject remains, reads `unknown`.

Each artifact's `provenance` stays judged against the run's recorded cohort,
because QC review records a verdict only from an ENIGMA gallery whose
provenance is current.

The renderer reads `stageCurrency` once at app level, in
`StageCurrencyProvider`, and the top bar, the Dashboard, Subjects, and Runs
share that read, so one trigger causes one `results.list` request. It reads
again when `cohortConfigKey` of the saved configuration changes (project root,
raw-data folder, subject glob, T1 pattern, and include and exclude lists). Each
read is tagged with its project, so a project switch never shows another
project's currency. The top bar, the Dashboard, and Subjects project the read
onto the matrix: a finished cell of an out-of-date stage takes the `outdated`
cell state, which exists only in the renderer; the sidecar never reports it and
the result validators reject it. A subject with an out-of-date cell counts as
Partly done rather than Done. The Runs stage cards keep counting per-stage
states, and the Dashboard, Subjects, and Results show a notice for out-of-date
cohort stages.

Artifact readers exposed to the renderer validate roots and apply format- and
preview-specific bounds; this does not bound every scientific script input.

### Reproducibility manifest

Each run also produces a reproducibility manifest below `.supraspina/`. Its
`product` block names the Supraspina version that wrote it and, in `build`, how
that build relates to the version's release: `release` for a package built
from a clean tree at the annotated `v<version>` tag, `development` for any
other package, and `unknown` when the sidecar carries no build record, as in a
source checkout. The `git` block records that build's source commit in
`git.sha` and whether tracked files differed from it in `git.dirty`; `git.repo`
is empty, and `git.sha` is empty for an unknown build. Packaging writes the
record through `scripts/build-identity.mjs` into the frozen sidecar's
`metadata/build-identity.json` and into the renderer bundle for About. The
scientific baseline commit never appears in these blocks, and no provenance
receipt binds the product version or the build, so an upgraded application
keeps reusing receipts whose scientific inputs still match. Manifests without
the `build` field load under the same schema version.

## Advisory surface-registration check

`recon-all` can end a hemisphere's surface registration (`?h.sphere.reg`) in a
wrong optimum without any warning in its log; the cortical parcels then sit
about one gyrus away from their anatomy. The sidecar's `registration_check`
module screens for this in each subject of the saved configuration's subject
scope that has `surf/?h.sphere.reg` and `surf/?h.sulc` under the reconstruction
backend's output folder. For each hemisphere it runs `mri_surf2surf` to
resample `?h.sulc` onto fsaverage through the subject's own `?h.sphere.reg`.
The call runs in a temporary `SUBJECTS_DIR` that holds only links to the
subject and to `<FreeSurfer home>/subjects/fsaverage`, so nothing is written in
the subject folder. The module reads the resampled curv file and fsaverage's
`?h.sulc` and `?h.aparc.annot` in plain Python and computes two Pearson
correlations: over the whole cortex (every aparc vertex outside the medial
wall) and over the dorsal frontoparietal regions (precentral, postcentral,
paracentral, superior parietal, supramarginal, caudal middle frontal, and
superior frontal).

A hemisphere is flagged when its robust z on either measure is below -3 or
either correlation is below 0.70. The robust z uses the median and 1.4826 times
the median absolute deviation of all checked hemispheres of the project, both
sides pooled. The project's own reference serves only once every in-scope
hemisphere has a current result and at least 20 are checked. A partial set
never serves, because a check walks the listing in order, controls first, and a
reference built from the hemispheres checked so far would move and drop flags
it had shown. While hemispheres are unchecked, status uses the reference the
last complete check stored or, before the project's first complete check, a
default reference that ships with the sidecar. A running check keeps the
reference that status showed when it started, so its flags only accumulate;
when it ends with every hemisphere current, the project's own reference takes
over.

Results are stored in `.supraspina/surface-registration.json`, one entry per
subject and hemisphere, keyed by the SHA-256 of both input files. The document
also records the method identity, a digest of the fsaverage files, and, once a
check ends with every listed hemisphere current, the cohort reference it ended
with (`reference`: the hemisphere count and each measure's median and scale,
written only when it changes and absent below 20 hemispheres). A changed
surface, method, or atlas makes the entry stale, and the hemisphere is checked
again. Each entry also stores a size, modification-time, and inode signature,
so a status read compares signatures instead of hashing; a hemisphere whose
signature changed reads as unchecked until the next check hashes it, and
unchanged content keeps its result without a new resample. The file is a
cache, not a receipt: no planner node, receipt, or reuse rule reads it, and an
unreadable file reads as empty.

A hemisphere whose check failed keeps its failure until its files change, the
FreeSurfer setup changes, or a check is asked to retry failures. Each cached
failure records a digest of the setup it met: the FreeSurfer home and the path
and file signature of `mri_surf2surf` and of the license (metadata only; the
license is never read). A failure recorded under another digest, or under none,
reads as unchecked, and the next check tries it again.

A failure that no hemisphere caused is never cached per hemisphere. When
`mri_surf2surf` cannot start, or its output shows that FreeSurfer rejected its
license or that a shared library is missing, the operation ends as failed with
that reason and the hemispheres it met stay unchecked. The output is read
through a pipe, and only its first and last 64 KiB are kept. Any other resample
failure is cached only once FreeSurfer is known to run: after a resample in the
same operation has succeeded, or after a setup probe, which the first such
failure runs once per operation. The probe has `mri_surf2surf` resample
fsaverage's own `?h.sulc` onto fsaverage with the same binary, environment, and
license. When it succeeds, each failure belongs to its hemisphere and is cached
under the setup digest. When it fails, the operation ends as failed with the
probe's reason, and none of the failures it was run for is cached. Counting
alike failures cannot separate the two cases, because a broken hemisphere, such
as one whose sulcal depth does not match its sphere's vertex count, fails
faster than a sound one resamples. A check with no resample failure never runs
the probe.

`surfaceRegistration.status` lists the results, the reference, the counts, and
the running or last operation. `surfaceRegistration.check` starts a background
operation and returns at once, and `surfaceRegistration.cancel` stops it. All
three are project-reference calls, so main supplies the saved configuration.
The check needs a resolved FreeSurfer home (the same precedence as recon-all),
`mri_surf2surf` under `<FreeSurfer home>/bin` or on `PATH`, fsaverage, and a
readable, nonempty license file. The license resolves as the FreeSurfer license
row of the tool table above, because that path is the `FS_LICENSE` each call
receives. Without one of these, status names the missing piece and a check is
refused. A running check stops when it is canceled, when another project
attaches, when the project detaches, and at shutdown; finished hemispheres stay
cached. It is not scientific work and never blocks a project switch, a detach,
or shutdown.

QC review reads the status when it opens and starts a check once per visit
when reconstructed hemispheres have no current result; its explicit Check
surface registration action also retries failed hemispheres. The renderer
remembers, for the app session, the saved FreeSurfer install root and license
path each check started under. When the last operation failed as a whole, QC
review starts none on its own while those saved settings are unchanged, since
another check would fail the same way; a failed operation it did not start
counts as started under the current settings. While a check runs, QC review
reads the status every 1.5 seconds. It leaves a running check alone when it
closes, because the sidecar stops the check on a project change. The renderer
words the advisory from the returned correlations and reference, states flags
as provisional while a check runs or a hemisphere is unchecked, marks flagged
subjects in the queue, and can limit the queue to them. When hemispheres stay
unchecked because the check is unavailable or its last operation failed, the
queue header restates the sidecar's reason; a reason the renderer does not
know reads "the check cannot run". Nothing in QC review sets or blocks a
verdict from the check. The [operator guide](user-guide.md#review-qc-galleries)
describes the screen.

## Group-analysis operation

The sidecar's `group_analysis` package serves the
[Analysis panel](user-guide.md#analyze-cohort-results) and follows the
surface-registration check's lifecycle. A `GroupAnalysisManager` handles the
project-reference calls `groupAnalysis.catalog`, `inputs`, `start`, `status`,
`cancel`, `list`, `result`, `termRows`, `measureDetail`, `saveSpec`,
`deleteSpec`, `saveSet`, `lockSet`, and `deleteSet`, and the main-internal
`importVariables`, `deleteVariables`, `exportData`, and `pinResult`. Main
attaches the saved configuration to each and refuses a renderer-supplied
configuration. Each handler returns within milliseconds.

The package's modules divide the work. `spec` holds both specification
versions and the measure-ID grammar. `dataset_v2`, `sources`, and `fsstats`
resolve a v2 sample from the pipeline tables, each subject's FreeSurfer stats,
the labeling cache, and imported variables without NumPy, and `design_check`
checks it, including the [site rule](science.md#sites-and-scanners).
`inputs` resolves a draft's sample and runs the design check this way, so the
RPC process never loads NumPy. `engine_v2` fits the model in the worker on
NumPy, the only numerical dependency; the Student-t, noncentral-t, and F
functions are pure Python. Atlas labeling is `atlas_manager` with its own
worker (`atlas_worker`), the recipes in `atlas_recipes`, the cache in
`atlas_cache`, the tool probes in `atlas_tools`, and the external source
catalog in `atlas_sources`. Golden fixtures and their generators are in
`sidecar/tests/fixtures/group_analysis/`; [Science](science.md) describes how
they are regenerated.

`start` validates the specification and the renderer's judged stage currency
and returns an operation identifier. A manager thread then snapshots the
registry, QC records, and surface-registration rows and starts a worker
process in its own session: the frozen binary with
`--supraspina-group-analysis-worker`, routed in `pyinstaller_entry.py` before
the package import, or `python -m supraspina_sidecar.group_analysis.worker` in
a source checkout. The worker receives one job document on standard input,
lowers its priority, pins numerical libraries to one thread, reads every table
once, reports progress as JSON lines, and writes the result atomically. The
renderer reads `status` every 500 milliseconds while a computation runs; there
is no event channel and no pipeline log line.

One computation runs at a time. `cancel` kills the worker's process group, a
request for another project stops it, and detach and shutdown stop it (the
shutdown waits at most 2 seconds). A stopped worker leaves no partial result,
and the previous result stays. The worker is not scientific work: it is not in
the process-ownership ledger, the switch guard does not count it, and it never
blocks a project switch, a detach, or shutdown. The handshake advertises the
`cohort-analysis-v1`, `cohort-analysis-v2`, and `atlas-labeling-v1`
capabilities.

Saved specifications and ROI sets live in `.supraspina/analysis/specs.json`,
whose writes name the revision they build on. Each result is
`.supraspina/analysis/results/<resultId>.json`: the specification, the resolved
sample with exclusion reasons, the input-table digests, the rows, the
per-subject values, the engine identity, the product version and build, the
stage currency the renderer judged at Compute, and `resultSha256` over the
record's canonical JSON. A record whose digest does not match reads as absent.
A v2 record is at most 32 MiB; `result` returns it without per-subject values
and with as many of its first term's rows as fit the 2 MiB payload cap, and
`termRows` pages any term's rows 2,000 at a time. The newest 20 results are
kept, plus every exported one. `list` judges each result against the project
now and names each difference as a stale reason (`inputs-changed`,
`qc-changed-sample`, `registry-changed`, `registration-changed`,
`engine-changed`, `sample-too-small`, or `labels-changed`). Imported variables
tables live in `.supraspina/analysis/variables/`; main's file dialog gives
their path, and the sidecar copies them with bounded reads. The store is
advisory state, not a receipt: no planner node, receipt, or reuse rule reads
it. The package writes only `.supraspina/analysis/` and, for an added atlas,
the machine atlas cache that main names; it never writes below `outputs/run/`,
the registry, the QC store, a receipt, or a derivative.

Main writes exports. `groupAnalysis.chooseExportFolder` opens the folder
dialog at `<project>/exports/analysis/`, and `groupAnalysis.writeExport` takes
the renderer's SVG and PNG figures, calls `groupAnalysis.exportData` for the
CSV and JSON text, and creates a new folder exclusively under the chosen
parent. For a v2 result, main also reads every term's rows through `termRows`
and renders `terms.csv`, `grid.csv`, and `atlas-licenses.csv`, the last from
the project's atlas catalog and the source list; the sidecar renders the rows
themselves as `results.csv` from the whole record. Names follow `[a-z0-9._-]`
with fixed extensions, files are written through temporary names, and nothing
is overwritten or registered in the Results inventory. A PDF is printed from
the SVG in a hidden window with sandboxing on, JavaScript off, no preload, and
an in-memory session that refuses every request. `groupAnalysis.chooseSetCsv`
reads an ROI set CSV in main after its file dialog.
`groupAnalysis.chooseVariablesCsv`, `chooseAtlasFiles`, and
`chooseLabelsFolder` show their dialogs in main, check the pick (an absolute
path, a regular file or folder that is not itself a link, an offered file kind,
and a size cap), and only then hand the path to the sidecar's
`importVariables`, `importAtlas`, or `importAtlasLabels`; the renderer never
names a path.

The brain viewer reads FreeSurfer files natively, never through JSON-RPC.
`brainViewer.assets` reports what is available, and `brainViewer.readAsset`
returns one file's bytes and SHA-256 as a `Uint8Array`. The allowlist is the
fsaverage5 pial, inflated, and sulcal-depth surfaces and DK annotations,
fsaverage's `brain.mgz` and `aparc+aseg.mgz`, and, optionally, the fsaverage5
Destrieux and Yeo annotations and fsaverage's Brodmann-area labels. These
resolve under the FreeSurfer home (the saved `tools.freesurferHome`, then
`FREESURFER_HOME`), with each real path confined under `realpath(home)/subjects`
and `FreeSurferColorLUT.txt` confined under the home itself. A subject's
`brain.mgz`, `aparc+aseg.mgz`, `wmparc.mgz`, `aparc.a2009s+aseg.mgz`,
`aparc.DKTatlas+aseg.mgz`, and `entowm.mgz` resolve under
`derivatives/freesurfer/<subject>/mri/` through main's artifact confinement.
Labeling-cache files (`atlas/<atlasId>/subject/<file>` and
`atlas/<atlasId>/templates-fsaverage5/<file>`) are confined under
`.supraspina/analysis/atlases/`, may not themselves be symlinks, and must be
files the atlas's recipe lets the viewer read. Only regular files up to 16 MiB
are read, and no FreeSurfer data is bundled. The renderer draws them with
NiiVue, which Vite bundles as a separate chunk loaded when the Brain tab first
opens. The build records every package it bundles into the renderer in
`out/renderer/bundled-packages.json`, from which the release notices and SBOM
take their license texts.

## Atlas labeling operation

The sidecar's `AtlasLabelingManager` labels, on demand, the
[atlases](science.md#atlases) that FreeSurfer does not write during
`recon-all`, with the group-analysis lifecycle. The Analysis panel starts it
from Choose measures through `groupAnalysis.labelStart` (atlas, subjects as
`missing`, `stale`, or a list, 1 to 8 parallel jobs, and the recon currency the
renderer shows). The other calls are `groupAnalysis.atlases`, `labelStatus`,
`labelCancel`, and `clearLabels`, which names the cache revision it builds on.
Main attaches the saved configuration and, to `atlases`, `labelStart`, and
`importAtlas`, the machine-level tools: the `subregionsPython` preference and
the machine atlas cache folder. The renderer reads `labelStatus` every second
while a labeling runs.

`labelStart` checks the tools, resolves the subjects, and returns an operation
identifier at once. It skips a subject without a reconstruction, one the
renderer's currency marks out of date, one whose `scripts/` folder holds a
FreeSurfer `IsRunning` marker, and, for a label-map atlas, one without an
imported map. A manager thread sweeps stale work folders and starts one worker
process in its own session: the frozen binary with
`--supraspina-atlas-labeling-worker`, routed in `pyinstaller_entry.py`, or
`python -m supraspina_sidecar.group_analysis.atlas_worker` in a source
checkout. The worker lowers its priority by nice 10, sets the OpenMP, ITK, and
BLAS thread counts to 1, reads one job document on standard input, and reports
one JSON line per subject start and end. It runs each FreeSurfer tool with the
FreeSurfer runtime environment and `SUBJECTS_DIR` set to a shadow folder,
`.supraspina/analysis/atlases/_work/<operationId>/<subject>/sd/`, that holds
file-level symlinks to the recipe's declared inputs, each confined by real path
to that subject's recon folder; every output path is explicit. Before and after
each subject, the worker records the recon folder's entries (type, size, and
modification time, without following symlinks); any difference fails the
subject with "The labeling tool changed files in the recon folder; labeling
stopped." and stops the operation. The tools are probed on their own thread
with a 5-second limit, and the result is kept for 30 seconds; the environment
check never runs them.

The project's labeling cache is `.supraspina/analysis/atlases/`:

| Path                                           | Contents                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| `<atlasId>/<subject>/`                         | The kept outputs and `labels.json` (schema `supraspina/atlas-labels`), replaced whole |
| `templates/fsaverage5/{lh,rh}.<atlasId>.annot` | Template labels for the brain viewer                                                  |
| `_work/<operationId>/`                         | Shadow folders and tool outputs of a running operation                                |
| `revision.json`                                | The revision every labeled, imported, or cleared subject bumps                        |

One labeling runs at a time per sidecar, independent of a computation. Cancel
kills the worker's process group, and finished subjects keep their labels. A
request for another project, a detach, and shutdown stop it. Like a
computation, it is advisory: it is not in the process-ownership ledger, the
switch guard does not count it, and it never blocks a project switch, a detach,
or shutdown. The main-internal `importAtlasLabels` copies recognized subregion
or label-map files from a folder of per-subject folders into the cache with
provenance `imported`; it reads an added atlas's recipe from the machine cache
and refuses every other recipe. `importAtlas` copies an added atlas's files
into the machine cache. Downloads of external atlases run in main
(`atlasSources.*`) into the machine cache, one at a time per app. The labeling
never writes under `derivatives/` or `outputs/run/`, never touches receipts,
the registry, the QC store, or a plan input, and emits no pipeline log or job
event. A computation reads the cache, and each labeled atlas's digest joins the
result's inputs.

## Cancellation, reload, and shutdown

Cancellation targets the sidecar-owned process group and records the outcome.
The supervisor restarts the sidecar after retryable failures with bounded
delays of 250, 1000, and 2500 milliseconds, but only when termination ownership
is proved.

Renderer reload and a permitted project switch invalidate or detach the active
project within the existing sidecar generation; they do not normally restart
the Python process. Window close, application quit, and update installation
stop the sidecar. Shutdown requests `system.shutdown`, requires no active jobs
or resource operations, then uses process-group termination and proves exit.
If safe ownership or termination cannot be established, Supraspina fails
closed.

On startup, the sidecar reconciles persisted records with owned-process
evidence. It marks interrupted or uncertain work for explicit review and never
reruns scientific commands on its own.

## Updates and failure reporting

Update capability resolves once in the main process. Development and source
runs resolve to `noop` and never contact the network. A packaged AppImage
resolves to `full`, and every other package, including the deb, resolves to
`notify`. Both packaged capabilities read the public GitHub Releases of
`qwareeq8/supraspina` through electron-updater's GitHub provider: at most one
launch check a day while Check automatically is on, and a manual check from
Settings or About. The last check time is stored in the machine preferences
file, apart from the preferences the renderer can patch.

The updater never downloads on its own. On `full`, a download starts only after
the operator confirms an offered version, and electron-updater verifies the
file against the SHA-512 in `latest-linux.yml` before it replaces the AppImage
on quit or on Restart and install. On `notify`, Supraspina links the release
page instead, because replacing an installed deb needs root. A request filter
on the `electron-updater` session cancels every request except release reads
on github.com and asset downloads from GitHub's two release-asset hosts. The
package smoke run replaces that filter with one that cancels every request and
makes no launch check.

Structured refusals cross the native boundary in sanitized form. Incidental
exceptions, credentials, local path details, and raw tool output are reduced or
redacted before renderer display. Bounded log and progress windows keep recent
attributed context, and logs carry no execution authority.

The sidecar's own checks (`ruff format --check`, `ruff check`, and `pytest`)
are part of the source gate in
[Development](development.md#source-verification).
