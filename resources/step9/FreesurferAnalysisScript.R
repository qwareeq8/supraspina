#!/usr/bin/env Rscript
# Run Step 9 per-region structural comparisons and effect-size analysis.
#
# A first-party reimplementation of the upstream SCI_Map Step 9 R analysis,
# which upstream ships only as a tutorial. Reproduce its per-region Welch
# t-test and Hedges g pipeline across four cohort comparisons: pain vs
# control, no-pain vs control, no-pain vs pain, and pooled SCI vs control.
# Upstream's Step 9 README (eba4f59) runs this framework
# on two tracks, so the script has two modes:
#
# - Raw track (the final stage): the cortical (SCI), subcortical (SUB), and
#   white matter (WM) measure blocks, twelve required tables, the per-cohort
#   and per-site ICV and mean-thickness summaries, and site_exclusions.csv.
# - Z-score track (the zstats stage): the BrainCharts thickness (SCI) and
#   subcortical (SUB) z-score blocks, eight required tables named Z_*.
#
# Every effect is reference minus focal, as upstream's esvis::hedg_g computes
# it: control minus SCI for PvH, nNPvH, and IvH, and SCI_P minus SCI_nNP for
# nNPvP. The Welch t statistic has the same sign. Each table names its groups
# in Group_ref and Group_foc and states the difference in Direction.
#
# In the raw track, a metadata Site column with two or more labels turns on the
# site-balanced rule: each comparison keeps only the sites that contribute at
# least one subject to both compared groups, as upstream's README asks ("run
# only the comparisons supported by that site's data"). No Site column, only
# empty values, or one label leaves every table as it was without sites.
#
# Exit nonzero with each missing family and reason when a required table cannot
# be estimated. Bound each input CSV to 64 MiB, 5,000 cohort rows, and 1,024
# columns. Correct the tutorial's invalid t.test formula, frame subsetting, and
# positional metadata binding. Compute Hedges g from its standard formula with
# base R. Write .xlsx results when writexl is present and .csv results
# otherwise; the summaries and site_exclusions.csv are always .csv. Source this
# file from FreesurferAnalysisScript.Rmd to add an HTML report.
#
# Pass positional arguments that match the adapter's plain-R invocation:
#   1 structural_dir  Provide the directory containing the Step 8 CSVs.
#   2 metadata_csv    Provide SubjectID/Cohort/Sex/Age and optional Site metadata.
#   3 out_dir         Provide the results-table output directory.
#   4 start_column    Set the first measure column after metadata; default to 5.
#   5 cortical_split  Set the final cortical-column index, including the key.
#   6 cohorts_csv     Set labels as control,pain,nopain,pooled.
# The z-score track takes --track zscores <zscores_csv> <out_dir> <cohorts_csv>
# and reads braincharts_refused_sites.csv beside the z-score CSV when present.

# -- Analysis helpers ----------------------------------------------------------

MAX_TABLE_BYTES <- 64 * 1024 * 1024
MAX_COHORT_ROWS <- 5000L
MAX_TABLE_COLUMNS <- 1024L

SITE_EXCLUSIONS_FILE <- "site_exclusions.csv"
SITE_EXCLUSIONS_COLUMNS <- c(
  "comparison", "site", "n_ref", "n_focal", "excluded_subjects", "reason"
)
SUMMARY_FILES <- c(icv = "summary_icv.csv", thickness = "summary_thickness.csv")
RAW_BLOCKS <- c("SCI", "SUB", "WM")
ZSCORE_BLOCKS <- c("SCI", "SUB")
ZSCORE_TABLE_PREFIX <- "Z_"
ZSCORE_SUFFIX <- "_zscore"
ZSCORE_THICKNESS_SUFFIX <- "_thickness_zscore"
RAW_FAILURE <- "Cannot create all twelve required R analysis result tables."
ZSCORE_FAILURE <- "Cannot create all eight required R analysis z-score tables."
# BrainCharts writes the sites it refused beside the z-score table.
REFUSED_SITES_FILE <- "braincharts_refused_sites.csv"
REFUSED_SITES_COLUMNS <- c("site", "subjects", "subject_ids", "reason")

#' Read one regular CSV after bounded header and row preflight.
read_bounded_csv <- function(path, label, na_strings = "NA") {
  info <- file.info(path)
  # Name a missing input distinctly from an oversized one so the adapter's
  # failure parser classifies it as missing_input, not input_bounds.
  if (nrow(info) != 1 || is.na(info$size)) {
    stop(sprintf("Provide %s; no such file exists at %s.", label, path))
  }
  if (isTRUE(info$isdir) || info$size > MAX_TABLE_BYTES) {
    stop(sprintf("Keep %s within 64 MiB as a regular CSV file.", label))
  }
  header <- read.csv(
    path, stringsAsFactors = FALSE, check.names = FALSE, nrows = 0
  )
  if (ncol(header) > MAX_TABLE_COLUMNS) {
    stop(sprintf("Keep %s within 1024 columns.", label))
  }
  frame <- read.csv(
    path,
    stringsAsFactors = FALSE,
    check.names = FALSE,
    nrows = MAX_COHORT_ROWS + 1L,
    na.strings = na_strings
  )
  if (nrow(frame) > MAX_COHORT_ROWS) {
    stop(sprintf("Keep %s within 5000 cohort rows.", label))
  }
  if (ncol(frame) > MAX_TABLE_COLUMNS) {
    stop(sprintf("Keep %s within 1024 columns.", label))
  }
  frame
}

