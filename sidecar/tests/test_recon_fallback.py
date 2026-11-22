"""Tests for the recon-all output reading behind the known-failure reruns."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from supraspina_sidecar import recon_fallback
from supraspina_sidecar.provenance import make_receipt
from supraspina_sidecar.recon_fallback import (
    KNOWN_FAILURES,
    NO_FIX_GA_FLAG,
    NO_FIX_WITH_GA_FLAG,
    Rerun,
    crashed_in_genetic_topology_fix,
    failure_cause,
    fallback_log_line,
    fallback_record,
    is_freesurfer_recon,
    known_failure,
    mark_recon_log,
    needs_no_fix_ga,
    read_recon_log_since,
    recon_log_path,
    rerun_argv,
)
from supraspina_sidecar.run_store import (
    EXECUTION_FALLBACK_KEY,
    RECEIPT_PAYLOAD_KEYS,
    execution_fallback_valid,
    receipt_record_contract_valid,
    receipt_record_digest,
)

#: A recon-all tail in which label-cortex finds no gyrus ambiens voxels
#: (FreeSurfer 8.2.0).
GYRUS_AMBIENS_FAILURE = """\
#--------------------------------------------
#@# Cortex Label lh Thu Jan  1 22:15:30 UTC 2026
cd /derivatives/freesurfer/sub-101/scripts
label-cortex --s sub-101 --lh --fix-ga
Found 0 label voxels
ERROR: found no voxels matching id 1
If the error is: found no voxels matching id 1, try rerunning with -no-fix-ga
Linux lab-host 6.8.0 #1 SMP x86_64 GNU/Linux

recon-all -s sub-101 exited with ERRORS at Thu Jan  1 22:15:33 UTC 2026

For more details, see the log file /derivatives/freesurfer/sub-101/scripts/recon-all.log
To report a problem, see http://surfer.nmr.mgh.harvard.edu/fswiki/BugReporting
"""

#: A recon-all tail in which the genetic topology fixer crashes in the lh
#: hemisphere (FreeSurfer 8.2.0).
TOPOLOGY_CRASH = """\
#--------------------------------------------
#@# Fix Topology lh Thu Jan  1 23:12:05 UTC 2026
cd /derivatives/freesurfer/sub-102/scripts
 mris_fix_topology -threads 1 -mgz -sphere qsphere.nofix -inflated inflated.nofix \
-orig orig.nofix -out orig.premesh -ga -seed 1234 sub-102 lh
#--------------------------------------------
#@# Fix Topology rh Thu Jan  1 23:12:05 UTC 2026
cd /derivatives/freesurfer/sub-102/scripts
 mris_fix_topology -threads 1 -mgz -sphere qsphere.nofix -inflated inflated.nofix \
-orig orig.nofix -out orig.premesh -ga -seed 1234 sub-102 rh
Waiting for PID 3239019 of (3239019 3239022) to complete...
*** stack smashing detected ***: terminated
/usr/local/freesurfer/8.2.0/bin/reconbatchjobs: line 77: 3239019 Aborted \
                (core dumped) exec $JOB >> $LOG 2>&1
Waiting for PID 3239022 of (3239019 3239022) to complete...
@#@FSTIME  2026:01:01:23:28:20 mris_fix_topology N 12 e 984.0
Linux lab-host 6.8.0 #1 SMP x86_64 GNU/Linux

