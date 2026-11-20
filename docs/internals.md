# Internals

How herdr-draw is built, where its data and logs live, and its known limits. For what it does, see the
[README](../README.md); for each part in detail, [RECIPE.md](../RECIPE.md).

## Data flow

```
agent ──herdr-draw mermaid add──▶ ~/.config/herdr-app/data/herdr-agent-diagram/<terminal>/
                              state.json + <pin>-r<rev>.svg (raw Pele SVG)
                                     │ watchFolder
          ┌──────────────────────────┴──────────────────────────┐
   mods/diagram-pane (pane header + badge)        mods/diagram-popup (viewer)
   count, glows while rev > seen                  themes the SVG (theme() colors,
   click → openOverlay(diagram-popup)             installed sans font), tabs, pages
```

State is keyed by `$HC_TERMINAL_ID` only: one diagram set per terminal.


## The popup

The header shows `◫ 1`, glowing. Click it, or `herdr-app do mod.open --name diagram-popup`
(opens for the focused pane). Each diagram is fitted to its viewport; its toolbar zooms
(− + fit 1:1), pans (← ↑ ↓ →) and maximises. Drag or scroll pans, pinch zooms,
double-click maximises. Keys: `←`/`→` pages, `↑`/`↓` or `1`-`9` tabs, `+` `-` `0` zoom/fit,
`f` maximise (arrows then pan), `Esc` restores, then closes.

Every pin also gets `<id>.png` beside `state.json` (light theme, via resvg) so an
agent can look at what it drew; `add`/`replace` print its path and a readability
warning when the fitted text would be under 70% size.

## CLI

Help is layered: `herdr-draw help` is a short overview (groups, aliases, exit codes, environment variables);
`herdr-draw <group> help` has that group's commands and flags; `herdr-draw canvas help` lists the board commands'
usages and `herdr-draw canvas help <command>` (or `<command> --help`) shows one. Usage errors (unknown command, option
or argument) exit 2.

```
herdr-draw mermaid add [--tab NAME] [--title T] [file]   bare mermaid or markdown with a ```mermaid fence; stdin if no file
herdr-draw mermaid replace <id> [--title T] [file]
herdr-draw mermaid source <id>
herdr-draw mermaid remove <id>
herdr-draw mermaid check [file | id]                     render only: Pele errors, a PNG preview, readability warnings
herdr-draw mermaid ls [--json]
herdr-draw mermaid clear
herdr-draw mermaid [convert] <file|-> --out <file|->    convert to editable .excalidraw, PNG or SVG
herdr-draw render <file|-> --out <file|->               render an Excalidraw scene without opening a board
  --terminal <addr>   override $HC_TERMINAL_ID (testing)
herdr-draw canvas open | start | status                  live Excalidraw canvas beside this terminal; status prints JSON health
herdr-draw canvas <board command>                        add, apply, update, delete, get, query, describe, screenshot,
                                                         export, import, snapshot, arrange, block, clear (herdr-draw canvas help)
herdr-draw open                                          the view for this terminal (for now: canvas open)
herdr-draw install [-y|--yes] [--agents claude,pi,codex|none] [--machines a,b | --no-machines] [--headless]
herdr-draw uninstall [-y] [--machines a,b]
herdr-draw doctor                                        exits 1 if something is missing
herdr-draw logs [component] [-n N] [--machine NAME] [--path]
herdr-draw -V | --version
herdr-draw help [group [command]]
```

Environment: `HC_TERMINAL_ID` (set by herdr-core; picks your pins and board), `HERDR_APP_HOME` (default
`~/.config/herdr-app`), `CANVAS_SIDECAR_PORT` (default 3077), `HERDR_DRAW_BUN` (the bun for the sidecar and board
commands), `HERDR_DRAW_DEBUG=0` (no debug log lines), `HERDR_DRAW_LOGS` and `HERDR_DRAW_BOARDS` (default under
`${XDG_STATE_HOME:-~/.local/state}/herdr-draw/`); for `install.sh`: `HERDR_DRAW_REPO`, `HERDR_DRAW_HOME`.

The CLI parses with [cac](https://github.com/cacjs/cac), one program per group (`cli/lib/args.mjs`); the board
commands keep their own table in `src/board/cli.ts`.

For editable diagrams, put Mermaid into a named block with `herdr-draw canvas block put`.
The [structured diagram guide](../skills/herdr-canvas-mod/references/visual-formats-structured.md)
shows guarded revisions and native edits on the same board.

### Upgrading a running sidecar

An older sidecar can continue to serve existing boards after an install. Export any live boards you
want to keep before restarting it. Use the sidecar PID from `herdr-draw canvas status` to stop that
process, then run `herdr-draw canvas start` and import the saved scenes into their boards.

## Debugging

Every part writes a log, with debug lines on by default for now (`HERDR_DRAW_DEBUG=0` turns them off):

| Where | What |
|-------|------|
| `~/.local/state/herdr-draw/logs/` (`$HERDR_DRAW_LOGS`) | `cli`, `sidecar`, `endpoint` (the bridge's far end), `install`; `sidecar-<port>.out` is its raw stdout |
| `~/.config/herdr-app/data/herdr-draw/logs/` | `mod-excal-canvas`, `mod-diagram-pane`, `mod-diagram-popup` (mods can only write under the app home) |
| `~/.local/state/herdr-draw/boards/` | each board saved as `<board>.excalidraw`; restore with `herdr-draw canvas import <file> --replace` |

`herdr-draw logs [component] [-n N]` merges them by time; `--machine vpsme` reads another machine's logs over hc.
For a remote board, read both sides: the laptop's `sidecar` (`relay:` and `bridge vpsme:` lines) and the machine's
`endpoint` (`<-` frames in, `->` frames out) and `sidecar`.

## Layout of this repo

- `cli/herdr-draw.mjs`: the CLI router; `cli/lib/mermaid.mjs` (Node, `pele`, `@resvg/resvg-js` for PNG previews)
  and `cli/lib/canvas.mjs` (starts the sidecar and splits the pane).
- `mods/diagram-pane/`: clone of Herdr's shipped `pane` header plus the badge.
- `mods/diagram-popup/`: the viewer.
- `skills/herdr-canvas-mod/`: the agent skill for pins, native canvas edits, and structured diagrams.

## Known limits

- Needs Herdr 0.1.16 or newer (the mods use `on_pinch` and `checking()`).
- Herdr stops mod code that runs too long, without a message: about 50 ms per render, 500 ms per event
  handler, 5 s per detached task (`sandbox.rs` in herdr-app, not documented upstream). Heavy work goes to the sidecar.
- The SVG text font is the nearest installed sans (Helvetica Neue), not Herdr's
  bundled Geist: GPUI's SVG rasteriser only sees installed fonts.
- Animations: Pele only marks animated edges (dash pattern + class, usecase and
  agentflow only); GPUI's `image()` draws one frame of SVGs and GIFs, and
  timer-driven frame swaps did not repaint reliably. Not supported.
- `mod.open` cannot pass props, so the popup opened from the palette or CLI
  shows the focused pane's terminal.
- `herdr-app check` does not run deferred renders: test tab switches in the app.
- Pele's own zoom/pan controls (`enableZoom`) are DOM-only; the popup reimplements
  them natively. `on_size_change` reports unzoomed px while `.w()`/`.h()` are
  multiplied by the app zoom, so the popup divides measured sizes by `settings().zoom`.