#' Compute the Hedges g effect size of a minus b.
hedges_g <- function(a, b) {
  n_a <- length(a)
  n_b <- length(b)
  pooled_sd <- sqrt(
    ((n_a - 1) * var(a) + (n_b - 1) * var(b)) / (n_a + n_b - 2)
  )
  if (is.na(pooled_sd) || pooled_sd == 0) {
    return(NA_real_)
  }
  cohens_d <- (mean(a) - mean(b)) / pooled_sd
  correction <- 1 - 3 / (4 * (n_a + n_b) - 9)
  cohens_d * correction
}

#' Name the difference every effect in a ref-versus-foc table reports.
direction_label <- function(ref, foc) {
  sprintf("%s minus %s", ref, foc)
}

#' Run one region's two-group comparison, returning a one-row data frame or NULL.
analyze_region <- function(frame, region, ref, foc) {
  a <- frame[frame$Cohort == ref, region]
  b <- frame[frame$Cohort == foc, region]
  a <- a[!is.na(a)]
  b <- b[!is.na(b)]
  if (length(a) < 2 || length(b) < 2) {
    return(NULL)
  }
  # Skip a region the Welch test cannot estimate, such as one constant in
  # both groups, so one degenerate column cannot abort the whole stage;
  # unestimable_reason names the failure when every region in a family skips.
  test <- tryCatch(t.test(a, b), error = function(e) NULL)
  if (is.null(test)) {
    return(NULL)
  }
  g <- hedges_g(a, b)
  total <- length(a) + length(b)
  se_g <- sqrt(total / (length(a) * length(b)) + g^2 / (2 * total))
  result <- data.frame(
    Region = region,
    p_value = test$p.value,
    Group_ref = ref,
    Mean_ref = mean(a),
    SD_ref = sd(a),
    N_ref = length(a),
    Group_foc = foc,
    Mean_foc = mean(b),
    SD_foc = sd(b),
    N_foc = length(b),
    t_statistic = unname(test$statistic),
    Hedges_g = g,
    SE_Hedges_g = se_g,
    CI_lower = g - 1.96 * se_g,
    CI_upper = g + 1.96 * se_g,
    Direction = direction_label(ref, foc),
    stringsAsFactors = FALSE
  )
  # Skip a region whose statistics are not finite, such as an all-zero
  # column where t.test returns NaN and hedges_g returns NA, instead of
  # aborting every family over one unestimable column.
  numeric_columns <- vapply(result, is.numeric, logical(1))
  if (any(!is.finite(unlist(result[numeric_columns], use.names = FALSE)))) {
    return(NULL)
  }
  result
}

#' Analyze every region of one measure block for one comparison.
analyze_comparison <- function(frame, regions, ref, foc) {
  rows <- lapply(regions, function(region) {
    analyze_region(frame, region, ref, foc)
  })
  rows <- rows[!vapply(rows, is.null, logical(1))]
  if (length(rows) == 0) {
    return(NULL)
  }
  do.call(rbind, rows)
}

#' Explain why no region in one result family could be estimated.
unestimable_reason <- function(frame, regions, ref, foc) {
  ref_counts <- vapply(regions, function(region) {
    sum(frame$Cohort == ref & !is.na(frame[[region]]))
  }, integer(1))
  foc_counts <- vapply(regions, function(region) {
    sum(frame$Cohort == foc & !is.na(frame[[region]]))
  }, integer(1))
  eligible <- ref_counts >= 2 & foc_counts >= 2
  if (!any(eligible)) {
    return(sprintf(
      paste0(
        "no region has at least 2 nonmissing observations in both cohorts ",
        "(maximum %s=%d; %s=%d)"
      ),
      ref, max(ref_counts), foc, max(foc_counts)
    ))
  }
  sprintf(
    "Welch t-test failed for all %d eligible region(s) in %s versus %s",
    sum(eligible), ref, foc
  )
}

#' Write a results table as .xlsx when writexl is available, else .csv.
write_results <- function(results, path_base) {
  if (requireNamespace("writexl", quietly = TRUE)) {
    writexl::write_xlsx(results, paste0(path_base, ".xlsx"))
  } else {
    write.csv(results, paste0(path_base, ".csv"), row.names = FALSE)
  }
}

#' Create an unpublished complete output generation on the destination filesystem.
create_generation <- function(final_out_dir) {
  parent <- dirname(final_out_dir)
  dir.create(parent, recursive = TRUE, showWarnings = FALSE)
  root <- file.path(parent, paste0(".", basename(final_out_dir), "-generations"))
  dir.create(root, recursive = TRUE, showWarnings = FALSE)
  stage <- tempfile(pattern = "generation-", tmpdir = root)
  if (!dir.create(stage, recursive = FALSE, showWarnings = FALSE)) {
    stop("Create an unpublished R analysis output generation.")
  }
  stage
}

