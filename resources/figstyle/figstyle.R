# Apply the shared Latin Modern style to Supraspina R QC figures.
#
# Register the bundled Latin Modern Roman faces with showtext/sysfonts. Pass the
# bundled fonts directory from the caller, resolved relative to its script. Open
# a Cairo device in the caller when this function succeeds. Return FALSE when
# showtext/sysfonts or the regular font file is unavailable, and let the caller
# use its default device.

apply_latin_modern <- function(fonts_dir) {
  if (!requireNamespace("sysfonts", quietly = TRUE) ||
    !requireNamespace("showtext", quietly = TRUE)) {
    return(FALSE)
  }
  regular <- file.path(fonts_dir, "lmroman10-regular.otf")
  if (!file.exists(regular)) {
    return(FALSE)
  }
  # Pass only optional faces that exist, and fall back to the regular face.
  # Treat any registration failure as unavailable styling.
  faces <- list(family = "LM Roman 10", regular = regular)
  optional <- c(
    bold = "lmroman10-bold.otf",
    italic = "lmroman10-italic.otf",
    bolditalic = "lmroman10-bolditalic.otf"
  )
  for (slot in names(optional)) {
    candidate <- file.path(fonts_dir, optional[[slot]])
    if (file.exists(candidate)) {
      faces[[slot]] <- candidate
    }
  }
  tryCatch(
    {
      do.call(sysfonts::font_add, faces)
      showtext::showtext_auto()
      TRUE
    },
    error = function(e) FALSE
  )
}
