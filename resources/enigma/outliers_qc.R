#!/usr/bin/env Rscript
# Run statistical QC on the ENIGMA cortical and subcortical measures.
#
# A first-party, argv-driven, base-R reimplementation of the upstream SCI_Map
# Step 2 ENIGMA cortical and subcortical outlier QC scripts. Draw one histogram
# per measure column.
# Flag subjects whose value falls outside mean +/- z * SD. Preserve the ENIGMA
# normal-distribution rule where Q1/Q3 +/- 1.5*IQR equals mean +/- 2.698*SD.
# Write one outliers.csv file plus one
# <source>__<measure>__<column>_hist.png per analyzed measure column.
# Bound each input table to 64 MiB, 5,000 cohort rows, and 1,024 columns.
#
# Pass three positional arguments:
#   1 measuresDir  Provide the directory holding the three ENIGMA measure CSVs.
#   2 outDir       Provide the qa_outliers output directory.
#   3 zThreshold   Set the SD multiplier; default to 2.698.

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 2) {
  stop("Run: outliers_qc.R <measuresDir> <outDir> [zThreshold].")
}
measures_dir <- args[1]
out_dir <- args[2]
z_threshold <- if (length(args) >= 3) suppressWarnings(as.numeric(args[3])) else NA
if (length(args) < 3) {
  z_threshold <- 2.698
}
if (length(z_threshold) != 1 || !is.finite(z_threshold) || z_threshold < 0) {
  stop("Set zThreshold to a finite value greater than or equal to zero.")
}

MAX_TABLE_BYTES <- 64 * 1024 * 1024
MAX_COHORT_ROWS <- 5000L
MAX_TABLE_COLUMNS <- 1024L
MAX_FLAGGED_ROWS <- 100000L

read_bounded_csv <- function(path, label) {
  info <- file.info(path)
  if (
    nrow(info) != 1 || is.na(info$size) || isTRUE(info$isdir) ||
      info$size > MAX_TABLE_BYTES
  ) {
    stop(sprintf("Keep %s within 64 MiB as a regular CSV file.", label))
  }
  header <- read.csv(
    path,
    stringsAsFactors = FALSE,
    check.names = FALSE,
    na.strings = c("", "NA", "x", "X"),
    nrows = 0
  )
  if (ncol(header) > MAX_TABLE_COLUMNS) {
    stop(sprintf("Keep %s within 1024 columns.", label))
  }
  # Read every cell as text so numeric validation sees the literal tokens;
  # type sniffing would turn an all-TRUE/FALSE column into logical values
  # that as.numeric silently maps to 1/0 instead of rejecting.
  frame <- read.csv(
    path,
    stringsAsFactors = FALSE,
    check.names = FALSE,
    na.strings = c("", "NA", "x", "X"),
    colClasses = "character",
    nrows = MAX_COHORT_ROWS + 1L
  )
  if (nrow(frame) > MAX_COHORT_ROWS) {
    stop(sprintf("Keep %s within 5000 cohort rows.", label))
  }
  if (ncol(frame) > MAX_TABLE_COLUMNS) {
    stop(sprintf("Keep %s within 1024 columns.", label))
  }
  frame
}

final_out_dir <- out_dir
dir.create(dirname(final_out_dir), recursive = TRUE, showWarnings = FALSE)
stage_dir <- tempfile(pattern = ".outliers-generation-", tmpdir = dirname(final_out_dir))
dir.create(stage_dir, recursive = TRUE, showWarnings = FALSE)
# Discard abandoned staging data on every handled failure path. A top-level
# on.exit call would never run in this script.
options(error = function() {
  if (nzchar(stage_dir)) unlink(stage_dir, recursive = TRUE, force = TRUE)
  quit(save = "no", status = 1L, runLast = FALSE)
})
out_dir <- stage_dir
hist_dir <- file.path(out_dir, "hist")
dir.create(hist_dir, recursive = TRUE, showWarnings = FALSE)

# Apply the shared Latin Modern figure style from resources/figstyle. Resolve it
# relative to this script for frozen and development runs. Use a Cairo device
# only when the style registers and R reports Cairo support. Fall back to the
# default PNG device otherwise.
script_path <- sub(
  "^--file=", "",
  grep("^--file=", commandArgs(trailingOnly = FALSE), value = TRUE)
)
script_dir <- if (length(script_path) > 0) {
  dirname(normalizePath(script_path[1]))
} else {
  getwd()
}
figstyle_r <- file.path(script_dir, "..", "figstyle", "figstyle.R")
lm_active <- FALSE
if (file.exists(figstyle_r)) {
  source(figstyle_r)
  lm_active <- apply_latin_modern(file.path(script_dir, "..", "fonts"))
}
use_cairo <- lm_active && isTRUE(capabilities("cairo"))

# Pair each bounded input with a source identity. Column semantics below select
# the measure and process shared summaries exactly once from their authoritative
# table.
inputs <- list(
  c("CorticalMeasuresENIGMA_ThickAvg.csv", "cortical_thickness"),
  c("CorticalMeasuresENIGMA_SurfAvg.csv", "cortical_area"),
  c("LandRvolumes.csv", "subcortical_volume")
)

column_measure <- function(source_id, column) {
  if (source_id == "cortical_thickness") {
    if (grepl("_thickavg$", column) || column %in% c("LThickness", "RThickness")) {
      return("thickness")
    }
    if (column %in% c("LSurfArea", "RSurfArea", "ICV")) return(NA_character_)
  } else if (source_id == "cortical_area") {
    if (grepl("_surfavg$", column) || column %in% c("LSurfArea", "RSurfArea")) {
      return("area")
    }
    if (column %in% c("LThickness", "RThickness", "ICV")) return(NA_character_)
  } else if (source_id == "subcortical_volume") {
    return("volume")
  }
  stop(sprintf("Classify the ENIGMA measure column %s from %s.", column, source_id))
}