#' Atomically point the public output path at one complete generation.
publish_generation <- function(stage, final_out_dir) {
  parent <- dirname(final_out_dir)
  root <- dirname(stage)
  current_link <- Sys.readlink(final_out_dir)
  if (file.exists(final_out_dir) && !nzchar(current_link)) {
    legacy <- tempfile(pattern = "legacy-", tmpdir = root)
    link_tmp <- tempfile(pattern = paste0(".", basename(final_out_dir), "-legacy-"), tmpdir = parent)
    if (!file.symlink(normalizePath(legacy, mustWork = FALSE), link_tmp)) {
      stop("Create the R analysis legacy-generation pointer.")
    }
    if (!file.rename(final_out_dir, legacy)) {
      unlink(link_tmp, force = TRUE)
      stop("Move the previous R analysis directory into the generation store.")
    }
    if (!file.rename(link_tmp, final_out_dir)) {
      file.rename(legacy, final_out_dir)
      unlink(link_tmp, force = TRUE)
      stop("Publish the previous R analysis generation pointer.")
    }
  }
  link_tmp <- tempfile(pattern = paste0(".", basename(final_out_dir), "-current-"), tmpdir = parent)
  if (!file.symlink(normalizePath(stage, mustWork = TRUE), link_tmp)) {
    stop("Create the complete R analysis generation pointer.")
  }
  if (!file.rename(link_tmp, final_out_dir)) {
    unlink(link_tmp, force = TRUE)
    stop("Publish the complete R analysis generation on one filesystem.")
  }
  invisible(NULL)
}

#' Find a metadata column by any of several candidate names.
find_column <- function(columns, candidates) {
  hit <- candidates[candidates %in% columns]
  if (length(hit) == 0) NA_character_ else hit[1]
}

#' Sort text in code-point order, independent of the R locale.
sort_text <- function(values) {
  sort(values, method = "radix")
}

#' Join words as "a", "a and b", or "a, b, and c".
join_words <- function(words) {
  n <- length(words)
  if (n <= 1) {
    return(paste(words, collapse = ""))
  }
  if (n == 2) {
    return(paste(words, collapse = " and "))
  }
  paste0(paste(words[-n], collapse = ", "), ", and ", words[n])
}

#' Name up to two subjects and count the rest.
summarize_subjects <- function(subjects) {
  if (length(subjects) <= 3) {
    return(join_words(subjects))
  }
  sprintf(
    "%s, %s, and %d more subjects", subjects[1], subjects[2], length(subjects) - 2
  )
}

#' Replace blank and NA-like region values with NA and refuse other nonnumeric text.
coerce_regions <- function(frame, regions, label) {
  for (region in regions) {
    raw <- frame[[region]]
    text <- trimws(as.character(raw))
    missing <- is.na(raw) | text == "" | toupper(text) %in% c("NA", "X")
    values <- suppressWarnings(as.numeric(text))
    invalid <- !missing & (is.na(values) | !is.finite(values))
    if (any(invalid)) {
      stop(sprintf(
        "Provide finite numeric values in %s region %s; found %d invalid value(s).",
        label, region, sum(invalid)
      ))
    }
    values[missing] <- NA_real_
    frame[[region]] <- values
  }
  frame
}

#' Read one subject-keyed Step 8 table with unique, nonempty subject keys.
read_subject_table <- function(path, label) {
  table <- read_bounded_csv(path, label)
  if (ncol(table) == 0) {
    stop(sprintf("Provide %s with a subject column.", label))
  }
  names(table)[1] <- "SubjectID"
  table$SubjectID <- as.character(table$SubjectID)
  if (anyDuplicated(table$SubjectID) != 0) {
    stop(sprintf("Provide unique subject values in %s.", label))
  }
  if (any(is.na(table$SubjectID) | !nzchar(trimws(table$SubjectID)))) {
    stop(sprintf("Provide nonempty subject values in %s.", label))
  }
  table
}

#' Return the (reference, focal) cohort labels of the four comparisons.
comparison_groups <- function(cohorts) {
  healthy <- cohorts[1]
  pain <- cohorts[2]
  nopain <- cohorts[3]
  pooled <- cohorts[4]
  list(
    PvH = c(healthy, pain),
    nNPvH = c(healthy, nopain),
    nNPvP = c(pain, nopain),
    IvH = c(healthy, pooled)
  )
}

#' Keep one comparison's two groups, pooling pain and no-pain for IvH.
comparison_frame <- function(frame, code, cohorts) {
  groups <- comparison_groups(cohorts)[[code]]
  if (code == "IvH") {
    frame$Cohort[frame$Cohort %in% cohorts[2:3]] <- cohorts[4]
  }
  frame[frame$Cohort %in% groups, , drop = FALSE]
}

#' Return an empty site_exclusions table with the contract columns.
empty_exclusions <- function() {
  data.frame(
    comparison = character(0),
    site = character(0),
    n_ref = integer(0),
    n_focal = integer(0),
    excluded_subjects = character(0),
    reason = character(0),
    missing_group = character(0),
    present_group = character(0),
    stringsAsFactors = FALSE
  )
}

#' Apply the site-balanced rule to one comparison's frame.
#'
#' Keep the sites with at least one subject in each compared group and record
#' one exclusion row per other site. Count subjects, not nonmissing values, so
#' every block of one comparison keeps the same sites.
site_balance <- function(frame, frame_sites, code, ref, foc) {
  kept <- character(0)
  rows <- list()
  for (site in sort_text(unique(frame_sites))) {
    in_site <- frame_sites == site
    n_ref <- sum(in_site & frame$Cohort == ref)
    n_foc <- sum(in_site & frame$Cohort == foc)
    if (n_ref > 0 && n_foc > 0) {
      kept <- c(kept, site)
      next
    }
    missing_group <- if (n_ref == 0) ref else foc
    rows[[length(rows) + 1L]] <- data.frame(
      comparison = code,
      site = site,
      n_ref = n_ref,
      n_focal = n_foc,
      excluded_subjects = paste(
        sort_text(frame$SubjectID[in_site]), collapse = ";"
      ),
      reason = sprintf("Site %s has no %s subjects in %s.", site, missing_group, code),
      missing_group = missing_group,
      present_group = if (n_ref == 0) foc else ref,
      stringsAsFactors = FALSE
    )
  }
  exclusions <- if (length(rows) > 0) do.call(rbind, rows) else empty_exclusions()
  list(kept = kept, exclusions = exclusions)
}

