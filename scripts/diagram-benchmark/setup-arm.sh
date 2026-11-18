#!/usr/bin/env bash
# Usage: setup-arm.sh <output-dir> <runtime-repo> <zmx-session> [canvas-skill-reference]
set -euo pipefail
suite=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
run=$1
root=$(cd "$2" && pwd)
session=$3
reference=${4:-"$root/skills/herdr-canvas-mod/references/canvas.md"}
mkdir -p "$run"
run=$(cd "$run" && pwd)
[[ ! -e "$run/config.sh" ]]
port=$(bun -e 'const s = Bun.serve({port:0, hostname:"127.0.0.1", fetch:()=>new Response()}); console.log(s.port); s.stop();')
printf 'root=%q\nport=%q\n' "$root" "$port" >"$run/config.sh"
cp -f "$suite/canvas" "$run/canvas"
chmod +x "$run/canvas"
cp -f "$reference" "$run/canvas-api.md"
structured="$root/skills/herdr-canvas-mod/references/visual-formats-structured.md"
if [[ -f "$structured" ]]; then
  cp -f "$structured" "$run/visual-formats-structured.md"
  cp -f "$reference" "$run/canvas.md"
fi
zmx run "$session" -d /bin/bash "$suite/start.sh" "$root" "$run" "$port"
printf '%s\n' "$run"
