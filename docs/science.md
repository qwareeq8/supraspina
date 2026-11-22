# Scientific methods and limitations

Supraspina is research workflow software. It orchestrates tools, records
evidence, and exposes human-review gates. It does not validate a method for a
study population, determine anatomical correctness, establish
de-identification, control a study's statistical error rates, or support
diagnosis, treatment, clinical decisions, or patient care.

The provenance baseline is upstream
[`ortizo-117/SCI_Map` commit `8a8c2d3`](https://github.com/ortizo-117/SCI_Map/tree/8a8c2d3586a37bb896bd8bdc3743b43e602827e3).
[`THIRD_PARTY_PROVENANCE.json`](../THIRD_PARTY_PROVENANCE.json) records which
files are upstream, acquired, reimplemented, or first-party support code. The
upstream tree has no repository license, so neither the source repository nor
the packages contain its files. Source checkouts and packaged builds acquire
them at run time through an operator-authorized flow that verifies every file
against its reviewed SHA-256 before use.

The BrainCharts stage, the z-score track, the R analysis site rule, the
white-matter family, and the ICV and mean-thickness summaries follow upstream
[commit `eba4f59`](https://github.com/ortizo-117/SCI_Map/tree/eba4f59489438a54d41825db57c6cfc983d059ad),
which `THIRD_PARTY_PROVENANCE.json` records for `braincharts_run.py` and every
BrainCharts run records in `braincharts_run.json`. The receipt-bound baseline
pin stays `8a8c2d3`. Upstream replaced PyBrainAge with BrainCharts at
`eba4f59`; Supraspina keeps both, so Brain-PAD results stay reproducible.

## Stage contract

The workflow has three subject-scoped stages and eleven cohort-scoped stages.
Optional defacing, BrainCharts normative modeling, and z-score group
comparisons are off by default. The table lists the primary data contracts;
configured paths can change their locations.

| Stage                          | Scope                   | Primary inputs                                                                                    | Method and primary outputs                                                                                                                                                                                                                                        |
| ------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brain FOV preparation          | Subject                 | Raw scalar 3D T1 NIfTI                                                                            | An in-range volume keeps the source input and gets QC and provenance only. Otherwise the stage publishes a SynthStrip-mask-guided, non-resampled crop, a source-grid mask, a QC montage, and provenance JSON under `derivatives/supraspina-brainfov`.             |
| Optional defacing              | Subject, off by default | Reviewed prepared T1                                                                              | Runs the selected `mri_deface`, `fsl_deface`, or `pydeface` command, or copies the input unchanged in `skip` mode, and writes a separate defaced T1 derivative.                                                                                                   |
| Reconstruction                 | Subject                 | Reviewed prepared or defaced T1                                                                   | Runs FreeSurfer, FastSurfer, or the `auto` fallback policy and writes a FreeSurfer-compatible subject directory and a reconstruction receipt.                                                                                                                     |
| ENIGMA QC                      | Cohort                  | FreeSurfer derivatives                                                                            | Runs the selected MATLAB or MATLAB Runtime backend and writes three measure CSV files and the subcortical, internal-cortical, and external-cortical galleries.                                                                                                    |
| Histogram and outlier review   | Cohort                  | ENIGMA measure tables                                                                             | Applies the configured z-score threshold (default 2.698) and writes `outliers.csv` and histograms named by source, measure, and column.                                                                                                                           |
| FreeSurfer feature extraction  | Cohort                  | FreeSurfer Destrieux and aseg statistics                                                          | Builds `concatenated_results.csv` with the subject ID and the 187 features in the trained order. PyBrainAge planning requires `aparc.a2009s` thickness and order validation.                                                                                      |
| Age metadata integration       | Cohort                  | Feature table and age table                                                                       | Joins the configured subject-ID and age columns. The default left join keeps a missing age as `NaN` with a warning, names those subjects, and requires every supplied age to be finite.                                                                           |
| PyBrainAge prediction          | Cohort                  | Age-integrated features, scaler, ExtraTrees model                                                 | Writes `ID`, `Age`, `BrainAge`, and `BrainPAD` to `predicted_results.csv`. Row-by-row fallback after a failed batch prediction is on by default.                                                                                                                  |
| Clinical merge                 | Cohort                  | Predictions and clinical table                                                                    | Joins on the configured key, requires `Cohort` and `AIS` by default, and writes `analysis/predicted_results.xlsx`.                                                                                                                                                |
| Brain-PAD statistics           | Cohort                  | Validated clinical workbook                                                                       | Validates identities, categories, finite model values and supplied ages, and the Brain-PAD sign, and writes a digest-bound generation of a cohort summary, five figures, and six comparison tables.                                                               |
| Structural data aggregation    | Cohort                  | FreeSurfer statistics                                                                             | Collects Desikan-Killiany regional statistics, cortical thickness, intracranial volume, and white-matter volumes into four cohort CSV files.                                                                                                                      |
| R analysis                     | Cohort                  | Aggregated structural data and `metadata.csv`                                                     | Rejects invalid nonmissing region values, applies the site rule, runs per-region structural comparisons, and publishes one generation of twelve result tables, `site_exclusions.csv`, the ICV and mean-thickness summaries, and an optional HTML report.          |
| BrainCharts normative modeling | Cohort, off by default  | Feature table, registry age, sex, site, and cohort, and the acquired `lifespan_57K_82sites` model | Adapts the model to each site's controls and publishes one manifest-bound generation under `braincharts/`: per-region z-scores for held-out controls and patients, a z-score summary, the split report, each subject's role, the refused sites, and a run record. |
| Z-score group comparisons      | Cohort, off by default  | BrainCharts z-scores and refused sites                                                            | Runs the R analysis comparisons on the z-scores, pooling the adapted sites, and publishes eight `Z_` result tables and an optional HTML report under `zstats/`.                                                                                                   |

The dependency graph branches after reconstruction. ENIGMA QC precedes
histogram and outlier review. FreeSurfer feature extraction precedes age
metadata integration, PyBrainAge prediction, clinical merge, and Brain-PAD
statistics, and also BrainCharts normative modeling, which precedes z-score
group comparisons. Structural data aggregation precedes R analysis.
Planning expands subject and cohort nodes and binds their exact inputs before
execution.

## Scientific input bounds

Cohort table readers reject inputs above 64 MiB, 5,000 data rows, or 1,024
columns before reading them into a dataframe or R table. Feature extraction and
structural aggregation stop subject-glob enumeration at 5,000 candidates, and
their intermediate FreeSurfer tables and stats files have lower limits of their
own.

The Clinical and Brain-PAD XLSX readers inspect the ZIP container before
OpenPyXL or pandas loads workbook XML. They allow at most 1,024 archive
members, 64 MiB per expanded member, 256 MiB of total expanded content, and a
100-to-1 compression ratio per member, and they reject encrypted, duplicate,
multi-disk, ZIP64, inconsistent, and trailing-data archives.

These are resource limits, not statements about an appropriate study size.
Splitting a cohort changes the statistical population and is a study decision;
Supraspina does not split inputs.

## Brain FOV geometry

The reader accepts uncompressed or gzipped single-file NIfTI-1 volumes with one
scalar 3D image. It rejects unsupported dimensions or data types and requires a
finite, nonsingular qform or sform affine. The physical field of view is
computed from the affine column norms in millimeters.

If every voxel axis spans at most 256 mm, the stage keeps the source T1 as the
selected input and publishes QC and provenance without copying the T1 or
creating a mask. NIfTI-1 stores the affine as IEEE-754 binary32, so a nominal
256 mm acquisition such as 0.8 mm by 320 voxels reads back as 256.0000038 mm;
the comparison therefore allows one binary32 unit in the last place at the
compared length, about 30 nm at the limit. A larger field of view requires a
verified SynthStrip mask. The crop is computed in source voxel coordinates,
copies encoded voxels without interpolation or resampling, translates the qform
and sform matrices, and preserves their codes. The default requested clearance
is 30 mm from the mask to each crop face. A dimension is capped at 256 mm, and a
candidate is rejected when a face would keep less than 15 mm of clearance.

The active affine uses a valid sform in preference to the qform, and no RAS or
LPS reorientation occurs. The montage columns labeled sagittal, coronal, and
axial are voxel axes 0, 1, and 2, so those labels assume the input axes already
have the expected anatomical orientation. In a cropped publication the written
SynthStrip mask stays on the source grid; it is crop evidence, not a mask in
the cropped geometry.

The provenance and montage let an operator review the crop. They do not prove
that the mask contains all relevant anatomy, that the orientation metadata is
correct, or that the derivative suits another purpose.

## QC and evidence

ENIGMA completion requires the current cohort in all three measure tables and
all three galleries. For each subject the detector expects 24 subcortical, 32
internal-cortical, and 4 external-cortical PNG panels, and it checks file
identity, PNG structure, dimensions, membership, and the bound gallery evidence
before a review can be accepted. These checks establish an output and review
contract, not anatomical accuracy.

`pass`, `fail`, and `defer` are operator decisions for the current analysis.
Failed subjects stay in history but leave the downstream cohort. Deferred and
unreviewed subjects require explicit acknowledgment in the plan. No cohort
stage reads the verdicts, so cohort receipts bind the analysis membership
(subjects, T1 inputs, and the QC Fail and configuration exclusions) rather than
the verdicts; each run records the verdicts it was planned with.

Receipts bind the saved configuration, the subject or cohort scope, inputs,
environment, managed-resource identity, command, the hashes of
repository-owned scientific support files, and the produced artifacts. The
command identity canonicalizes the run directory and the machine-local
directory of acquired scientific resources, so runs that execute the same
executable, arguments, cohort, and destinations share one reusable identity,
and each referenced resource is bound by its content: rebuilding the assets
with identical bytes keeps receipts current, and changed bytes invalidate them.
Run identity and the run-scoped input projections are bound separately. Every
other path, argument, and destination is exact. After the scientific process
exits and before it signs a receipt, the sidecar rechecks the bound inputs,
support files, and execution identity; a missing or changed value invalidates
completion. Existing files without a current receipt are not adopted. Only the
current project, QC, run, manifest, and receipt schemas are accepted, with no
data-format migration layer.

### Per-subject reuse in cohort stages

ENIGMA QC on the MATLAB Runtime backend reruns only the subjects whose images
could differ; the source MATLAB backend renders every subject. Each subject has
three render units: subcortical and internal-cortical slices from
`mri/aparc+aseg.mgz` and the intensity volume the wrapper passes (`mri/nu.mgz`
for FreeSurfer 8, `mri/orig_nu.mgz` otherwise), and external-cortical views
from `surf/{lh,rh}.pial.T1` and `label/{lh,rh}.aparc.annot`.

A unit's earlier render is kept only when the newest earlier ENIGMA receipt
that recorded the unit used the same method and the current SHA-256 of every
unit input and every file the unit owns equals that receipt's record. The
method is the bound command (with the run directory canonicalized), the bytes
of the ENIGMA assets and compiled launchers, the tool evidence (MATLAB Runtime
and shell tools), the runtime's `VersionInfo.xml` and runtime library, the
bytes of the module that declares the units, and the step options, including
`fsVersion`. The system OpenGL and Mesa libraries, fonts, and the X server or
`xvfb-run` are not bound. Every other unit is rendered, and upstream's wrapper
always writes the measure tables and HTML galleries over the full cohort, so a
reused subject's images are byte-identical to the run that rendered them.

Before launch, each rendered unit's earlier output moves into a holding area,
`.supraspina-held/<run>` in the QC output directory, so the tool writes into an
empty location. Because the wrapper exits cleanly even when a MATLAB child
fails, the receipt is refused and the stage fails when a rendered unit lacks a
gallery panel or listed file, holds a file older than the launch, or holds bytes
identical to the earlier render (MATLAB writes a creation time into every PNG,
so a real render always differs). After the wrapper exits, Supraspina rereads
the inputs and the reused images and refuses the receipt if any changed. On
success the held copy is removed; on failure or cancellation it is checked
against its digests and moved back. A held copy that does not match stays
held, the current output stays as it is, the job log names both paths for a
person to resolve, and the unit is rendered again on the next run. If
Supraspina stops during the run, the next ENIGMA QC launch moves the held
output back, or removes it when that run's receipt recorded the new output.

The receipt record (`unitReuse`, outside the signed payload) lists each unit as
computed or reused, with the reason, the input and output digests, the run that
rendered its bytes, each source run's receipt, and whether reuse was on.
Turning reuse off renders every unit and still records why each would have
been rendered. A subject ID with characters other than ASCII letters, digits,
dot, dash, and underscore is rendered every run and recorded as unrecorded.

A verdict records the gallery run it was reviewed on, so a reused subject keeps
its verdict. When a subject's images are rendered again because its inputs or
the method changed after its verdict, QC review says so above the montage; the
verdict, the analysis cohort, and every plan digest stay as they are.

The stages that compute cohort statistics (outliers, Brain-PAD, R analysis,
z-scores, and BrainCharts) depend on the whole cohort and always rerun in full.
Feature extraction, aggregation, age, clinical, and PyBrainAge take seconds per
cohort and also rerun in full.

## Brain age and cohort statistics

The pinned PyBrainAge v3 asset is an ExtraTrees model with its matching scaler.
Its committed Linux x86_64 explicit lock binds 178 conda-forge artifact URLs,
builds, and SHA-256 values. The runtime requires Python 3.7.12, NumPy 1.20.3,
pandas 1.3.4, scikit-learn 0.24.2, SciPy 1.7.3, openpyxl 3.0.10, matplotlib
3.5.3, Seaborn 0.12.2, statsmodels 0.13.2, and pip 24.0. A separate
hash-required lock installs `cliffs-delta` 1.0.0 without dependencies.

Provisioning records the two lock digests, the runtime versions, bounded conda
metadata, the micromamba identity, and the archive, model, and scaler.
Diagnostics later rechecks those identities and runs a synthetic pickle and
prediction probe. This binds the software environment more tightly than a
version-only solve, but it does not validate the model for a population.
The environment serves only PyBrainAge prediction; see
[PyBrainAge and BrainCharts](installation.md#pybrainage-and-braincharts) for
the Python 3.7 security caveat. Brain-PAD uses the separately configured analysis Python, which
also needs `cliffs-delta` 1.0.0.

For each predicted row,

$$
\mathrm{BrainPAD} = \mathrm{BrainAge} - \mathrm{Age}.
$$

A positive value means only that this model's estimated age is higher than the
supplied chronological age. Supraspina assigns no individual clinical meaning
to the difference and does not establish calibration, accuracy, or
generalizability for a study population.

Chronological age is not a model input, so a subject whose age never reached
the feature table still receives a brain-age prediction; only its Brain-PAD is
undefined and stays empty. The Brain-PAD stage excludes those subjects from
every Brain-PAD statistic, comparison, and figure, counts them in the
`N without age` column of the cohort summary, and reports them once on standard
error. The age-integration and prediction stage details and logs name the same
subjects, up to twenty identifiers.

Brain-PAD analysis requires the cohort labels `control`, `SCI_nNP`, and
`SCI_P`. Every SCI row requires AIS `A`, `B`, `C`, or `D`; a control AIS may be
missing or one of those values. Nonmissing sex values must be `Female` or
`Male`. The stage requires unique nonempty subject identities, a finite
`BrainAge`, finite `Age` and `BrainPAD` values wherever they are supplied,
`BrainPAD = BrainAge - Age` exactly on every row with an age, an empty
`BrainPAD` on every row without one, and a finite nonnegative time since injury
when supplied. The clinical merge before it checks only the configured required
columns and membership, not these domains.

For at least three observations, the parametric branch is chosen only when both
Shapiro-Wilk and a fitted-parameter Kolmogorov-Smirnov test give $p > 0.05$.
That branch uses SciPy's default equal-variance independent t-test and an
effect labeled Cohen's $d$ with denominator $\sqrt{(s_1^2+s_2^2)/2}$. The other
branch uses Mann-Whitney U and Cliff's delta. Two-group comparisons require at
least two nonmissing values per group. One global Brain-PAD normality decision
controls the cohort, sex, and chronological-age comparisons, so the age test is
chosen from Brain-PAD normality rather than age normality. The AIS and
time-since-injury comparisons make their own normality decisions. Each AIS
grade group in `BrainPAD_acorss_AIS.csv` (upstream's spelling) holds SCI rows only, so a control row
with an AIS grade stays in the control cohort. AIS analysis also produces a
chi-square table when its contingency table is at least 2 by 2. The
time-since-injury figure fits an unadjusted pooled-SCI ordinary least-squares
model with an intercept and reports the raw $R^2$ and $p$.

R analysis uses Welch two-sample t-tests and Hedges $g$ for four fixed
cohort contrasts over cortical, subcortical, and white-matter measure blocks.
Every effect is reference minus focal, as upstream's `esvis::hedg_g` computes
it: control minus SCI for PvH, nNPvH, and IvH, and SCI_P minus SCI_nNP for
nNPvP. The Welch $t$ has the same sign, so a positive $t$ or $g$ means the
reference group's mean is higher. Upstream's formula t-test takes its sign from
the order of the cohort factor levels, which follows the locale's collation;
Supraspina fixes it as reference minus focal. Each table names its groups in
`Group_ref` and `Group_foc` (controls read `SCI_H` and pooled SCI reads `SCI`)
and the difference in `Direction`, and the report states the direction. The
Analysis panel and its figures report SCI minus control, the opposite sign.
Result rows include an approximate 95% interval for Hedges $g$. The
white-matter family compares raw `wm_volumes.csv` volumes without head-size
adjustment; the Analysis panel fits head-size-adjusted models.
`summary_icv.csv` and `summary_thickness.csv` give the n, mean, and SD of each
`icv_data.csv` and `cortical_thickness.csv` measure by cohort (control, SCI_P,
SCI_nNP, and pooled SCI) and site.

No pipeline stage applies a multiple-comparison correction, and the Analysis
panel's corrections ([Interactive group analysis](#interactive-group-analysis))
do not change these outputs. P-values, effect sizes, intervals, and figures
require a study-specific statistical review.

## Figure interpretation

The five Brain-PAD PNGs are descriptive. The stage rejects nonfinite `Age`,
`BrainAge`, or `BrainPAD` values and a missing `BrainAge` instead of omitting
them. A subject without a chronological age is left out of the figures and
reported on standard error. Missing sex and time-since-injury values can be
left out of the specific stratified plot or comparison that uses them. A fixed
random seed makes jitter placement reproducible for the same software and input
bytes.

| File                              | Encodings and boundaries                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BrainPAD_comparison.png`         | Brain-PAD in years by recognized cohort. Boxes omit plotted fliers, black jittered points show included rows, and the labeled black triangle shows the group mean. The title reports the plotted n.                 |
| `Chronological_vs_BrainAge.png`   | Chronological age in years on x and predicted brain age in years on y, with a labeled dashed identity line. Cohort points use color and marker shape, and the title reports the plotted n.                          |
| `BrainPAD_vs_Age.png`             | Chronological age in years on x and Brain-PAD in years on y, with per-cohort linear fit lines in the matching color and no confidence bands. Points use color and marker shape, and the title reports n.            |
| `BrainPAD_across_sex.png`         | Separate `Female` and `Male` panels with cohort boxes and jittered points. Missing sex values are omitted, and other nonmissing labels fail input validation. Each panel reports its plotted n.                     |
| `BrainPAD_vs_TimeSinceInjury.png` | Recognized SCI cohorts with time since injury in years on x and Brain-PAD in years on y. Points use color and marker shape. The annotation reports n and the pooled OLS R^2 and p, with no fitted line or interval. |

The figures use the Okabe-Ito blue, orange, and green cohort palette, and
scatter points also use circle, square, and triangle markers. Colors identify
recognized cohort codes only; they do not encode severity, quality, or clinical
status. Legends and categorical axes expand the compatibility cohort codes, but
table headers keep compatibility names such as `BrainPAD` and `BrainAge`.

ENIGMA outlier review assigns thickness, area, or volume semantics per source
column, rejects invalid nonmissing numeric cells and negative volumes, and
names each histogram by source, measure, and column. Histograms label
thickness, area, and volume in mm, mm^2, and mm^3, show valid and missing
counts, and draw the configured mean +/- z SD review limits when the SD is
defined and nonzero. Structure titles can keep the source hemisphere or region
abbreviations. They use the bundled Latin Modern faces only when R can load
`sysfonts`, `showtext`, and a Cairo device; otherwise R's default PNG font is
used. Interpret every figure with its project configuration, source tables, and
run receipts.

## Sites and scanners

A site is one acquisition batch: a scanner plus protocol. One physical center
with two scanners is two sites. The subject
registry stores each subject's site label. When no subject has a site, the
project counts as one site and every stage behaves as it does without sites.
When some subjects have a site and others do not, planning blocks R analysis,
BrainCharts normative modeling, and z-score group comparisons and
names the subjects without a site; the other stages do not read sites.

R analysis reads each subject's site from its run-scoped metadata projection,
where the registry label replaces any `Site` or `site` column of
`metadata.csv`. With two or more labels, each comparison keeps only the sites
that contribute at least one subject to both compared groups, counted after
IvH pools pain and no-pain. The rule applies to all four comparisons, nNPvP
included, and a comparison keeps the same sites in its cortical, subcortical,
and white-matter families. With one label or none, the tables equal those of a
run without sites. Every run writes `site_exclusions.csv`
(`comparison,site,n_ref,n_focal,excluded_subjects,reason`, header only when
nothing is excluded), and the report's Sites section states the sites and each
exclusion, for example "PvH, nNPvH, and IvH leave out site B (4 SCI
subjects) because it has no controls."

Brain-PAD statistics pool all sites with no site rule, so Brain-PAD results do
not depend on site labels; when some site has no controls, the plan warns.
Histogram and outlier review also pools all sites, flagging values against the
whole cohort's mean and SD, so a scanner offset can flag one site's subjects.
With two or more site labels, the stage's Pipeline pane states this.

No method recovers a group difference from a site that holds only one group:
there the scanner offset and the group effect are the same contrast, so neither
the site rule, a site covariate, nor harmonization such as ComBat can separate
them. The site rule leaves such a site out instead of letting its scanner
offset pass as a group effect. Its subjects stay usable for within-group and
descriptive analyses; a between-group result that includes them needs controls
scanned on that scanner. The Analysis panel applies the same reasoning to its
own models through its design check (see [Design check](#design-check)).

## Normative modeling (BrainCharts)

BrainCharts normative modeling reimplements upstream Step 3 at `eba4f59` in the
first-party, MIT-licensed `resources/braincharts/braincharts_run.py`. It uses
the `lifespan_57K_82sites` model (Rutherford et al. 2022, eLife 11:e72904,
doi:10.7554/eLife.72904): per region, a Bayesian linear regression on sex,
site, and a B-spline basis of age (-5 to 110 years), trained on 82 sites. The
stage predicts with pcntoolkit 0.35.0 (`alg="blr"`, `inputsuffix="estimate"`)
and forces adaptation, as upstream does. The model and pcntoolkit are GPL-3.0
(the braincharts NOTICE also calls the models public domain). Supraspina never
bundles them: the operator accepts the license notice and downloads them from
the official repository at a pinned commit, with every file checked by size and
SHA-256, and `braincharts_run.py` imports pcntoolkit only at run time inside
that environment.

The stage reads the 187 regions of the feature table (150 Destrieux thickness
regions and 37 subcortical volumes), maps their FreeSurfer names to the model's
names as upstream's key file does, and stops unless they equal the union of the
model's phenotype lists. Age, sex, site, and cohort come from the registry, not
from the age table. A subject without an age, with an age outside -5 to 110
years, with a sex other than female or male, or without a value for a region
gets no z-scores, and the stage states why.

Each site is adapted as a new site under the token `supraspina-site-<n>`, which
no training site uses. The number of a site's controls, counted after those
refusals, decides its split:

- With fewer than 2 controls, the site is refused and its subjects get no
  z-scores, with a stated reason such as "Site B has no controls, so the
  model cannot be adapted to it; its 4 subjects get no z-scores." Planning
  blocks the stage when no site has 2 controls and warns which sites it refuses.
  It counts the age and sex refusals from the registry, but a missing region
  value shows only in the feature table, so a site can still be refused at run
  time.
- With exactly 2, both controls adapt the model and none is held out.
  pcntoolkit 0.35 needs at least 2 adaptation rows per site, and upstream's
  split would give such a site 1 and fail the whole run.
- With 3 or more, upstream's split is unchanged. One `random.Random(seed)`, seed
  117 by default, draws for the sites in sorted label order; each site's
  controls are sorted by subject ID and shuffled, and
  `n_adapt = max(1, min(n - 1, round(n * 0.5)))` of them adapt the model, with
  Python's half-to-even rounding (21 controls give 10 adaptation and 11
  held-out controls).

The seed is the stage's only setting. `braincharts_run.json` records it with
the site numbers and tokens, the model archive's SHA-256, and the runtime
versions. Held-out controls and every patient of an adapted site get one
z-score per region; adaptation controls define the site's norm and get none, as
upstream. A z-score places a region relative to the adapted model's prediction
for that age, sex, and site. It is a research measure, not a clinical score,
and Supraspina does not establish the model's calibration for a spinal cord
injury population.

Z-score group comparisons run `FreesurferAnalysisScript.R` in its z-score mode,
the second Step 9 track of upstream's README: the same four contrasts, Welch
$t$ and Hedges $g$ with the same reference-minus-focal sign, over the thickness
z-scores (`Z_SCI`, 150 regions) and the subcortical z-scores (`Z_SUB`, 37
regions). They write eight `Z_SCI_<code>_results` and `Z_SUB_<code>_results`
tables and pool the adapted sites with no site rule, because adaptation removes
each site's offset. A refused site has no rows, and the report names it.
Planning blocks the stage when a compared group would have fewer than 2
subjects with z-scores.

## Missing-data and detector behavior

- Selected subjects with no matching T1 or more than one block planning.
  Configured exclusions and a human QC `fail` remove subjects from analysis;
  outlier flags do not.
- Feature extraction can omit a subject without the required FreeSurfer files,
  and membership evidence then keeps the stage incomplete. Missing regional
  values become blank cells and later fail PyBrainAge numeric validation.
- The default age left join keeps missing ages with a warning. The joined
  `subject_features.csv` names its age column `Age`, because the bundled
  `predict.py` matches that header case-sensitively. The stage does not
  establish that the value is in years or in a study-appropriate range.
- Clinical merge keeps unmatched prediction rows. Its detector checks column
  presence, exact subject membership, and at least one populated value in each
  configured required column; it does not require valid categories or complete
  values in every row.
- Supraspina reruns a subject's recon-all once for each of two known FreeSurfer
  failures, appending the flag that avoids it. When `label-cortex --fix-ga`
  finds no gyrus ambiens voxels ("found no voxels matching id 1"), the rerun
  adds `-no-fix-ga`, as FreeSurfer advises, so that subject's cortex label omits
  the gyrus-ambiens fill. When `mris_fix_topology -ga` crashes in the
  `Fix Topology` step (with FreeSurfer 8.2.0 it can abort with "stack smashing
  detected"), the rerun adds
  `-no-fix-with-ga`, so FreeSurfer's non-genetic fixer corrects that subject's
  surface topology. Both fixers remove the topological defects but can resolve
  a defect differently, so surface measures of such a subject can differ
  slightly from what the genetic fixer would give. A rerun that hits the other
  known failure reruns once more with both flags; a failure whose flag is
  already added fails the subject. The receipt record lists every added flag
  and its reason, in order, outside the signed payload, so the receipt still
  matches the planned command and each subject's fixer stays on record.
  Detection reads only the last 400 lines recon-all printed and the last 256
  KiB it appended to `recon-all.log`; a crash outside both windows is not
  recognized, and the subject fails.
- Structural aggregation omits subjects without the required `aparc` and
  `aseg` files, leaves missing regions blank, and can emit a header-only
  white-matter table. That table starts with upstream's three cerebral
  white-matter totals (`TotalCerebralWM`, `RightCerebralWM`, and
  `LeftCerebralWM`, from the `# Measure` lines of `wmparc.stats`) and leaves a
  missing total or structure volume blank where upstream writes 0. Membership
  checks catch missing subject rows but do not establish numeric validity or
  units.
- Brain-PAD stages all twelve outputs before publishing them and writes a
  manifest last that binds each expected basename, size, and SHA-256. The
  detector rejects a missing, changed, or mixed output set.
- R analysis reads `metadata.csv` from the metadata folder through a
  run-scoped projection that keeps the analysis subjects and takes each cohort
  value and site from the subject registry; planning blocks the stage when the
  file is missing or unreadable. It inner-joins the projection with
  `dk_all_stats.csv`, and with `wm_volumes.csv` for the white-matter family,
  rejects invalid nonmissing regional values, and removes missing values per
  region. It skips a region with fewer than two values per group, a region
  whose values are constant across both groups of a contrast, and a region
  whose Welch statistics are not finite, and it names the per-family reason
  when a contrast keeps no region. Sex and age are read but not used as
  covariates. It publishes a complete generation through one atomic pointer
  switch and leaves the prior generation active after a failed run.
- BrainCharts gives no z-scores to adaptation controls, to the subjects of a
  refused site, or to a subject without a usable age, sex, or region value.
  `braincharts_split.csv` names each subject's role and reason, and the
  detector requires one z-score row per held-out control and patient.

Completion checks differ by stage. Brain FOV verifies supported NIfTI and crop
geometry; ENIGMA verifies cohort tables, gallery references, and PNG structure;
the feature, age, PyBrainAge, and clinical stages check selected schemas or
membership. Brain-PAD requires its digest-bound twelve-file generation, R
analysis requires one complete twelve-family table format plus
`site_exclusions.csv` and the two summaries, BrainCharts requires its manifest-bound seven-file
generation, and z-score group comparisons require all eight `Z_` families.
Defacing, reconstruction, and aggregation require the expected artifact
families plus receipt evidence. No detector proves scientific correctness.

## Interactive group analysis

The Analysis panel fits region-level linear models over values the pipeline and
FreeSurfer have already written (see
[Analyze cohort results](user-guide.md#analyze-cohort-results) for its use).
Its engine, `ols-glh-freedman-lane-v2`, runs in a separate sidecar worker
process on NumPy with pure-Python Student-t, noncentral-t, and F distribution
functions. It tests general linear hypotheses on ordinary least-squares fits
with Freedman-Lane permutation inference. On a specification upgraded from the
first panel version it reproduces that version's engine,
`ols-freedman-lane-maxt-v1`, byte for byte.

### Inputs and variables

Measures come from three tiers. The pipeline tables are `dk_all_stats.csv`
(612 Desikan-Killiany cortical columns and the aseg volumes),
`cortical_thickness.csv` (mean thickness), and `icv_data.csv` (eTIV) from
structural aggregation, and `predicted_results.csv` (Brain-PAD) from the
Brain-PAD stage. Tier A reads each subject's FreeSurfer `stats/` files
directly, read-only. Tier B reads atlases labeled on demand
([Atlases](#atlases)). A bilateral measure is the mean of the left and right
values. Every file is read with bounded reads and hashed, and the result
records one digest per pipeline table, per tier A source over the included
subjects (`stats:<source>`), per labeled atlas (`labels:<atlas>`), and per
imported table (`variables:<table>`).

Variables come from the registry (`age`, `sex`, `cohortRole`,
`sourceCohortLabel`, `ais`, `tSinceSci`, and `site`), the `metadata.csv`, age,
and clinical CSV files, imported variables tables, derived variables, and
measures used as covariates. The panel never parses free text. A column is
numeric when more than half of its present cells are finite numbers; its other
cells read as missing, and a column that is not numeric is categorical.

An imported table is a UTF-8 CSV of at most 4 MiB whose subject ID column is
the first header named `subject_id`, `participant_id`, `subject`, or `id`
(case-insensitive), with each subject listed once. The sidecar copies it to
`.supraspina/analysis/variables/var-<hex16>.csv`, where the 16 hex digits begin
the file's SHA-256, and lists it in `tables.json`; a project keeps at most 16
tables. A derived variable is the `sum` of 2 to 8 numeric variables, the
`difference` of two, `log1p` of one (values at or below -1 become missing), or
`bins` of one at increasing cut points (left-closed: `<c1`, `c1 to <c2`, ...,
`>=ck`). Derived variables are computed in listed order and can use only
earlier ones.

### Designs

A between-groups design compares the groups of a variable. A within-group
design first restricts the sample to a population, for example SCI from
`SCI_P` and `SCI_nNP`, and runs its tests inside it. Both take up to 8 subset
filters, each keeping levels of a categorical variable or a numeric range; a
subject without a value fails a filter. A design holds 1 to 16 tests that share
the covariates and inclusion rules:

- A two-group test (within a group, a subgroup comparison such as cervical
  versus thoracic-lumbar) estimates the focal group minus the reference.
- A three-or-more-groups test runs an omnibus F test, then all pairs, each
  group versus the reference, or no pairwise comparisons.
- An association test estimates the slope on a numeric variable, transformed
  by none, $\log(1 + x)$, or standardization (per SD), optionally adjusted for
  group.
- A slope-difference (interaction) test asks whether a numeric moderator's
  slope differs between groups or, for a categorical moderator, whether the
  group difference differs between its levels.

Each test can stay in the correction family or be a sensitivity test outside
it, and can add up to 4 covariates of its own. A stratified design reruns every
test in each stratum of a categorical variable and can add a heterogeneity
test.

### Models

Each measure is fitted by ordinary least squares, $y = X\beta + \varepsilon$.
A test's sample is every included subject that its factor, tested variable,
moderator, and extra covariates define. Its design is an intercept, the tested
columns, and the covariates, each covariate centered on its mean over the
fitted rows:

- Group tests have one indicator per modeled group except the reference, in
  definition order. By default every defined group enters the model and shares
  one residual variance; "Compared groups only" fits the focal and reference
  groups alone. A two-group term is the focal indicator, so the estimate is the
  adjusted focal-minus-reference difference.
- An omnibus term is every indicator, an F test of rank groups minus 1. Each
  pairwise term is a t test obtained by reparametrization: the pair's reference
  becomes the baseline in the same column space, so its Freedman-Lane reduced
  model merges the pair. Under "Compared groups only" a pair is fitted on its
  two groups alone.
- An association term is the slope of the centered, transformed variable,
  whose transform is computed over the test's sample; "Adjust for group" adds
  the group indicators.
- An interaction design adds the centered moderator (numeric) or its level
  indicators (categorical, levels sorted, the first the baseline) and every
  group-by-moderator product. The term is all products, of rank $(k-1)(m-1)$
  for $k$ groups and a moderator with $m$ levels in the sample ($k-1$ for a
  numeric moderator), a t test at rank 1 and an F test above it.

Sex is one indicator that is 1 for a female level, other categorical
covariates enter as indicators, and a covariate constant within a measure's
rows is dropped. Measures with the same rows and covariates share one design. A
measure is skipped with a stated reason when a compared group has fewer
subjects than the smallest cell, the tested variable is constant, an
interaction group has fewer than 3 subjects or a constant moderator, a
moderator level is empty, the design is rank deficient or leaves no residual
degree of freedom, or the model fits the measure exactly.

Each stratum is its own sample with its own complete cases and centering, and
the pooled sample is every subject in some stratum; subjects outside every
stratum are left out. The pooled model has no stratum term. The heterogeneity
test fits the pooled design plus stratum indicators and every tested column by
stratum product, and tests those products (the test's rank times the number of
strata with subjects minus 1).

The head-size covariate is eTIV from `icv_data.csv`, sTIV from each subject's
`aseg.stats`, the SynthSeg TIV from `synthseg.tiv.dat`, or none. Under the
default rule it adjusts the extensive measures only: cortical surface area,
gray-matter volume, vertex count, and folding index of every parcellation,
every aseg and labeled volume, and the whole-brain volumes. Thickness,
curvature, gray-to-white contrast, mean thickness, the surface-hole count, and
Brain-PAD are not adjusted, and a head-size measure is never a covariate of
itself. The rule can instead adjust all measures.

### Statistics and effect sizes

For one tested coefficient $\hat\beta_j$ with residual variance $s^2$ and
$v_{jj} = [(X^\top X)^{-1}]_{jj}$, $t = \hat\beta_j / \sqrt{s^2 v_{jj}}$ on
the residual degrees of freedom. For a set $S$ of $r > 1$ coefficients with
$V = (X^\top X)^{-1}$, $F = \hat\beta_S^\top V_{SS}^{-1} \hat\beta_S / (r s^2)$
on $r$ and the residual degrees of freedom. Every row carries an HC3
heteroscedasticity-consistent p-value as a sensitivity column (a Wald F for an
F term) and, with permutations, the uncorrected permutation p-value.

- Two-group and pairwise rows report the adjusted $d = t\sqrt{v_{jj}} =
  \hat\beta_j / s$, the adjusted difference in residual standard deviations,
  with a 95% CI that inverts the noncentral t: the bounds are the
  noncentrality parameters at which the observed $t$ lies at the 97.5th and
  2.5th percentiles, multiplied by $\sqrt{v_{jj}}$. They also report a raw-SD
  $d$ (the adjusted difference over the pooled raw SD of the two groups), the
  adjusted difference as a percentage of the raw reference mean, and partial
  $\eta^2 = t^2/(t^2 + \mathrm{df})$.
- Association rows report the slope in measure units per unit of the
  transformed variable, the slope per SD of that variable over the fitted
  rows, and the partial $r = t/\sqrt{t^2 + \mathrm{df}}$ with a Fisher-z 95%
  CI, $\tanh(\operatorname{artanh} r \pm z_{0.975}/\sqrt{\mathrm{df} - 1})$.
  A slope-difference row of rank 1 reports the difference and the partial $r$.
- F rows report partial $\eta^2 = rF/(rF + \mathrm{df})$ without an interval.

The measure detail adds model-based group means at the covariate means with
95% CIs, each subject's covariate-adjusted value (only covariate contributions
are removed), and, for associations and numeric moderators, the fitted lines
with a 95% confidence band and the simple slopes per group. These are
descriptive and carry no correction.

### Corrections and families

P-values are two-sided or one-sided in the chosen direction. An F test has no
direction, so any test of rank above 1 makes every test two-sided; because the
levels of a categorical moderator and the strata with subjects come from the
data, the panel fixes the sidedness from the catalog levels and defined strata,
and the design check blocks a one-sided draft whose sample makes a term an F
test. Holm and Bonferroni control the family-wise error rate and
Benjamini-Hochberg the false discovery rate.

The default, permutation max-T, controls the family-wise error rate under the
Freedman-Lane scheme (Winkler AM, Ridgway GR, Webster MA, Smith SM, Nichols
TE. Permutation inference for the general linear model. NeuroImage.
2014;92:381-397. doi:10.1016/j.neuroimage.2014.01.060). Each permutation
shuffles the residuals $e_z$ of the model without the tested term and records the family
maximum of $|t|$ (two-sided), the signed $t$ (one-sided), or $F$. For an F
term, with $W = Q^\top P e_z$ from the QR factors of $X$,
$\hat\beta^*_S = R^{-1}_{[S]} W$,
$s^{*2} = (\lVert e_z \rVert^2 - \lVert W \rVert^2)/\mathrm{df}$, and
$F^* = \lVert L^\top \hat\beta^*_S \rVert^2 / (r s^{*2})$ with
$L L^\top = V_{SS}^{-1}$. The corrected p-value is
$(1 + \#\{\text{null} \ge \text{observed}\})/(1 + B)$ for $B$ permutations, so
it is never below $1/(B+1)$, and figures print that floor as
"$\le 1/(B+1)$". One permutation stream from NumPy's PCG64 generator with the
recorded seed covers every subject some test uses, in subject ID order, and is
restricted to each design's rows by keeping the order in which those subjects
appear (induced permutations). An induced permutation is a uniformly random
permutation of those rows and equals the full permutation when no value is
missing, so max-T stays defined across measures with different missing
subjects.

The family spans every in-family test together or each test separately, and
either can be split by measure family (one per DK metric, per parcellation
atlas and metric, and per volume atlas, then aseg, global, and Brain-PAD).
Interaction terms, an omnibus test's pairwise terms (one family over pairs and
measures, or one per pair), and heterogeneity terms each form their test's own
family, and each stratum and the pooled sample are separate families. Under
max-T a family never mixes t and F statistics or F statistics of different
ranks; correcting t and F tests together needs Holm, Bonferroni, or BH-FDR. A
test outside the family gets no corrected p-value and reads "Sensitivity,
outside the family". "Show pairwise only after a significant omnibus" marks
pairwise rows whose omnibus test is not significant and never changes a
p-value. A row is significant when its corrected p-value is at most alpha.

### Design check

The panel checks a draft against the resolved sample before Compute. Blocking
findings stop Compute, and warnings carry their disclosure data (cell counts
with sex per cell, variance inflation factors, and crosstabs). Per test:

- A compared group (every group of an omnibus or interaction test) below the
  smallest cell (3 by default, settable from 2 to 20) blocks, and one below 10
  warns. In a stratified design a stratum below the smallest cell is skipped
  with a warning.
- Residual degrees of freedom below 1 block, and below 5 warn.
- A design column that the others predict with $R^2 \ge 0.999$ blocks with the
  dependency named, for example "Age at injury equals age minus time since
  injury". A variance inflation factor of 5 or more warns, and one of 10 or
  more warns strongly.
- Group factors confounded with sex, another categorical covariate, the
  strata, or the population variable warn at Cramer's V of 0.5 or more.
- A covariate missing for every subject of a modeled group, a subset that
  empties a group, a tested variable that does not vary, $\log(1 + x)$ of a
  value at or below -1, and an interaction cell without subjects (or a group
  with fewer than 3 subjects with a varying numeric moderator) block.
- A one-sided draft blocks when the sample makes a term an F test: a slope
  difference whose moderator has enough levels, or a heterogeneity test over
  enough strata with subjects, for a rank above 1.
- A subject missing a value that only some tests need leaves only those tests,
  with a warning.

The design check applies the [site rule](#sites-and-scanners) to the panel. When
some subject has a registry site, a between-groups test whose sample has a site
holding only one of its groups blocks, names the site, and offers two fixes:
leave the site out (a subset filter) or adjust for site. With site as a
covariate the finding warns instead, since that site's subjects then inform the
other covariates and the residual variance but not the group difference; in a
design stratified by site that stratum is skipped. When site determines group
for every subject, the test blocks even with the covariate. Subjects without a
site count as one site for this check only, with a warning when sites are
mixed. Within a group, the sites of the test's groups are crosstabulated and
warn at Cramer's V of 0.5 or more.

### Inclusion rules

Candidates are the registry's subjects and every subject the tables list,
judged in a fixed order whose first failing rule names the exclusion: the saved
configuration's subject scope and exclusions; the QC rule (Non-failed, the
default, excludes QC Fail, QC Pass only needs a Pass, and the third option
admits every subject); the population; the subset filters; membership in a
modeled group or stratum; the shared covariates; the tests' own values; the
surface-registration rule; the ENIGMA outlier rule; and a value for at least
one measure. A measure is fitted on its complete cases: subjects with the
measure, every covariate of its design, and, for a head-size-adjusted measure,
the head size. By default a hemisphere flagged by the surface-registration
check has its cortical measures set missing, and a bilateral mean and mean
thickness are missing when either hemisphere is flagged. The outlier rule can
set the flagged measure (and the bilateral mean it enters) missing or exclude
the subject.

### Results and exports

A result is one record, `.supraspina/analysis/results/<resultId>.json`, of at
most 32 MiB: the specification, the resolved sample with exclusion reasons, the
input digests, the terms (each with its test, kind t or F, rank, family, and
stratum or pair), one row per term and measure, the skipped measures with
reasons, and the measure detail. A record that would exceed the cap drops the
per-subject values and keeps the rows, group means, and fitted lines. Compute
reads the inputs as they are on disk when it starts.

A result is provisional when a stage its values depend on was not current, when
it reads per-subject FreeSurfer files and an included subject's reconstruction
was out of date, when an unjudged registration check could change its sample,
or when an outlier rule could not be applied. A later change to a table, a tier
A file, an imported table, the labels, the sample, the registry fields, the
registration flags, or the engine makes it out of date with a named reason.

An export holds `results.csv` (one row per term and measure), `terms.csv`,
`grid.csv` (measures by terms with the effect, its interval, p, corrected p, and
significance), `spec.json` with the result identity, input digests, and sample
counts, and, for a v2 result, `atlas-licenses.csv`: each atlas the measures
use, where it came from, the cached version, the license with its link and the
time the operator acknowledged it, and what to cite. Figures are optional, and
`subjects.csv`, which contains participant IDs, is written only on request.

### Validation

The test suite binds both engines and the distribution functions to synthetic
reference fixtures whose expected values never come from the engine.
Parametric values must match to $10^{-9}$ relative, the distribution functions
to $10^{-12}$ ($10^{-9}$ absolute for interval roots), and permutation and
max-T p-values exactly. The fixtures cover every sidedness, correction,
analysis type, and group model; omnibus F tests with pooled and per-pair
pairwise families; numeric and categorical interactions; stratified designs;
and within-SCI batteries with per-test missingness. The v2 engine must also
match the v1 engine byte for byte on the upgraded v1 specifications. The
partial-r interval uses the exact normal quantile rather than $z = 1.96$.

### Reference fixtures

The fixtures in `sidecar/tests/fixtures/group_analysis/` are synthetic, and
their expected values never come from the engine:

- `spec-v1-example.json` holds one v1 specification with its canonical digest
  and binds the TypeScript and Python canonical forms
  (`test_group_analysis_spec.py`).
- `spec-v2-{two-group,omnibus,within-battery,interaction,stratified}.json`
  hold one v2 specification per design with its canonical digest, checked by
  `test_group_analysis_spec_v2.py` and `src/shared/group-analysis-v2.test.ts`.
  `spec-v2-two-group.json` is `upgrade_v1` of `spec-v1-example.json`
  (`upgradedFrom`). Their floats (subset bounds and bin cuts) also bind the
  ECMAScript number form of the canonical JSON. A new fixture's digest comes
  from `spec_digest` and must match `canonicalSpecJson` in the TypeScript test.
- `engine-dataset.json` is a synthetic cohort in three groups (CTRL, SCI_P,
  and SCI_nNP) with age, sex (1 = female), eTIV, two numeric variables
  (`score` and `tsi`), and 22 correlated measures with missing cells. Subjects
  are stored unsorted, since the engine orders its permutation index by
  subject ID.
- `engine-goldens.json` holds six specifications covering every sidedness,
  correction, analysis type, and group model, with their expected rows,
  adjusted group means, and one measure's per-subject values
  (`test_group_analysis_engine.py`).
- `distribution-goldens.json` holds SciPy's incomplete beta, t, and
  noncentral-t values and the reference implementation's noncentral-t intervals
  (`test_group_analysis_distributions.py`).
- `engine-goldens-v2.json` adds variables for the same subjects (site, injury
  level and AIS with missing cells, a motor score, and sex as text), seven v2
  cases (omnibus F with pooled and per-pair pairwise families, both group
  models, log1p and standardized associations, numeric and categorical
  interactions, a stratified design with heterogeneity, and a within-SCI
  battery with per-test missingness and a test outside the family) with their
  expected terms, rows, and one measure's group means, fitted-line points, and
  simple slopes, and SciPy's F survival function
  (`test_group_analysis_engine_v2.py`). The same tests check the v2 engine
  against the v1 engine byte for byte on the upgraded `engine-goldens.json`
  specifications.
- `result-v2-example.json` is a stored v2 result, a term page, and a measure
  detail from the worker for a stratified design over three measures. The
  TypeScript schemas parse it (`src/shared/group-analysis-v2.test.ts`), and
  `test_group_analysis_worker_v2.py` checks that it is current; regenerate it
  by running that test with `SUPRASPINA_WRITE_FIXTURES=1`.

`generate_goldens.py` computes its expected values with statsmodels and the
reference implementation in
[`analyses/lib/family_models.py`](../analyses/lib/family_models.py)
(`d_with_ci`, `nct_ci`, `bh`, `holm`, and `induced_positions`), and asserts
that the reference `fit_family` and `add_corrections` agree with its own
Freedman-Lane and parametric results for its two-group cases. HC3 standard
errors come from statsmodels.
`generate_goldens_v2.py` fits every model with statsmodels using QR (the
default pseudoinverse fit loses about $10^{-9}$ relative on near-zero t
values), tests each hypothesis as a contrast matrix $R$ in one fixed
parametrization, and runs each permutation as a full refit on permuted
reduced-model residuals, the reduced design being $XN$ with $N$ the null space
of $R$, on the `default_rng(seed).permutation` stream restricted to each
block by `induced_positions`. The tests use $10^{-9}$ relative tolerance for
parametric values, $10^{-12}$ for the distribution functions ($10^{-9}$
absolute for interval roots), and exact equality for permutation and max-T
p-values.

Both generators need Python 3.12 or later with numpy 2.5.3, scipy 1.18.1,
pandas 3.0.6, and statsmodels 0.15.0, and their output is byte-identical for
the same versions:

```bash
uv venv "$TMPDIR/refenv"
uv pip install --python "$TMPDIR/refenv/bin/python" numpy==2.5.3 \
  scipy==1.18.1 pandas==3.0.6 statsmodels==0.15.0
"$TMPDIR/refenv/bin/python" sidecar/tests/fixtures/group_analysis/generate_goldens.py
```

`generate_goldens_v2.py` takes the same environment and reads
`engine-dataset.json`.

### Limitations of the analysis

A result is advisory, not a receipt: it lives in `.supraspina/analysis/`, no
planner node, receipt, or reuse rule reads it, and it never changes a run, the
registry, or a QC verdict. The analysis is region- and structure-level only,
with no vertex- or voxel-wise inference and no spinal cord measures. Atlases
distributed in MNI space need subject-space label maps made outside the app.
Labeled values depend on the FreeSurfer build and the interpreter that made
them, which the labels record. The brain maps draw each region's t statistic on
the fsaverage templates or on one subject's label maps; they are not
subject-space inference and draw t terms only. Linear models assume additive
covariate effects shared by the modeled groups, and a stratified or
interaction model tests only the differences it names. An association is not
evidence of cause. As with the pipeline outputs, the p-values, intervals, and
figures require a study-specific statistical review.

## Atlases

Supraspina bundles no atlas. FreeSurfer ships the built-in atlases and the
tools that label subjects with them. An external atlas is downloaded from its
official site when the site serves stable files without a login; otherwise the
operator opens the site, downloads the files, and imports them.
[Atlas labeling operation](architecture.md#atlas-labeling-operation) describes
how labeling runs.

### Measure IDs and metrics

Measure IDs name their source and atlas: `dk:{lh|rh|bi}:{region}:{metric}` and
`aseg:{structure}` or `aseg:bi:{structure}` (the pipeline tables),
`global:{name}`, `brainage:BrainPAD`,
`parc:{atlas}:{lh|rh|bi}:{region}:{metric}`, and
`vol:{atlas}:{lh|rh|bi|mid}:{structure}`. Region and structure names drop the
atlas's hemisphere token (`Left-`, `lh.`, an infix such as `wm-lh-` or `_LH_`,
or a suffix `_L`), so the two hemispheres pair into a bilateral mean, and a
structure without a hemisphere is `mid`. For files from elsewhere, hemispheres
pair by the first rule that matches: `_LH_` and `_RH_` infixes (Schaefer), `_L`
and `_R` suffixes (Brainnetome), `lh.` and `rh.` prefixes, `Left-` and `Right-`
prefixes, or none. A specification lists at most 20,000 measures of at most 160
characters.

Parcellation metrics are FreeSurfer's `aparc.stats` columns (thickness and its
SD in mm, area in mm^2, gray-matter volume in mm^3, vertex count, mean and
Gaussian curvature in 1/mm and 1/mm^2, and the folding and curvature indices)
and the gray-to-white contrast `GWC` (the `w-g.pct.stats` mean, in percent).
Volumes are in mm^3. A value FreeSurfer writes as `nan` reads as missing.

### Built-in atlases

The built-in atlases need a FreeSurfer installation and are covered by the
[FreeSurfer license](https://surfer.nmr.mgh.harvard.edu/fswiki/FreeSurferSoftwareLicense).
The ID is the atlas token of the measure IDs.

| ID               | Atlas                                     | Values from                                                                                                                 |
| ---------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `dk`             | Desikan-Killiany                          | `dk_all_stats.csv` of structural aggregation                                                                                |
| `aseg`           | Subcortical segmentation (aseg)           | `dk_all_stats.csv` of structural aggregation                                                                                |
| `aseg-global`    | Whole-brain measures                      | `aseg.stats`, `brainvol.stats`, and `synthseg.tiv.dat` of each subject; eTIV and mean thickness from structural aggregation |
| `a2009s`         | Destrieux (`aparc.a2009s`)                | `{lh,rh}.aparc.a2009s.stats` of each subject                                                                                |
| `dkt`            | DKT (`aparc.DKTatlas`)                    | `{lh,rh}.aparc.DKTatlas.stats` of each subject                                                                              |
| `dkpial`         | Desikan-Killiany on the pial surface      | `{lh,rh}.aparc.pial.stats` of each subject                                                                                  |
| `ba`             | Brodmann areas (`BA_exvivo`)              | `{lh,rh}.BA_exvivo.stats` of each subject                                                                                   |
| `bathresh`       | Brodmann areas, thresholded               | `{lh,rh}.BA_exvivo.thresh.stats` of each subject                                                                            |
| `gwc`            | Gray-to-white contrast (DK regions)       | `{lh,rh}.w-g.pct.stats` of each subject                                                                                     |
| `wmparc`         | White-matter parcellation                 | `wmparc.stats` of each subject                                                                                              |
| `entowm`         | Entorhinal white matter                   | `entowm.stats` of each subject                                                                                              |
| `synthseg`       | SynthSeg volumes                          | `synthseg.vol.csv` of each subject                                                                                          |
| `brainstem-ss`   | Brainstem subfields                       | The recon's brainstem volume file, else labeled with `segment_subregions`                                                   |
| `hippo-amygdala` | Hippocampal subfields and amygdala nuclei | The recon's hippocampal and amygdala volume files, else labeled                                                             |
| `thalamic`       | Thalamic nuclei                           | The recon's thalamic volume file, else labeled                                                                              |
| `yeo7`, `yeo17`  | Yeo 2011, 7 and 17 networks               | Labeled from FreeSurfer's `fsaverage` `Yeo2011_{7,17}Networks_N1000` annotations                                            |

Tier A sources (every per-subject row above) are read directly. The catalog
lists a source's regions from the first five readable subjects and its reach as
"n of N subjects have the file", from file metadata alone; files are hashed
only at Compute.

The FreeSurfer documentation names the papers to cite for the built-in
atlases, except the labeled ones:

- Brainstem subfields: Iglesias JE, Van Leemput K, Bhatt P, et al. Bayesian
  segmentation of brainstem structures in MRI. NeuroImage. 2015;113:184-195.
- Hippocampal subfields and amygdala nuclei: Iglesias JE, Augustinack JC,
  Nguyen K, et al. A computational atlas of the hippocampal formation using ex
  vivo, ultra-high resolution MRI. NeuroImage. 2015;115:117-137. Saygin ZM,
  Kliemann D, Iglesias JE, et al. High-resolution magnetic resonance imaging
  reveals nuclei of the human amygdala. NeuroImage. 2017;155:370-382.
- Thalamic nuclei: Iglesias JE, Insausti R, Lerma-Usabiaga G, et al. A
  probabilistic atlas of the human thalamic nuclei combining ex vivo MRI and
  histology. NeuroImage. 2018;183:314-326.
- Yeo networks: Yeo BTT, Krienen FM, Sepulcre J, et al. The organization of
  the human cerebral cortex estimated by intrinsic functional connectivity. J
  Neurophysiol. 2011;106(3):1125-1165.

### Atlases labeled on demand

Tier B atlases are labeled into
`.supraspina/analysis/atlases/<atlasId>/<subject>/`:

| Recipe                    | Tools and outputs                                                                                                                    | Estimate per subject |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| Brainstem subfields       | `segment_subregions brainstem` on `norm.mgz` and `aseg.mgz`; `brainstemSsLabels.volumes.txt` and the label map                       | 5 to 12 min          |
| Hippocampus and amygdala  | `segment_subregions hippo-amygdala`, also reading `wmparc.mgz`; per hemisphere the subfield and nucleus volumes and the label map    | About 20 min         |
| Thalamic nuclei           | `segment_subregions thalamus`; `ThalamicNuclei.volumes.txt` and the label map                                                        | About 14 min         |
| Yeo 7 and 17 networks     | `mri_surf2surf` of FreeSurfer's fsaverage annotation, then `mris_anatomical_stats -noglobal` on the white surface                    | About 1 min          |
| Added annotation (annot)  | `mri_surf2surf` from the annotation's template (fsaverage, fsaverage6, or fsaverage5, by vertex count), then `mris_anatomical_stats` | About 1 min          |
| Added classifier (gcs)    | `mris_ca_label -seed 1234` on `sphere.reg` with `aseg.presurf.mgz`, then `mris_anatomical_stats`                                     | About 1.5 min        |
| Added volume (label maps) | `mri_segstats` of an imported subject-space label map with the atlas's color table over `norm.mgz`, label 0 excluded (`Volume_mm3`)  | About 30 s           |

The subregion recipes run FreeSurfer's own samseg package, as
`python -s -m samseg.cli.segment_subregions <structure> ... --threads 1`, under
the machine's subregions Python preference (Python 3.12 with NumPy, SciPy,
nibabel, and surfa), because FreeSurfer 8.2.0's `fspython` 3.8 cannot load
samseg's CPython 3.12 bindings, and they leave the recon unchanged. DKT and
added classifiers and annotations are also labeled onto fsaverage5 for the Brain tab; DKT measures
themselves come from each subject's own `aparc.DKTatlas` statistics, so DKT
labels only that template.

When a recon already has a subregion atlas's volume files, they win, and the
labeling cache serves only subjects without them. Each subject's `labels.json`
records the atlas, the recipe and its version, the FreeSurfer build, the
interpreter's Python version, the exact argv, every recon input with its size,
modification time, and SHA-256, the recon state at the start, the kept outputs
with their SHA-256, the parsed values, and the duration. Labels are current;
stale when a recon input, the tool identity, or the recipe version changed; or
provisional when they were made while the recon was out of date. Labeling
skips subjects whose recon is out of date or running. Imported labels record
the folder they came from and their recon inputs.

### External sources

The catalog of external sources is
`sidecar/supraspina_sidecar/group_analysis/atlas_sources.py`, mirrored as
`ATLAS_SOURCES` in `src/shared/atlas-labeling.ts`. Each URL, size, and SHA-256
was verified from the source. A source pins files only when it serves stable
files without a login that the panel can label subjects with.

| Source                                                                                                                                               | License                                                                          | Access                            | Labels subjects with |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------- | -------------------- |
| [Schaefer 2018 cortical parcellations](https://github.com/ThomasYeoLab/CBIG/tree/master/stable_projects/brain_parcellation/Schaefer2018_LocalGlobal) | [MIT](https://github.com/ThomasYeoLab/CBIG/blob/master/LICENSE.md)               | Download from GitHub (CBIG)       | Annotation           |
| [Brainnetome atlas](https://www.nitrc.org/projects/bn_atlas/)                                                                                        | Brainnetome terms: non-commercial, attribution, share alike (login required)     | Open NITRC, then import the files | Classifier (gcs)     |
| [Brainstem Navigator](https://www.nitrc.org/projects/brainstemnavig/)                                                                                | Not stated on the project page (login required)                                  | Open NITRC, then import the files | Label maps           |
| [Harvard Ascending Arousal Network atlas v2](https://datadryad.org/dataset/doi:10.5061/dryad.zw3r228d2)                                              | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (Dryad terms)      | Open Dryad, then import the files | Label maps           |
| [JHU white-matter atlases](https://fsl.fmrib.ox.ac.uk/fsl/docs/other/datasets.html)                                                                  | [FSL license (non-commercial)](https://fsl.fmrib.ox.ac.uk/fsl/docs/license.html) | Open FSL, then import the files   | Label maps           |

Citations, as the catalog records them:

- Schaefer 2018: Schaefer A, et al. Local-global parcellation of the human
  cerebral cortex from intrinsic functional connectivity MRI. Cereb Cortex.
  2018;28(9):3095-3114.
- Brainnetome: Fan L, Li H, Zhuo J, et al. The human Brainnetome atlas: a new
  brain atlas based on connectional architecture. Cereb Cortex.
  2016;26(8):3508-3526.
- Brainstem Navigator: Bianciardi M, et al. Brainstem Navigator v1.0. NITRC.
  doi:10.25790/bml0cm.96. The project page names the atlas papers to cite.
- Harvard AAN v2: Edlow BL, et al. Sustaining wakefulness: brainstem
  connectivity in human consciousness. bioRxiv. 2023.
  doi:10.1101/2023.07.13.548265.
- JHU: Mori S, et al. MRI Atlas of Human White Matter. Elsevier; 2005. Wakana
  S, et al. NeuroImage. 2007;36:630-644. Hua K, et al. NeuroImage.
  2008;39(1):336-347.

Version `cbig-35b5664` of Schaefer 2018 pins the CBIG repository at commit
[`35b5664bec8822e2f77da5e090e96f91d0095be6`](https://github.com/ThomasYeoLab/CBIG/tree/35b5664bec8822e2f77da5e090e96f91d0095be6)
(2026-08-31): its `LICENSE.md` and the fsaverage annotations of 100, 200, and
400 parcels in 7 and 17 networks from
`stable_projects/brain_parcellation/Schaefer2018_LocalGlobal/Parcellations/FreeSurfer5.3/fsaverage/label/`,
13 files and 15,804,327 bytes in all. The atlas IDs are `schaefer100-7`,
`schaefer100-17`, `schaefer200-7`, `schaefer200-17`, `schaefer400-7`, and
`schaefer400-17`. Subjects are labeled from the annotations, since CBIG serves
its gcs classifiers only from a Dropbox archive.

| File                                                | Bytes     | SHA-256                                                            |
| --------------------------------------------------- | --------- | ------------------------------------------------------------------ |
| `LICENSE.md`                                        | 1,084     | `0e38f0e8b304f13de2ce2911320faaa08ced178e031d3bbebc3e4769762e5f50` |
| `lh.Schaefer2018_100Parcels_7Networks_order.annot`  | 1,313,376 | `4c648453ee3de1041be3bc28d39621a6edc13a2ec046e493a765821ed3ab5052` |
| `rh.Schaefer2018_100Parcels_7Networks_order.annot`  | 1,313,371 | `0cedc865047580df56e46186dc6416d8cf431cae104a1666ec8dc3efa761fb3c` |
| `lh.Schaefer2018_100Parcels_17Networks_order.annot` | 1,313,574 | `cc92db8dee0091ea3d19c265ca0e4387982f4d78e82ec9a1b227ee829d4c8fcc` |
| `rh.Schaefer2018_100Parcels_17Networks_order.annot` | 1,313,537 | `dfb63fc3244ba56b9609d4854a41e8cdd165c168b93b69ac2a60a0e7c4890f82` |
| `lh.Schaefer2018_200Parcels_7Networks_order.annot`  | 1,315,895 | `c225937c31584c74d3e7c8fba7c17916ce4e730faa542ee61659041db136ac87` |
| `rh.Schaefer2018_200Parcels_7Networks_order.annot`  | 1,315,902 | `5439cd1fb913cbb76366f9590b5733efcb7adf9cde25413f6e0b681ff0abdcf8` |
| `lh.Schaefer2018_200Parcels_17Networks_order.annot` | 1,316,234 | `7b83bd37b30ced55bacf21aa837404bca453fa6f1b2fa4b2d1d3cf185c4950db` |
| `rh.Schaefer2018_200Parcels_17Networks_order.annot` | 1,316,210 | `70a78d74b1be6110e0d272b8c82c08f284633f0f003148c743b480a7bf13f7f5` |
| `lh.Schaefer2018_400Parcels_7Networks_order.annot`  | 1,320,939 | `351848da486c2b178ef825640c076fcbcf054095bed0c91d5854d2c593e5c1ee` |
| `rh.Schaefer2018_400Parcels_7Networks_order.annot`  | 1,321,004 | `595444aecc3b59a8a6838b2e5c7f2052e88e25b1c5f833c5a6bdb984e3fa978f` |
| `lh.Schaefer2018_400Parcels_17Networks_order.annot` | 1,321,612 | `4121084967a6fb51bafe4ee1dd0e79aabfad90b20424866a6b46069efc1f2d51` |
| `rh.Schaefer2018_400Parcels_17Networks_order.annot` | 1,321,589 | `515c9de716435fcedf7062c8116fb4e039e74b21a37191fa715d6c7712b62dad` |

The other sources pin nothing. Brainnetome and
Brainstem Navigator sit behind a NITRC login and grant no redistribution. The
Harvard AAN v2 and JHU atlases are distributed in MNI space, and the panel
labels only subject-space label maps, so their subject-space maps must be made
outside the app (registration to each subject) before import.

### Downloads and the machine cache

A download shows the license and requires the operator to acknowledge it. It
then fetches each pinned file over HTTPS from `raw.githubusercontent.com` (the
only allowed host), without redirects, into a private staging folder. Each file
is bounded by its pinned size and hashed while it streams, and a size or
SHA-256 mismatch keeps nothing. The verified set and its manifest replace the
version folder in one rename, so a canceled or failed download leaves nothing
partial. One download runs at a time per app.

Downloaded and added atlases live in Electron's user-data folder under
`atlases/<sourceId>/<version>/` with a `manifest.json` (schema
`supraspina/atlas-source-cache`) that records each file's path, URL, SHA-256,
and size, the license and when it was acknowledged, when the files arrived,
and whether they were `downloaded` or `imported`. The cache is shared by every
project on the machine. Labeling checks a downloaded atlas's digests again
before it runs and refuses changed files. The atlas cache does not touch the
managed scientific resources, `SCIENTIFIC_RESOURCE_PINS.json`, the environment
check, or receipts.

### Adding an atlas

Add atlas... in Choose measures adds an atlas from a listed source or from any
other files, with a license name (and an optional HTTPS link) that the operator
confirms. The files are copied with their SHA-256 into
`atlases/user-<hex8>/imported/` of the machine cache, and the atlas reads
`user-<hex8>` in its measure IDs. A machine keeps at most 32 added atlases, and
each file can be up to 256 MB. An added atlas is one of three kinds:

- A surface classifier is one `lh.*.gcs` and one `rh.*.gcs`. Each subject is
  classified with `mris_ca_label` on its `sphere.reg`, and the fsaverage5
  template is labeled for the Brain tab.
- A surface annotation is one `lh.*.annot` and one `rh.*.annot` on one
  template: fsaverage (163,842 vertices), fsaverage6 (40,962), or fsaverage5
  (10,242). Each subject and the fsaverage5 template receive it through
  `mri_surf2surf`.
- Label maps in subject space are the atlas's color table and, per subject, one
  `.mgz` label map aligned with that subject's FreeSurfer volumes, imported
  with Import outputs... from a folder that holds one folder per subject ID.
  Labeling measures each label's volume with `mri_segstats`.

## Known limitations

- Subject discovery is pattern-based and does not validate a BIDS dataset.
  The project schema rejects unknown keys.
- The outlier threshold is `steps.outliers.params.zThreshold`; the Brain-PAD and
  R analysis scripts use fixed label sets.
- ENIGMA QC follows the `fsVersion` rule in
  [Packaged runtime and external tools](installation.md#packaged-runtime-and-external-tools);
  a mixed or mismatched cohort fails before QC.
- PyBrainAge features require Destrieux `aparc.a2009s` cortical thickness in the
  trained order, and BrainCharts reads the same 187 regions. Structural
  aggregation reads Desikan-Killiany `aparc` statistics and does not require
  `aparc.a2009s`.
- The defacing detector does not establish de-identification, privacy
  compliance, or authorization to share an image.
- Inputs within the byte, row, column, archive, and enumeration limits can
  still need substantial memory, especially near several limits at once. The
  limits prevent unbounded reads; they do not estimate memory needs.
- The R analysis script requires all twelve result families, and its z-score
  mode all eight. If an empty measure block or a sparse comparison leaves every
  region unestimable, it exits nonzero and names each missing family with its
  block or cohort-count reason, including the sites the site rule left out. It
  does not impute data or change the statistical method.
- The R analysis script writes all result tables as `.xlsx` when `writexl` is
  present and all as `.csv` otherwise; `site_exclusions.csv` and the two
  summaries are always CSV. The detector rejects mixed formats and both
  variants of one family.
- Managed containers, licensed external tools, model terms, GPU drivers, study
  configuration, and scanner-specific acceptance are outside package and
  source-test qualification.