#' Describe each subject's site and whether the site rule applies.
#'
#' The lookup covers every metadata subject; the labels and the mixed-site
#' check cover the analysis subjects. Refuse a mix of set and empty sites (the
#' planner blocks that state too), so no subject silently joins or leaves a
#' site.
site_design <- function(metadata, subj_col, subject_ids) {
  site_col <- find_column(names(metadata), c("Site", "site"))
  values <- if (is.na(site_col)) {
    rep("", nrow(metadata))
  } else {
    trimws(as.character(metadata[[site_col]]))
  }
  values[is.na(values)] <- ""
  lookup <- stats::setNames(values, as.character(metadata[[subj_col]]))
  sites <- unname(lookup[subject_ids])
  sites[is.na(sites)] <- ""
  labels <- sort_text(unique(sites[nzchar(sites)]))
  if (length(labels) > 0 && any(!nzchar(sites))) {
    unset <- sort_text(subject_ids[!nzchar(sites)])
    stop(sprintf(
      "Set a site for %s; some subjects have a site and these do not.",
      summarize_subjects(unset)
    ))
  }
  list(
    lookup = lookup,
    labels = labels,
    active = length(labels) >= 2
  )
}

#' Count the subjects of each site and cohort.
site_counts <- function(merged, sites, cohorts) {
  labels <- if (length(sites$labels) > 0) sites$labels else ""
  rows <- lapply(labels, function(site) {
    in_site <- unname(sites$lookup[merged$SubjectID]) == site
    counts <- vapply(cohorts[1:3], function(cohort) {
      sum(in_site & merged$Cohort == cohort)
    }, integer(1))
    data.frame(
      Site = site,
      Cohort = cohorts[1:3],
      N = unname(counts),
      stringsAsFactors = FALSE
    )
  })
  do.call(rbind, rows)
}

#' Summarize each measure by cohort and site (n, mean, SD).
summarize_measures <- function(frame, measures, sites, cohorts) {
  groups <- list(cohorts[1], cohorts[2], cohorts[3], cohorts[2:3])
  names(groups) <- cohorts
  labels <- if (length(sites$labels) > 0) sites$labels else ""
  frame_sites <- unname(sites$lookup[frame$SubjectID])
  frame_sites[is.na(frame_sites)] <- ""
  rows <- list()
  for (cohort in names(groups)) {
    for (site in labels) {
      members <- frame$Cohort %in% groups[[cohort]] & frame_sites == site
      if (!any(members)) {
        next
      }
      for (measure in measures) {
        values <- frame[[measure]][members]
        values <- values[!is.na(values)]
        rows[[length(rows) + 1L]] <- data.frame(
          Cohort = cohort,
          Site = site,
          Measure = measure,
          N = length(values),
          Mean = if (length(values) > 0) mean(values) else NA_real_,
          SD = if (length(values) > 1) sd(values) else NA_real_,
          stringsAsFactors = FALSE
        )
      }
    }
  }
  if (length(rows) == 0) {
    return(data.frame(
      Cohort = character(0), Site = character(0), Measure = character(0),
      N = integer(0), Mean = numeric(0), SD = numeric(0),
      stringsAsFactors = FALSE
    ))
  }
  do.call(rbind, rows)
}

#' Write one Step 8 summary table by cohort and site.
write_summary <- function(structural_dir, basename, meta, sites, cohorts, out_path) {
  table <- read_subject_table(file.path(structural_dir, basename), basename)
  measures <- setdiff(names(table), "SubjectID")
  table <- coerce_regions(table, measures, basename)
  merged <- merge(meta[, c("SubjectID", "Cohort")], table, by = "SubjectID")
  write.csv(
    summarize_measures(merged, measures, sites, cohorts),
    out_path,
    row.names = FALSE,
    na = ""
  )
}

#' Estimate every block and comparison, writing one table per family.
#'
#' Return the "<family>: <reason>" text of every family that could not be
#' estimated. ``kept_sites`` is NULL when the site rule is off, else the sites
#' each comparison keeps.
write_family_tables <- function(blocks, cohorts, out_dir, prefix, sites_lookup,
                                kept_sites, exclusions) {
  comparisons <- comparison_groups(cohorts)
  missing_families <- character(0)
  for (block_name in names(blocks)) {
    block <- blocks[[block_name]]
    for (code in names(comparisons)) {
      family <- sprintf("%s%s_%s", prefix, block_name, code)
      if (!is.null(block$empty_reason)) {
        missing_families <- c(
          missing_families, sprintf("%s: %s", family, block$empty_reason)
        )
        next
      }
      ref <- comparisons[[code]][1]
      foc <- comparisons[[code]][2]
      frame <- comparison_frame(block$frame, code, cohorts)
      if (!is.null(kept_sites)) {
        frame <- frame[
          unname(sites_lookup[frame$SubjectID]) %in% kept_sites[[code]], ,
          drop = FALSE
        ]
      }
      results <- analyze_comparison(frame, block$regions, ref, foc)
      if (is.null(results)) {
        reason <- unestimable_reason(frame, block$regions, ref, foc)
        left_out <- exclusions$site[exclusions$comparison == code]
        if (length(left_out) > 0) {
          reason <- sprintf(
            "%s after the site rule left out site%s %s",
            reason, if (length(left_out) == 1) "" else "s", join_words(left_out)
          )
        }
        missing_families <- c(missing_families, sprintf("%s: %s", family, reason))
        next
      }
      write_results(results, file.path(out_dir, paste0(family, "_results")))
    }
  }
  missing_families
}

