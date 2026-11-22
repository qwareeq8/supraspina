"""Shared setup of the figure scripts: Arial from the configured font folder, and PDF export.

Every figure is written as a PDF with embedded TrueType fonts, plus an SVG (pdftocairo) and a
600 dpi PNG beside it, in config.output_dir("figures").
"""

import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402

ARIAL = ("arial.ttf", "arialbd.ttf", "ariali.ttf")


def register_arial():
    """Make Arial, Arial Bold, and Arial Italic (and Bold Italic when present) known to matplotlib."""
    from matplotlib import font_manager

    folder = config.path("figures.font_dir")
    for name in ARIAL + ("arialbi.ttf",):
        p = folder / name
        if p.exists():
            font_manager.fontManager.addfont(str(p))
        elif name in ARIAL:
            raise SystemExit(f"Font {p} is missing; set figures.font_dir to a folder with the Arial files.")


def out_dir() -> Path:
    return config.output_dir("figures")


def export(pdf, transparent=True):
    """Write the SVG and the 600 dpi PNG beside a figure PDF.

    A transparent canvas needs pdftocairo, the only one of the two Poppler tools that writes PNG alpha.
    """
    pdf = Path(pdf)
    subprocess.run(["pdftocairo", "-svg", str(pdf), str(pdf.with_suffix(".svg"))], check=True)
    if transparent:
        subprocess.run(["pdftocairo", "-png", "-transp", "-r", "600", "-singlefile", str(pdf),
                        str(pdf.with_suffix(""))], check=True)
    else:
        subprocess.run(["pdftoppm", "-r", "600", "-png", "-singlefile", str(pdf), str(pdf.with_suffix(""))],
                       check=True)
