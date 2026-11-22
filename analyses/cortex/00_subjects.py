"""List the participants to re-register and the first job list (b40infl, both hemispheres).

Participants: the analyzed sample plus the screen reference (qc.cortical_screen_reference), whose b40infl fits set
the robust z of criterion C. Each needs a recon in freesurfer.subjects_dir. Writes subjects.txt and
joblist_b40infl.txt under <work_dir>/cortex. Prints counts only.
"""

import cortex_common as cc

subs = sorted(set(cc.sample_ids()) | set(cc.reference_ids()))
missing = [s for s in subs if not (cc.FS / s / "surf/lh.sphere").exists()]
assert not missing, f"{len(missing)} participant(s) without a FreeSurfer recon in freesurfer.subjects_dir."
(cc.WORK / "subjects.txt").write_text("".join(s + "\n" for s in subs))
(cc.WORK / "joblist_b40infl.txt").write_text("".join(f"{s} {h}\n" for s in subs for h in ("lh", "rh")))
print(f"Participants to re-register: {len(subs)} (sample {len(cc.sample_ids())}, reference {len(cc.reference_ids())}).")
