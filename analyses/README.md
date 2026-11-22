# Dorsal medulla analyses

Analysis code for "Dorsal medullary volume deficits vary with level and completeness of chronic
spinal cord injury", which compares adults with chronic spinal cord injury (SCI) with healthy
controls. The scripts take T1-weighted images and FreeSurfer reconstructions from the
Supraspina workflow and produce every regional, voxelwise, clinical, and permutation result of the
paper, its tables, and its figures.

Participant-level data are not public (participant privacy and consent terms; see the paper's data
availability statement). Every script reads its inputs through a private configuration file, writes
participant-level files only under the configured `work_dir`, and writes group-level tables and
figures under `output_dir`. Nothing under either folder may be published.

## Requirements

| Software | Version | Used for |
| --- | --- | --- |
| FreeSurfer | 8.2.0 | `recon-all`, brainstem subfields, thalamic nuclei, hypothalamic subunits, buckner40 surface registration |
| FastSurfer (Apptainer image) | 2.5.4 | CerebNet cerebellar lobules (the paper used the CUDA image on a GPU) |
| ANTs | 2.6.5 | Deformation-based morphometry (DBM) templates and registrations, atlas transfer |
| FSL | 6.0.7.22 | `randomise` (TFCE), `fslmaths`, and atlases |
| SPM with MATLAB | SPM 25.01.02, MATLAB R2026a | Unified segmentation and DARTEL |
| Python | 3.11 | Statistics and figures |
| Python packages | NumPy 2.4, SciPy 1.17, pandas 3.0, statsmodels 0.14.6, nibabel 5.4.2, Matplotlib 3.11.2, PyYAML, cairosvg, Pillow | |
| Poppler | Any recent | `pdftocairo` and `pdftoppm` for the figure exports |

FreeSurfer's `segment_subregions` runs in a Python 3.12 environment holding the FreeSurfer 8.2.0
samseg package (`software.samseg_python`). R is not needed. Figures use Arial (`figures.font_dir`).

Atlases are not distributed here. Download them and set the `atlases` keys of the configuration:

| Atlas | Source | Key |
| --- | --- | --- |
| Allen Human Reference Atlas 3D (2020) on ICBM 2009b; Ding et al. 2016, doi:10.1002/cne.24080 | Allen Institute | `atlases.allen_hra3d` |
| ICBM 2009b nonlinear symmetric template; Fonov et al. 2011, doi:10.1016/j.neuroimage.2010.07.033 | McConnell Brain Imaging Centre | `atlases.icbm2009b_sym` |
| JHU ICBM-DTI-81 white matter labels, Harvard-Oxford subcortical atlas, cerebellum atlas, MNI152 1 mm | FSL (see [Atlases](../docs/science.md#atlases)) | `atlases.jhu_labels`, `atlases.harvard_oxford_sub`, `atlases.fsl_cerebellum`, `atlases.fsl_mni152_1mm` |
| Brainstem Navigator v1.0; doi:10.25790/bml0cm.96 | [NITRC](https://www.nitrc.org/projects/brainstemnavig/) | `atlases.brainstem_navigator` |
| Brainstem pathway atlas; Tang et al. 2018, doi:10.1016/j.neuroimage.2017.12.042 | The authors | `atlases.brainstem_tracts` |
| Brainnetome FreeSurfer classifiers; Fan et al. 2016, doi:10.1093/cercor/bhw157 | [NITRC](https://www.nitrc.org/projects/bn_atlas/) | `atlases.brainnetome_fs` |

## Configure

1. Run Supraspina's Brain FOV preparation (30 mm margin), reconstruction (FreeSurfer 8.2.0
   recon-all), and ENIGMA QC stages. The analyses read the reconstructions from
   `freesurfer.subjects_dir` without writing to them.
2. Stage one T1 and one brain mask per participant for DARTEL, as `<id>.nii.gz` in `t1_dir` and
   `t1_mask_dir`. Where Brain FOV cropped the scan, use its cropped T1
   (`<id>_desc-brainfov<digest>_T1w.nii.gz`) and its SynthStrip mask, which stays on the source
   grid. Where it kept the source T1, use that T1 and a mask from
   `mri_synthstrip -i <T1> -m <mask>`. DARTEL uses the mask only to place the origin.
3. Copy `config.example.yaml` to `config.yaml` in this folder (git-ignored) or to a private location
   named by the `ANALYSES_CONFIG` environment variable, and fill in every path. The example
   documents each key.
4. Write the participants table (`participants`): one row per analyzed participant with
   `participant_id`, `sci`, `age`, `female`, `eTIV`, the within-SCI clinical columns, and the
   `dbm_template` flag of the template participants. `participant_columns` maps other column
   names if an existing table is used. `clinical/01_years_since_injury.py` computes years since
   injury from a private table of dates (`clinical.injury_dates`); copy its result into the
   participants table.
5. Keep the QC decisions in the private files named under `qc`: thalamic montage ratings, the
   group-blind review of flagged cortical registrations, single-region exclusions, and registration
   exclusions (empty in the paper).

## Run

Each folder has a `run.sh` with `--process-only` (participant-level processing) and `--stats-only`
(group statistics). `run_all.sh --process-only` and `run_all.sh --stats-only` run every folder in
dependency order. Between the two, rate the blind thalamic montages (`thalamus/montage.py` writes
them) and review the cortical registrations that `cortex/10_screen.py` flags. Processing takes
several days on one workstation; the converged permutations take about 50 minutes on 12 processes.

| Folder | Content |
| --- | --- |
| `lib/` | Configuration access, the group model (`stats_lib.py`), family-wise models for FreeSurfer measures (`family_models.py`), and the converged permutation engine (`permutation.py`) |
| `subfields/` | Brainstem subfield segmentation and statistics |
| `thalamus/` | Thalamic nuclei, blind QC montages, six nucleus groups |
| `cortex/` | buckner40 re-registration, registration screen, Desikan-Killiany and Brainnetome S1 and M1 measures, regional screen, Euler numbers |
| `exploratory/` | Hypothalamus and cerebellar lobules I to VI |
| `dartel/` | SPM segmentation, DARTEL template and normalization, regional volumes, voxelwise white matter |
| `dbm_brainstem/` | Brainstem DBM template, registrations, regions, voxelwise analysis |
| `compartments/` | Allen and JHU atlas transfer, medullary compartments, colliculi, rim and core |
| `atlas_nuclei_tracts/` | Brainstem Navigator nuclei and brainstem tracts on the DBM template |
| `dbm_wholebrain/` | Whole-brain DBM template, registrations, medullary region, clusters |
| `summary/` | Cross-pipeline agreement and unadjusted volumes |
| `clinical/` | Table 1, within-SCI model, covariation, scores, sensitivity analyses, clinical stratification |
| `permutations/` | Converged Freedman-Lane P values (10,000,008 permutations) |
| `figures/` | Figures 1 to 6 and Supplementary Figures 1 and 2 |

Regional P values come from the converged permutation engine (`permutations/`, and
`clinical/24_sensitivity_group.py` for the sensitivity sample). The section scripts also report
5,000-permutation P values as a check; those, and the voxelwise randomise results, depend on the
order of participants, so a rerun can differ in the third decimal.

## Result map

Group-level outputs are under `output_dir/<folder>/`. Permutation files end in `_10000000`.

### Results

| Result | Script | Output |
| --- | --- | --- |
| Medulla, pons, and midbrain subfield volumes, SCI vs controls (Figure 2) | `subfields/stats.py` | `brainstem_subfield_stats.csv` |
| DARTEL gray and white matter volumes of the brainstem regions, SCI vs controls (Figure 2) | `dartel/10_roi_stats.py` | `roi_stats.csv`, `medulla_z\|gmwm_fwhm0` |
| Brainstem DBM log-Jacobians of the medulla, pons, and midbrain (Table 2; Figure 2) | `dbm_brainstem/24_stats.py` | `roi_primary.csv` |
| Medullary region log-Jacobian in the whole-brain DBM, uncorrected (Figure 2) | `dbm_wholebrain/29_roi_agreement.py` | `roi_agreement.csv`, `roi = medulla` |
| Converged family-wise P of the subfield, DARTEL, and brainstem DBM families (Figures 2 and 3) | `permutations/brainstem_families.py` | `sub_`, `dar_`, `dbm_*.csv`, `p_maxT` |
| Agreement of the medullary estimates across pipelines | `summary/medulla_agreement.py` | `medulla_agreement.csv` |
| Five medullary compartments: DCN region, rest of tegmentum, pyramids, olives, and inferior cerebellar peduncles (Table 2; Figures 1 and 2) | `compartments/30_stats.py` | `roi_main.csv`, `threshold = t50` |
| Compartment family-wise P | `permutations/brainstem_families.py` | `comp_*.csv`, `p_maxT` |
| Each participant's DCN region relative to a control-based prediction | `clinical/23_consistency.py` | `consistency.csv` |
| DCN region minus the inferior and superior colliculi, and the superior colliculus (Figure 2) | `compartments/32_tectal_control.py` | `tectal_control.csv` |
| Their P | `permutations/brainstem_families.py` | `tect_*.csv`, `p_single` |
| Atlas-free dorsal minus ventral contrast and the JHU corticospinal tract (Table 2) | `compartments/30_stats.py` | `roi_main.csv`, `GEO_DV_caudal`, `JHU_CST` |
| Their P | `permutations/brainstem_families.py` | `comp_single_*.csv`, `p_single` |
| Post hoc rim minus core contrast of the closed medulla | `compartments/31_posthoc_depth.py` | `posthoc_depth.csv`, `rim_minus_core` |
| 7 T atlas nuclei, the inferior medullary reticular formation outside the DCN region, and brainstem tract parts on the DBM template (Figure 3) | `atlas_nuclei_tracts/stats.py` | `tests_fine.csv` |
| Their family-wise P and the DCN region minus dorsal vagal complex P | `permutations/brainstem_families.py` | `nav_`, `trc_`, `fine_single_*.csv` |
| Within-SCI model of the DCN region on injury level, AIS A, and years since injury, with variance inflation factors (Table 2; Figure 4A) | `clinical/20_clinical_model.py` | `clinical_model.csv`, `sample = all` |
| The same model in the sensitivity sample | `clinical/20_clinical_model.py` | `clinical_model.csv`, `sample = sensitivity` |
| DCN region, SCI vs controls, in the sensitivity sample (Table 2) | `clinical/24_sensitivity_group.py` | `sensitivity_group.csv` |
| Partial correlations of the ISNCSCI scores with the medullary measures, and the variance level and AIS explain (Table 2) | `clinical/22_scores.py` | `score_correlations.csv`, `score_level_ais_r2.csv` |
| Covariation of the DCN region, the ventral thalamic group, and S1 trunk measures, with the minimum detectable correlation (Table 2; Figure 4B) | `clinical/21_covariation.py` | `covariation.csv` |
| Correlation in controls and the group-by-DCN interaction | `clinical/21_covariation.py` | `interaction.csv` |
| Brainstem DBM voxelwise TFCE clusters (Figure 2) | `dbm_brainstem/27_voxel_summary.py` | `voxel_clusters.csv`, `voxel_summary.csv` |
| DARTEL white matter voxelwise TFCE (Supplementary Figure 2) | `dartel/12_wm_vbm_summary.py` | `wm_vbm_summary.csv` |
| Whole-brain DBM TFCE clusters, their anatomical parts, and their cluster means | `dbm_wholebrain/27_voxel_summary.py`, `27b_cluster_parts.py` | `voxel_clusters.csv`, `cluster_parts.csv` |
| Six thalamic nucleus groups and VPL (Figure 4) | `thalamus/stats.py` | `family.csv`, `outside_family.csv` |
| Thalamic family-wise P (Figure 4) | `permutations/thalamus_cortex_families.py` | `thal_*.csv`, `family = thal6` |
| Brainnetome S1 and M1 body-part parcel area, volume, and thickness (Figure 4) | `cortex/40_somatotopic.py` | `somatotopic_results.csv` |
| Their family-wise P (Figure 4) | `permutations/thalamus_cortex_families.py` | `soma_*.csv`, `secondary_size` and `primary` |
| Clinical strata vs controls and within-SCI stratifiers with Benjamini-Hochberg q (Figure 6; Supplementary Figure 1; Table 2) | `clinical/30_stratification.py` | `within_sci.csv`, `stratum_vs_ctrl.csv` |
| Euler numbers by group (quality control) | `cortex/70_euler.py` | `euler_by_group.csv` |
| Outcomes of the cortical registration screen and review | `cortex/17_screen_summary.py` | `screen_summary.csv` |
| Minimum detectable effects within SCI and for the pain groups | `clinical/30_stratification.py` | `within_sci.csv`, `mde` |

### Tables and supplementary material

| Item | Script | Output |
| --- | --- | --- |
| Table 1 | `clinical/10_table1.py` | `table1.csv` |
| Table 2 | The rows above | |
| Supplementary Table 1 (families) | The scripts above; family definitions in `permutations/` | |
| Supplementary Table 2 (unadjusted volumes) | `summary/unadjusted_volumes.py` | `unadjusted_volumes.csv` |
| Supplementary Table 3: aseg brainstem and thalamus, postcentral area, and the regional measures (minimum family-wise P, and the count of nominal P below 0.05 against its null) | `cortex/20_region.py` (effects); `permutations/thalamus_cortex_families.py` (P) | `region_results.csv`, `region_family_summary.csv`; `region_*.csv`, `region_count238_*.json` |
| Supplementary Table 3: hypothalamus, cerebellar lobules I to VI | `exploratory/40_stats.py` | `exploratory_sci_vs_ctrl.csv` |
| Supplementary methods: mask sizes, smallest attainable P | `dbm_brainstem/27_voxel_summary.py`, `dbm_wholebrain/27_voxel_summary.py`, `dartel/11_wm_vbm_setup.py` | `voxel_summary.csv`, `wm_vbm_summary.csv` |

### Figures

| Figure | Script | Inputs |
| --- | --- | --- |
| 1 | `figures/fig1_pipeline_panels.py`, `fig1_stats_panels.py`, then `make_figures.py 1` | One control's pipeline outputs (`figures.example_participant`), compartment values, design matrix |
| 2 | `figures/make_figures.py 2` | Compartments, subfields, DARTEL, both DBM analyses, `permutations/comp_` and `tect_` |
| 3 | `figures/fig3_atlas_nuclei_tracts.py` | `atlas_nuclei_tracts/`, `permutations/fine_single_` |
| 4 | `figures/make_figures.py 4` | `clinical/`, thalamus, cortex, `permutations/` |
| 5 | `figures/fig5_wholebrain_dbm.py` | Whole-brain DBM maps and `randomise` chunks |
| 6 | `figures/make_figures.py 6` | `clinical/stratum_vs_ctrl.csv`, `within_sci.csv` |
| Supplementary 1 | `figures/make_figures.py S1` | `clinical/stratum_vs_ctrl.csv` |
| Supplementary 2 | `figures/make_figures.py S2` | DARTEL white matter maps |
| TIFF exports | `figures/render_tiffs.py` | The SVG figures |

## License and citation

The code in this folder is released under the MIT license in [LICENSE](../LICENSE). If you use it,
cite the paper and this repository as described in [CITATION.cff](../CITATION.cff).

## Scope notes

- Five whole-brain measures that the stratification family counts but the paper does not report
  enter as a private table (`clinical.additional_measures`); their extraction is not part of this
  folder.
- The statement that VPL had the largest effect among individual thalamic nuclei has no script
  here; `thalamus/stats.py` tests VPL only.
