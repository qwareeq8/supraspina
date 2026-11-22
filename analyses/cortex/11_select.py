"""Apply the prespecified, group-blind registration rule to every hemisphere of the analyzed sample.

b40infl passes -> b40infl; else b40 passes -> b40; else unresolved (missing unless the visual review keeps it).
Writes selection.tsv, joblist_b40.txt (hemispheres failing b40infl without a b40 result yet), and
joblist_default.txt (hemispheres the review keeps with the recon's own registration, which need Brainnetome labels
on sphere.reg). Prints counts only.
"""

import pandas as pd

import cortex_common as cc

# The itertuples call renames the keyword column "pass".
a = pd.read_csv(cc.WORK / "screen_b40infl.tsv", sep="\t").rename(columns={"pass": "passed"})
a = a[a.participant_id.isin(cc.sample_ids())]
assert len(a) == 2 * len(cc.sample_ids()), "Hemispheres without a b40infl screen."
fb_path = cc.WORK / "screen_b40.tsv"
fb = pd.read_csv(fb_path, sep="\t").set_index(["participant_id", "hemi"]) if fb_path.exists() else None
rows, todo = [], []
for r in a.itertuples():
    sel, why = None, ""
    if r.passed:
        sel = "b40infl"
    else:
        why = ";".join(k for k, ok in (("A1", r.A1_fit), ("A2", r.A2_geometry), ("C", r.C_regional)) if not ok)
        if fb is not None and (r.participant_id, r.hemi) in fb.index:
            f = fb.loc[(r.participant_id, r.hemi)]
            if bool(f["pass"]):
                sel = "b40"
            else:
                sel = "unresolved"
                why += " | b40 fails " + ";".join(k for k in ("A1_fit", "A2_geometry", "C_regional") if not bool(f[k]))
        else:
            todo.append(f"{r.participant_id} {r.hemi}")
    rows.append({"participant_id": r.participant_id, "hemi": r.hemi, "selected": sel, "b40infl_fail": why})
sel = pd.DataFrame(rows)
sel.to_csv(cc.WORK / "selection.tsv", sep="\t", index=False)
(cc.WORK / "joblist_b40.txt").write_text("".join(t + "\n" for t in todo))
adj = cc.adjudication()
dflt = adj[(adj.decision == "keep") & (adj.registration == "default")]
(cc.WORK / "joblist_default.txt").write_text("".join(f"{s} {h}\n" for s, h in zip(dflt.participant_id, dflt.hemi)))
print(sel.selected.value_counts(dropna=False).to_string())
print(f"Pending b40 fallback jobs: {len(todo)}; default-registration jobs from the review: {len(dflt)}.")
