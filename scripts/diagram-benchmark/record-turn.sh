#!/usr/bin/env bash
# Call once when sending an agent a stage or a grader repair prompt.
set -euo pipefail
run=$1
case "$2" in build|revision|repair) ;; *) echo 'Expected build, revision, or repair' >&2; exit 2 ;; esac
jq -nc --arg stage "$2" --argjson at "$(python3 -c 'import time; print(time.time())')" \
  '{stage:$stage, sent_at:$at}' >>"$run/turns.jsonl"
