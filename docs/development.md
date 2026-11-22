# Development and verification

Supraspina has two source environments: npm for the Electron and TypeScript
application and `uv` for the Python sidecar. Keep them separate and use both
committed locks. Read [Scientific methods and limitations](science.md) before
changing stage descriptors, adapters, resources, detectors, or output
contracts.

## Requirements

- A Linux development host.
- Node.js `^22.13.0` or `>=24.0.0`. Node 23 does not satisfy the engine range.
- npm with `package-lock.json`. No npm version is pinned.
- Python 3.12 or later.
- `uv` with `sidecar/uv.lock`. No `uv` version is pinned.
- Chromium installed through Playwright, for visual and accessibility checks.
- `shellcheck`, for the repository shell scripts.

Releases and the hosted source gate use the exact hashed Python 3.12.10 inputs
in `sidecar/requirements/`, not the `uv` development environment.

## Set up and run

From the repository root:

```bash
npm ci
uv sync --project sidecar --all-extras --locked
uv run --project sidecar --all-extras --locked \
  python -m supraspina_sidecar.scientific_assets --acquire
npm run dev
```

`uv sync` creates `sidecar/.venv`, which the Electron development build uses as
the sidecar interpreter. The repository does not contain the ENIGMA QC and
SCI_Map files, because they carry no license, so the acquisition step downloads
the pinned SCI_Map archive, verifies the archive and every selected file
against the committed checksums, and activates a generation in the same
machine-local scientific-asset cache that packaged builds use. Diagnostics
offers the same command. A checkout resolves the ENIGMA QC and feature
extraction directories from that generation and every other resource directory
from its own `resources/`. Sidecar tests that need upstream files read them
from the generation and fail with this command until it has run.

After editing a first-party file in `resources/enigma/` or
`resources/features/`, run `npm run provenance:write` and the acquisition
again. The acquisition then rebuilds the generation from the files already
acquired, without a download. Until it does, the checkout runs its own copy and
reports the generation as out of date.

For direct protocol work, start the sidecar on its own:

```bash
uv run --project sidecar --all-extras --locked supraspina-sidecar
```

It reads one JSON-RPC request per standard-input line and writes one response
or notification per standard-output line. In normal use, Electron starts and
supervises it.

`npm start` and `npm run preview` rebuild the Electron bundles and launch an
unpackaged preview. `npm run build` writes the main, preload, and renderer
bundles under `out/`; it does not freeze Python or create a package.
`npm run build:sidecar` creates the PyInstaller onedir bundle, and
`npm run package:linux` combines it with AppImage and deb packaging. Outside a
release, the build script resolves an interpreter and requires PyInstaller; a
release sets `SUPRASPINA_BUILD_PYTHON` to the prepared, hashed Python 3.12.10
environment. Build packages only as [Releasing](releasing.md) describes, never
from the `uv` development environment.

## Repository map

| Path                          | Responsibility                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `src/main/`                   | Electron authority, IPC, lifecycle, sidecar supervision, package smoke          |
| `src/preload/`                | Typed, context-isolated renderer bridge                                         |
| `src/renderer/`               | React UI, local presentation state, accessibility behavior                      |
| `src/shared/`                 | Zod schemas, IPC contracts, stage descriptors, UI help                          |
| `sidecar/supraspina_sidecar/` | Python RPC server, schemas, DAG, stores, resources, adapters, process ownership |
| `resources/`                  | Supraspina-owned scientific support files and bundled fonts                     |
| `scripts/`                    | Build, metadata, provenance, screenshot, package, and release checks            |
| `packaging/`                  | Committed application icon and Linux icon ladder                                |
| `docs/screenshots/`           | Deterministic synthetic documentation captures and manifest                     |
| `fixtures/`                   | Shared JSON fixtures that both the TypeScript and Python tests read             |
| `licenses/`                   | Reproduced third-party license texts and font manifests                         |
| `analyses/`                   | Standalone research analysis code, separate from the application                |