histogram_name <- function(source_id, measure_label, column) {
  paste0(source_id, "__", measure_label, "__", column, "_hist.png")
}

empty_flagged <- function() data.frame(
  SubjID = character(0),
  structure = character(0),
  measure = character(0),
  direction = character(0),
  value = numeric(0),
  lower = numeric(0),
  upper = numeric(0),
  stringsAsFactors = FALSE
)

flagged_chunks <- list()
flagged_count <- 0L
add_rows <- function(indices, ids, structure, measure, direction,
                     values, lower, upper) {
  if (length(indices) == 0) {
    return(invisible(NULL))
  }
  if (flagged_count + length(indices) > MAX_FLAGGED_ROWS) {
    stop(sprintf(
      "Keep outliers.csv within %d flagged rows by narrowing inputs or threshold.",
      MAX_FLAGGED_ROWS
    ))
  }
  flagged_count <<- flagged_count + length(indices)
  flagged_chunks[[length(flagged_chunks) + 1L]] <<- data.frame(
    SubjID = ids[indices], structure = structure, measure = measure,
    direction = direction, value = values[indices], lower = lower, upper = upper,
    stringsAsFactors = FALSE
  )
  invisible(NULL)
}

found_any <- FALSE
for (spec in inputs) {
  path <- file.path(measures_dir, spec[1])
  source_id <- spec[2]
  if (!file.exists(path)) {
    next
  }
  found_any <- TRUE
  d <- read_bounded_csv(path, spec[1])
  if (ncol(d) < 2 || nrow(d) == 0) {
    next
  }
  ids <- as.character(d[[1]])
  if (anyDuplicated(ids) != 0) {
    stop(sprintf("Provide unique SubjIDs in %s.", spec[1]))
  }
  for (j in 2:ncol(d)) {
    col_name <- names(d)[j]
    measure_label <- column_measure(source_id, col_name)
    if (is.na(measure_label)) next
    raw <- as.character(d[[j]])
    v <- suppressWarnings(as.numeric(d[[j]]))
    missing <- is.na(raw) | trimws(raw) == "" | toupper(trimws(raw)) %in% c("NA", "X")
    invalid <- !missing & (is.na(v) | !is.finite(v))
    if (any(invalid)) {
      stop(sprintf(
        "Provide finite numeric values in %s column %s; found %d invalid value(s).",
        spec[1], col_name, sum(invalid)
      ))
    }
    if (measure_label == "volume" && any(!is.na(v) & v < 0)) {
      stop(sprintf("Remove negative volumes from %s column %s.", spec[1], col_name))
    }
    mu <- mean(v, na.rm = TRUE)
    s <- sd(v, na.rm = TRUE)
    if (sum(!is.na(v)) > 0) {
      hist_png <- file.path(
        hist_dir, histogram_name(source_id, measure_label, col_name)
      )
      if (use_cairo) {
        png(hist_png, width = 600, height = 400, type = "cairo")
        par(family = "LM Roman 10")
      } else {
        png(hist_png, width = 600, height = 400)
      }
      unit_label <- switch(
        measure_label,
        thickness = "mm",
        area = "mm^2",
        volume = "mm^3",
        "configured units"
      )
      structure_label <- gsub("_", " ", col_name, fixed = TRUE)
      hist(
        v,
        main = sprintf(
          "%s: %s distribution (n=%d, missing=%d)",
          structure_label,
          measure_label,
          sum(!is.na(v)),
          sum(is.na(v))
        ),
        sub = sprintf("Review limits: mean +/- %.3f SD", z_threshold),
        xlab = sprintf("%s (%s)", measure_label, unit_label),
        col = "grey80",
        border = "white"
      )
      if (!is.na(s) && s > 0) {
        abline(v = c(mu - z_threshold * s, mu + z_threshold * s), col = "#000000", lty = 2)
      }
      dev.off()
    }
    if (is.na(s) || s == 0) {
      next
    }
    lower <- mu - z_threshold * s
    upper <- mu + z_threshold * s
    add_rows(
      which(!is.na(v) & v < lower), ids, col_name, measure_label,
      "low", v, lower, upper
    )
    add_rows(
      which(!is.na(v) & v > upper), ids, col_name, measure_label,
      "high", v, lower, upper
    )
  }
}

if (!found_any) {
  stop(sprintf("Provide at least one ENIGMA measures CSV in %s.", measures_dir))
}

# Write the header even when no outliers are present.
flagged <- if (length(flagged_chunks) == 0) {
  empty_flagged()
} else {
  do.call(rbind, flagged_chunks)
}
write.csv(flagged, file.path(out_dir, "outliers.csv"), row.names = FALSE)
backup <- paste0(final_out_dir, ".previous")
if (file.exists(backup)) unlink(backup, recursive = TRUE, force = TRUE)
had_previous <- file.exists(final_out_dir)
if (had_previous && !file.rename(final_out_dir, backup)) {
  stop("Move the previous outlier generation before publication.")
}
if (!file.rename(out_dir, final_out_dir)) {
  if (had_previous) file.rename(backup, final_out_dir)
  stop("Publish the complete outlier generation on one filesystem.")
}
stage_dir <- ""
if (had_previous) unlink(backup, recursive = TRUE, force = TRUE)
cat(sprintf(
  "Review outliers.csv (%d flagged) and histograms in %s.\n",
  nrow(flagged), final_out_dir
))
