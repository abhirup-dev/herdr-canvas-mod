---
name: herdr-canvas-mod
description: "Use inside the Herdr desktop app to show the user a diagram beside the agent, either pinned as Mermaid (the pane's Diagrams badge and popup) or drawn on a live Excalidraw canvas the user can edit too. Use when the user asks to pin, replace or remove a diagram, mentions the diagram badge or popup, asks to draw, lay out or edit a diagram together, or asks to see the canvas; also when another skill produced a chart.mmd worth keeping visible. Works the same when the agent runs on another machine the app reaches. One CLI: `herdr-draw`."
---

# herdr-canvas-mod

Choose a route through the `herdr-draw` CLI:

| The user wants | Use | Read first |
|---|---|---|
| A diagram kept visible, read-only (an architecture, a flow, a state machine) | `herdr-draw mermaid`: pins show in the pane's Diagrams badge and popup | [references/mermaid.md](references/mermaid.md) |
| Generate or revise an editable flowchart, sequence diagram, Gantt, or Sankey quickly | Named Mermaid blocks with `canvas block get/put` | [Structured diagrams and mixed edits](references/visual-formats-structured.md) |
| Draw a custom scene, make a precise element edit, or open the canvas | Native `canvas` element commands | [Live canvas](references/canvas.md) |

Use the editable canvas by default when showing a diagram in Herdr. Use a pin when the user asks for
the Diagrams badge, the popup, or a read-only view.

Keep pins few, so the Diagrams popup doesn't become a dump: pin what the user asked for, or only the
most important, load-bearing diagrams. Diagrams that are just part of a chat answer stay in chat.

For diagrams you show:

- **Keep the canvas tall.** Its pane is tall and narrow: lay out top to bottom, a few nodes per row,
  wrap long chains; go wide only when asked. For pins, follow the checker (it knows the popup's size).
- **Look at what you made before you say you're done.** `mermaid add`/`replace` print a `preview:` PNG
  path; `canvas screenshot` prints JSON with the PNG as `file`. Open it and fix cut-off text, crossing
  labels and cramped layouts.
- `herdr-draw mermaid help` and `herdr-draw canvas help [command]` list every command and flag. Never
  pass `--terminal`; your terminal's `$HC_TERMINAL_ID` picks your pins and your board.
- If a pin or the canvas doesn't show up, check `herdr-draw logs` before guessing.