`resources/` holds only files Supraspina may redistribute: the first-party
scientific reimplementations, including `enigma/outliers_qc.R`, the
path-injection and report-template adaptations, presentation and packaging
support, the `enigma/CHECKSUMS.sha256` manifest, and the bundled Latin Modern
fonts under their GUST license. The unlicensed upstream files, chiefly the
ENIGMA FreeSurfer protocol tree, the feature-order template, and the two ENIGMA
wrapper scripts that Supraspina adapts, are never committed. The acquisition
installs them from the pinned archive, and `npm run check:provenance` fails
while any of them is in the checkout.
`sidecar/tests/fixtures/upstream-resource-blobs.json` records each one's
upstream path, Git blob, and installed SHA-256. `THIRD_PARTY_PROVENANCE.json`
records the classification, delivery, and license of every file and is
authoritative over this summary.

Generated paths include `out/`, `build/`, `release/`, `resources/sidecar/`,
`visual-evidence/`, JavaScript and Python coverage, and sidecar build and
virtual-environment directories. They are ignored and are not release inputs.

## Focused checks

Run the checks closest to a change before the complete source gate:

```bash
npm run typecheck
npm run lint
npm test
npm run build

uv run --project sidecar --all-extras --locked ruff format --check sidecar
uv run --project sidecar --all-extras --locked ruff check sidecar
uv run --project sidecar --all-extras --locked pytest sidecar
```

`npm run check:screenshots` checks the committed capture metadata, and
`npm run visual:test` checks the source UI's viewports, themes, zoom, overflow,
accessibility, and screenshot matrix. Install its Chromium runtime with:

```bash
./node_modules/.bin/playwright install chromium
```

On a clean Ubuntu gate host, use `--with-deps chromium` instead.

### Real-Electron acceptance

`npm run acceptance:electron -- --manifest /absolute/run.json` audits a visible
Supraspina window through `scripts/real-electron-ui-check.cjs`. Where
`npm run visual:test` renders the source UI in Chromium, this driver launches a
real Electron target and drives its controls, so it checks shell behavior:
window geometry, fonts, focus, route changes, console errors, and axe results in
the shipped process model.

The driver validates the manifest before launch. It requires `schemaVersion` 1,
a `runId`, a `target` (`kind` of `source`, `unpacked`, `appimage`, or
`deb-installed`, plus `id` and an absolute `executable`, with optional `cwd`,
`args`, and `env`), an absolute `profile` and `outdir`, a `display`, and a
`stage.mode` of `first-run`, `empty`, `populated`, or `completed`. Populated and
completed stages also require `stage.recentProject.path`, which the driver
chooses from the visible Open menu. Optional fields are `stage.firstRunAction`,
`stage.freesurferConfiguration`, `windows`, `screenshotRepeats`, `timeoutMs`,
`settleMs`, `expectedTitle`, `failOnAxeIncomplete`, and per-route
`expectations`. Validation rejects headless, sandbox-disabling, and
state-substituting launch arguments, a `target.args` entry that overrides the
profile, and reserved `target.env` keys.

The run needs:

- The X display named in `display`, where the window must be visible. The
  driver exports it to the Electron process.
- A scratch `profile` directory, passed as `--user-data-dir`. The driver keeps
  it between staged runs, so initialize it with a `first-run` or `empty` stage
  first; a `populated` or `completed` stage on a new profile fails on the
  first-run modal.
- `xdotool` when `stage.freesurferConfiguration` is present, because the
  FreeSurfer installation root and license are chosen through native X11 file
  choosers. The driver uses the binary named in
  `stage.freesurferConfiguration.xdotool`, `/usr/bin/xdotool` by default.

## Source verification

There is no single `verify` script. The npm commands below run in the order of
`.github/workflows/quality-gates.yml`. The Python commands use the locked
development environment and cover the same checks that the hosted gate runs
with its hashed Python 3.12.10 inputs. Run every block from the repository
root:

```bash
npm run check:release
npm run check:prod-deps
npm run check:provenance
npm run check:python-locks
npm run check:screenshots

npm run format:check
npm run typecheck
npm run lint
npm run test:scripts
npm run test:cov
npm run test:cov:critical
npm run visual:test

uv run --project sidecar --all-extras --locked ruff format --check sidecar
uv run --project sidecar --all-extras --locked ruff check sidecar
uv run --project sidecar --all-extras --locked \
  python -m supraspina_sidecar.scientific_assets --acquire
uv run --project sidecar --all-extras --locked pytest sidecar
(
  cd sidecar
  uv run --all-extras --locked pytest \
    --cov=supraspina_sidecar --cov-branch \
    --cov-report=term-missing --cov-report=json:coverage.json
  uv run --all-extras --locked python scripts/check_coverage.py coverage.json
)

shellcheck scripts/*.sh
git diff --check
```

The hosted workflow runs only for version-tag pushes, so commits on `main` get
no hosted run and this local gate is the source verification between releases.
Run it before every commit. The hosted run verifies release identity and the
source gates on Ubuntu 24.04; it does not build, publish, install, or accept
Linux packages. Package acceptance is the maintainer process in
[Releasing](releasing.md).

## Change rules

Keep the renderer behind the typed preload API, and keep filesystem and process
authority in the Electron main process or the sidecar. Preserve the
saved-project revision boundary, project identity and generation, one-use plan
authorization, exact cohort and input fingerprints, current-schema receipts,
process-tree ownership, cancellation evidence, bounded control-plane messages,
redaction, and immutable run history.

Do not weaken a detector, QC gate, provenance check, coverage threshold,
resource pin, updater gate, or path boundary to make other work pass. A change
to scientific commands, transforms, defaults, statistical behavior, or output
contracts needs separate scientific review and tests of the changed behavior.
Never commit an upstream SCI_Map or ENIGMA file.

Use Vitest for main, preload, shared, and renderer behavior and pytest for the
sidecar. Test observable contracts and failure boundaries, and keep fixtures
distinctive enough that a wrong source cannot satisfy an assertion. Use
deterministic synthetic fixtures for tests, documentation, and UI captures;
never add participant or patient data, derived images, identifying metadata, or
content digests of private data.

When public behavior, commands, supported targets, inputs, outputs, or errors
change, update the one document that owns the fact rather than repeating it.
Use Conventional Commit subjects, as in the existing history, and keep
unrelated changes out of a commit.

## Documentation screenshots

The nine committed dark-theme captures in `docs/screenshots/` come from the
deterministic `supraspina-synthetic-documentation-v2` fixture: seed `17`, a
fixed clock, and 12 synthetic subjects. It contains no real participant,
patient, or clinical data, and no QC anatomy is rendered. Demographic,
cohort, AIS, date, time, and reviewer-note fields read `Redacted`; synthetic
subject identifiers and application labels stay visible to tell the scenarios
apart. The captures are 3200 by 2000 pixels in metadata-free PNG files.

The set shows representative states of Dashboard, Subjects, Runs, Logs, QC
review, Results, Analysis, and Diagnostics. QC review shows its drawn panels,
each a plain `Synthetic QC panel` placeholder tile with no anatomy. The
Analysis capture shows the Forest tab of the fixture's synthetic group-analysis
result, judged current, with the Brain tab closed; the capture fails if the
page holds a canvas. The Analysis grid capture shows the Grid tab of a
synthetic within-group battery, a v2 result with five tests over four outcomes,
one outside the correction family, and also draws no brain.

`docs/screenshots/MANIFEST.json` records each PNG's source route, dimensions,
content digest, fixture identity, redaction policy, production-source closure,
and locked Playwright and Chromium identity. A change to the source or the
capture runtime invalidates the set until it is recaptured, and
`npm run check:screenshots` fails until then.

### Recapture the set

With the locked Node dependencies and Playwright Chromium installed, run from
the repository root:

```bash
npm run build
npm run screenshots:documentation
npm run check:screenshots
```

Review all nine PNGs before committing them, and confirm that the manifest
names the approved synthetic fixture, no real-participant data, no QC raster
content, and the current file digests.