recon-all -s sub-102 exited with ERRORS at Thu Jan  1 23:28:30 UTC 2026
"""

_GA_FIX = (
    " mris_fix_topology -threads 1 -mgz -sphere qsphere.nofix -inflated "
    "inflated.nofix -orig orig.nofix -out orig.premesh -ga -seed 1234 -threads 1 "
    "sub-102 {hemi}"
)


def _fix_log(hemi: str, *, crashed: bool) -> list[str]:
    # One hemisphere's job log as reconbatchjobs appends it: a blank line, the
    # command, a blank line, then mris_fix_topology's own output.
    lines = [
        "",
        _GA_FIX.format(hemi=hemi),
        "",
        "Setting OMP_NUM_THREADS=1",
        "reading spherical homeomorphism from 'qsphere.nofix'",
        "using genetic algorithm with optimized parameters",
        "setting seed for random number genererator to 1234",
        "INFO: assuming .mgz format",
        "before topology correction, eno=-114 (nv=147962, nf=296152, ne=444228, g=58)",
        "using quasi-homeomorphic spherical map to tessellate cortical surface...",
        "CORRECTING DEFECT 0 (vertices=31, convex hull=59, v0=1405)",
    ]
    if crashed:
        return [*lines, "*** stack smashing detected ***: terminated"]
    return [
        *lines,
        "terminating search with 238 intersecting",
        "topology fixing took 7.7 minutes",
        f"FSRUNTIME@ mris_fix_topology {hemi}  0.1288 hours 1 threads",
        "#VMPC# mris_fix_topology VmPeak  743436",
    ]


def _parallel_topology_crash(crashed: str) -> str:
    """Return recon-all.log for a -parallel Fix Topology with one crashed hemi.

    The layout follows FreeSurfer 8.2.0's recon-all and reconbatchjobs: both
    commands echoed, the waits with the aborted job's status between them, then
    each job's log appended in hemisphere order.
    """
    status = (
        "/usr/local/freesurfer/8.2.0/bin/reconbatchjobs: line 77: {pid} Aborted"
        "                 (core dumped) exec $JOB >> $LOG 2>&1"
    )
    lines = [
        "#--------------------------------------------",
        "#@# Fix Topology lh Thu Jan  1 23:12:05 UTC 2026",
        "",
        _GA_FIX.format(hemi="lh"),
        "",
        "#--------------------------------------------",
        "#@# Fix Topology rh Thu Jan  1 23:12:05 UTC 2026",
        "",
        _GA_FIX.format(hemi="rh"),
        "",
        "Waiting for PID 3239019 of (3239019 3239022) to complete...",
    ]
    if crashed == "lh":
        lines.append(status.format(pid=3239019))
    lines.append("Waiting for PID 3239022 of (3239019 3239022) to complete...")
    if crashed == "rh":
        lines.append(status.format(pid=3239022))
    lines += _fix_log("lh", crashed=crashed == "lh")
    lines += _fix_log("rh", crashed=crashed == "rh")
    lines += [
        "PIDs (3239019 3239022) completed and logs appended.",
        "Linux lab-host 6.8.0 #1 SMP x86_64 GNU/Linux",
        "",
        "recon-all -s sub-102 exited with ERRORS at Thu Jan  1 23:28:30 UTC 2026",
    ]
    return "\n".join(lines) + "\n"


#: A serial genetic fix that finished, then a later tool in the same step that
#: crashed, which must not rerun with -no-fix-with-ga.
LATER_TOOL_CRASH = """\
#@# Fix Topology lh Thu Jan  1 23:12:05 UTC 2026
 mris_fix_topology -threads 1 -mgz -ga -seed 1234 sub-01 lh
@#@FSTIME  2026:01:01:23:17:05 mris_fix_topology N 14 e 300.0
 mris_euler_number ../surf/lh.orig.premesh
