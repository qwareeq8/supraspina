#!/usr/bin/env bash
# Register every analyzed participant to the finished template (NJ parallel single-threaded jobs).
set -euo pipefail
source "$(dirname "$0")/common.sh"
LOG=$W/logs/register_all.log
say() { echo "$(date -Is) $*" >> "$LOG"; }
[ -e "$W/template/TEMPLATE_DONE" ] || { echo "The template is not finished (10_template.sh)." >&2; exit 1; }
mapfile -t ids < <(participant_ids)
t0=$(date +%s); say "start; participants: ${#ids[@]}"
printf '%s\n' "${ids[@]}" | xargs -P "$NJ" -I{} bash "$HERE/12_final_one.sh" {} || say "some registrations failed"
n=0; for s in "${ids[@]}"; do [ -e "$W/reg/${s}_ok" ] && n=$((n + 1)); done
say "done n_ok=$n sec=$(( $(date +%s) - t0 ))"
[ "$n" -eq "${#ids[@]}" ] || { echo "Only $n of ${#ids[@]} registrations finished." >&2; exit 1; }