# -- Raw track -----------------------------------------------------------------

run_analysis_in_place <- function(structural_dir, metadata_csv, out_dir,
                                  start_column, cortical_split, cohorts) {
  dir.create(out_dir, recursive = TRUE, showWarnings = FALSE)
  healthy <- cohorts[1]

  measures <- read_bounded_csv(
    file.path(structural_dir, "dk_all_stats.csv"), "dk_all_stats.csv"
  )
  # Keep "NA" as text so a site labeled NA stays a site, not an unset value.
  metadata <- read_bounded_csv(
    metadata_csv, "Final metadata CSV", na_strings = character(0)
  )

  # Keep these candidates and their order identical to the planning-side
  # metadata projection, so every metadata table planning accepts joins on
  # the same column here.
  subj_col <- find_column(
    names(metadata),
    c("participant_id", "SubjectID", "Subject_ID", "ID", "subject")
  )
  cohort_col <- find_column(names(metadata), c("Cohort", "cohort", "Group"))
  if (is.na(subj_col) || is.na(cohort_col)) {
    stop("Provide metadata.csv with a subject id column and a Cohort column.")
  }
  sex_col <- find_column(names(metadata), c("Sex", "sex"))
  age_col <- find_column(names(metadata), c("Age", "age"))

  names(measures)[1] <- "SubjectID"
  if (anyDuplicated(as.character(measures$SubjectID)) != 0) {
    stop("Provide unique SubjectID values in dk_all_stats.csv.")
  }
  if (anyDuplicated(as.character(metadata[[subj_col]])) != 0) {
    stop("Provide unique subject ids in the Final metadata CSV.")
  }
  if (any(!nzchar(trimws(as.character(measures$SubjectID))))) {
    stop("Provide nonempty SubjectID values in dk_all_stats.csv.")
  }
  if (any(!nzchar(trimws(as.character(metadata[[subj_col]]))))) {
    stop("Provide nonempty subject ids in the Final metadata CSV.")
  }
  meta <- data.frame(
    SubjectID = as.character(metadata[[subj_col]]),
    Cohort = as.character(metadata[[cohort_col]]),
    Sex = if (is.na(sex_col)) NA else metadata[[sex_col]],
    Age = if (is.na(age_col)) NA else metadata[[age_col]],
    stringsAsFactors = FALSE
  )
  # Relabel the app's "control" metadata value as cohorts[1] so PvH/IvH have rows.
  meta$Cohort[meta$Cohort == "control"] <- healthy
  measures$SubjectID <- as.character(measures$SubjectID)

  merged <- merge(meta, measures, by = "SubjectID")
  if (nrow(merged) > MAX_COHORT_ROWS || ncol(merged) > MAX_TABLE_COLUMNS) {
    stop("Keep the merged Final table within 5000 rows and 1024 columns.")
  }
  if (nrow(merged) == 0) {
    stop("Provide subjects shared between metadata and dk_all_stats.csv.")
  }

  if (is.na(start_column) || start_column < 5 || start_column > ncol(merged) + 1) {
    stop("Set start_column between 5 and one past the merged column count.")
  }
  measure_names <- if (start_column <= ncol(merged)) {
    names(merged)[start_column:ncol(merged)]
  } else {
    character(0)
  }
  if (anyDuplicated(measure_names) != 0) {
    stop("Provide unique R analysis measure-column names.")
  }
  merged <- coerce_regions(merged, measure_names, "R analysis")
  # Treat cortical_split as the final original cortical-column index including
  # the subject key. Account for the four merged metadata columns and the active
  # start_column when selecting the remaining cortical measures.
  n_cortical <- max(
    0,
    min(cortical_split + 4 - start_column, length(measure_names))
  )
  cortical <- measure_names[seq_len(n_cortical)]
  subcortical <- if (n_cortical < length(measure_names)) {
    measure_names[(n_cortical + 1):length(measure_names)]
  } else {
    character(0)
  }

  # White matter volumes (upstream WM_Stats): every wm_volumes.csv structure.
  wm <- read_subject_table(file.path(structural_dir, "wm_volumes.csv"), "wm_volumes.csv")
  merged_wm <- merge(meta, wm, by = "SubjectID")
  if (nrow(merged_wm) > MAX_COHORT_ROWS || ncol(merged_wm) > MAX_TABLE_COLUMNS) {
    stop("Keep the merged white matter table within 5000 rows and 1024 columns.")
  }
  wm_regions <- setdiff(names(wm), "SubjectID")
  merged_wm <- coerce_regions(merged_wm, wm_regions, "white matter")

  sites <- site_design(metadata, subj_col, merged$SubjectID)
  comparisons <- comparison_groups(cohorts)
  exclusions <- empty_exclusions()
  kept_sites <- NULL
  if (sites$active) {
    kept_sites <- list()
    for (code in names(comparisons)) {
      frame <- comparison_frame(merged, code, cohorts)
      balance <- site_balance(
        frame, unname(sites$lookup[frame$SubjectID]), code,
        comparisons[[code]][1], comparisons[[code]][2]
      )
      kept_sites[[code]] <- balance$kept
      exclusions <- rbind(exclusions, balance$exclusions)
    }
  }
  blocks <- list(
    SCI = list(
      frame = merged, regions = cortical,
      empty_reason = if (length(cortical) == 0) {
        "no measure columns were assigned to the SCI block"
      }
    ),
    SUB = list(
      frame = merged, regions = subcortical,
      empty_reason = if (length(subcortical) == 0) {
        "no measure columns were assigned to the SUB block"
      }
    ),
    WM = list(
      frame = merged_wm, regions = wm_regions,
      empty_reason = if (length(wm_regions) == 0) {
        "wm_volumes.csv has no white matter structures"
      } else if (nrow(merged_wm) == 0) {
        "wm_volumes.csv has no rows for the metadata subjects"
      }
    )
  )
  missing_families <- write_family_tables(
    blocks, cohorts, out_dir, "", sites$lookup, kept_sites, exclusions
  )
  if (length(missing_families) > 0) {
    stop(paste(RAW_FAILURE, paste(missing_families, collapse = "; ")))
  }

  write.csv(
    exclusions[, SITE_EXCLUSIONS_COLUMNS],
    file.path(out_dir, SITE_EXCLUSIONS_FILE),
    row.names = FALSE
  )
  write_summary(
    structural_dir, "icv_data.csv", meta, sites, cohorts,
    file.path(out_dir, SUMMARY_FILES[["icv"]])
  )
  write_summary(
    structural_dir, "cortical_thickness.csv", meta, sites, cohorts,
    file.path(out_dir, SUMMARY_FILES[["thickness"]])
  )
  cat(sprintf("Review the completed Step 9 results in %s.\n", out_dir))
  invisible(list(
    track = "raw",
    cohorts = cohorts,
    site_labels = sites$labels,
    site_rule = sites$active,
    site_counts = site_counts(merged, sites, cohorts),
    exclusions = exclusions
  ))
}

