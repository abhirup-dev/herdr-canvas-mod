#!/bin/bash
set -euo pipefail
root=$1
run=$2
port=$3
cd "$root"
export CANVAS_SIDECAR_PORT="$port" HERDR_APP_HOME="$run/app" HERDR_DRAW_LOGS="$run/logs"
export HERDR_DRAW_BOARDS="$run/boards" HC_SOCKET="$run/no-core.sock" HC_TERMINAL_ID=release-audit
mkdir -p "$HERDR_APP_HOME"
exec bun src/sidecar/main.ts
