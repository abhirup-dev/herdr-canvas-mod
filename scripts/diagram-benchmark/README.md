# Diagram API benchmark

The release case revises a flowchart, request trace, traffic Sankey, and Gantt schedule on one board.
The architecture case revises four connected layers, including a migration across block boundaries.
Each has a build and a staged revision. Agents may generate JSON with scripts on either version.
For a source-backed arm, require the candidate agent to keep each of the four panels or layers as
a named Mermaid block. Allow native elements for notes, visual polish, and links across blocks.
An unrestricted candidate arm can show which interface agents choose on their own.

## Run

1. Prepare separate runtime snapshots for the baseline and candidate, each with its locked dependencies.
   Keep both fixed during the test. Run `setup-arm.sh <output-dir> <runtime-repo> <zmx-session>` for each.
   To isolate a skill change, pass the variant skill reference as the fourth argument and use the same
   runtime and imported board for both agents.
2. Give matched agents the same `cases/<case>/stage-1.txt`, the provided `canvas-api.md`, and only
   their own arm directory. They should use `./canvas` for board commands. Record each prompt with
   `record-turn.sh <output-dir> build|revision|repair`. One turn is one controller prompt that
   requires a new completion. Tool calls within a turn are recorded separately.
3. Run `python3 grade.py <case> <output-dir>/stage1.excalidraw --stage 1` and inspect the PNG.
   If a required check fails, send the errors and record one repair turn. After the first passing
   build, run `python3 checkpoint.py <case> <output-dir>` to inject the same hand edits in each board.
4. Send `cases/<case>/stage-2.txt`. Grade the final export with
   `python3 grade.py <case> <output-dir>/stage2.excalidraw --before <output-dir>/checkpoint/live-before.excalidraw`.
   Inspect the PNG for collisions, date positioning, flow proportions, and readability.
5. Collect the final exports, screenshots, counts and concrete examples of failures. Compare wall
   times and CLI calls with the same timing definition. Report the sample size and any interruptions.
   Stop the zmx sessions created for the trial. These sidecars use their own ports and data directories.

The grader verifies editable bound routes, trace order, expected chart labels, protected shape IDs,
and hand edits. It also reports retained arrow identities, required logical components (excluding the
annotation), and the actual editable elements by type and block membership. Block membership includes
generated labels and can include elements subsequently adjusted by the agent. For an offline CLI
comparison, convert each original source with `herdr-draw mermaid <file> --out <scene.excalidraw>`
and count its elements. Compare those against live block output. A standalone conversion lacks any
native elements the agent added outside the blocks.

The first-to-last CLI span includes time between CLI calls and excludes time spent before the first
or after the last call. The PNG is a headless export. It cannot establish the native Herdr paint
budget or interaction quality.