#' Analyze into an unpublished directory and publish the complete table set.
run_analysis <- function(structural_dir, metadata_csv, out_dir,
                         start_column, cortical_split, cohorts) {
  stage <- create_generation(out_dir)
  on.exit(if (nzchar(stage)) unlink(stage, recursive = TRUE, force = TRUE), add = TRUE)
  run_analysis_in_place(
    structural_dir, metadata_csv, stage, start_column, cortical_split, cohorts
  )
  publish_generation(stage, out_dir)
  stage <- ""
  cat(sprintf("Published the complete Step 9 generation at %s.\n", out_dir))
}

# -- Z-score track -------------------------------------------------------------

#' Read the site labels BrainCharts refused from the file beside the z-scores.
#'
#' A z-score CSV without that file (one not written by the BrainCharts stage)
#' states no refusals. Labels stay text, so a site named NA or 01 keeps its name.
read_refused_sites <- function(zscores_csv) {
  path <- file.path(dirname(zscores_csv), REFUSED_SITES_FILE)
  info <- file.info(path)
  if (nrow(info) != 1 || is.na(info$size)) {
    return(character(0))
  }
  if (isTRUE(info$isdir) || info$size > MAX_TABLE_BYTES) {
    stop(sprintf("Keep %s within 64 MiB as a regular CSV file.", REFUSED_SITES_FILE))
  }
  refused <- read.csv(
    path,
    colClasses = "character",
    check.names = FALSE,
    na.strings = character(0),
    nrows = MAX_COHORT_ROWS + 1L
  )
  if (!identical(names(refused), REFUSED_SITES_COLUMNS) ||
      nrow(refused) > MAX_COHORT_ROWS) {
    stop(sprintf(
      "Provide %s with the columns %s.",
      REFUSED_SITES_FILE, join_words(REFUSED_SITES_COLUMNS)
    ))
  }
  sort_text(unique(trimws(refused$site)))
}