Segmentation fault (core dumped)
recon-all -s sub-01 exited with ERRORS at Thu Jan  1 23:17:10 UTC 2026
"""

RECON_ARGV = [
    "recon-all",
    "-subject",
    "sub-101",
    "-sd",
    "/derivatives/freesurfer",
    "-all",
    "-parallel",
    "-openmp",
    "6",
]


def test_the_observed_label_cortex_failure_asks_for_no_fix_ga() -> None:
    assert needs_no_fix_ga(GYRUS_AMBIENS_FAILURE)


def test_the_error_with_only_the_label_cortex_step_asks_for_no_fix_ga() -> None:
    output = (
        "label-cortex --s sub-01 --rh --fix-ga\nERROR: found no voxels matching id 1\n"
    )
    assert needs_no_fix_ga(output)


@pytest.mark.parametrize(
    "output",
    [
        # FreeSurfer's hint is a condition on the error, not the error itself.
        "ERROR: mri_label2label failed\n"
        "If the error is: found no voxels matching id 1, try rerunning with "
        "-no-fix-ga\n",
        # Another label id is a different failure.
        "label-cortex --s sub-01 --lh --fix-ga\n"
        "ERROR: found no voxels matching id 10\n",
        # The error alone, with neither the step nor the hint.
        "ERROR: found no voxels matching id 1\n",
        # Other recon-all failures.
        "mris_fix_topology: topology correction failed\n"
        "recon-all -s sub-01 exited with ERRORS at Wed Sep 16 17:33:49 EDT 2026\n",
        "Command terminated by signal 9\n"
        "@#@FSTIME  2026:09:16:17:33:03 mri_synthseg N 11 e 45.97 S 62.05\n",
        "ERROR: it appears that recon-all is already running\n",
        "ERROR: FreeSurfer license file /opt/freesurfer/license.txt not found.\n",
        "",
    ],
)
def test_other_failures_do_not_ask_for_no_fix_ga(output: str) -> None:
    assert not needs_no_fix_ga(output)


def test_the_observed_topology_crash_asks_for_no_fix_with_ga() -> None:
    assert crashed_in_genetic_topology_fix(TOPOLOGY_CRASH)
    assert not needs_no_fix_ga(TOPOLOGY_CRASH)
    failure = known_failure(TOPOLOGY_CRASH)
    assert failure is not None
    assert failure.flag == NO_FIX_WITH_GA_FLAG


def test_the_log_only_topology_crash_asks_for_no_fix_with_ga() -> None:
    # The job's own log, appended after reconbatchjobs reports the abort,
    # carries glibc's report without the job status.
    log = (
        "#@# Fix Topology lh Thu Jan  1 23:12:05 UTC 2026\n"
        "mris_fix_topology -threads 1 -mgz -sphere qsphere.nofix -inflated "
        "inflated.nofix -orig orig.nofix -out orig.premesh -ga -seed 1234 "
        "sub-103 lh\n"
        "before topology correction, eno=-114 (nv=147962, nf=296152, ne=444228, "
        "g=58)\n"
        "*** stack smashing detected ***: terminated\n"
    )
    assert crashed_in_genetic_topology_fix(log)
    # A segmentation fault in the same place is the same failure.
    segfault = log.replace(
        "*** stack smashing detected ***: terminated",
        "/usr/local/freesurfer/8.2.0/bin/reconbatchjobs: line 77: 3 Segmentation "
        "fault (core dumped) exec $JOB >> $LOG 2>&1",
    )
    assert crashed_in_genetic_topology_fix(segfault)


@pytest.mark.parametrize("crashed", ["lh", "rh"])
def test_the_parallel_topology_crash_asks_for_no_fix_with_ga(crashed: str) -> None:
    log = _parallel_topology_crash(crashed)
    assert crashed_in_genetic_topology_fix(log)
    failure = known_failure(log)
    assert failure is not None
    assert failure.flag == NO_FIX_WITH_GA_FLAG
    assert failure_cause(log) == (
        "mris_fix_topology failed: stack smashing detected (Aborted, core dumped)"
    )


def test_a_crash_after_the_genetic_fix_finished_is_not_a_topology_crash() -> None:
    assert not crashed_in_genetic_topology_fix(LATER_TOOL_CRASH)
    assert known_failure(LATER_TOOL_CRASH) is None
    assert failure_cause(LATER_TOOL_CRASH) == (
        "mris_euler_number failed: Segmentation fault (core dumped)"
    )
    # The same in a -parallel run: both fixes finished, then the Euler check.
    finished = _parallel_topology_crash("none").replace(
        "PIDs (3239019 3239022) completed and logs appended.\n",
        "PIDs (3239019 3239022) completed and logs appended.\n"
        " mris_euler_number ../surf/lh.orig.premesh\n"
        "Segmentation fault (core dumped)\n",
    )
    assert not crashed_in_genetic_topology_fix(finished)
    # A bare abort with no command after the finished fixes is not one either.
    assert not crashed_in_genetic_topology_fix(
        _parallel_topology_crash("none") + "Aborted (core dumped)\n"
    )


@pytest.mark.parametrize(
    "output",
    [
        # The non-genetic fixer crashing: -no-fix-with-ga would not change it.
        TOPOLOGY_CRASH.replace(" -ga -seed", " -seed"),
        # A crash in another step.
        "#@# CA Reg Thu Jan  1 21:12:05 UTC 2026\n"
        "mri_ca_register -nobigventricles -T transforms/talairach.lta\n"
        "*** stack smashing detected ***: terminated\n"
        "Aborted (core dumped)\n",
        # A crash after the topology fix finished, in a later step.
        TOPOLOGY_CRASH.replace(
            "Waiting for PID 3239019",
            "#@# Make White Surf lh Thu Jan  1 23:20:00 UTC 2026\n"
            "mris_place_surface --adgws-in ../surf/autodet.gw.stats.lh.dat\n"
            "Waiting for PID 3239019",
        ),
        # Killed is usually the kernel's out-of-memory handling.
        "#@# Fix Topology lh Thu Jan  1 23:12:05 UTC 2026\n"
        "mris_fix_topology -threads 1 -mgz -ga -seed 1234 sub-01 lh\n"
        "reconbatchjobs: line 77: 3239019 Killed exec $JOB >> $LOG 2>&1\n",
        # An ERROR line after the crash names another failure.
        TOPOLOGY_CRASH + "ERROR: could not open file orig.premesh\n",
        # The topology step and command without any crash.
        "#@# Fix Topology lh Thu Jan  1 23:12:05 UTC 2026\n"
        "mris_fix_topology -threads 1 -mgz -ga -seed 1234 sub-01 lh\n"
        "recon-all -s sub-01 exited with ERRORS at Thu Jan  1 23:28:30 UTC 2026\n",
        # A crash with no step header or no topology command.
        "*** stack smashing detected ***: terminated\nAborted (core dumped)\n",
        "#@# Fix Topology lh Thu Jan  1 23:12:05 UTC 2026\nAborted (core dumped)\n",
        # Prose that opens with a signal word is not a crash.
        "#@# Fix Topology lh Thu Jan  1 23:12:05 UTC 2026\n"
        "mris_fix_topology -threads 1 -mgz -ga -seed 1234 sub-01 lh\n"
        "Aborted by user request\n",
        "#@# Fix Topology lh Thu Jan  1 23:12:05 UTC 2026\n"
        "mris_fix_topology -threads 1 -mgz -ga -seed 1234 sub-01 lh\n"
        "Segmentation fault handler installed\n",
        GYRUS_AMBIENS_FAILURE,
        "",
    ],
)
def test_other_failures_do_not_ask_for_no_fix_with_ga(output: str) -> None:
    assert not crashed_in_genetic_topology_fix(output)


def test_each_known_failure_has_its_own_flag_and_kind() -> None:
    flags = [failure.flag for failure in KNOWN_FAILURES]
    kinds = [failure.kind for failure in KNOWN_FAILURES]
    assert flags == [NO_FIX_GA_FLAG, NO_FIX_WITH_GA_FLAG]
    assert len(set(kinds)) == len(kinds)


def test_a_failure_whose_flag_is_applied_is_not_known_again() -> None:
    assert known_failure(GYRUS_AMBIENS_FAILURE) is KNOWN_FAILURES[0]
    assert known_failure(GYRUS_AMBIENS_FAILURE, [NO_FIX_GA_FLAG]) is None
    assert known_failure(TOPOLOGY_CRASH, [NO_FIX_GA_FLAG]) is KNOWN_FAILURES[1]
    assert known_failure(TOPOLOGY_CRASH, [NO_FIX_WITH_GA_FLAG]) is None
    assert known_failure("recon-all -s sub-01 exited with ERRORS\n") is None


def test_the_rerun_appends_each_flag_once_and_only_to_recon_all() -> None:
    assert rerun_argv(RECON_ARGV, [NO_FIX_GA_FLAG]) == [*RECON_ARGV, NO_FIX_GA_FLAG]
    assert rerun_argv(RECON_ARGV, [NO_FIX_GA_FLAG, NO_FIX_WITH_GA_FLAG]) == [
        *RECON_ARGV,
        NO_FIX_GA_FLAG,
        NO_FIX_WITH_GA_FLAG,
    ]
    assert rerun_argv([*RECON_ARGV, NO_FIX_GA_FLAG], [NO_FIX_GA_FLAG]) is None
    assert rerun_argv([*RECON_ARGV, NO_FIX_WITH_GA_FLAG], [NO_FIX_WITH_GA_FLAG]) is None
    assert rerun_argv(RECON_ARGV, [NO_FIX_GA_FLAG, NO_FIX_GA_FLAG]) is None
    assert rerun_argv(RECON_ARGV, []) is None
    assert rerun_argv(["apptainer", "exec", "fastsurfer.sif"], [NO_FIX_GA_FLAG]) is None
    assert rerun_argv([], [NO_FIX_GA_FLAG]) is None
    assert is_freesurfer_recon(["/opt/freesurfer/bin/recon-all", "-s", "x"])


def test_the_recon_log_path_follows_the_subject_and_subjects_dir() -> None:
    assert recon_log_path(RECON_ARGV) == os.path.join(
        "/derivatives/freesurfer", "sub-101", "scripts", "recon-all.log"
    )
    assert recon_log_path(["recon-all", "-subject", "sub-01"]) is None
    assert mark_recon_log(["recon-all", "-sd", "/x"]) is None
    assert read_recon_log_since(None) == ""


def test_the_log_read_covers_only_what_the_attempt_appended(tmp_path: Path) -> None:
    argv = ["recon-all", "-s", "sub-01", "-sd", str(tmp_path)]
    log = tmp_path / "sub-01" / "scripts" / "recon-all.log"
    missing = mark_recon_log(argv)
    assert missing is not None
    assert missing.inode is None
    assert read_recon_log_since(missing) == ""

    log.parent.mkdir(parents=True)
    log.write_text("earlier: ERROR: found no voxels matching id 1\n", encoding="utf-8")
    mark = mark_recon_log(argv)
    with log.open("a", encoding="utf-8") as handle:
        handle.write("this attempt\n")
    assert read_recon_log_since(mark) == "this attempt\n"

    # A log recon-all replaced, or one that shrank, is read whole.
    log.write_text("new log\n", encoding="utf-8")
    assert read_recon_log_since(mark) == "new log\n"
    assert read_recon_log_since(missing) == "new log\n"


def test_the_log_read_is_bounded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(recon_fallback, "_LOG_TAIL_BYTES", 8)
    argv = ["recon-all", "-s", "sub-01", "-sd", str(tmp_path)]
    log = tmp_path / "sub-01" / "scripts" / "recon-all.log"
    log.parent.mkdir(parents=True)
    mark = mark_recon_log(argv)
    log.write_text("0123456789abcdef", encoding="utf-8")
    assert read_recon_log_since(mark) == "89abcdef"


def test_the_cause_names_the_failing_tool_and_its_error() -> None:
    assert failure_cause(GYRUS_AMBIENS_FAILURE) == (
        "label-cortex failed: found no voxels matching id 1"
    )


def test_the_cause_prefers_the_tool_fs_time_reports() -> None:
    output = (
        "mri_ca_register -nobigventricles -T transforms/talairach.lta\n"
        "ERROR: could not open file norm.mgz.\n"
        "@#@FSTIME  2026:01:01:22:15:33 mri_ca_label N 9 e 1.0 S 0.1\n"
    )
    assert failure_cause(output) == "mri_ca_label failed: could not open file norm.mgz"


def test_the_cause_falls_back_to_the_step_or_recon_all() -> None:
    header = "#@# Cortex Label lh Thu Jan  1 22:15:30 UTC 2026\nERROR: no voxels\n"
    assert failure_cause(header) == "Cortex Label lh failed: no voxels"
    assert failure_cause("ERROR: bad input\n") == "recon-all failed: bad input"
    # recon-all itself is not the failing tool it names.
    assert (
        failure_cause("recon-all -s sub-01 -sd /x\nERROR: bad input\n")
        == "recon-all failed: bad input"
    )


def test_a_long_cause_is_bounded() -> None:
    cause = failure_cause("ERROR: " + "x" * 2000 + "\n")
    assert cause is not None
    assert len(cause) == 512
    assert cause.endswith("...")


def test_a_crashed_tool_states_its_signal() -> None:
    # FreeSurfer 8.2.0 with parallel hemispheres: the lh topology fix
    # aborts, and no ERROR line follows.
    output = (
        "#@# Fix Topology lh Thu Jan  1 23:12:05 UTC 2026\n"
        " mris_fix_topology -threads 1 -mgz -sphere qsphere.nofix -ga -seed 1234"
        " sub-01 lh\n"
        "#@# Fix Topology rh Thu Jan  1 23:12:05 UTC 2026\n"
        " mris_fix_topology -threads 1 -mgz -sphere qsphere.nofix -ga -seed 1234"
        " sub-01 rh\n"
        "Waiting for PID 3239019 of (3239019 3239022) to complete...\n"
        "/usr/local/freesurfer/8.2.0/bin/reconbatchjobs: line 77: 3239019 Aborted"
        "                 (core dumped) exec $JOB >> $LOG 2>&1\n"
        "Waiting for PID 3239022 of (3239019 3239022) to complete...\n"
        "@#@FSTIME  2026:01:01:23:28:20 mris_fix_topology N 12 e 984.0\n"
        "recon-all -s sub-01 exited with ERRORS at Thu Jan  1 23:28:30 UTC 2026\n"
    )
    assert failure_cause(output) == "mris_fix_topology failed: Aborted (core dumped)"
    # glibc's report, before or after the job status, states what aborted.
    assert failure_cause(TOPOLOGY_CRASH) == (
        "mris_fix_topology failed: stack smashing detected (Aborted, core dumped)"
    )
    status_first = (
        " mris_fix_topology -threads 1 -ga -seed 1234 sub-01 lh\n"
        "reconbatchjobs: line 77: 3239019 Aborted (core dumped) exec $JOB\n"
        "*** stack smashing detected ***: terminated\n"
    )
    assert failure_cause(status_first) == (
        "mris_fix_topology failed: stack smashing detected (Aborted, core dumped)"
    )
    assert failure_cause(
        "mris_fix_topology -ga sub-01 lh\n*** stack smashing detected ***: terminated\n"
    ) == ("mris_fix_topology failed: stack smashing detected")
    assert failure_cause("*** buffer overflow detected ***: terminated\nAborted\n") == (
        "recon-all failed: buffer overflow detected (Aborted)"
    )
    assert failure_cause("Killed\n") == "recon-all failed: Killed"
    # A bare status ends its line; trailing spaces do not change it.
    assert failure_cause("Segmentation fault (core dumped)  \n") == (
        "recon-all failed: Segmentation fault (core dumped)"
    )
    # The shell's job status may name the job after the status.
    assert failure_cause(
        "mri_ca_register -T a.lta\nrecon.sh: line 9: 42 Bus error exec $JOB\n"
    ) == ("mri_ca_register failed: Bus error")
    # An ERROR line wins over a crash line.
    assert failure_cause("Segmentation fault\nERROR: bad input\n") == (
        "recon-all failed: bad input"
    )


@pytest.mark.parametrize(
    "output",
    [
        "Process Killed by the user is prose, not a job status\n",
        "Aborted by user request\n",
        "Killed processes are listed below\n",
        "recon-all -s sub-01 exited with ERRORS at Wed Sep 16 17:33:49 EDT 2026\n",
        "mri_convert: unknown input format\n",
        "error: lowercase prose is not an ERROR line\n",
        "ERROR:  .\n",
        "",
    ],
)
def test_output_without_an_error_line_states_no_cause(output: str) -> None:
    assert failure_cause(output) is None


NO_FIX_GA, NO_FIX_WITH_GA = KNOWN_FAILURES


def _single(exit_code: int = 1) -> dict[str, object]:
    return fallback_record([Rerun(NO_FIX_GA, exit_code)])


def _composed() -> dict[str, object]:
    return fallback_record([Rerun(NO_FIX_GA, 1), Rerun(NO_FIX_WITH_GA, 134)])


def test_the_log_line_and_record_state_the_rerun() -> None:
    assert fallback_log_line("sub-101", [Rerun(NO_FIX_GA, 1)]) == (
        "recon-all for sub-101 found no gyrus ambiens voxels; the "
        "reconstruction reruns with -no-fix-ga."
    )
    assert fallback_log_line("sub-102", [Rerun(NO_FIX_WITH_GA, 1)]) == (
        "recon-all for sub-102 stopped in the surface topology fix "
        "(mris_fix_topology crashed); the reconstruction reruns with "
        "-no-fix-with-ga."
    )
    # The record keeps the shape the first fallback recorded.
    record = _single()
    assert record == {
        "kind": "freesurfer-no-fix-ga",
        "addedArguments": ["-no-fix-ga"],
        "reason": (
            "label-cortex found no voxels matching id 1 while filling the gyrus "
            "ambiens (--fix-ga), so recon-all reran with -no-fix-ga, as "
            "FreeSurfer advises."
        ),
        "firstAttemptExitCode": 1,
    }
    assert execution_fallback_valid(record)
    topology = fallback_record([Rerun(NO_FIX_WITH_GA, 1)])
    assert execution_fallback_valid(topology)
    assert topology["kind"] == "freesurfer-no-fix-with-ga"
    assert topology["addedArguments"] == ["-no-fix-with-ga"]
    with pytest.raises(ValueError, match="at least one rerun"):
        fallback_record([])


def test_composed_reruns_record_every_argument_and_reason_in_order() -> None:
    assert fallback_log_line(
        "sub-103", [Rerun(NO_FIX_GA, 1), Rerun(NO_FIX_WITH_GA, 134)]
    ) == (
        "recon-all for sub-103 stopped in the surface topology fix "
        "(mris_fix_topology crashed); the reconstruction reruns with "
        "-no-fix-ga and -no-fix-with-ga."
    )
    record = _composed()
    assert execution_fallback_valid(record)
    assert record["kind"] == "freesurfer-no-fix-ga+freesurfer-no-fix-with-ga"
    assert record["addedArguments"] == ["-no-fix-ga", "-no-fix-with-ga"]
    assert record["reason"] == f"{NO_FIX_GA.reason} {NO_FIX_WITH_GA.reason}"
    assert record["firstAttemptExitCode"] == 1
    assert record["reruns"] == [
        {
            "kind": NO_FIX_GA.kind,
            "addedArguments": ["-no-fix-ga"],
            "reason": NO_FIX_GA.reason,
            "attemptExitCode": 1,
        },
        {
            "kind": NO_FIX_WITH_GA.kind,
            "addedArguments": ["-no-fix-with-ga"],
            "reason": NO_FIX_WITH_GA.reason,
            "attemptExitCode": 134,
        },
    ]
    reverse = fallback_record([Rerun(NO_FIX_WITH_GA, 1), Rerun(NO_FIX_GA, 1)])
    assert execution_fallback_valid(reverse)
    assert reverse["addedArguments"] == ["-no-fix-with-ga", "-no-fix-ga"]


def _synthetic_payload(step_key: str) -> dict[str, object]:
    payload: dict[str, object] = {key: f"value-{key}" for key in RECEIPT_PAYLOAD_KEYS}
    payload["stepKey"] = step_key
    if step_key == "recon":
        payload["reconstruction"] = {"backend": "freesurfer"}
        payload["reconstructionSignature"] = "a" * 64
    return payload


def _synthetic_receipt(
    step_key: str, execution_fallback: dict[str, object] | None = None
) -> dict[str, object]:
    return make_receipt(
        "b" * 64,
        _synthetic_payload(step_key),
        {"state": "done", "artifacts": []},
        run_id="run-1",
        job_id="#job",
        committed_at_ms=7,
        execution_fallback=execution_fallback,
    )


def test_receipts_without_a_fallback_keep_their_record_digest() -> None:
    # A receipt with no fallback must keep its exact record and digest.
    recon = _synthetic_receipt("recon")
    aggregate = _synthetic_receipt("aggregate")

    assert EXECUTION_FALLBACK_KEY not in recon
    assert recon["recordSha256"] == (
        "adf0abaa7824c3ce431ce5992f19066d4b7a4fdfb4e760430c7c3858e11aa305"
    )
    assert aggregate["recordSha256"] == (
        "f437df1e444ea567c73d1ad3e31eaa3964a54f4f0718be93b3cf35d4be681a3d"
    )
    assert receipt_record_contract_valid(recon)
    assert receipt_record_contract_valid(aggregate)


def test_a_fallback_receipt_binds_the_record_but_not_the_signature() -> None:
    plain = _synthetic_receipt("recon")
    fell_back = _synthetic_receipt("recon", _single())

    assert fell_back["signature"] == plain["signature"]
    assert fell_back[EXECUTION_FALLBACK_KEY] == _single()
    assert fell_back["recordSha256"] != plain["recordSha256"]
    assert receipt_record_contract_valid(fell_back)

    tampered = dict(fell_back)
    tampered[EXECUTION_FALLBACK_KEY] = {**_single(), "reason": "edited"}
    assert not receipt_record_contract_valid(tampered)

    stripped = dict(fell_back)
    stripped.pop(EXECUTION_FALLBACK_KEY)
    assert not receipt_record_contract_valid(stripped)


def _rerun_edit(index: int, **fields: object) -> dict[str, object]:
    record = _composed()
    reruns = [dict(entry) for entry in record["reruns"]]  # type: ignore[union-attr]
    reruns[index].update(fields)
    return {**record, "reruns": reruns}


def test_a_composed_fallback_receipt_is_valid_and_binds_every_rerun() -> None:
    receipt = _synthetic_receipt("recon", _composed())
    assert receipt_record_contract_valid(receipt)
    assert receipt["signature"] == _synthetic_receipt("recon")["signature"]


@pytest.mark.parametrize(
    "value",
    [
        None,
        {},
        # Composed records: the summary must restate the reruns in order.
        {**_single(), "reruns": []},
        {**_composed(), "reruns": _composed()["reruns"][:1]},  # type: ignore[index]
        {**_composed(), "reruns": "two"},
        {**_composed(), "addedArguments": ["-no-fix-with-ga", "-no-fix-ga"]},
        {**_composed(), "kind": "freesurfer-no-fix-ga"},
        {**_composed(), "reason": NO_FIX_GA.reason},
        {**_composed(), "firstAttemptExitCode": 134},
        {
            key: value
            for key, value in _composed().items()
            if key != "firstAttemptExitCode"
        },
        _rerun_edit(1, addedArguments=["-no-fix-with-ga", "-no-fix-ga"]),
        _rerun_edit(1, attemptExitCode=True),
        _rerun_edit(1, extra=True),
        _rerun_edit(0, reason=""),
        _rerun_edit(1, kind=""),
        {
            **fallback_record([Rerun(NO_FIX_GA, 1), Rerun(NO_FIX_GA, 1)]),
        },
        {**_single(), "extra": True},
        {**_single(), "kind": ""},
        {**_single(), "addedArguments": []},
        {**_single(), "addedArguments": [""]},
        {**_single(), "reason": ""},
        {**_single(), "firstAttemptExitCode": True},
        {**_single(), "firstAttemptExitCode": "1"},
    ],
)
def test_a_malformed_fallback_record_is_rejected(value: object) -> None:
    receipt = _synthetic_receipt("recon")
    receipt[EXECUTION_FALLBACK_KEY] = value
    receipt["recordSha256"] = receipt_record_digest(receipt)
    assert not receipt_record_contract_valid(receipt)


def test_only_a_reconstruction_receipt_may_record_a_fallback() -> None:
    receipt = _synthetic_receipt("aggregate", _single())
    assert not receipt_record_contract_valid(receipt)
