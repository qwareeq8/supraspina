"""Apply shared Latin Modern export typography to Supraspina pipeline figures.

Register packaged Latin Modern Roman faces with Matplotlib. Set shared export
rcParams for a serif body, Computer Modern math through mathtext, 300 dpi, and a
tight bounding box. Resolve fonts relative to this resource for any selected
analysis interpreter. Import no sidecar package.
"""

from __future__ import annotations

from pathlib import Path

import matplotlib
from matplotlib import font_manager

#: Use the bundled Latin Modern Roman OpenType family name. Match the exact name
#: resolved by Matplotlib and verified in ``resources/fonts``.
FONT_FAMILY = "LM Roman 10"

_FONTS_DIR = Path(__file__).resolve().parent.parent / "fonts"


def apply_latin_modern() -> None:
    """Register the bundled Latin Modern faces and set shared export rcParams.

    Allow repeated registration of already-known faces. Apply the remaining
    rcParams when font files are absent, and let Matplotlib fall back to its
    default serif when callers later render figures.
    """
    for font in sorted(_FONTS_DIR.glob("lmroman10-*.otf")):
        font_manager.fontManager.addfont(str(font))
    matplotlib.rcParams.update(
        {
            "font.family": "serif",
            "font.serif": [FONT_FAMILY, "DejaVu Serif"],
            "mathtext.fontset": "cm",
            "savefig.dpi": 300,
            "figure.dpi": 300,
            "savefig.bbox": "tight",
        }
    )