#' Compare BrainCharts z-scores between cohorts, pooling the adapted sites.
run_zscore_analysis_in_place <- function(zscores_csv, out_dir, cohorts) {
  dir.create(out_dir, recursive = TRUE, showWarnings = FALSE)
  # Keep every text cell as written so a site or subject named "NA" stays a
  # label; coerce_regions below reads blank, NA, and X z-scores as missing.
  zscores <- read_bounded_csv(
    zscores_csv, "BrainCharts z-score CSV", na_strings = character(0)
  )
  if (!all(c("subject", "cohort") %in% names(zscores))) {
    stop("Provide the BrainCharts z-score CSV with subject and cohort columns.")
  }
  subjects <- as.character(zscores$subject)
  if (anyDuplicated(subjects) != 0) {
    stop("Provide unique subject values in the BrainCharts z-score CSV.")
  }
  if (any(is.na(subjects) | !nzchar(trimws(subjects)))) {
    stop("Provide nonempty subject values in the BrainCharts z-score CSV.")
  }
  site_labels <- if ("siteLabel" %in% names(zscores)) {
    labels <- trimws(as.character(zscores$siteLabel))
    labels[is.na(labels)] <- ""
    labels
  } else {
    rep("", nrow(zscores))
  }
  refused_sites <- read_refused_sites(zscores_csv)
  scored_refused <- intersect(refused_sites[nzchar(refused_sites)], site_labels)
  if (length(scored_refused) > 0) {
    stop(sprintf(
      "Site %s was refused by BrainCharts but has rows in the z-score CSV.",
      scored_refused[1]
    ))
  }
  z_columns <- names(zscores)[endsWith(names(zscores), ZSCORE_SUFFIX)]
  thickness <- z_columns[endsWith(z_columns, ZSCORE_THICKNESS_SUFFIX)]
  subcortical <- setdiff(z_columns, thickness)
  frame <- data.frame(
    SubjectID = subjects,
    Cohort = as.character(zscores$cohort),
    stringsAsFactors = FALSE
  )
  frame$Cohort[frame$Cohort == "control"] <- cohorts[1]
  frame <- cbind(frame, zscores[, z_columns, drop = FALSE])
  frame <- coerce_regions(frame, z_columns, "BrainCharts z-score")
  if (nrow(frame) == 0) {
    stop("Provide at least one subject row in the BrainCharts z-score CSV.")
  }
  blocks <- list(
    SCI = list(
      frame = frame, regions = thickness,
      empty_reason = if (length(thickness) == 0) {
        "the z-score CSV has no thickness z-score columns"
      }
    ),
    SUB = list(
      frame = frame, regions = subcortical,
      empty_reason = if (length(subcortical) == 0) {
        "the z-score CSV has no subcortical z-score columns"
      }
    )
  )
  missing_families <- write_family_tables(
    blocks, cohorts, out_dir, ZSCORE_TABLE_PREFIX, NULL, NULL, empty_exclusions()
  )
  if (length(missing_families) > 0) {
    stop(paste(ZSCORE_FAILURE, paste(missing_families, collapse = "; ")))
  }
  cat(sprintf("Review the completed Step 9 z-score results in %s.\n", out_dir))
  invisible(list(
    track = "zscores",
    cohorts = cohorts,
    site_subjects = table(site_labels[nzchar(site_labels)]),
    refused_sites = refused_sites
  ))
}

#' Analyze z-scores into an unpublished directory and publish the table set.
run_zscore_analysis <- function(zscores_csv, out_dir, cohorts) {
  stage <- create_generation(out_dir)
  on.exit(if (nzchar(stage)) unlink(stage, recursive = TRUE, force = TRUE), add = TRUE)
  run_zscore_analysis_in_place(zscores_csv, stage, cohorts)
  publish_generation(stage, out_dir)
  stage <- ""
  cat(sprintf("Published the complete Step 9 z-score generation at %s.\n", out_dir))
}

# -- Report text ---------------------------------------------------------------

#' State the direction of every effect in the result tables.
direction_text <- function(cohorts) {
  comparisons <- comparison_groups(cohorts)
  pairs <- vapply(names(comparisons), function(code) {
    sprintf(
      "%s (%s)",
      direction_label(comparisons[[code]][1], comparisons[[code]][2]), code
    )
  }, character(1))
  c(
    paste0(
      "Every effect is reference minus focal, as in upstream's esvis::hedg_g: ",
      join_words(unname(pairs)), "."
    ),
    paste(
      "A positive t statistic or Hedges g means the reference group's mean is",
      "higher. Each table names its groups in Group_ref and Group_foc and the",
      "difference in Direction. The Analysis panel reports SCI minus control,",
      "the opposite sign."
    )
  )
}

#' Describe the sites of a raw-track run and every site the rule left out.
site_text <- function(analysis) {
  labels <- analysis$site_labels
  if (length(labels) == 0) {
    return("All subjects come from one site.")
  }
  if (length(labels) == 1) {
    return(sprintf("All subjects come from one site, %s.", labels))
  }
  lines <- sprintf(
    "Subjects come from %d sites: %s.", length(labels), join_words(labels)
  )
  exclusions <- analysis$exclusions
  if (nrow(exclusions) == 0) {
    return(c(lines, "Every comparison uses every site."))
  }
  cohorts <- analysis$cohorts
  keys <- unique(exclusions[, c("site", "missing_group")])
  for (index in seq_len(nrow(keys))) {
    site <- keys$site[index]
    missing_group <- keys$missing_group[index]
    rows <- exclusions[
      exclusions$site == site & exclusions$missing_group == missing_group, ,
      drop = FALSE
    ]
    codes <- names(comparison_groups(cohorts))
    codes <- codes[codes %in% rows$comparison]
    subjects <- unique(unlist(strsplit(rows$excluded_subjects, ";", fixed = TRUE)))
    # Name the left-out subjects by their group; several SCI groups are SCI.
    present <- unique(rows$present_group)
    noun <- if (length(present) == 1) {
      paste0(present, " ")
    } else if (all(present %in% cohorts[2:4])) {
      paste0(cohorts[4], " ")
    } else {
      ""
    }
    lacking <- if (missing_group == cohorts[1]) {
      "controls"
    } else {
      sprintf("%s subjects", missing_group)
    }
    lines <- c(lines, sprintf(
      "%s %s out site %s (%d %ssubject%s) because it has no %s.",
      join_words(codes),
      if (length(codes) == 1) "leaves" else "leave",
      site,
      length(subjects),
      noun,
      if (length(subjects) == 1) "" else "s",
      lacking
    ))
  }
  lines
}

