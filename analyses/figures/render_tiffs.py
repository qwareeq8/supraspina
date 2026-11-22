"""Render Figures 1 to 6 as Brain TIFFs: RGB, LZW, 300 dpi, 185 mm (2185 px) wide, on white.

Reads the figure SVGs in config.output_dir("figures") and writes figure-<n>.tif beside them, printing
each file's size and print height. Needs cairosvg and Pillow.
"""

import io
import re
import sys
from pathlib import Path

import cairosvg
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402

NAMES = {1: "fig1_pipeline", 2: "fig2_brainstem_medulla", 3: "fig3_atlas_nuclei_tracts",
         4: "fig4_clinical_pathway", 5: "fig5_wholebrain_dbm", 6: "fig6_stratification"}
WIDTH = 2185  # 185 mm at 300 dpi.

folder = config.output_dir("figures")
for n, name in NAMES.items():
    svg = folder / f"{name}.svg"
    head = svg.read_text(encoding="utf8", errors="ignore")[:2000]
    w = re.search(r'<svg[^>]*\bwidth="([\d.]+)(\w*)"', head)
    h = re.search(r'<svg[^>]*\bheight="([\d.]+)(\w*)"', head)
    png = cairosvg.svg2png(url=str(svg), output_width=WIDTH, background_color="white")
    im = Image.open(io.BytesIO(png)).convert("RGB")
    dest = folder / f"figure-{n}.tif"
    im.save(dest, compression="tiff_lzw", dpi=(300, 300))
    chk = Image.open(dest)
    print(f"Fig. {n}: {svg.name} svg {w.groups() if w else None} x {h.groups() if h else None}; "
          f"tif {chk.size} {chk.mode} {chk.info.get('compression')} dpi {chk.info.get('dpi')}; "
          f"{chk.size[1] / 300 * 25.4:.0f} mm tall; {dest.stat().st_size / 1e6:.1f} MB")