#' Describe the sites a z-score run pools and every site BrainCharts refused.
zscore_site_text <- function(analysis) {
  counts <- analysis$site_subjects
  lead <- "Z-scores are adapted per site, so the comparisons pool sites"
  text <- if (length(counts) == 0) {
    paste0(lead, ".")
  } else {
    labels <- sort_text(names(counts))
    parts <- sprintf(
      "%s (%d subject%s)", labels, as.integer(counts[labels]),
      ifelse(as.integer(counts[labels]) == 1, "", "s")
    )
    paste0(lead, ": ", join_words(parts), ".")
  }
  for (site in analysis$refused_sites) {
    named <- if (nzchar(site)) sprintf("Site %s", site) else "The cohort"
    text <- paste(
      text, sprintf("%s was refused by BrainCharts and has no rows.", named)
    )
  }
  text
}

# -- Command-line entry points -------------------------------------------------

#' Parse and check the four comma-separated cohort labels.
parse_cohorts <- function(text) {
  cohort_vec <- strsplit(text, ",", fixed = TRUE)[[1]]
  if (length(cohort_vec) != 4 || any(!nzchar(cohort_vec))) {
    stop("Set exactly four nonempty cohort labels.")
  }
  cohort_vec
}

#' Render one Step 9 report into a generation and publish it.
#'
#' The rmarkdown package knits in this function's frame, so no local may be
#' named params.
render_into_generation <- function(template, out_dir, report_params) {
  if (!requireNamespace("rmarkdown", quietly = TRUE)) {
    stop("Install the rmarkdown package to render the R analysis report.")
  }
  stage <- create_generation(out_dir)
  on.exit(if (nzchar(stage)) unlink(stage, recursive = TRUE, force = TRUE), add = TRUE)
  report_params$out_dir <- stage
  rmarkdown::render(
    input = template,
    output_format = "html_document",
    output_file = "report.html",
    output_dir = stage,
    params = report_params,
    knit_root_dir = stage
  )
  publish_generation(stage, out_dir)
  stage <- ""
}

#' Render the Step 9 report from fixed positional argv.
render_report <- function(args) {
  if (length(args) != 7) {
    stop(paste(
      "Run: FreesurferAnalysisScript.R --render-report <template.Rmd>",
      "<structural_dir> <metadata_csv> <out_dir> <start_column>",
      "<cortical_split> <control,pain,nopain,pooled>."
    ))
  }
  start_col <- suppressWarnings(as.integer(args[5]))
  split_idx <- suppressWarnings(as.integer(args[6]))
  if (is.na(start_col) || is.na(split_idx)) {
    stop("Set start_column and cortical_split to integers.")
  }
  cohort_vec <- parse_cohorts(args[7])
  render_into_generation(args[1], args[4], list(
    track = "raw",
    structural_dir = args[2],
    metadata_csv = args[3],
    start_column = start_col,
    cortical_split = split_idx,
    cohorts = cohort_vec
  ))
}

#' Render the Step 9 z-score report from fixed positional argv.
render_zscore_report <- function(args) {
  if (length(args) != 4) {
    stop(paste(
      "Run: FreesurferAnalysisScript.R --track zscores --render-report",
      "<template.Rmd> <zscores_csv> <out_dir> <control,pain,nopain,pooled>."
    ))
  }
  cohort_vec <- parse_cohorts(args[4])
  render_into_generation(args[1], args[3], list(
    track = "zscores",
    zscores_csv = args[2],
    cohorts = cohort_vec
  ))
}

# -- Command-line entry point (skipped when sourced, e.g. by the Rmd) ----------

if (sys.nframe() == 0L) {
  # R truncates error messages at 1000 characters by default, which cut the
  # list of unestimable families the adapter reports.
  options(warning.length = 8170L)
  args <- commandArgs(trailingOnly = TRUE)
  track <- "raw"
  if (length(args) > 0 && identical(args[1], "--track")) {
    if (length(args) < 2 || !(args[2] %in% c("raw", "zscores"))) {
      stop("Set --track to raw or zscores.")
    }
    track <- args[2]
    args <- args[-(1:2)]
  }
  if (identical(track, "zscores")) {
    if (length(args) > 0 && identical(args[1], "--render-report")) {
      render_zscore_report(args[-1])
      quit(status = 0L)
    }
    if (length(args) != 3) {
      stop(paste(
        "Run: FreesurferAnalysisScript.R --track zscores <zscores_csv>",
        "<out_dir> <control,pain,nopain,pooled>."
      ))
    }
    run_zscore_analysis(args[1], args[2], parse_cohorts(args[3]))
    quit(status = 0L)
  }
  if (length(args) > 0 && identical(args[1], "--render-report")) {
    render_report(args[-1])
    quit(status = 0L)
  }
  if (length(args) < 3) {
    stop(paste(
      "Run: FreesurferAnalysisScript.R <structural_dir> <metadata_csv>",
      "<out_dir> [start_column] [cortical_split] [control,pain,nopain,pooled]."
    ))
  }
  start_col <- if (length(args) >= 4) as.integer(args[4]) else 5L
  split_idx <- if (length(args) >= 5) as.integer(args[5]) else 613L
  cohort_vec <- if (length(args) >= 6) {
    strsplit(args[6], ",")[[1]]
  } else {
    c("SCI_H", "SCI_P", "SCI_nNP", "SCI")
  }
  run_analysis(args[1], args[2], args[3], start_col, split_idx, cohort_vec)
}
